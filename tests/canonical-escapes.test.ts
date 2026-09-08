// SPDX-License-Identifier: Apache-2.0
//
// The canonical-JSON escape forms, pinned one class of code point at a time.
//
// SPEC §3.1 hashes the escaped string, so these are not stylistic: an implementation that
// spells one escape differently computes a different offer id for the same terms, and every
// later frame names the contract by that id. The expected strings here are written out by
// hand rather than produced by the encoder, so this file disagrees with the encoder if the
// encoder moves — which is the whole point of having it. Issue #48.

import { describe, expect, it } from "vitest";

import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJson, decodeFrame, encodeFrame, makeOffer, offerId } from "../src/index.js";

const PAYER = "did:key:z6Mk" + "a".repeat(44);
const NOW = 1_760_000_000_000;

/** An offer carrying `text` in `job.id`, everything else fixed and ASCII. */
function offerWith(text: string) {
  return makeOffer({
    from: PAYER,
    role: "payer",
    amount: "1",
    asset: "FLOP",
    lock: "hash",
    rails: ["flop-htlc"],
    claimByMs: NOW + 3_600_000,
    refundAfterMs: NOW + 7_200_000,
    expiresMs: NOW + 600_000,
    nonce: "9f2c81d04c9e1f7a",
    job: { proto: "a2a", id: `a${text}b` },
  });
}

/** What `job.id` looks like on the wire. */
function wireJobId(line: string): string {
  const found = /"job":\{"id":"((?:[^"\\]|\\.)*)"/.exec(line);
  if (!found) throw new Error(`no job.id on the wire in: ${line}`);
  return found[1];
}

