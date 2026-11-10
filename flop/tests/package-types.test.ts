// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const compiler = resolve(
  dirname(require.resolve("typescript/package.json")),
  require("typescript/package.json").bin.tsc,
);

describe("package declarations", () => {
  it("typechecks a consumer of the public entry point without skipLibCheck", () => {
    const result = spawnSync(process.execPath, [
      compiler,
      "--project", fileURLToPath(new URL("./fixtures/package-types/tsconfig.json", import.meta.url)),
    ], { encoding: "utf8", timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 30_000);
});
