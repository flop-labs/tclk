// SPDX-License-Identifier: Apache-2.0
//
// tclk/1 lock primitives: the hash lock (HTLC leaf) and the secret checks the state
// machine and rails share. The point lock (PTLC leaf) is NOT re-implemented here —
// ./points.ts is the canonical source (byte-identical to the on-chain `Predicate::Point`)
// and is re-exported through the tclk barrel; adaptor signatures live in ./adaptor.ts.

import { sha256 } from "@noble/hashes/sha2.js";
import { hexToU8a, randomU8a, u8aToHex } from "./hex.js";
import { verifyPointWitness } from "./points.js";
import type { LockKind } from "./frames.js";

/** A hash lock: the public `hash` statement and its secret `preimage`, both 0x-hex. */
export interface HashLock {
  /** 32-byte preimage. Keep secret until the claim. */
  preimage: string;
  /** sha256(preimage) — safe to publish; the on-chain `Predicate::Hash` statement. */
  hash: string;
}

/** Derive the hash lock for a given 32-byte preimage (0x-hex or bytes). */
export function hashLockFromPreimage(preimage: string | Uint8Array): HashLock {
  const p = typeof preimage === "string" ? hexToU8a(preimage) : preimage;
  if (p.length !== 32) {
    throw new Error(`tclk: hash-lock preimage must be 32 bytes, got ${p.length}`);
  }
  return { preimage: u8aToHex(p), hash: u8aToHex(sha256(p)) };
}

/** Mint a fresh random hash lock. */
export function generateHashLock(): HashLock {
  return hashLockFromPreimage(randomU8a(32));
}

/** True iff `sha256(preimage) == hash`. Fail-closed: malformed input is false, never a throw. */
export function verifyHashPreimage(hash: string, preimage: string | Uint8Array): boolean {
  try {
    return hashLockFromPreimage(preimage).hash === hash.toLowerCase();
  } catch {
    return false;
  }
}

/** Check a revealed secret against a statement for either lock kind. Fail-closed boolean. */
export function verifySecret(lock: LockKind, statement: string, secret: string | Uint8Array): boolean {
  if (lock === "hash") return verifyHashPreimage(statement, secret);
  return verifyPointWitness(statement, secret);
}

/**
 * Payee-side deadline check before accepting an offer, fail-closed like
 * `validateTimelockStagger`: the claim window (now → claimByMs) must cover doing the
 * work and revealing, and the claim→refund gap must cover the rail observing the
 * reveal before the payer may refund. Both margins are the caller's risk tolerance —
 * there is no safe universal default, so none is supplied.
 */
export function validateDeadlines(
  offer: { claimByMs: number; refundAfterMs: number },
  nowMs: number,
  minClaimWindowMs: number,
  minRefundGapMs: number,
): boolean {
  if (minClaimWindowMs < 1 || minRefundGapMs < 1) return false;
  return (
    offer.claimByMs - nowMs >= minClaimWindowMs &&
    offer.refundAfterMs - offer.claimByMs >= minRefundGapMs
  );
}
