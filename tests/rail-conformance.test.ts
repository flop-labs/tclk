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
  paperNote,
  type LockTerms,
  type SettlementRail,
} from "../src/index.js";
import { PaperRail as PaperRailV1 } from "./fixtures/paper-rail-v1.js";

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

// Fixed compatibility vector: both versions use the same contract, statement,
// terms and note location. Isolate terminal branches rather than overwrite a deal.
const migrationTerms: LockTerms = {
  contract: "0x" + "ab".repeat(32),
  lock: "hash",
  statement: "0x02d449a31fbb267c8f352e9968a79e3e5fc95c1bbeaa502fd6454ebde5a4bedc",
  amount: "1000000",
  asset: "PAPER",
  payer: PAYER_DID,
  payee: PAYEE_DID,
  claimByMs: CLAIM_BY,
  refundAfterMs: REFUND_AFTER,
};
const migrationSecret = "0x" + "11".repeat(32);
const migrationLines = {
  v1: `tclkpaper1 locked hash ${migrationTerms.statement} 1756707200000`,
  v2: `tclkpaper2 locked hash ${migrationTerms.statement} 1000000 PAPER ${PAYER_DID} ${PAYEE_DID} 1756703600000 1756707200000`,
};

describe("PaperRail — same-contract v1/v2 migration conformance", () => {
  for (const storedVersion of ["v1", "v2"] as const) {
    for (const readerVersion of ["v1", "v2"] as const) {
      for (const operation of ["claim", "refund"] as const) {
        it(`${readerVersion} reader / ${storedVersion} record / ${operation}`, async () => {
          let now = T0;
          const notes = new MemoryNoteStore();
          const rails = {
            v1: new PaperRailV1(notes, () => now),
            v2: new PaperRail(notes, () => now),
          };
          const ref = migrationTerms.contract;
          const { ns, key } = paperNote(ref);

          // Exercise the actual writers, and pin their exact emitted bytes.
          expect(await rails[storedVersion].lock(migrationTerms)).toBe(ref);
          const lockedLine = migrationLines[storedVersion];
          expect(notes.raw(ns, key)).toBe(lockedLine);

          const reader = rails[readerVersion];
          const unreadable = readerVersion === "v1" && storedVersion === "v2";
          const record = await reader.read(ref);
          if (unreadable) expect(record).toBeNull();
          else expect(record?.status).toBe("locked");
          expect(await reader.verifyLock(migrationTerms, ref)).toBe(
            readerVersion === storedVersion,
          );

          // Neither version can replace a record, including an unreadable one.
          for (const rail of [rails.v1, rails.v2]) {
            await expect(rail.lock(migrationTerms)).rejects.toThrow(
              new Error(`tclk: paper rail already has a record for ${ref}`),
            );
            expect(notes.raw(ns, key)).toBe(lockedLine);
          }

          if (operation === "refund") now = REFUND_AFTER;
          const advance = (rail: PaperRail | PaperRailV1) => operation === "claim"
            ? rail.claim(ref, migrationSecret)
            : rail.refund(ref);

          if (unreadable) {
            await expect(advance(reader)).rejects.toThrow(
              new Error(`tclk: ${operation} on an unreadable paper record ${ref}`),
            );
            expect(notes.raw(ns, key)).toBe(lockedLine);
            // The failed old reader does not prevent recovery by an upgraded one.
            await advance(rails.v2);
          } else {
            await advance(reader);
          }

          const status = operation === "claim" ? "claimed" : "refunded";
          const terminalLine = lockedLine.replace(" locked ", ` ${status} `)
            + (operation === "claim" ? ` ${migrationSecret}` : "");
          expect(notes.raw(ns, key)).toBe(terminalLine);
          expect((await rails.v2.read(ref))?.status).toBe(status);
          if (storedVersion === "v1") {
            expect((await rails.v1.read(ref))?.status).toBe(status);
          } else {
            expect(await rails.v1.read(ref)).toBeNull();
          }
          for (const rail of [rails.v1, rails.v2]) {
            expect(await rail.verifyLock(migrationTerms, ref)).toBe(false);
          }
        });
      }
    }
  }
});
