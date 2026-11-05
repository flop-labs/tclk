// SPDX-License-Identifier: Apache-2.0
//
// The release gate for the announced server version.
//
// `server.test.ts` pins the handshake to `mcp/package.json`, but on a commit where the
// manifest still reads the version an older build restated, that comparison holds either
// way. This file drops the dependence on whatever version the repository currently
// carries: it assembles the layout npm publishes — the `dist` of `files`, beside a
// `package.json` — with one field moved, the version a release bumps, and asks the server
// inside it what it announces. A build that restates a literal answers with the old
// version here whatever the manifest beside it says; a build that reads that manifest
// answers with the new one. No manual edit to a committed file, so CI runs it.
//
// Needs `pnpm -r --include-workspace-root build` first, for the same reason
// `gen:worker-manifest` does: `dist` is the artifact that ships, so `dist` is what gets
// asked. The Worker inherits the answer rather than needing its own probe —
// `tool-manifest.generated.ts` is written from this same build by `scripts/generate.mjs`,
// and `worker/tests/manifest.test.ts` fails if the committed copy has drifted from it.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The version this stands in for a release moving to. Any value the sources cannot also
// hold works; this one is far enough from a plausible release to be unmistakable in a
// failure message.
const RELEASED_VERSION = "9999.0.0-release-probe";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<
  string,
  unknown
> & { version: string };
const dist = join(packageRoot, "dist");

let probe: string | undefined;

afterAll(() => {
  if (probe !== undefined) rmSync(probe, { recursive: true, force: true });
});

describe("a published build's handshake", () => {
  it("announces the version of the package.json shipped beside it", async () => {
    expect(
      existsSync(join(dist, "server.js")),
      "run `pnpm -r --include-workspace-root build` before this suite",
    ).toBe(true);
    // Guards this test rather than the server: a probe version that matched the manifest
    // would pass against a hard-coded literal too, which is the hole being closed here.
    expect(RELEASED_VERSION).not.toBe(manifest.version);

    // Scratch space under `node_modules`: already ignored, and never picked up by `pnpm
    // pack` the way a stray directory beside `dist` would be.
    probe = mkdtempSync(join(packageRoot, "node_modules", ".tclk-release-probe-"));
    cpSync(dist, join(probe, "dist"), { recursive: true });
    writeFileSync(
      join(probe, "package.json"),
      `${JSON.stringify({ ...manifest, version: RELEASED_VERSION }, null, 2)}\n`,
    );

    const { createServer } = (await import(
      pathToFileURL(join(probe, "dist", "server.js")).href
    )) as typeof import("../src/server.js");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([
      createServer({ env: {} }).connect(serverTransport),
      client.connect(clientTransport),
    ]);

    expect(client.getServerVersion()).toEqual({ name: "tclk-mcp", version: RELEASED_VERSION });
    await client.close();
  });
});
