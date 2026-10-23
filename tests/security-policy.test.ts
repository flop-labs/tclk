// SPDX-License-Identifier: Apache-2.0
// The security policy must describe the settlement and release surfaces that exist
// in this tree; a stale "paper only" promise misdirects vulnerability reports.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("security policy contract", () => {
  it("distinguishes the value-bearing FLOP adapter from PaperRail", () => {
    const policy = read("../SECURITY.md");
    const rail = read("../flop/src/rail.ts");
    const chain = read("../flop/src/chain.ts");
    const packageName = JSON.parse(read("../flop/package.json")).name;

    expect(packageName).toBe("@flop-labs/tclk-flop");
    expect(rail).toContain("export class FlopRail");
    expect(chain).toContain("openEscrow");
    expect(policy).toContain("PaperRail");
    expect(policy).toContain("FlopRail");
    expect(policy).toContain("devnet");
    expect(policy).toContain("escrow");
    expect(policy).toMatch(/private advisory/i);
    expect(policy).not.toMatch(/No rail here holds value/i);
  });

  it("acknowledges published core and MCP packages without promising instant updates", () => {
    const policy = read("../SECURITY.md");
    const supportedVersions = policy.split("## Supported versions\n")[1];
    expect(supportedVersions).toMatch(/`@flop-labs\/tclk`/);
    expect(supportedVersions).toMatch(/`@flop-labs\/tclk-mcp`/);
    expect(policy).toMatch(/for installed releases, the affected package and version/);
    expect(policy).not.toContain("`main` is the only artifact");
    expect(policy).toContain("0.1.0");
    expect(policy).toMatch(/already-installed packages/);
    expect(policy).not.toMatch(/Nothing is published to a registry yet/i);
  });
});
