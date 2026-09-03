// SPDX-License-Identifier: Apache-2.0
//
// The anti-drift gate between the two deployments.
//
// `src/tool-manifest.generated.ts` is what the Worker advertises; `mcp/src/server.ts` is
// what the stdio binary advertises. This test builds the stdio server from source, reads
// its surface back through the MCP SDK exactly as a client would, and asserts the
// checked-in file still says the same thing — tool names, JSON Schemas, annotations,
// server info, instructions and the protocol versions the SDK speaks.
//
// If it fails, the fix is to regenerate, never to edit the generated file:
//
//     pnpm -r --include-workspace-root build
//     pnpm --filter @flop-labs/tclk-mcp run gen:worker-manifest

import { describe, expect, it } from "vitest";

import { createServer } from "../../src/server.js";
import { PROTOCOL_VERSIONS as SDK_PROTOCOL_VERSIONS, readServerSurface } from "../scripts/tool-manifest.mjs";
import {
  INSTRUCTIONS,
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  SERVER_INFO,
  TOOLS,
} from "../src/tool-manifest.generated.js";

describe("the Worker's tool manifest", () => {
  it("is exactly the stdio server's surface", async () => {
    const surface = await readServerSurface(createServer({ env: {} }));

    expect(TOOLS.map((tool) => tool.name)).toEqual(surface.tools.map((tool) => tool.name));
    // JSON round-tripped: the generated file went through `JSON.stringify`, so compare
    // like against like rather than against zod-shaped objects with `undefined` members.
    expect(JSON.parse(JSON.stringify(TOOLS))).toEqual(JSON.parse(JSON.stringify(surface.tools)));
    expect(JSON.parse(JSON.stringify(SERVER_INFO))).toEqual(
      JSON.parse(JSON.stringify(surface.serverInfo)),
    );
    expect(INSTRUCTIONS).toBe(surface.instructions);
  });

  it("carries the protocol versions this build of the SDK speaks", () => {
    expect([...PROTOCOL_VERSIONS]).toEqual(SDK_PROTOCOL_VERSIONS.supported);
    expect(LATEST_PROTOCOL_VERSION).toBe(SDK_PROTOCOL_VERSIONS.latest);
    expect(PROTOCOL_VERSIONS[0]).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("has a handler behind every advertised tool", async () => {
    const { createHandlers } = await import("../../src/tools.js");
    const handlers = createHandlers({ env: {} }) as unknown as Record<string, unknown>;
    for (const tool of TOOLS) {
      expect(typeof handlers[tool.name], `${tool.name} has no handler`).toBe("function");
    }
    // …and nothing behind a handler that is not advertised.
    const advertised = new Set(TOOLS.map((tool) => tool.name));
    for (const name of Object.keys(handlers)) {
      expect(advertised.has(name), `${name} is a handler with no manifest entry`).toBe(true);
    }
  });
});
