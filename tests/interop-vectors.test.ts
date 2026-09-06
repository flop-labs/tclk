/**
 * vectors/tclk-v1.golden.json is a portable, language-agnostic companion to
 * tests/vectors.test.ts: one fully-populated, decodable example of every tclk/1 frame
 * type, meant for a from-scratch port in another language to check itself against
 * without a TypeScript toolchain (see vectors/README.md).
 *
 * This test is what keeps that file honest. It doesn't re-derive the vectors (that's
 * scripts/generate-interop-vectors.mjs, run by hand when the wire format changes on
 * purpose); it just proves, against the actual source encoder/decoder, that:
 *   - every vector's `line` is exactly what encodeFrame(frame) produces, and
 *   - decodeFrame(line) reproduces `frame` exactly (order-independent key comparison).
 * A JSON fixture with no test behind it can drift from the code silently; this is the
 * same anti-drift discipline AGENTS.md describes for tests/vectors.test.ts, applied to
 * the portable file too.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { decodeFrame, encodeFrame, type TclkFrame } from "../src/index.js";

interface GoldenVectorFile {
  schema: string;
  wirePrefix: string;
  vectors: Record<string, { frame: TclkFrame; line: string }>;
}

const path = new URL("../vectors/tclk-v1.golden.json", import.meta.url);
const doc: GoldenVectorFile = JSON.parse(readFileSync(path, "utf8"));

describe("portable interop vectors (vectors/tclk-v1.golden.json)", () => {
  it("covers all eight frame types, exactly once each", () => {
    const types = Object.values(doc.vectors).map((v) => v.frame.type);
    expect(new Set(types)).toEqual(
      new Set(["offer", "accept", "lock", "reveal", "refund", "cancel", "receipt", "heartbeat"]),
    );
    expect(types).toHaveLength(8);
  });

  for (const [name, vector] of Object.entries(doc.vectors)) {
    it(`${name}: frame -> line matches the reference encoder`, () => {
      expect(encodeFrame(vector.frame)).toBe(vector.line);
    });

    it(`${name}: line -> frame matches the reference decoder`, () => {
      expect(decodeFrame(vector.line)).toEqual(vector.frame);
    });

    it(`${name}: line starts with the documented wire prefix`, () => {
      expect(vector.line.startsWith(doc.wirePrefix)).toBe(true);
    });
  }
});
