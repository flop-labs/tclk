import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { normalizeLineEndings } from "../scripts/normalize-line-endings.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("protocol generator line endings", () => {
  it("normalizes CRLF and bare CR without changing content", () => {
    expect(normalizeLineEndings("first\r\nsecond\rthird\nfourth")).toBe(
      "first\nsecond\nthird\nfourth",
    );
  });

  it("accepts a CRLF checkout in the generator freshness check", () => {
    const checkout = mkdtempSync(join(tmpdir(), "tclk-generator-"));
    try {
      for (const relative of [
        "scripts/generate-frame-fields.mjs",
        "scripts/normalize-line-endings.mjs",
        "schema/tclk1-frames.schema.json",
        "src/frame-fields.generated.ts",
        "SPEC.md",
      ]) {
        const target = join(checkout, relative);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(root, relative), target);
      }
      for (const relative of ["SPEC.md", "src/frame-fields.generated.ts"]) {
        const target = join(checkout, relative);
        writeFileSync(target, readFileSync(target, "utf8").replace(/\r?\n/g, "\r\n"));
      }

      expect(() => execFileSync(
        process.execPath,
        [join(checkout, "scripts/generate-frame-fields.mjs"), "--check"],
        { cwd: checkout, stdio: "pipe" },
      )).not.toThrow();
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
