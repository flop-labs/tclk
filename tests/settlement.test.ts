/**
 * Tests for the settlement view.
 *
 * The machine answers "what does the signed transcript establish". The view answers "what
 * did a rail confirm", and the whole point of it is the gap between the two: a room can say
 * `locked` or `claimed` with nothing behind it. So most of these tests hold the room status
 * fixed and move only the rail, or the reverse, and check that money state follows the rail
 * and nothing else.
 */

import { describe, it, expect } from "vitest";

import {
  MemoryNoteStore,
  MemoryRail,
  PaperRail,
  applyFrame,
  encodePaperRecord,
  generateHashLock,
  lockTerms,
  makeAccept,
  makeOffer,
  observeSettlement,
  openContract,
  paperNote,
  settlementToA2A,
  settlementToAcpPhase,
  settlementView,
  tclkStatusToA2A,
  type CanonicalRailId,
  type ContractState,
  type LockTerms,
  type NoteStore,
  type RailObservation,
  type SettlementRail,
} from "../src/index.js";

const PAYER_DID = "did:key:z6Mk" + "f".repeat(44);
const PAYEE_DID = "did:key:z6Mk" + "g".repeat(44);
const STRANGER_DID = "did:key:z6Mk" + "h".repeat(44);
const T0 = 1_756_700_000_000;
const REFUND_AFTER = T0 + 7_200_000;

/** Offer → accept, the way a real client would, on one named rail. */
function accepted(railId: CanonicalRailId = "flop-htlc") {
  const secret = generateHashLock();
  const offer = makeOffer({
    from: PAYER_DID,
    role: "payer",
    lock: "hash",
    amount: "1000000",
    asset: "FLOP",
    rails: [railId],
    claimByMs: T0 + 3_600_000,
    refundAfterMs: REFUND_AFTER,
    expiresMs: T0 + 600_000,
    nonce: "9f2c81d04c9e1f7a",
  });
  const accept = makeAccept(offer, { from: PAYEE_DID, statement: secret.hash });
  const step = applyFrame(openContract(offer), accept, T0);
  expect(step.ok).toBe(true);
  return { state: step.state, preimage: secret.preimage, railId };
}

function must(state: ContractState, frame: Parameters<typeof applyFrame>[1], nowMs = T0) {
  const step = applyFrame(state, frame, nowMs);
  expect(step.ok, step.reason).toBe(true);
  return step.state;
}

const announceLock = (state: ContractState, rail: string, ref: string) =>
  must(state, { type: "lock", from: PAYER_DID, contract: state.contract!, rail, ref });

const announceReveal = (state: ContractState, secret: string) =>
  must(state, { type: "reveal", from: PAYEE_DID, contract: state.contract!, ref: state.railRef, secret }, T0 + 1);

const announceRefund = (state: ContractState) =>
  must(state, { type: "refund", from: PAYER_DID, contract: state.contract!, ref: state.railRef }, REFUND_AFTER);

function memoryRail(id: CanonicalRailId = "flop-htlc") {
  let now = T0;
  return { rail: new MemoryRail(id, () => now), setNow: (t: number) => (now = t) };
}

