import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("normative protocol references", () => {
  it("does not point maintainers to the removed protocol draft", () => {
    for (const path of ["src/index.ts", "src/frames.ts", "tests/tclk.test.ts"]) {
      const text = read(path);
      expect(text, path).not.toContain("technocore-lock-protocol.md");
      expect(text, path).toContain("SPEC.md");
    }
  });

  it("links the actual normative spec from the published MCP README", () => {
    const text = read("mcp/README.md");
    expect(text).not.toContain("repository's design docs");
    expect(text).toContain(
      "[`SPEC.md`](https://github.com/flop-labs/tclk/blob/main/SPEC.md)",
    );
  });
});
