/**
 * Golden cross-implementation vectors for tclk/1.
 *
 * These byte strings pin the wire format itself: the domain-tagged offer id, the
 * contract id that binds the full offer to the acceptance, and the canonical
 * ASCII line each encodes to. They were generated from the reference implementation,
 * so any port (this one, or a future one in another language) that disagrees is
 * wrong — fix the implementation, never the vector.
 */

import { describe, it, expect } from "vitest";

import { decodeFrame, encodeFrame, makeAccept, makeOffer } from "../src/index.js";

const PAYER_DID = "did:key:z6Mk" + "f".repeat(44);

/** Offer id for the non-ASCII job frame below — the hash of the ESCAPED canonical JSON,
 *  i.e. of exactly the bytes that frame puts on the wire. */
const NON_ASCII_OFFER_ID =
  "0xfdad69c602bef151596e3e914cc3ca05b1ccd009211b57c4fdbf0ba0e0d4635b";
const PAYEE_DID = "did:key:z6Mk" + "g".repeat(44);

const OFFER_ID = "0xd001fbbf4fa36d9ab8ea88df02a8b3303539e9d59f7ff9d9bfeb679318e9ce75";
const CONTRACT_ID = "0x2768bf32b455317879796093ff2e5882371cbec238611ca71f555a7fcbe58e1c";

const OFFER_LINE =
  'tclk1 {"amount":"1000000","asset":"FLOP","claimByMs":1756703600000,"expiresMs":1756700600000,' +
  '"from":"did:key:z6Mkffffffffffffffffffffffffffffffffffffffffffff",' +
  `"id":"${OFFER_ID}",` +
  '"job":{"context":"ctx-1","id":"task-3f","proto":"a2a"},"lock":"hash",' +
  '"nonce":"9f2c81d04c9e1f7a","rails":["flop-htlc","x402"],"refundAfterMs":1756707200000,' +
  '"role":"payer","type":"offer"}';

const ACCEPT_LINE =
  `tclk1 {"contract":"${CONTRACT_ID}",` +
  '"from":"did:key:z6Mkgggggggggggggggggggggggggggggggggggggggggggg",' +
  `"nonce":"0011223344556677","ref":"${OFFER_ID}",` +
  '"statement":"0xabababababababababababababababababababababababababababababababab",' +
  '"type":"accept"}';

describe("tclk golden vectors", () => {
  const offer = makeOffer({
    from: PAYER_DID,
    role: "payer",
    amount: "1000000",
    asset: "FLOP",
    lock: "hash",
    rails: ["flop-htlc", "x402"],
    claimByMs: 1756703600000,
    refundAfterMs: 1756707200000,
    expiresMs: 1756700600000,
    job: { proto: "a2a", id: "task-3f", context: "ctx-1" },
    nonce: "9f2c81d04c9e1f7a",
  });

  const accept = makeAccept(offer, {
    from: PAYEE_DID,
    statement: "0x" + "ab".repeat(32),
    nonce: "0011223344556677",
  });

  it("pins the offer id and its canonical line", () => {
    expect(offer.id).toBe(OFFER_ID);
    expect(encodeFrame(offer)).toBe(OFFER_LINE);
  });

  it("pins the contract id and the accept line", () => {
    expect(accept.contract).toBe(CONTRACT_ID);
    expect(encodeFrame(accept)).toBe(ACCEPT_LINE);
  });

  // The id must commit to the bytes the wire carries, not to the pre-escape string.
  // With a non-ASCII job field the two differ, so this vector is what catches a
  // domainHash that hashes the unescaped form: the frame line below is pure ASCII, and
  // the id is the hash of exactly that JSON payload.
  it("pins an id whose frame carries a non-ASCII field", () => {
    const offer = makeOffer({
      from: PAYER_DID,
      role: "payer",
      lock: "hash",
      amount: "100",
      asset: "FLOP",
      rails: ["flop-htlc"],
      claimByMs: 1756703600000,
      refundAfterMs: 1756707200000,
      expiresMs: 1756700600000,
      job: { proto: "a2a", id: "t" + String.fromCharCode(0xe2) + "che-1" },
      nonce: "9f2c81d04c9e1f7a",
    });

    const line = encodeFrame(offer);
    expect(line).toMatch(/^[\x20-\x7e]*$/);
    expect(line).toContain(String.raw`\u00e2`);
    expect(offer.id).toBe(NON_ASCII_OFFER_ID);
  });

  // Issue #48: Pin exact canonical JSON escaping forms (C0 controls, short escapes,
  // non-ASCII BMP, surrogate pairs for astral code points, quotes, and backslashes).
  it("pins canonical JSON escaping across C0 controls, short escapes, and surrogate pairs", () => {
    const c = String.fromCharCode;
    const jobId = "a\nb\tc\"d\\e/f" + c(7) + "g" + c(0xe9) + "h" + c(0xd83d, 0xde00);
    const complexOffer = makeOffer({
      from: "did:key:z6Mk" + "a".repeat(44),
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
  });
});
