/**
 * Tests for the paper rail.
 *
 * It settles nothing, so what is worth testing is that it enforces the same predicates a
 * real rail must — a client written against it is written correctly — and that every read
 * out of its world-writable note surface is fail-closed, since a stranger can put anything
 * there.
 */

import { describe, it, expect } from "vitest";

import { hexToU8a } from "../src/hex.js";
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

  it("refuses a claim it cannot record, and the lock stays claimable", async () => {
    const { rail, notes } = railAt();
    const deal = terms();
    const ref = await rail.lock(deal.terms);
    const { ns, key } = paperNote(ref);
    const locked = notes.raw(ns, key);

    // Both spellings open the statement — `verifySecret` decodes the secret through `isHex`,
    // which takes either hex case, and takes raw bytes from an untyped caller — but SPEC §3
    // spells a secret as 64 lowercase hex, which is the grammar decodePaperRecord enforces,
    // so neither can be written down.
    for (const [spelling, secret] of [
      ["uppercase hex", "0x" + deal.secret.slice(2).toUpperCase()],
      ["raw 32 bytes", hexToU8a(deal.secret)],
    ] as const) {
      const refused = await rail.claim(ref, secret as string).then(
        () => "resolved",
        (err: Error) => err.message,
      );
      expect(refused, spelling).toMatch(/refusing to write an unreadable paper record/);
      // Whatever catches this refusal logs it, so it names the status, not the secret.
      expect(refused.toLowerCase()).not.toContain(deal.secret.slice(2, 18));
      expect(notes.raw(ns, key)).toBe(locked);
    }

    await rail.claim(ref, deal.secret);
    expect((await rail.read(ref))?.status).toBe("claimed");
  });

  it("refuses to lock terms it cannot record, leaving the slot unspent", async () => {
    const { rail, notes } = railAt();
    const deal = terms();
    const { ns, key } = paperNote(deal.terms.contract);
    const shouted: LockTerms = {
      ...deal.terms,
      statement: "0x" + deal.terms.statement.slice(2).toUpperCase(),
    };

    // The first write spends the ifAbsent slot, so a line no reader can decode is terminal
    // for this rail: no later lock replaces it — only an unconditional note write can.
    await expect(rail.lock(shouted)).rejects.toThrow(/refusing to write an unreadable/);
    expect(notes.raw(ns, key)).toBeUndefined();
    expect(await rail.lock(deal.terms)).toBe(deal.terms.contract);
    expect(await rail.verifyLock(deal.terms, deal.terms.contract)).toBe(true);
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

  it("refuses to emit a line its own decoder would reject", () => {
    const statement = "0x" + "ab".repeat(32);
    const shouted = "0x" + "AB".repeat(32);
    // One check per field the emitter can spell in a way the grammar refuses: the
    // statement's hex case, a deadline that stringifies as `1e+21`, the secret's hex case.
    for (const record of [
      { status: "locked", lock: "hash", statement: shouted, refundAfterMs: REFUND_AFTER },
      { status: "locked", lock: "hash", statement, refundAfterMs: 1e21 },
      {
        status: "claimed",
        lock: "hash",
        statement,
        refundAfterMs: REFUND_AFTER,
        secret: "0x" + "CD".repeat(32),
      },
    ] as const) {
      expect(() => encodePaperRecord(record), JSON.stringify(record)).toThrow(
        /unreadable paper record/,
      );
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
});