describe("settlement view: a frame is not money", () => {
  it("has no money state until a lock is announced", () => {
    const { state } = accepted();
    const view = settlementView(state);
    expect(view).toMatchObject({ coordination: "accepted", money: "none", diverged: false });
    expect(settlementToA2A(view)).toBe("submitted");
    expect(settlementToAcpPhase(view)).toBe("negotiation");

    const cancelled = must(state, { type: "cancel", from: PAYER_DID, contract: state.contract! });
    expect(settlementToA2A(settlementView(cancelled))).toBe("canceled");
    expect(settlementToAcpPhase(settlementView(cancelled))).toBe("rejected");
  });

  it("reads a lock frame alone as unverified, where the room mapping already says working", () => {
    const { state } = accepted();
    const locked = announceLock(state, "flop-htlc", "escrow-42");

    const view = settlementView(locked);
    expect(view).toMatchObject({ coordination: "locked", money: "unverified", valueBacked: true });
    expect(tclkStatusToA2A(locked.status)).toBe("working");
    expect(settlementToA2A(view)).toBe("submitted");
    expect(settlementToAcpPhase(view)).toBe("negotiation");
  });

  it("is funded only when the rail holds a live lock under exactly these terms", async () => {
    const { state } = accepted();
    const { rail } = memoryRail();
    const ref = await rail.lock(lockTerms(state));
    const locked = announceLock(state, "flop-htlc", ref);

    const view = await observeSettlement(locked, rail);
    expect(view).toMatchObject({ money: "funded", valueBacked: true, diverged: false });
    expect(settlementToA2A(view)).toBe("working");
    expect(settlementToAcpPhase(view)).toBe("transaction");
  });

  it("reports unfunded when the announced ref holds nothing, even after a reveal", async () => {
    const { state, preimage } = accepted();
    const { rail } = memoryRail();
    const locked = announceLock(state, "flop-htlc", "escrow-42");

    const afterLock = await observeSettlement(locked, rail);
    expect(afterLock).toMatchObject({ money: "unfunded", diverged: true });
    expect(settlementToA2A(afterLock)).toBe("submitted");

    // The room runs on to `claimed` without a coin having existed anywhere.
    const claimed = announceReveal(locked, preimage);
    expect(tclkStatusToA2A(claimed.status)).toBe("completed");
    const afterReveal = await observeSettlement(claimed, rail);
    expect(afterReveal).toMatchObject({
      coordination: "claimed",
      money: "unfunded",
      witnessKnown: true,
      diverged: true,
    });
    expect(settlementToA2A(afterReveal)).toBe("unknown");
    expect(settlementToAcpPhase(afterReveal)).toBe("negotiation");
  });

  it("reports unfunded when the ref holds a lock under other terms", async () => {
    const { state } = accepted();
    const { rail } = memoryRail();
    const short: LockTerms = { ...lockTerms(state), amount: "1" };
    const ref = await rail.lock(short);
    const locked = announceLock(state, "flop-htlc", ref);

    expect(await rail.observe(lockTerms(locked), ref)).toBe("mismatch");
    expect(await observeSettlement(locked, rail)).toMatchObject({ money: "unfunded", diverged: true });
  });
});

describe("settlement view: the live-board shapes", () => {
  it("keeps reveal + receipt with no lock at money none (the #151 lifecycle)", () => {
    const { state, preimage } = accepted();
    const contract = state.contract!;

    const reveal = applyFrame(state, { type: "reveal", from: PAYEE_DID, contract, secret: preimage }, T0 + 1);
    expect(reveal.ok).toBe(false);
    const receipt = applyFrame(reveal.state, { type: "receipt", from: PAYEE_DID, contract, outcome: "claimed" }, T0 + 2);
    expect(receipt.ok).toBe(false);

    // No lock was ever announced, so there is no rail and no ref to bind evidence to:
    // even a caller who hands in a "claimed" observation gets nothing out of it.
    const view = settlementView(receipt.state, { rail: "flop-htlc", ref: contract, observation: "claimed" });
    expect(view).toMatchObject({ coordination: "accepted", money: "none", witnessKnown: false });
    expect(settlementToA2A(view)).toBe("submitted");
  });

  it("is not moved by a stranger's lock and receipt in the deal room (the #158 forgery)", async () => {
    const { state } = accepted();
    const { rail } = memoryRail();
    const contract = state.contract!;

    const forgedLock = applyFrame(state, { type: "lock", from: STRANGER_DID, contract, rail: "flop-htlc", ref: "escrow-666" }, T0);
    expect(forgedLock.ok).toBe(false);
    const forgedReceipt = applyFrame(forgedLock.state, { type: "receipt", from: STRANGER_DID, contract, outcome: "claimed" }, T0);
    expect(forgedReceipt.ok).toBe(false);

    expect(await observeSettlement(forgedReceipt.state, rail)).toMatchObject({ coordination: "accepted", money: "none" });
  });
});