describe("canonical JSON escape forms (SPEC §3)", () => {
  it.each([
    ['"', 'a\\"b', "quotation mark"],
    ["\\", "a\\\\b", "reverse solidus"],
    ["/", "a/b", "solidus, never escaped"],
    ["\b", "a\\bb", "backspace, short escape"],
    ["\t", "a\\tb", "tab, short escape"],
    ["\n", "a\\nb", "line feed, short escape"],
    ["\f", "a\\fb", "form feed, short escape"],
    ["\r", "a\\rb", "carriage return, short escape"],
    ["\u0000", "a\\u0000b", "NUL, no short escape"],
    ["\u0001", "a\\u0001b", "SOH, no short escape"],
    ["\u001b", "a\\u001bb", "ESC, no short escape"],
    ["\u001f", "a\\u001fb", "US, the last C0"],
    ["\u00a0", "a\\u00a0b", "NBSP, first code point past ASCII"],
    ["\u00e9", "a\\u00e9b", "e-acute"],
    ["\u200b", "a\\u200bb", "zero-width space"],
    ["\u2028", "a\\u2028b", "line separator"],
    ["\u2029", "a\\u2029b", "paragraph separator"],
    ["\u4e2d", "a\\u4e2db", "CJK"],
    ["\uffff", "a\\uffffb", "last BMP code point"],
  ])("emits %j as %j (%s)", (input, expected) => {
    expect(wireJobId(encodeFrame(offerWith(input)))).toBe(expected);
  });

  it("spells an astral character as its two surrogate escapes, never \\u{…}", () => {
    const line = encodeFrame(offerWith("\u{1f600}"));
    expect(wireJobId(line)).toBe("a\\ud83d\\ude00b");
    expect(line).not.toContain("\\u{");
  });

  it("spells a lone surrogate as the one escape of itself, and round-trips it", () => {
    expect(wireJobId(encodeFrame(offerWith("\ud800")))).toBe("a\\ud800b");
    expect(wireJobId(encodeFrame(offerWith("\udfff")))).toBe("a\\udfffb");
  });

  it("uses lowercase hex in every escape", () => {
    const line = encodeFrame(offerWith("\u00e9\u4e2d\uffff\u{1f600}"));
    expect(wireJobId(line)).toBe("a\\u00e9\\u4e2d\\uffff\\ud83d\\ude00b");
    expect(/\\u[0-9a-f]*[A-F]/.test(line)).toBe(false);
  });

  it("refuses U+007F, the one code point neither escape rule covers", () => {
    // JSON's own escaping stops at U+001F and the non-ASCII rule starts at U+0080, so DEL
    // would reach the wire raw — and technocore sweeps it to a space before storing.
    expect(() => encodeFrame(offerWith("\u007f"))).toThrow(/non-printable-ASCII/);
    expect(canonicalJson(offerWith("\u007f")).includes("\u007f")).toBe(true);
  });

  it("hashes the escaped form: the id is over the bytes the wire carries", () => {
    // The escaper, written independently of src/. If the two ever disagree, one of them
    // moved and the offer id moved with it.
    const escape = (json: string) =>
      json.replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const { id, ...fields } = offerWith("é\u{1f600}");
    const escaped = escape(canonicalJson(fields));
    const digest = sha256(new TextEncoder().encode(`FLOP::tclk::v1|offer|${escaped}`));
    const expected = "0x" + [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");

    expect(id).toBe(expected);
    expect(offerId(fields)).toBe(expected);
    // …and not over the pre-escape string, which is what makes the forms above normative.
    const rawDigest = sha256(new TextEncoder().encode(`FLOP::tclk::v1|offer|${canonicalJson(fields)}`));
    expect("0x" + [...rawDigest].map((b) => b.toString(16).padStart(2, "0")).join("")).not.toBe(id);
  });

  // Every escape class in one frame, frozen to a single wire line and one offer id, so a
  // cross-language port can diff against one constant as well as the per-class assertions
  // above. Composite vector contributed by @Aphelios01-sdk on #68, at @sv's request in #67.
  it("pins every escape class at once against one frozen line and id", () => {
    const jobId =
      "a\nb\tc\"d\\e/f" + String.fromCharCode(0x07) + "g" +
      String.fromCharCode(0xe9) + "h" + String.fromCodePoint(0x1f600);
    const complexOffer = makeOffer({
      from: PAYER,
      role: "payer",
      amount: "1",
      asset: "FLOP",
      lock: "hash",
      rails: ["flop-htlc"],
      claimByMs: 1_760_003_600_000,
      refundAfterMs: 1_760_007_200_000,
      expiresMs: 1_760_000_600_000,
      job: { proto: "a2a", id: jobId },
      nonce: "9f2c81d04c9e1f7a",
    });

    const expectedId = "0x6d256c211f927c2c23a874d35f4b5372de66b4642274ed8a8b62b73ca5bf6a58";
    const expectedLine =
      'tclk1 {"amount":"1","asset":"FLOP","claimByMs":1760003600000,"expiresMs":1760000600000,' +
      '"from":"did:key:z6Mkaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
      `"id":"${expectedId}",` +
      '"job":{"id":"a\\nb\\tc\\"d\\\\e/f\\u0007g\\u00e9h\\ud83d\\ude00","proto":"a2a"},' +
      '"lock":"hash","nonce":"9f2c81d04c9e1f7a","rails":["flop-htlc"],"refundAfterMs":1760007200000,' +
      '"role":"payer","type":"offer"}';

    expect(complexOffer.id).toBe(expectedId);
    expect(encodeFrame(complexOffer)).toBe(expectedLine);
    expect(decodeFrame(expectedLine).id).toBe(expectedId);

    // A cross-language port has no encoder of ours to agree with, so the frozen id is also
    // recomputed through the file's independent escaper, the way the previous test does. Now
    // the constant rests on the escape rule rather than on our encoder alone.
    const escape = (json: string) =>
      json.replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const { id: _id, ...fields } = complexOffer;
    const digest = sha256(new TextEncoder().encode(`FLOP::tclk::v1|offer|${escape(canonicalJson(fields))}`));
    expect("0x" + [...digest].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe(expectedId);
  });
});
