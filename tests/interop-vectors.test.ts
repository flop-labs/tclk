/**
 * vectors/tclk-v1.golden.json is a portable, language-agnostic companion to
 * tests/vectors.test.ts: one decodable example of every tclk/1 frame type, meant for a
 * from-scratch port in another language to check itself against without a TypeScript
 * toolchain (see vectors/README.md).
 *
 * This test is what keeps that file honest. It doesn't re-derive the vectors (that's
 * scripts/generate-interop-vectors.mjs, run by hand when the corpus changes on purpose);
 * it proves, against the actual source encoder/decoder, that:
 *   - every vector's `line` is exactly what encodeFrame(frame) produces, and
 *   - decodeFrame(line) reproduces `frame` exactly (order-independent key comparison),
 * and it pins the file itself to the SHA-256 published in vectors/README.md, so a
 * regenerated file with reordered keys or respelled numbers fails here, even though every
 * line still round-trips, instead of surprising a port that compares the file.
 * A JSON fixture with no test behind it can drift from the code silently; this is the
 * same anti-drift discipline AGENTS.md describes for tests/vectors.test.ts, applied to
 * the portable file too.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { FRAME_FIELDS } from "../src/frame-fields.generated.js";
import { decodeFrame, encodeFrame, type TclkFrame } from "../src/index.js";

/**
 * SHA-256 of vectors/tclk-v1.golden.json as committed, LF line endings included.
 * vectors/README.md publishes the same value. Any change to the file changes it: the
 * generator prints the new value, which goes here and in the README together.
 */
const GOLDEN_SHA256 = "31d804f7a1eba6bb6ec353bc28496f790734193f7df6f4fd27aece1dbd4f9d02";

interface GoldenVectorFile {
  schema: string;
  wirePrefix: string;
  vectors: Record<string, { frame: TclkFrame; line: string }>;
}

const path = new URL("../vectors/tclk-v1.golden.json", import.meta.url);
const bytes = readFileSync(path);
const doc: GoldenVectorFile = JSON.parse(bytes.toString("utf8"));

describe("portable interop vectors (vectors/tclk-v1.golden.json)", () => {
  it("covers all eight frame types, exactly once each", () => {
    const types = Object.values(doc.vectors).map((v) => v.frame.type);
    expect(new Set(types)).toEqual(
      new Set(["offer", "accept", "lock", "reveal", "refund", "cancel", "receipt", "heartbeat"]),
    );
    expect(types).toHaveLength(8);
  });

  // `paymentKey` is left out on purpose: adding it would change the contract id (and, on
  // `offer`, the offer id), which every later frame carries, so `offer` and `accept` would
  // no longer be the frames tests/vectors.test.ts pins.
  it("carries every optional field at least once, except paymentKey", () => {
    for (const [type, fields] of Object.entries(FRAME_FIELDS)) {
      const vector = Object.values(doc.vectors).find((v) => v.frame.type === type);
      expect(vector, type).toBeDefined();
      const required = new Set<string>(fields.required);
      for (const field of fields.allowed) {
        if (required.has(field) || field === "paymentKey") continue;
        expect(vector?.frame, `${type}.${field}`).toHaveProperty(field);
      }
    }
  });

  it("is pinned byte for byte by the SHA-256 that vectors/README.md publishes", () => {
    expect(bytes.includes(0x0d), "CRLF line endings: check the file out with LF").toBe(false);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(GOLDEN_SHA256);
    expect(readFileSync(new URL("../vectors/README.md", import.meta.url), "utf8")).toContain(
      GOLDEN_SHA256,
    );
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
