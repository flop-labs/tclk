// SPDX-License-Identifier: Apache-2.0
// SPEC §3 calls `schema/tclk1-frames.schema.json` "the same artifact the decoder uses" and
// the package ships it in `files`, so an independent implementation validates against the
// installed copy rather than against `src/`. An `exports` map hides every subpath it does
// not name, so the specifier a consumer writes is resolved here — through this package's
// own map, by self-reference — and a map that stops naming the schema fails in this suite
// instead of in someone's install.

import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCHEMA_SPECIFIER = "@flop-labs/tclk/schema/tclk1-frames.schema.json";

const nodeRequire = createRequire(import.meta.url);
const shipped = fileURLToPath(new URL("../schema/tclk1-frames.schema.json", import.meta.url));

describe("published package surface", () => {
  it("resolves the shipped frame schema by its package specifier", () => {
    // Both sides through realpath: the resolver returns the real path, so a checkout
    // reached by a symlink would otherwise compare unequal.
    expect(realpathSync(nodeRequire.resolve(SCHEMA_SPECIFIER))).toBe(realpathSync(shipped));

    const schema = JSON.parse(readFileSync(nodeRequire.resolve(SCHEMA_SPECIFIER), "utf8"));
    expect(schema.$id).toBe("https://github.com/flop-labs/tclk/schema/tclk1-frames.schema.json");
    expect(schema.$defs.offer).toBeDefined();
  });
});
