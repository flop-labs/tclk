/**
 * Tests for the arbitration primitives (SPEC §8.2, §8.3).
 *
 * The properties that matter are the ones an adversary would attack: a commitment must
 * bind to its contract so a verdict cannot be lifted between deals, it must hide a verdict
 * drawn from a two-element set, and a split must be useless until every share is present.
 */

import { describe, it, expect } from "vitest";

import {
  combineSecret,
  combineWitness,
  generateHashLock,
  generatePointLock,
  generateSalt,
  hashLockFromPreimage,
  pointLockFromWitness,
  splitSecret,
  splitWitness,
  verifyVoteCommitment,
  voteCommitment,
} from "../src/index.js";

const CONTRACT = "0x" + "ab".repeat(32);
const OTHER_CONTRACT = "0x" + "cd".repeat(32);

describe("commit–reveal voting", () => {
  it("round-trips a verdict and rejects every altered reveal", () => {
    const salt = generateSalt();
    const commitment = voteCommitment(CONTRACT, "yes", salt);

    expect(verifyVoteCommitment(commitment, CONTRACT, "yes", salt)).toBe(true);
    expect(verifyVoteCommitment(commitment, CONTRACT, "no", salt)).toBe(false);
    expect(verifyVoteCommitment(commitment, CONTRACT, "yes", generateSalt())).toBe(false);
    expect(verifyVoteCommitment("0x" + "00".repeat(32), CONTRACT, "yes", salt)).toBe(false);
  });

  it("binds to the contract, so a verdict cannot be lifted to another deal", () => {
    const salt = generateSalt();
    const commitment = voteCommitment(CONTRACT, "yes", salt);

    expect(verifyVoteCommitment(commitment, OTHER_CONTRACT, "yes", salt)).toBe(false);
    expect(voteCommitment(OTHER_CONTRACT, "yes", salt)).not.toBe(commitment);
  });

  it("hides a verdict drawn from a tiny set — the salt is what does that", () => {
    // Same verdict, different salts: an observer holding the commitment cannot tell which
    // of "yes"/"no" it is, because it cannot recompute either without the salt.
    const a = voteCommitment(CONTRACT, "yes", generateSalt());
    const b = voteCommitment(CONTRACT, "yes", generateSalt());
    expect(a).not.toBe(b);
    expect(generateSalt()).not.toBe(generateSalt());
  });

  it("is fail-closed on malformed input rather than throwing at a reader", () => {
    const salt = generateSalt();
    expect(verifyVoteCommitment("nonsense", CONTRACT, "yes", salt)).toBe(false);
    expect(verifyVoteCommitment(voteCommitment(CONTRACT, "yes", salt), "bad", "yes", salt)).toBe(false);
    expect(verifyVoteCommitment(voteCommitment(CONTRACT, "yes", salt), CONTRACT, "yes", "0x00")).toBe(false);

    // The separator cannot be smuggled into a verdict: "a|b" and a verdict "a" with a
    // salt-shaped tail must not collide.
    expect(() => voteCommitment(CONTRACT, "yes|no", salt)).toThrow(/'\|'/);
    expect(() => voteCommitment(CONTRACT, "", salt)).toThrow(/must not be empty/);
  });
});

describe("unanimous panels — splitting the secret", () => {
  it("recombines a hash-lock preimage, and the lock still opens", () => {
    const lock = generateHashLock();
    const shares = splitSecret(lock.preimage, 3);

    expect(shares).toHaveLength(3);
    expect(combineSecret(shares)).toBe(lock.preimage);
    // Order does not matter, and the reconstructed preimage opens the same statement.
    expect(combineSecret([...shares].reverse())).toBe(lock.preimage);
    expect(hashLockFromPreimage(combineSecret(shares)).hash).toBe(lock.hash);
  });

  it("recombines a point-lock witness, and the same statement opens", () => {
    const lock = generatePointLock();
    const shares = splitWitness(lock.witness, 4);

    expect(shares).toHaveLength(4);
    expect(combineWitness(shares)).toBe(lock.witness);
    expect(combineWitness([...shares].reverse())).toBe(lock.witness);
    // The panel is invisible to the rail: the reconstructed witness derives the very same
    // Point(Y) the contract committed to.
    expect(pointLockFromWitness(combineWitness(shares)).statement).toBe(lock.statement);
  });

  it("is useless until every share is present", () => {
    const lock = generateHashLock();
    const shares = splitSecret(lock.preimage, 3);

    // Any proper subset recombines to something that is NOT the preimage — so it does not
    // open the lock. That is the whole security property of an n-of-n split.
    expect(combineSecret(shares.slice(0, 2))).not.toBe(lock.preimage);
    expect(hashLockFromPreimage(combineSecret(shares.slice(0, 2))).hash).not.toBe(lock.hash);

    const ptlc = generatePointLock();
    const witnessShares = splitWitness(ptlc.witness, 3);
    expect(combineWitness(witnessShares.slice(0, 2))).not.toBe(ptlc.witness);
  });

  it("rejects degenerate splits and malformed shares", () => {
    const lock = generateHashLock();
    expect(() => splitSecret(lock.preimage, 1)).toThrow(/at least 2 parts/);
    expect(() => splitSecret("0x1234", 2)).toThrow(/32 bytes/);
    expect(() => combineSecret(["0x00"])).toThrow(/at least 2 parts/);
    expect(() => combineSecret([lock.preimage, "not-hex"])).toThrow(/32 bytes/);
    expect(() => splitWitness("0x" + "00".repeat(32), 2)).toThrow(/scalar in \[1, n\)/);
    expect(() => combineWitness([lock.preimage, "0x" + "00".repeat(32)])).toThrow(/scalar/);
  });

  it("produces shares that are each a usable scalar", () => {
    // A share landing on zero would be an invalid scalar and would leak that a share is
    // the identity; the splitter resamples rather than emitting one.
    for (let i = 0; i < 20; i += 1) {
      for (const share of splitWitness(generatePointLock().witness, 3)) {
        expect(share).toMatch(/^0x[0-9a-f]{64}$/);
        expect(BigInt(share) > 0n).toBe(true);
      }
    }
  });
});
