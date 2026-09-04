/**
 * Tests for the paper rail.
 *
 * It settles nothing, so what is worth testing is that it enforces the same predicates a
 * real rail must — a client written against it is written correctly — and that every read
 * out of its world-writable note surface is fail-closed, since a stranger can put anything
 * there.
 */

import { describe, it, expect } from "vitest";

import {
  MemoryNoteStore,
  PaperRail,
  PAPER_RECORD_PREFIX,
  decodePaperRecord,
  encodePaperRecord,
  paperNote,
  applyFrame,
  generateHashLock,
  generatePointLock,
  lockTerms,
  makeAccept,
  makeOffer,
  openContract,
  type LockTerms,
} from "../src/index.js";

const PAYER_DID = "did:key:z6Mk" + "f".repeat(44);
const PAYEE_DID = "did:key:z6Mk" + "g".repeat(44);
const T0 = 1_756_700_000_000;
const REFUND_AFTER = T0 + 7_200_000;

/** Drive offer → accept and project the rail terms, the way a real client would. */
function terms(lock: "hash" | "point" = "hash") {
  const secret = lock === "hash" ? generateHashLock() : generatePointLock();
  const statement = "hash" in secret ? secret.hash : secret.statement;
  const key = "0x02" + "7".repeat(64);
  const offer = makeOffer({
    from: PAYER_DID,
    role: "payer",
    lock,
    amount: "1000000",
    asset: "PAPER",
    rails: ["paper"],
    claimByMs: T0 + 3_600_000,
    refundAfterMs: REFUND_AFTER,
    expiresMs: T0 + 600_000,
    nonce: "9f2c81d04c9e1f7a",
    ...(lock === "point" ? { paymentKey: key } : {}),
  } as Parameters<typeof makeOffer>[0]);
  const accept = makeAccept(offer, {
    from: PAYEE_DID,
    statement,
    ...(lock === "point" ? { paymentKey: key } : {}),
  });
  const state = applyFrame(openContract(offer), accept, T0).state;
  return {
    terms: lockTerms(state),
    secret: "preimage" in secret ? secret.preimage : secret.witness,
  };
}

function railAt(now = T0) {
  let clock = now;
  const notes = new MemoryNoteStore();
  return { notes, rail: new PaperRail(notes, () => clock), setNow: (t: number) => (clock = t) };
}

describe("paper rail — the predicates a real rail must enforce", () => {
  it("locks once, then claims with a secret that opens the statement", async () => {
    const { rail, notes } = railAt();
    const deal = terms();

    const ref = await rail.lock(deal.terms);
    expect(await rail.verifyLock(deal.terms, ref)).toBe(true);

    // The stored line is readable without a parser — that is the point of the format.
    const { ns, key } = paperNote(deal.terms.contract);
    expect(notes.raw(ns, key)).toBe(
      `${PAPER_RECORD_PREFIX} locked hash ${deal.terms.statement} ${REFUND_AFTER}`,
    );

    await expect(rail.claim(ref, "0x" + "00".repeat(32))).rejects.toThrow(/secret/);
    await rail.claim(ref, deal.secret);
    expect((await rail.read(ref))?.status).toBe("claimed");
    await expect(rail.refund(ref)).rejects.toThrow(/claimed/);
  });

  it("refuses a second lock on the same contract", async () => {
    const { rail } = railAt();
    const deal = terms();
    await rail.lock(deal.terms);
    await expect(rail.lock(deal.terms)).rejects.toThrow(/already has a record/);
  });

  it("claims strictly before refundAfterMs, refunds only at or after it", async () => {
    const { rail, setNow } = railAt();
    const deal = terms();
    const ref = await rail.lock(deal.terms);

    await expect(rail.refund(ref)).rejects.toThrow(/before refundAfterMs/);
    setNow(REFUND_AFTER);
    await expect(rail.claim(ref, deal.secret)).rejects.toThrow(/after refundAfterMs/);
    await rail.refund(ref);
    expect((await rail.read(ref))?.status).toBe("refunded");
    expect(await rail.verifyLock(deal.terms, ref)).toBe(false);
  });

  it("will not lock into an already-open refund window", async () => {
    const { rail } = railAt(REFUND_AFTER);
    await expect(rail.lock(terms().terms)).rejects.toThrow(/already-open refund window/);
  });

  it("carries the point-lock path too — the witness opens it", async () => {
    const { rail } = railAt();
    const deal = terms("point");
    const ref = await rail.lock(deal.terms);
    await rail.claim(ref, deal.secret);
    expect((await rail.read(ref))?.status).toBe("claimed");
  });
});

