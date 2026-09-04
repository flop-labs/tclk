/**
 * Regression test: decodeFrame() must reject exactly what encodeFrame() would refuse to
 * emit.
 *
 * encodeFrame() already guards against non-printable-ASCII lines, because technocore's
 * real single-line sweep replaces Unicode Cc/Cf/Cs/Co/Zl/Zp characters with a space before
 * storing — so a line only a hand-crafted (non-conforming) sender or a corrupted/tampered
 * export could ever contain such a byte. Before this fix, decodeFrame() (and by extension
 * parseTranscriptExport / foldTranscript) had no matching guard: a line no conforming
 * encoder could ever produce would still decode into a "valid" frame with a matching
 * offerId, silently. That's the opposite of what an offline transcript auditor needs from
 * this invariant.
 *
 * This is not a fund-safety bug (no rail in this repo custodies value yet, see
 * SECURITY.md) — it's a canonical-encoding robustness gap: exactly the "bytes a signature
 * covers are not the bytes stored" category SECURITY.md lists as in scope.
 */

import { describe, it, expect } from "vitest";

import { canonicalJson, decodeFrame, encodeFrame, offerId, type OfferFields } from "../src/index.js";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

function baseOfferFields(jobId: string): OfferFields {
  return {
    type: "offer",
    from: DID,
    role: "payer",
    amount: "1000",
    asset: "USDC",
    lock: "hash",
    rails: ["flop-htlc"],
    claimByMs: 2_000_000_000_000,
    refundAfterMs: 2_000_000_100_000,
    expiresMs: 2_000_000_000_000,
    nonce: "aabbccdd",
    job: { proto: "a2a", id: jobId },
  };
}

describe("decodeFrame / encodeFrame sweep-guard symmetry", () => {
  it("encodeFrame refuses a raw control byte (U+007F) in a free-text field", () => {
    const fields = baseOfferFields("task-\x7f-123");
    const offer = { ...fields, id: offerId(fields) };
    expect(() => encodeFrame(offer)).toThrow(/non-printable-ASCII/);
  });

  it("decodeFrame refuses the same line an encoder could never have produced", () => {
    const fields = baseOfferFields("task-\x7f-123");
    const offer = { ...fields, id: offerId(fields) };
    // Simulate a line that reached a reader some other way: a non-reference sender, a
    // hand-edited transcript export, or a corrupted file — never through this SDK's
    // encodeFrame(), which would have refused it above.
    const rawLine = "tclk1 " + canonicalJson(offer);
    expect(/\x7f/.test(rawLine)).toBe(true); // sanity: the raw byte really is in the line
    expect(() => decodeFrame(rawLine)).toThrow(/non-printable-ASCII/);
  });

  it("legitimate non-ASCII content still round-trips exactly", () => {
    const fields = baseOfferFields("tâche-日本語-123");
    const offer = { ...fields, id: offerId(fields) };
    const line = encodeFrame(offer);
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true); // encoded line is pure printable ASCII
    const decoded = decodeFrame(line);
    expect(decoded.type === "offer" && decoded.job?.id).toBe("tâche-日本語-123");
  });
});
