// SPDX-License-Identifier: Apache-2.0
//
// ⚠️ UNAUDITED REFERENCE CRYPTOGRAPHY — NOT FOR MAINNET VALUE FLOWS.
// Adaptor (a.k.a. "encrypted") signatures are the off-chain primitive behind PTLCs.
// This module implements the *single-signer Schnorr adaptor signature over secp256k1* —
// provably correct and tied to the on-chain `Point` leaf — so the pre-sign / adapt /
// extract / verify cycle exists and is testable end-to-end.
//
// SCOPE / WHAT THIS IS NOT:
//  - This is a FULL-Schnorr construction (the nonce R is a full 33-byte point, e =
//    H(R‖P‖m)). It is NOT BIP-340 x-only. The BTC-Taproot-exact form requires BIP-340's
//    even-y normalization of the nonce and a `needs_negation` flag on the witness — the
//    genuinely fragile part that needs an *audited reference* before any value flow. That
//    normalization + MuSig2 nonce aggregation is deliberately left for the audited
//    signing stack.
//  - Nonces here are random per call (no deterministic RFC6979 / BIP-340 nonce). Fine for
//    correctness tests; an audited impl must pin nonce derivation (reuse leaks the key).
//
// The load-bearing property, which IS demonstrated and tested: completing an adaptor
// signature reveals the witness `t`, and that exact `t` opens the on-chain `Point(T=t·G)`
// escrow leaf (`verifyPointWitness`). That is the PTLC atomic-linkage guarantee.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToU8a, u8aConcat, u8aToHex } from "./hex.js";

const P256 = secp256k1.Point;
type Point = ReturnType<typeof P256.fromBytes>;
const N: bigint = P256.CURVE().n;

const mod = (a: bigint): bigint => ((a % N) + N) % N;

function toScalar(hex: string): bigint {
  const v = mod(BigInt(u8aToHex(hexToU8a(hex))));
  if (v === 0n) throw new Error("scalar is zero / out of range");
  return v;
}

function scalarHex(v: bigint): string {
  return "0x" + mod(v).toString(16).padStart(64, "0");
}

function pointHex(p: Point): string {
  return u8aToHex(p.toBytes(true));
}

function asBytes(msg: string | Uint8Array): Uint8Array {
  return typeof msg === "string" ? hexToU8a(msg) : msg;
}

/** Schnorr challenge e = H(R ‖ P ‖ m) mod n, with R, P SEC1-compressed. */
function challenge(R: Point, P: Point, msg: Uint8Array): bigint {
  const data = u8aConcat(R.toBytes(true), P.toBytes(true), msg);
  return mod(BigInt(u8aToHex(sha256(data))));
}

/** An encrypted (pre-)signature under a statement `T`: announced nonce `R̂` and `ŝ`. */
export interface PreSignature {
  /** Announced nonce point R̂ = r·G (33-byte SEC1 hex). */
  nonce: string;
  /** Pre-signature scalar ŝ = r + e·d (mod n), 0x-hex. */
  s: string;
}

/** A completed signature (R, s): a valid full-Schnorr signature once adapted. */
export interface Signature {
  /** Nonce point R = R̂ + T (33-byte SEC1 hex). */
  nonce: string;
  /** Signature scalar s = ŝ + t (mod n), 0x-hex. */
  s: string;
}

/** The signer's SEC1-compressed public key `P = d·G` for a 32-byte secret key, or `null`
 *  if the key is malformed (bad hex / zero / out of range). Fail-closed, like the rest of
 *  the library (`verifyPointWitness`) — never throws on bad input. */
export function getPublicKey(secretKey: string): string | null {
  try {
    return pointHex(P256.BASE.multiply(toScalar(secretKey)));
  } catch {
    return null;
  }
}

/**
 * Produce a pre-signature on `msg` under statement `T` (33-byte SEC1 point), or `null` if
 * `secretKey` or `statement` is malformed. The challenge binds the *decrypted* nonce
 * `R̂ + T`, so the pre-signature is only completable into a valid signature by someone who
 * knows the witness `t` for `T`.
 */
export function preSign(
  secretKey: string,
  msg: string | Uint8Array,
  statement: string,
): PreSignature | null {
  try {
    const d = toScalar(secretKey);
    const P = P256.BASE.multiply(d);
    const r = mod(BigInt(u8aToHex(secp256k1.utils.randomSecretKey())));
    const Rhat = P256.BASE.multiply(r);
    const T = P256.fromBytes(hexToU8a(statement));
    const e = challenge(Rhat.add(T), P, asBytes(msg));
    return { nonce: pointHex(Rhat), s: scalarHex(r + e * d) };
  } catch {
    return null;
  }
}

/** Complete a pre-signature with the witness `t` into a full-Schnorr signature, or `null`
 *  if `pre` or `witness` is malformed. */
export function adapt(pre: PreSignature, witness: string): Signature | null {
  try {
    const t = toScalar(witness);
    const Rhat = P256.fromBytes(hexToU8a(pre.nonce));
    const R = Rhat.add(P256.BASE.multiply(t));
    return { nonce: pointHex(R), s: scalarHex(toScalar(pre.s) + t) };
  } catch {
    return null;
  }
}

/**
 * Extract the witness `t = s − ŝ (mod n)` from a pre-signature and its completed
 * signature, or `null` if either scalar is malformed. This is the on-chain → off-chain
 * bridge: `t` opens `Point(T)`.
 */
export function extractWitness(pre: PreSignature, sig: Signature): string | null {
  try {
    return scalarHex(toScalar(sig.s) - toScalar(pre.s));
  } catch {
    return null;
  }
}

/** Verify a pre-signature: `ŝ·G == R̂ + e·P` with `e = H((R̂+T)‖P‖m)`. */
export function verifyPreSignature(
  publicKey: string,
  msg: string | Uint8Array,
  statement: string,
  pre: PreSignature,
): boolean {
  try {
    const P = P256.fromBytes(hexToU8a(publicKey));
    const Rhat = P256.fromBytes(hexToU8a(pre.nonce));
    const T = P256.fromBytes(hexToU8a(statement));
    const e = challenge(Rhat.add(T), P, asBytes(msg));
    return P256.BASE.multiply(toScalar(pre.s)).equals(Rhat.add(P.multiply(e)));
  } catch {
    return false;
  }
}

/** Verify a completed full-Schnorr signature: `s·G == R + e·P`, `e = H(R‖P‖m)`. */
export function verifySignature(
  publicKey: string,
  msg: string | Uint8Array,
  sig: Signature,
): boolean {
  try {
    const P = P256.fromBytes(hexToU8a(publicKey));
    const R = P256.fromBytes(hexToU8a(sig.nonce));
    const e = challenge(R, P, asBytes(msg));
    return P256.BASE.multiply(toScalar(sig.s)).equals(R.add(P.multiply(e)));
  } catch {
    return false;
  }
}
