// SPDX-License-Identifier: Apache-2.0
//
// PTLC point locks: the secp256k1 half of the protocol, byte-identical to the on-chain
// `Predicate::Point` leaf — a 32-byte big-endian scalar witness `y` in [1, n) and its
// 33-byte SEC1-compressed statement `Y = y·G`. A lock minted here verifies on-chain and
// a witness taken from a `PointWitnessRevealed` event verifies here: the same `(y, Y)`
// reused across the chain leaf and every off-chain rail, which is what makes the PTLC
// atomic-linkage guarantee hold.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToU8a, isHex, randomU8a, u8aToHex } from "./hex.js";

// ── Curve order (secp256k1) ─────────────────────────────────────────────────
// Witnesses must be a scalar in [1, n). Off-chain validation mirrors the on-chain
// `Scalar::from_repr` (rejects y >= n) and the explicit `y != 0` guard.
export const SECP256K1_N = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);

/** A point lock: the public `statement` (Y) and its secret `witness` (y), both 0x-hex. */
export interface PointLock {
  /** 32-byte big-endian scalar `y`, 0x-prefixed. Keep secret until release. */
  witness: string;
  /** 33-byte SEC1-compressed `Y = y·G`, 0x-prefixed. Safe to publish. */
  statement: string;
}

function assertScalarInRange(y: Uint8Array): void {
  if (y.length !== 32) {
    throw new Error(`PTLC witness must be 32 bytes, got ${y.length}`);
  }
  const v = BigInt(u8aToHex(y));
  if (v === 0n || v >= SECP256K1_N) {
    throw new Error("PTLC witness is not a scalar in [1, n)");
  }
}

/** Derive the point lock for a given 32-byte scalar witness `y` (0x-hex or bytes). */
export function pointLockFromWitness(witness: string | Uint8Array): PointLock {
  const y = typeof witness === "string" ? hexToU8a(witness) : witness;
  assertScalarInRange(y);
  // `compressed(y·G)` — byte-identical to the on-chain k256 encoding.
  const statement = secp256k1.Point.BASE.multiply(BigInt(u8aToHex(y))).toBytes(true);
  return { witness: u8aToHex(y), statement: u8aToHex(statement) };
}

/** Mint a fresh random point lock `(y, Y=y·G)`. */
export function generatePointLock(): PointLock {
  // Rejection-sample a valid scalar, testing the draw inline rather than by catching
  // `pointLockFromWitness`. A bare `catch` here also swallows `randomU8a`'s refusal on a
  // runtime with no Web Crypto CSPRNG, and retrying *that* forever turns the loud failure
  // `hex.ts` raises on purpose into a synchronous spin that no timer, signal handler or
  // `await` can interrupt. `generateHashLock` and `generateSalt` let the same refusal
  // through; this was the one generator that did not.
  //
  // Bounded for the same reason: a draw lands outside [1, n) with probability under 2^-128,
  // so exhausting these attempts means the CSPRNG is broken, not that we were unlucky.
  for (let attempt = 0; attempt < 8; attempt++) {
    const y = randomU8a(32);
    const v = BigInt(u8aToHex(y));
    if (v === 0n || v >= SECP256K1_N) continue;
    return pointLockFromWitness(y);
  }
  throw new Error("tclk: CSPRNG returned no scalar in [1, n) in 8 draws");
}

/** True iff `witness` (y) is the discrete-log of `statement` (Y): `compressed(y·G) == Y`. */
export function verifyPointWitness(statement: string, witness: string | Uint8Array): boolean {
  try {
    const derived = pointLockFromWitness(witness);
    return derived.statement.toLowerCase() === statement.toLowerCase();
  } catch {
    return false;
  }
}

/** A valid SEC1-compressed secp256k1 point: 33 bytes, prefix 0x02/0x03, on the curve. */
export function isValidPointStatement(statement: string): boolean {
  if (!isHex(statement)) return false;
  const bytes = hexToU8a(statement);
  if (bytes.length !== 33 || (bytes[0] !== 0x02 && bytes[0] !== 0x03)) return false;
  // Length+prefix is not enough: the x-coordinate must actually lie on the curve, or
  // `open_escrow` would accept the policy here and revert on-chain (the pallet's
  // `decode_point` → `InvalidPointStatement`), burning fees. Parse the SEC1 point so
  // the client-side check matches the on-chain one (fail-closed).
  try {
    secp256k1.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}
