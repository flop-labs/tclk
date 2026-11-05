// SPDX-License-Identifier: Apache-2.0
//
// Two follow-ups to #48 that live in code; the SPEC wording is #68's.
//
// - `toAscii` is exported. It is the step between `canonicalJson` and both the id hash and the
//   wire line, so a port can check its own escaper against it instead of re-deriving the rule
//   from tests: lowercase, exactly four hex digits, one escape per UTF-16 code unit from U+0080.
// - `decodeFrame` refuses U+007F however a line spells it. The encoder can never emit DEL, so a
//   decoded frame carrying one is a frame the reference could not re-encode, and its id hashes a
//   raw 0x7f that no conforming line carries.

import { describe, expect, it } from "vitest";

import { sha256 } from "@noble/hashes/sha2.js";
import {
  TCLK_DOMAIN,
  TCLK_PREFIX,
  canonicalJson,
  decodeFrame,
  encodeFrame,
  makeOffer,
  offerId,
  toAscii,
  type OfferFrame,
} from "../src/index.js";

const PAYER = "did:key:z6Mk" + "a".repeat(44);
const DEL = String.fromCharCode(0x7f);
const E_ACUTE = String.fromCharCode(0xe9);
const CJK = String.fromCharCode(0x4e2d); // one UTF-16 code unit
const ASTRAL = String.fromCodePoint(0x1f600); // two: a surrogate pair

/** An offer whose `job.id` carries `text`, everything else fixed and ASCII. */
function offerWith(text: string): OfferFrame {
  return makeOffer({
    from: PAYER,
    role: "payer",
    amount: "1",
    asset: "FLOP",
    lock: "hash",
    rails: ["flop-htlc"],
    claimByMs: 1_760_003_600_000,
    refundAfterMs: 1_760_007_200_000,
    expiresMs: 1_760_000_600_000,
    nonce: "9f2c81d04c9e1f7a",
    job: { proto: "a2a", id: `a${text}b` },
  });
}

