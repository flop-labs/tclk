import { describe, expect, it } from "vitest";

import {
  MemoryRail,
  MemoryNoteStore,
  PaperRail,
  applyFrame,
  generateHashLock,
  lockTerms,
  makeAccept,
  makeOffer,
  openContract,
  type LockTerms,
  type SettlementRail,
} from "../src/index.js";

const PAYER_DID = "did:key:z6Mk" + "f".repeat(44);
const PAYEE_DID = "did:key:z6Mk" + "g".repeat(44);

const T0 = 1_756_700_000_000;
const CLAIM_BY = T0 + 3_600_000;
const REFUND_AFTER = T0 + 7_200_000;

type RailFixture = {
  rail: SettlementRail;
  setNow: (now: number) => void;
};

function acceptedTerms(railId: SettlementRail["id"]): { terms: LockTerms; secret: string } {
  const lock = generateHashLock();

  const offer = makeOffer({
    from: PAYER_DID,
    role: "payer",
    lock: "hash",
    amount: "1000000",
    asset: "PAPER",
    rails: [railId],
    claimByMs: CLAIM_BY,
    refundAfterMs: REFUND_AFTER,
    expiresMs: T0 + 600_000,
    nonce: "9f2c81d04c9e1f7a",
  });

  const accept = makeAccept(offer, {
    from: PAYEE_DID,
    statement: lock.hash,
  });

  const step = applyFrame(openContract(offer), accept, T0);
  expect(step.ok).toBe(true);

  return {
    terms: lockTerms(step.state),
    secret: lock.preimage,
  };
}

function settlementRailConformance(
  name: string,
  factory: () => RailFixture,
) {
  describe(`${name} — SettlementRail conformance`, () => {
    it("verifies an exact live lock", async () => {
      const { rail } = factory();
      const { terms } = acceptedTerms(rail.id);

      const ref = await rail.lock(terms);

      expect(await rail.verifyLock(terms, ref)).toBe(true);
    });

    const mutations: Array<{
      field: keyof LockTerms;
      mutate: (terms: LockTerms) => LockTerms;
    }> = [
      {
        field: "contract",
        mutate: (t) => ({ ...t, contract: "0x" + "ab".repeat(32) }),
      },
      {
        field: "lock",
        mutate: (t) => ({ ...t, lock: t.lock === "hash" ? "point" : "hash" }),
      },
      {
        field: "statement",
        mutate: (t) => ({ ...t, statement: "0x" + "cd".repeat(32) }),
      },
      {
        field: "amount",
        mutate: (t) => ({ ...t, amount: "1000001" }),
      },
      {
        field: "asset",
        mutate: (t) => ({ ...t, asset: "OTHER" }),
      },
      {
        field: "payer",
        mutate: (t) => ({ ...t, payer: PAYEE_DID }),
      },
      {
        field: "payee",
        mutate: (t) => ({ ...t, payee: PAYER_DID }),
      },
      {
        field: "claimByMs",
        mutate: (t) => ({ ...t, claimByMs: t.claimByMs + 1 }),
      },
      {
        field: "refundAfterMs",
        mutate: (t) => ({ ...t, refundAfterMs: t.refundAfterMs + 1 }),
      },
    ];

    for (const { field, mutate } of mutations) {
      it(`rejects a lock whose ${field} differs`, async () => {
        const { rail } = factory();
        const { terms } = acceptedTerms(rail.id);

        const ref = await rail.lock(terms);
        const changed = mutate(terms);

        expect(await rail.verifyLock(changed, ref)).toBe(false);
      });
    }

    it("refuses a duplicate lock for the same contract", async () => {
      const { rail } = factory();
      const { terms } = acceptedTerms(rail.id);

      await rail.lock(terms);

      await expect(rail.lock(terms)).rejects.toThrow();
    });

    it("rejects a wrong claim secret", async () => {
      const { rail } = factory();
      const { terms } = acceptedTerms(rail.id);

      const ref = await rail.lock(terms);

      await expect(
        rail.claim(ref, "0x" + "00".repeat(32)),
      ).rejects.toThrow();
    });

    it("claims with the correct secret strictly before refundAfterMs", async () => {
      const { rail } = factory();
      const { terms, secret } = acceptedTerms(rail.id);

      const ref = await rail.lock(terms);

      await rail.claim(ref, secret);

      expect(await rail.verifyLock(terms, ref)).toBe(false);
    });

    it("rejects refund before refundAfterMs", async () => {
      const { rail } = factory();
      const { terms } = acceptedTerms(rail.id);

      const ref = await rail.lock(terms);

      await expect(rail.refund(ref)).rejects.toThrow();
    });

    it("refunds at refundAfterMs", async () => {
      const { rail, setNow } = factory();
      const { terms } = acceptedTerms(rail.id);

      const ref = await rail.lock(terms);

      setNow(REFUND_AFTER);
      await rail.refund(ref);

      expect(await rail.verifyLock(terms, ref)).toBe(false);
    });

    it("rejects claim at refundAfterMs", async () => {
      const { rail, setNow } = factory();
      const { terms, secret } = acceptedTerms(rail.id);

      const ref = await rail.lock(terms);

      setNow(REFUND_AFTER);

      await expect(rail.claim(ref, secret)).rejects.toThrow();
    });
  });
}

settlementRailConformance("MemoryRail", () => {
  let now = T0;
  return {
    rail: new MemoryRail("memory", () => now),
    setNow: (next) => {
      now = next;
    },
  };
});


settlementRailConformance("PaperRail", () => {
  let now = T0;
  const notes = new MemoryNoteStore();

  return {
    rail: new PaperRail(notes, () => now),
    setNow: (next) => {
      now = next;
    },
  };
});
