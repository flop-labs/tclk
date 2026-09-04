// SPDX-License-Identifier: Apache-2.0
//
// Arbitration primitives that need no new cryptography: commitments for a commit–reveal
// vote, and secret splitting for a unanimous panel (SPEC §8.2, §8.3).
//
// Neither of these makes a rail enforce a verdict — they change who holds the secret and
// when a vote becomes visible, nothing more. Read §8.5 before building on them.
//
// k-of-n is deliberately NOT here. That needs secret sharing with Lagrange interpolation
// or threshold signatures, which is materially easier to get subtly wrong than anything
// in this file; use an audited implementation. Everything below is sha256, XOR, and
// addition mod the curve order.

import { sha256 } from "@noble/hashes/sha2.js";

import { TCLK_DOMAIN } from "./frames.js";
import { hexToU8a, randomU8a, stringToU8a, u8aToHex } from "./hex.js";
import { SECP256K1_N } from "./points.js";

const HEX32 = /^0x[0-9a-f]{64}$/;

/**
 * Characters technocore rewrites to a space before it stores a message: control,
 * format, line- and paragraph-separator. The same hazard `encodeFrame` refuses to
 * emit, reached by a different path — SPEC 8.3 opens a commitment by posting the
 * verdict into a room, so the verdict makes that round trip too.
 *
 * Deliberately narrower than the frame guard's printable-ASCII rule: a frame line is
 * ASCII because canonical JSON escapes it, but a verdict is hashed and posted raw, and
 * a visible non-ASCII verdict ("si", "\u306f\u3044") survives the venue untouched.
 * Only the invisible classes are a problem.
 */
const VENUE_REWRITES = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function requireSecret(value: string, name: string): Uint8Array {
  if (!HEX32.test(value)) throw new Error(`tclk: ${name} must be 32 bytes of 0x-hex`);
  return hexToU8a(value);
}

/** A fresh 32-byte salt. A commitment without one is a dictionary lookup, not a secret. */
export function generateSalt(): string {
  return u8aToHex(randomU8a(32));
}

/**
 * A juror's sealed vote: `sha256(domain|commit|contract|verdict|salt)`.
 *
 * The contract id is inside the hash on purpose. Without it a commitment made for one deal
 * could be replayed into another — the same lifting the frame signatures prevent at the
 * transport layer, and worth preventing here too, since a juror's verdict is exactly the
 * kind of thing an adversary would want to move between contracts.
 *
 * The salt is what makes it sealed. Verdicts come from a tiny set ("yes", "no"), so a
 * commitment over the verdict alone is trivially brute-forced and hides nothing.
 */
export function voteCommitment(contract: string, verdict: string, salt: string): string {
  if (!HEX32.test(contract)) throw new Error("tclk: contract must be a 0x-hex contract id");
  if (verdict.length === 0) throw new Error("tclk: verdict must not be empty");
  if (verdict.includes("|")) throw new Error("tclk: verdict must not contain '|'");
  // A verdict carrying one of these commits fine and can then never be reopened: the
  // venue swaps it for a space in the reveal round, so the string that comes back is
  // not the string that was hashed. Refuse at commit time rather than strand the vote.
  if (VENUE_REWRITES.test(verdict)) {
    throw new Error("tclk: verdict must not contain characters the venue rewrites");
  }
  requireSecret(salt, "salt");
  return u8aToHex(
    sha256(stringToU8a(`${TCLK_DOMAIN}|commit|${contract}|${verdict}|${salt}`)),
  );
}

/**
 * Check a revealed vote against its commitment. Fail-closed: a malformed reveal is a
 * mismatch, never a throw, because these arrive as room messages from other agents.
 */
export function verifyVoteCommitment(
  commitment: string,
  contract: string,
  verdict: string,
  salt: string,
): boolean {
  try {
    return voteCommitment(contract, verdict, salt) === commitment.toLowerCase();
  } catch {
    return false;
  }
}

// ── Unanimous panels: split the secret so every holder must release ──────────
//
// n-of-n only. Every share is required, so one juror going quiet blocks the claim and the
// deal refunds at its deadline — strong agreement, weak liveness. Pick it when a wrong
// payment costs more than a stalled one.

function requireParts(parts: number): void {
  if (!Number.isInteger(parts) || parts < 2) {
    throw new Error("tclk: a split needs at least 2 parts");
  }
}

/**
 * Split a hash-lock preimage into `parts` XOR shares. Any subset short of all of them
 * reveals nothing about the preimage.
 */
export function splitSecret(preimage: string, parts: number): string[] {
  const secret = requireSecret(preimage, "preimage");
  requireParts(parts);
  const shares: Uint8Array[] = [];
  const last = secret.slice();
  for (let i = 0; i < parts - 1; i += 1) {
    const share = randomU8a(32);
    for (let b = 0; b < 32; b += 1) last[b] ^= share[b];
    shares.push(share);
  }
  shares.push(last);
  return shares.map(u8aToHex);
}

/** Recombine XOR shares into the preimage. Order does not matter. */
export function combineSecret(shares: readonly string[]): string {
  requireParts(shares.length);
  const out = new Uint8Array(32);
  for (const share of shares) {
    const bytes = requireSecret(share, "share");
    for (let b = 0; b < 32; b += 1) out[b] ^= bytes[b];
  }
  return u8aToHex(out);
}

function scalar(value: string, name: string): bigint {
  requireSecret(value, name);
  const v = BigInt(value);
  if (v <= 0n || v >= SECP256K1_N) throw new Error(`tclk: ${name} is not a scalar in [1, n)`);
  return v;
}

/**
 * Split a point-lock witness into `parts` additive shares: `y = Σ yᵢ mod n`. The panel's
 * shares sum to the witness, so the same `Point(Y)` opens — the settlement layer never
 * learns a panel was involved.
 *
 * Shares are resampled until each is a valid scalar in [1, n) and they sum correctly; the
 * retry is for the negligible draw that lands on zero, not a correctness crutch.
 */
export function splitWitness(witness: string, parts: number): string[] {
  const y = scalar(witness, "witness");
  requireParts(parts);
  for (;;) {
    const shares: bigint[] = [];
    let sum = 0n;
    for (let i = 0; i < parts - 1; i += 1) {
      const s = BigInt(u8aToHex(randomU8a(32))) % SECP256K1_N;
      shares.push(s);
      sum = (sum + s) % SECP256K1_N;
    }
    const last = (((y - sum) % SECP256K1_N) + SECP256K1_N) % SECP256K1_N;
    shares.push(last);
    if (shares.every((s) => s > 0n && s < SECP256K1_N)) {
      return shares.map((s) => "0x" + s.toString(16).padStart(64, "0"));
    }
  }
}

/** Recombine additive shares into the witness: `Σ yᵢ mod n`. Order does not matter. */
export function combineWitness(shares: readonly string[]): string {
  requireParts(shares.length);
  let sum = 0n;
  for (const share of shares) sum = (sum + scalar(share, "share")) % SECP256K1_N;
  if (sum === 0n) throw new Error("tclk: shares sum to zero, which is not a valid witness");
  return "0x" + sum.toString(16).padStart(64, "0");
}