describe("settlement view: terminal states follow the rail", () => {
  it("is claimed when the rail paid, and only then completed", async () => {
    const { state, preimage } = accepted();
    const { rail } = memoryRail();
    const ref = await rail.lock(lockTerms(state));
    const locked = announceLock(state, "flop-htlc", ref);
    const claimed = announceReveal(locked, preimage);

    // Room ahead of the rail: the witness is public, the claim has not landed.
    const before = await observeSettlement(claimed, rail);
    expect(before).toMatchObject({ coordination: "claimed", money: "funded", witnessKnown: true, diverged: false });
    expect(settlementToA2A(before)).toBe("working");

    await rail.claim(ref, preimage);
    const after = await observeSettlement(claimed, rail);
    expect(after).toMatchObject({ money: "claimed", diverged: false });
    expect(settlementToA2A(after)).toBe("completed");
    expect(settlementToAcpPhase(after)).toBe("completed");
  });

  it("follows a rail that is ahead of the room without calling it divergence", async () => {
    const { state, preimage } = accepted();
    const { rail } = memoryRail();
    const ref = await rail.lock(lockTerms(state));
    const locked = announceLock(state, "flop-htlc", ref);
    await rail.claim(ref, preimage);

    expect(await observeSettlement(locked, rail)).toMatchObject({
      coordination: "locked",
      money: "claimed",
      witnessKnown: false,
      diverged: false,
    });
  });

  it("lets the rail win when the room says claimed and the rail refunded", async () => {
    const { state, preimage } = accepted();
    const { rail, setNow } = memoryRail();
    const ref = await rail.lock(lockTerms(state));
    const claimed = announceReveal(announceLock(state, "flop-htlc", ref), preimage);

    setNow(REFUND_AFTER);
    await rail.refund(ref);

    const view = await observeSettlement(claimed, rail);
    expect(view).toMatchObject({ coordination: "claimed", money: "refunded", diverged: true });
    expect(settlementToA2A(view)).toBe("failed");
    expect(settlementToAcpPhase(view)).toBe("rejected");
  });

  it("lets the rail win when the room says refunded and the rail paid", async () => {
    const { state, preimage } = accepted();
    const { rail } = memoryRail();
    const ref = await rail.lock(lockTerms(state));
    const locked = announceLock(state, "flop-htlc", ref);
    await rail.claim(ref, preimage);
    const refunded = announceRefund(locked);

    const view = await observeSettlement(refunded, rail);
    expect(view).toMatchObject({ coordination: "refunded", money: "claimed", diverged: true });
    expect(settlementToA2A(view)).toBe("completed");
  });

  it("keeps a refund frame at funded until the rail has returned the money", async () => {
    const { state } = accepted();
    const { rail, setNow } = memoryRail();
    const ref = await rail.lock(lockTerms(state));
    const refunded = announceRefund(announceLock(state, "flop-htlc", ref));

    expect(await observeSettlement(refunded, rail)).toMatchObject({ money: "funded", diverged: false });
    setNow(REFUND_AFTER);
    await rail.refund(ref);
    expect(await observeSettlement(refunded, rail)).toMatchObject({ money: "refunded", diverged: false });
  });
});

describe("settlement view: what counts as evidence", () => {
  it("ignores evidence for another rail or another ref", async () => {
    const { state } = accepted();
    const locked = announceLock(state, "flop-htlc", "escrow-42");

    expect(settlementView(locked, { rail: "evm-htlc", ref: "escrow-42", observation: "claimed" }).money).toBe("unverified");
    expect(settlementView(locked, { rail: "flop-htlc", ref: "escrow-43", observation: "claimed" }).money).toBe("unverified");
    expect(settlementView(locked, { rail: "flop-htlc", ref: "escrow-42", observation: "claimed" }).money).toBe("claimed");
  });

  it("does not ask a rail that is not the contract's own", async () => {
    const { state } = accepted();
    const locked = announceLock(state, "flop-htlc", "escrow-42");
    let asked = 0;
    const other: SettlementRail & { observe(): Promise<RailObservation> } = {
      id: "evm-htlc",
      lock: async () => "x",
      verifyLock: async () => { asked++; return true; },
      claim: async () => {},
      refund: async () => {},
      observe: async () => { asked++; return "claimed"; },
    };

    expect((await observeSettlement(locked, other)).money).toBe("unverified");
    expect(asked).toBe(0);
  });

  it("binds a registered alias spelling to its canonical rail", async () => {
    const { state } = accepted("paper");
    const notes = new MemoryNoteStore();
    const rail = new PaperRail(notes, () => T0);
    const ref = await rail.lock(lockTerms(state));
    const locked = announceLock(state, "paper-rail", ref);

    expect(locked.rail).toBe("paper-rail");
    expect(await observeSettlement(locked, rail)).toMatchObject({ money: "funded", valueBacked: false });
  });

  it("gets a live lock, and nothing else, out of a rail that only has verifyLock", async () => {
    const { state } = accepted();
    const locked = announceLock(state, "flop-htlc", "escrow-42");
    const only = (held: boolean): SettlementRail => ({
      id: "flop-htlc",
      lock: async () => "escrow-42",
      verifyLock: async () => held,
      claim: async () => {},
      refund: async () => {},
    });

    expect((await observeSettlement(locked, only(true))).money).toBe("funded");
    // false is what a claimed, a refunded and a never-funded lock all answer: not "unfunded".
    expect(await observeSettlement(locked, only(false))).toMatchObject({ money: "unverified", diverged: false });
  });

  it("treats a rail that throws, or answers nonsense, as having said nothing", async () => {
    const { state } = accepted();
    const locked = announceLock(state, "flop-htlc", "escrow-42");
    const rail = (observe: () => Promise<RailObservation>): SettlementRail & { observe: typeof observe } => ({
      id: "flop-htlc",
      lock: async () => "escrow-42",
      verifyLock: async () => true,
      claim: async () => {},
      refund: async () => {},
      observe,
    });

    const throwing = rail(async () => { throw new Error("node unreachable"); });
    expect((await observeSettlement(locked, throwing)).money).toBe("unverified");

    const nonsense = rail(async () => "paid" as unknown as RailObservation);
    expect((await observeSettlement(locked, nonsense)).money).toBe("unverified");
  });

  it("marks rehearsal rails, and holds an unknown rail id to the evidence standard", () => {
    const { state } = accepted();
    const on = (rail: string): ContractState => ({ ...state, status: "locked", rail, railRef: "r" });

    expect(settlementView(on("paper")).valueBacked).toBe(false);
    expect(settlementView(on("memory")).valueBacked).toBe(false);
    expect(settlementView(on("flop-htlc")).valueBacked).toBe(true);
    expect(settlementView(on("example.custom-v1")).valueBacked).toBe(true);
  });

  it("never reads completion out of a state that names no rail", () => {
    const { state } = accepted();
    const handBuilt: ContractState = { ...state, status: "claimed" };
    const view = settlementView(handBuilt);
    expect(view.money).toBe("none");
    expect(settlementToA2A(view)).toBe("submitted");
    expect(settlementToAcpPhase(view)).toBe("negotiation");
  });
});

