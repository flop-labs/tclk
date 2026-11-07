import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The MCP handler tests cover runtime behavior. Guard the root table's caller-facing
// promises: a built frame is not a signed commitment, and whoami has no tier field.
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function toolRow(name: string): string {
  const tick = String.fromCharCode(96);
  const row = readme.split("\n").find((line) => line.startsWith("| " + tick + name + tick + " |"));
  expect(row, "README MCP table must list " + name).toBeDefined();
  return row!.split("|")[2]!.trim();
}

describe("root README MCP tool contract", () => {
  it("does not promise a signature from the offer builder", () => {
    const description = toolRow("tclk_make_offer");
    expect(description).toMatch(/\bunsigned\b/i);
    expect(description).toContain("tclk_post_frame");
    expect(description).not.toMatch(/\bbuild and sign\b/i);
  });

  it("describes whoami identities and missing-key notes, not tier output", () => {
    const description = toolRow("tclk_whoami");
    expect(description).toMatch(/did:key/i);
    expect(description).toMatch(/payment key/i);
    expect(description).toMatch(/\bmissing\b/i);
    expect(description).not.toMatch(/\btiers?\b/i);
  });
});
