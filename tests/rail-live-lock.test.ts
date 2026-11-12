// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  hashLockFromPreimage,
  MemoryNoteStore,
  MemoryRail,
  PaperRail,
  pointLockFromWitness,
  type LockTerms,
} from "../src/index.js";

const T0 = 1_756_700_000_000;
const SECRET = "0x" + "01".repeat(32);

function terms(lock: "hash" | "point"): LockTerms {
  return {
    contract: "0x" + "ab".repeat(32),
    lock,
    statement: lock === "hash"
      ? hashLockFromPreimage(SECRET).hash
      : pointLockFromWitness(SECRET).statement,
    amount: "1000000",
    asset: "PAPER",
    payer: "did:key:z6Mk" + "f".repeat(44),
    payee: "did:key:z6Mk" + "g".repeat(44),
    claimByMs: T0 + 3_600_000,
    refundAfterMs: T0 + 7_200_000,
  };
}

for (const id of ["memory", "paper"] as const) {
  describe(`${id} live-lock verification`, () => {
    function setup() {
      let now = T0;
      const rail = id === "memory"
        ? new MemoryRail("memory", () => now)
        : new PaperRail(new MemoryNoteStore(), () => now);
      return { rail, setNow: (next: number) => { now = next; } };
    }

    for (const lock of ["hash", "point"] as const) {
      it(`stops verifying an expired ${lock} lock before any refund`, async () => {
        const { rail, setNow } = setup();
        const deal = terms(lock);
        const ref = await rail.lock(deal);

        setNow(deal.claimByMs);
        expect(await rail.verifyLock(deal, ref)).toBe(true);
        setNow(deal.refundAfterMs - 1);
        expect(await rail.verifyLock(deal, ref)).toBe(true);
        setNow(deal.refundAfterMs);
        expect(await rail.verifyLock(deal, ref)).toBe(false);
        await expect(rail.claim(ref, SECRET)).rejects.toThrow(/after refundAfterMs/);
        setNow(deal.refundAfterMs + 1);
        expect(await rail.verifyLock(deal, ref)).toBe(false);

        // Verification does not execute a refund or consume the still-locked record.
        await rail.refund(ref);
        expect(await rail.verifyLock(deal, ref)).toBe(false);
      });
    }

    it("does not certify a live lock from an invalid clock reading", async () => {
      const { rail, setNow } = setup();
      const deal = terms("hash");
      const ref = await rail.lock(deal);

      for (const now of [NaN, Infinity, -Infinity, -1]) {
        setNow(now);
        expect(await rail.verifyLock(deal, ref)).toBe(false);
      }
      setNow(0);
      expect(await rail.verifyLock(deal, ref)).toBe(true);
      setNow(T0);
      await rail.claim(ref, SECRET);
      expect(await rail.verifyLock(deal, ref)).toBe(false);
    });
  });
}

it("PaperRail checks expiry after the asynchronous note read", async () => {
  const notes = new MemoryNoteStore();
  const deal = terms("hash");
  let now = T0;
  const rail = new PaperRail({
    get: async (ns, key) => {
      const value = await notes.get(ns, key);
      now = deal.refundAfterMs;
      return value;
    },
    set: (ns, key, value, condition) => notes.set(ns, key, value, condition),
  }, () => now);
  const ref = await rail.lock(deal);

  expect(await rail.verifyLock(deal, ref)).toBe(false);
  await rail.refund(ref);
  expect((await rail.read(ref))?.status).toBe("refunded");
});