/** The offer id over an already-escaped canonical string, the way any implementation hashes it. */
function idOver(escaped: string): string {
  const digest = sha256(new TextEncoder().encode(`${TCLK_DOMAIN}|offer|${escaped}`));
  return "0x" + [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The same escapes with uppercase hex digits, as several JSON serializers write them. */
const upperHex = (json: string) =>
  json.replace(/\\u([0-9a-f]{4})/g, (_match, hex: string) => `\\u${hex.toUpperCase()}`);

describe("toAscii, exported", () => {
  it("escapes é, a CJK character and an astral pair exactly as the wire carries them", () => {
    expect(toAscii(E_ACUTE)).toBe("\\u00e9");
    expect(toAscii(CJK)).toBe("\\u4e2d");
    expect(toAscii(ASTRAL)).toBe("\\ud83d\\ude00");
    expect(toAscii(`{"s":"${E_ACUTE}${CJK}${ASTRAL}"}`)).toBe(
      '{"s":"\\u00e9\\u4e2d\\ud83d\\ude00"}',
    );
  });

  it("follows the rule for every UTF-16 code unit: unchanged below U+0080, then lowercase four-digit escapes", () => {
    const wrong: string[] = [];
    for (let unit = 0; unit <= 0xffff; unit++) {
      const ch = String.fromCharCode(unit);
      const expected = unit < 0x80 ? ch : `\\u${unit.toString(16).padStart(4, "0")}`;
      if (toAscii(ch) !== expected) wrong.push(unit.toString(16));
    }
    expect(wrong).toEqual([]);
  });

  it("is the step the id hashes: an uppercase-hex port computes another id, and its frame is refused", () => {
    for (const text of [E_ACUTE, CJK, ASTRAL]) {
      const offer = offerWith(text);
      const { id, ...fields } = offer;
      expect(offerId(fields)).toBe(idOver(toAscii(canonicalJson(fields))));
      expect((decodeFrame(encodeFrame(offer)) as OfferFrame).id).toBe(id);

      const portId = idOver(upperHex(toAscii(canonicalJson(fields))));
      expect(portId).not.toBe(id);
      const portLine = TCLK_PREFIX + upperHex(toAscii(canonicalJson({ ...fields, id: portId })));
      expect(() => decodeFrame(portLine)).toThrow(/offer id mismatch/);
    }
  });
});

describe("decodeFrame refuses U+007F however the line spells it", () => {
  // makeOffer builds the frame and its reference id; encodeFrame refuses to emit it. The lines
  // below are what a hand-written or foreign encoder can still post: printable ASCII, so the
  // venue stores them as they are.
  const offer = offerWith(DEL);
  const { id: offerIdWithDel, ...fields } = offer;
  const spellDel = (json: string, spelling: string) => json.split(DEL).join(spelling);

  it("refuses DEL spelled as \\u007f, instead of accepting it with an id over the raw byte", () => {
    // The reference id hashes a raw 0x7f: the rest of the offer is ASCII and toAscii leaves DEL
    // alone, so the escaped form is the canonical JSON itself.
    expect(offerIdWithDel).toBe(idOver(canonicalJson(fields)));
    expect(() => encodeFrame(offer)).toThrow(/non-printable-ASCII/);
    for (const spelling of ["\\u007f", "\\u007F"]) {
      const line = TCLK_PREFIX + spellDel(canonicalJson(offer), spelling);
      expect(line).toMatch(/^[\x20-\x7e]*$/);
      expect(() => decodeFrame(line)).toThrow(/frame\.job\.id contains U\+007F/);
    }
  });

  it("refuses the frame a port makes by escaping DEL before hashing, for the same reason", () => {
    const portId = idOver(spellDel(canonicalJson(fields), "\\u007f"));
    const portLine = TCLK_PREFIX + spellDel(canonicalJson({ ...fields, id: portId }), "\\u007f");
    expect(() => decodeFrame(portLine)).toThrow(/U\+007F/);
  });

  it("refuses a raw DEL too", () => {
    const line = TCLK_PREFIX + canonicalJson(offer);
    expect(line.includes(DEL)).toBe(true);
    // A decoder that refuses non-printable bytes before the parse stops it there instead.
    expect(() => decodeFrame(line)).toThrow(/U\+007F|non-printable-ASCII/);
  });

  it("refuses DEL in the free-text fields of other frame types", () => {
    const contract = "0x" + "ab".repeat(32);
    const lines = [
      `${TCLK_PREFIX}{"contract":"${contract}","from":"${PAYER}","reason":"x\\u007fy","type":"refund"}`,
      `${TCLK_PREFIX}{"contract":"${contract}","from":"${PAYER}","nonce":"0011223344556677","note":"\\u007f","type":"heartbeat"}`,
    ];
    for (const line of lines) {
      expect(() => decodeFrame(line)).toThrow(/U\+007F/);
      // The same frame with any other character there decodes.
      expect(() => decodeFrame(line.replace("\\u007f", "z"))).not.toThrow();
    }
  });

  it("still accepts escaped C0 controls: the encoder emits exactly these, so they round-trip", () => {
    for (const unit of [0x00, 0x07, 0x09, 0x0a, 0x1b, 0x1f]) {
      const text = String.fromCharCode(unit);
      const line = encodeFrame(offerWith(text));
      const decoded = decodeFrame(line) as OfferFrame;
      expect(decoded.job?.id).toBe(`a${text}b`);
      expect(encodeFrame(decoded)).toBe(line);
    }
  });

  it("does not take an escaped backslash followed by the text u007f for DEL", () => {
    const text = "\\u007f"; // six characters: a backslash, then u007f
    const line = encodeFrame(offerWith(text));
    expect(line).toContain('"a\\\\u007fb"');
    expect((decodeFrame(line) as OfferFrame).job?.id).toBe(`a${text}b`);
  });
});
