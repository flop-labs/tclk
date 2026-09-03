// SPDX-License-Identifier: Apache-2.0
// The schema owns the frame field sets and rail registry. This check prevents either the
// generated decoder contract or the normative SPEC table from drifting away unnoticed.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("protocol schema", () => {
  it("has current generated decoder fields and SPEC documentation", () => {
    expect(() => execFileSync(
      process.execPath,
      ["scripts/generate-frame-fields.mjs", "--check"],
      { cwd: root, stdio: "pipe" },
    )).not.toThrow();
  });
});
