/**
 * Tests for the single-signer Schnorr adaptor signature (UNAUDITED reference).
 *
 * The oracle for correctness is the construction's own verifier plus the cross-module
 * tie-in: the witness extracted from a completed adaptor signature must open the
 * Point(T) leaf (verifyPointWitness) — the PTLC atomic-linkage property.
 */

import { describe, it, expect } from "vitest";

import { generatePointLock, schnorrAdaptor, verifyPointWitness } from "../src/index.js";

const { getPublicKey, preSign, adapt, extractWitness, verifyPreSignature, verifySignature } =
  schnorrAdaptor;

const SK = "0x" + "11".repeat(32);
const MSG = new TextEncoder().encode("settle inference job #42");

describe("Schnorr adaptor signature", () => {
  it("pre-sign verifies, adapt completes, extract recovers the witness", () => {
    const pk = getPublicKey(SK)!;
    const { witness: t, statement: T } = generatePointLock();

    const pre = preSign(SK, MSG, T)!;
    expect(verifyPreSignature(pk, MSG, T, pre)).toBe(true);

    const sig = adapt(pre, t)!;
    expect(verifySignature(pk, MSG, sig)).toBe(true); // a valid completed signature

    const recovered = extractWitness(pre, sig);
    expect(recovered).toBe(t); // exact witness recovered
  });

  it("THE PTLC bridge: the extracted witness opens the Point(T) leaf", () => {
    const { witness: t, statement: T } = generatePointLock();
    const pre = preSign(SK, MSG, T)!;
    const sig = adapt(pre, t)!;
    const recovered = extractWitness(pre, sig)!;
    // The same scalar that completes the off-chain signature satisfies the on-chain leaf.
    expect(verifyPointWitness(T, recovered)).toBe(true);
  });

  it("a pre-signature alone is not a valid signature (no witness leaked)", () => {
    const pk = getPublicKey(SK)!;
    const { statement: T } = generatePointLock();
    const pre = preSign(SK, MSG, T)!;
    // Treating the pre-signature's announced nonce as a full signature must fail.
    expect(verifySignature(pk, MSG, { nonce: pre.nonce, s: pre.s })).toBe(false);
  });

  it("the wrong witness yields a signature that does not verify", () => {
    const pk = getPublicKey(SK)!;
    const { statement: T } = generatePointLock();
    const wrong = generatePointLock().witness;
    const pre = preSign(SK, MSG, T)!;
    const sig = adapt(pre, wrong)!;
    expect(verifySignature(pk, MSG, sig)).toBe(false);
  });

  it("rejects a pre-signature under a different message or key", () => {
    const pk = getPublicKey(SK)!;
    const { statement: T } = generatePointLock();
    const pre = preSign(SK, MSG, T)!;
    expect(verifyPreSignature(pk, new TextEncoder().encode("other"), T, pre)).toBe(false);
    const otherPk = getPublicKey("0x" + "22".repeat(32))!;
    expect(verifyPreSignature(otherPk, MSG, T, pre)).toBe(false);
  });

  it("hex-string messages and byte messages agree", () => {
    const pk = getPublicKey(SK)!;
    const { witness: t, statement: T } = generatePointLock();
    const msgHex = "0xdeadbeef";
    const pre = preSign(SK, msgHex, T)!;
    const sig = adapt(pre, t)!;
    expect(verifySignature(pk, msgHex, sig)).toBe(true);
  });

  it("fail-closed: malformed input returns null, never throws", () => {
    const { statement: T, witness: t } = generatePointLock();
    // getPublicKey: bad key.
    expect(getPublicKey("0xzz")).toBeNull();
    expect(getPublicKey("0x" + "00".repeat(32))).toBeNull(); // zero scalar
    // preSign: bad statement / bad key.
    expect(preSign(SK, MSG, "0xnot-a-point")).toBeNull();
    expect(preSign("0x00", MSG, T)).toBeNull();
    // adapt: bad witness / bad pre.
    const pre = preSign(SK, MSG, T)!;
    expect(adapt(pre, "0x" + "00".repeat(32))).toBeNull(); // zero witness
    expect(adapt({ nonce: "0xbad", s: pre.s }, t)).toBeNull();
    // extractWitness: malformed scalars.
    expect(extractWitness({ nonce: pre.nonce, s: "0xzz" }, { nonce: pre.nonce, s: pre.s })).toBeNull();
  });
});
