// SPDX-License-Identifier: Apache-2.0
//
// The identity provenance in examples/live-deal.mjs, pinned.
//
// Requested on #134 by @bdunn77, who verified the behaviour by hand and pointed out the obvious
// gap: nothing in the tree stops a later change from dropping the labels or the warning, and the
// whole point of them is that an ephemeral run and a real one are otherwise indistinguishable.
// Hand verification is not a gate.
//
// Every run here is pointed at a closed loopback port and inherits no signing variables, so the
// script fails at its first fetch and no shared venue is contacted. The malformed case must not
// even get that far — the guarantee is that a bad seed is refused before any transport attempt,
// which is asserted by the absence of the venue line rather than by trusting the ordering.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLE = "examples/live-deal.mjs";
const CLOSED = "http://127.0.0.1:1";
const SEED = "ab".repeat(32);

/** Run the example with a clean environment plus `env`, and return what it printed. */
function run(env: Record<string, string> = {}) {
  const { TCLK_PAYER_SEED, TCLK_PAYEE_SEED, TECHNOCORE_URL, ...rest } = process.env;
  const r = spawnSync(process.execPath, [EXAMPLE], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...rest, TECHNOCORE_URL: CLOSED, ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("examples/live-deal.mjs identity provenance", () => {
  // Fails rather than skips when the package is not built. The example imports `dist/`, so
  // without it these tests cannot run — and a suite that quietly reports five skips as success
  // is the failure mode this file exists to prevent, one level up. CI builds before it tests
  // (CONTRIBUTING, "CI runs exactly these three"), so this only ever fires locally, where the
  // fix is one command and a silent pass would be a lie.
  it("requires the package to be built", () => {
    expect(
      existsSync(new URL("../dist/index.js", import.meta.url)),
      "run `pnpm build` first: examples/live-deal.mjs imports dist/",
    ).toBe(true);
  });

  it("labels both sides ephemeral and warns, when no seed is configured", () => {
    const { out } = run();
    expect(out).toContain("(ephemeral — one-run key)");
    expect(out.match(/\(ephemeral — one-run key\)/g)).toHaveLength(2);
    expect(out).toContain("It is a rehearsal,");
  });

  it("names the variable a configured side came from, and does not warn", () => {
    const { out } = run({ TCLK_PAYEE_SEED: SEED });
    expect(out).toContain("(from TCLK_PAYEE_SEED)");
    // The payer is still a one-run key, and the notice is only for the both-ephemeral case.
    expect(out).toContain("(ephemeral — one-run key)");
    expect(out).not.toContain("It is a rehearsal,");
  });

  it("labels each side with its own variable when both are configured", () => {
    const { out } = run({ TCLK_PAYER_SEED: SEED, TCLK_PAYEE_SEED: "cd".repeat(32) });
    expect(out).toContain("(from TCLK_PAYER_SEED)");
    expect(out).toContain("(from TCLK_PAYEE_SEED)");
    expect(out).not.toContain("(ephemeral — one-run key)");
  });

  it("derives the same DID from the bare and 0x spellings of one seed", () => {
    const did = (out: string) => /payee\s+(did:key:z6Mk\S+)/.exec(out)?.[1];
    const bare = did(run({ TCLK_PAYEE_SEED: SEED }).out);
    const prefixed = did(run({ TCLK_PAYEE_SEED: `0x${SEED}` }).out);
    expect(bare).toMatch(/^did:key:z6Mk/);
    expect(prefixed).toBe(bare);
  });

  it("refuses a malformed seed with exit 2, before any transport attempt", () => {
    const { status, out } = run({ TCLK_PAYEE_SEED: "not-a-seed" });
    expect(status).toBe(2);
    expect(out).toContain("TCLK_PAYEE_SEED must be a 32-byte Ed25519 seed");
    // The venue line is the first thing printed after the signers are built, so its absence is
    // what shows the refusal happened before the script went anywhere near the network.
    expect(out).not.toContain("venue");
  });
});
