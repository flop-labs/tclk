import { describe, expect, it } from "vitest";
import {
  generateHashLock,
  hashLockFromPreimage,
  validateDeadlines,
  verifyHashPreimage,
  verifySecret,
} from "../src/locks.js";

describe("tclk: locks & deadlines verification", () => {
  describe("hashLockFromPreimage & generateHashLock", () => {
    it("should generate a valid 32-byte random hash lock", () => {
      const lock = generateHashLock();
      expect(lock.preimage).toMatch(/^0x[a-f0-9]{64}$/i);
      expect(lock.hash).toMatch(/^0x[a-f0-9]{64}$/i);
    });

    it("should throw error when preimage is not 32 bytes", () => {
      expect(() => hashLockFromPreimage("0x1234")).toThrow(
        /hash-lock preimage must be 32 bytes/
      );
    });
  });

  describe("verifyHashPreimage & verifySecret (fail-closed check)", () => {
    it("should correctly verify valid hash and preimage", () => {
      const lock = generateHashLock();
      expect(verifyHashPreimage(lock.hash, lock.preimage)).toBe(true);
      expect(verifySecret("hash", lock.hash, lock.preimage)).toBe(true);
    });

    it("should return false on malformed or mismatched inputs without throwing", () => {
      const lock = generateHashLock();
      expect(verifyHashPreimage(lock.hash, "0xbadpreimage")).toBe(false);
      expect(verifySecret("hash", lock.hash, "invalid")).toBe(false);
      expect(verifySecret("point", "invalid_statement", "invalid_secret")).toBe(false);
    });
  });

  describe("validateDeadlines edge cases", () => {
    const now = 100000;
    const minClaimWindow = 5000;
    const minRefundGap = 10000;

    it("should pass valid offer deadlines", () => {
      const offer = {
        claimByMs: now + minClaimWindow + 1000,
        refundAfterMs: now + minClaimWindow + 1000 + minRefundGap + 1000,
      };
      expect(validateDeadlines(offer, now, minClaimWindow, minRefundGap)).toBe(true);
    });

    it("should fail-close on invalid or unsafe numbers (NaN, Infinity, Negative)", () => {
      expect(
        validateDeadlines(
          { claimByMs: NaN, refundAfterMs: 200000 },
          now,
          minClaimWindow,
          minRefundGap
        )
      ).toBe(false);

      expect(
        validateDeadlines(
          { claimByMs: 150000, refundAfterMs: Infinity },
          now,
          minClaimWindow,
          minRefundGap
        )
      ).toBe(false);

      expect(
        validateDeadlines(
          { claimByMs: -100, refundAfterMs: 200000 },
          now,
          minClaimWindow,
          minRefundGap
        )
      ).toBe(false);
    });

    it("should fail when claim window or refund gap is too tight", () => {
      const tightOffer = {
        claimByMs: now + minClaimWindow - 1, // too short
        refundAfterMs: now + minClaimWindow + minRefundGap,
      };
      expect(validateDeadlines(tightOffer, now, minClaimWindow, minRefundGap)).toBe(false);
    });
  });
});