describe("paper rail — reads are anonymous input", () => {
  it("verifyLock is fail-closed on a mismatched ref and on tampered terms", async () => {
    const { rail } = railAt();
    const deal = terms();
    const ref = await rail.lock(deal.terms);

    expect(await rail.verifyLock(deal.terms, "0x" + "ab".repeat(32))).toBe(false);
    const moved: LockTerms = { ...deal.terms, refundAfterMs: REFUND_AFTER + 1 };
    expect(await rail.verifyLock(moved, ref)).toBe(false);
  });

  it("a stranger's line in the namespace reads as absent, never as a lock", async () => {
    const { rail, notes } = railAt();
    const deal = terms();
    const { ns, key } = paperNote(deal.terms.contract);

    for (const junk of [
      "locked",
      "tclkpaper1 locked hash",
      "tclkpaper1 exploded hash 0x" + "ab".repeat(32) + ` ${REFUND_AFTER}`,
      "tclkpaper2 locked hash 0x" + "ab".repeat(32) + ` ${REFUND_AFTER}`,
      "tclkpaper1 locked sha256 0x" + "ab".repeat(32) + ` ${REFUND_AFTER}`,
      "tclkpaper1 locked hash 0xnothex " + REFUND_AFTER,
      "tclkpaper1 locked hash 0x" + "ab".repeat(32) + " 0",
      // A claimed record must carry the secret, and only a claimed one may.
      "tclkpaper1 claimed hash 0x" + "ab".repeat(32) + ` ${REFUND_AFTER}`,
      "tclkpaper1 locked hash 0x" + "ab".repeat(32) + ` ${REFUND_AFTER} 0x` + "cd".repeat(32),
    ]) {
      await notes.set(ns, key, junk);
      expect(decodePaperRecord(junk), junk).toBeNull();
      expect(await rail.read(deal.terms.contract)).toBeNull();
      expect(await rail.verifyLock(deal.terms, deal.terms.contract)).toBe(false);
    }
  });

  it("rejects statements that do not fit their declared lock kind", () => {
    for (const malformed of [
      `tclkpaper1 locked hash 0x${"ab".repeat(33)} ${REFUND_AFTER}`,
      `tclkpaper1 locked hash 0x${"a".repeat(65)} ${REFUND_AFTER}`,
      `tclkpaper1 locked point 0x${"ab".repeat(32)} ${REFUND_AFTER}`,
      `tclkpaper1 locked point 0x04${"11".repeat(32)} ${REFUND_AFTER}`,
      `tclkpaper1 locked point 0x02${"ff".repeat(32)} ${REFUND_AFTER}`,
    ]) {
      expect(decodePaperRecord(malformed), malformed).toBeNull();
    }
  });

  it("round-trips every record shape it emits", () => {
    const statement = "0x" + "ab".repeat(32);
    for (const record of [
      { status: "locked", lock: "hash", statement, refundAfterMs: REFUND_AFTER },
      { status: "refunded", lock: "point", statement: "0x02" + "7".repeat(64), refundAfterMs: 1 },
      {
        status: "claimed",
        lock: "hash",
        statement,
        refundAfterMs: REFUND_AFTER,
        secret: "0x" + "cd".repeat(32),
      },
    ] as const) {
      expect(decodePaperRecord(encodePaperRecord(record))).toEqual(record);
    }
  });

  it("refuses to advance a record that changed under it", async () => {
    const { rail, notes } = railAt();
    const deal = terms();
    const ref = await rail.lock(deal.terms);
    const { ns, key } = paperNote(ref);

    // A stranger rewrites the note between our read and our write. The CAS catches the
    // one case it can — our own stale view — and cannot fence the stranger at all.
    const rail2 = new PaperRail(
      {
        get: async () => notes.raw(ns, key) ?? null,
        set: async () => false, // the venue answers 409: someone else moved it first
      },
      () => T0,
    );
    await expect(rail2.claim(ref, deal.secret)).rejects.toThrow(/changed under us/);
  });

  it("rejects a malformed contract id rather than sharding garbage", () => {
    expect(() => paperNote("nonsense")).toThrow(/malformed contract id/);
  });

  it("stays fail-closed and readable on non-canonical case", async () => {
    const { rail } = railAt();
    const deal = terms();

    // Malformed ids read as absent instead of throwing out of a polling loop.
    await expect(rail.verifyLock({ ...deal.terms, contract: "0xZZZ" }, "0xZZZ")).resolves.toBe(false);
    await expect(rail.read("0xZZZ")).resolves.toBeNull();

    // An uppercase statement never reaches the note: honest terms are already
    // lowercase via lockTerms(), anything else is a hand-built caller bug.
    const upperStatement = deal.terms.statement.toUpperCase().replace("0X", "0x");
    await expect(rail.lock({ ...deal.terms, statement: upperStatement })).rejects.toThrow(
      /does not fit its lock kind/,
    );

    // verifySecret accepts uppercase, so claim does too — but it stores the
    // canonical lowercase spelling, keeping a successful claim auditable.
    const ref = await rail.lock(deal.terms);
    const upperSecret = deal.secret.toUpperCase().replace("0X", "0x");
    await rail.claim(ref, upperSecret);
    const record = await rail.read(ref);
    expect(record?.status).toBe("claimed");
    expect(record?.secret).toBe(deal.secret.toLowerCase());
  });
});