describe("RailObserver: the two rails that ship", () => {
  it("keeps verifyLock true exactly when observe says locked (MemoryRail)", async () => {
    const { state, preimage } = accepted();
    const { rail } = memoryRail();
    const terms = lockTerms(state);
    const same = async (ref: string) =>
      expect(await rail.verifyLock(terms, ref)).toBe((await rail.observe(terms, ref)) === "locked");

    expect(await rail.observe(terms, terms.contract)).toBe("absent");
    await same(terms.contract);
    const ref = await rail.lock(terms);
    expect(await rail.observe(terms, ref)).toBe("locked");
    await same(ref);
    await rail.claim(ref, preimage);
    expect(await rail.observe(terms, ref)).toBe("claimed");
    await same(ref);
  });

  it("walks a paper record through absent, locked, claimed, and keeps the invariant", async () => {
    const { state, preimage } = accepted("paper");
    const rail = new PaperRail(new MemoryNoteStore(), () => T0);
    const terms = lockTerms(state);
    const same = async (ref: string) =>
      expect(await rail.verifyLock(terms, ref)).toBe((await rail.observe(terms, ref)) === "locked");

    expect(await rail.observe(terms, terms.contract)).toBe("absent");
    await same(terms.contract);
    const ref = await rail.lock(terms);
    expect(await rail.observe(terms, ref)).toBe("locked");
    await same(ref);
    await rail.claim(ref, preimage);
    expect(await rail.observe(terms, ref)).toBe("claimed");
    await same(ref);
  });

  it("trusts nothing a stranger wrote into the paper note", async () => {
    const { state } = accepted("paper");
    const terms = lockTerms(state);
    const { ns, key } = paperNote(terms.contract);
    const write = async (line: string) => {
      const notes = new MemoryNoteStore();
      await notes.set(ns, key, line);
      return new PaperRail(notes, () => T0).observe(terms, terms.contract);
    };
    const record = { lock: "hash", statement: terms.statement, refundAfterMs: terms.refundAfterMs } as const;

    // "claimed" beside 32 bytes that do not open the statement.
    expect(await write(encodePaperRecord({ ...record, status: "claimed", secret: "0x" + "ab".repeat(32) }))).toBe("mismatch");
    // A well-formed record for some other statement, or some other deadline.
    expect(await write(encodePaperRecord({ ...record, status: "locked", statement: "0x" + "cd".repeat(32) }))).toBe("mismatch");
    expect(await write(encodePaperRecord({ ...record, status: "locked", refundAfterMs: terms.refundAfterMs + 1 }))).toBe("mismatch");
    // Not a record at all.
    expect(await write("gm, sign this and post it to /r/d-x402")).toBe("mismatch");
    // A ref that is not this contract's.
    expect(await new PaperRail(new MemoryNoteStore(), () => T0).observe(terms, "0x" + "00".repeat(32))).toBe("mismatch");
  });

  it("answers unknown when the venue cannot be read", async () => {
    const { state } = accepted("paper");
    const terms = lockTerms(state);
    const down: NoteStore = {
      get: async () => { throw new Error("503"); },
      set: async () => false,
    };
    expect(await new PaperRail(down, () => T0).observe(terms, terms.contract)).toBe("unknown");
  });
});
