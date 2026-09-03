/**
 * Tests for the Technocore Lock Protocol (tclk/1) primitives.
 *
 * This suite is the anti-drift gate for docs/design/technocore-lock-protocol.md:
 * the wire codec against the venue's caps (single line, ASCII, ≤4096 chars), the
 * domain-tagged ids, the fail-closed state machine, both lock kinds end-to-end
 * (HTLC preimage; PTLC witness incl. the adaptor pre-sign → adapt → extract cycle),
 * the reference rail predicates, and the A2A / Virtuals ACP mappings.
 */

import { describe, it, expect } from "vitest";

import {
  MAX_FRAME_CHARS,
  TCLK_PREFIX,
  applyFrame,
  contractId,
  dealRoom,
  decodeFrame,
  encodeFrame,
  generateHashLock,
  generatePointLock,
  hashLockFromPreimage,
  isValidStatement,
  lockTerms,
  makeAccept,
  makeOffer,
  MemoryRail,
  openContract,
  parseStateNoteValue,
  OFFER_ROOM,
  capabilityToken,
  parseCapabilityToken,
  stateNote,
  stateNoteValue,
  tclkStatusToA2A,
  tclkStatusToAcpPhase,
  tryDecodeFrame,
  validateDeadlines,
  verifyHashPreimage,
  verifyPointWitness,
  verifySecret,
  a2aJob,
  acpJob,
  schnorrAdaptor,
  type ContractState,
  type OfferFrame,
  type TclkStatus,
} from "../src/index.js";

const PAYER_DID = "did:key:z6Mk" + "f".repeat(44);
const PAYEE_DID = "did:key:z6Mk" + "g".repeat(44);
const STRANGER_DID = "did:key:z6Mk" + "h".repeat(44);

const T0 = 1_756_700_000_000; // "now" for deterministic tests
const CLAIM_BY = T0 + 3_600_000;
const REFUND_AFTER = T0 + 7_200_000;
const EXPIRES = T0 + 600_000;

function baseOffer(overrides: Record<string, unknown> = {}): OfferFrame {
  return makeOffer({
    from: PAYER_DID,
    role: "payer",
    amount: "1000000",
    asset: "FLOP",
    lock: "hash",
    rails: ["flop-htlc", "x402"],
    claimByMs: CLAIM_BY,
    refundAfterMs: REFUND_AFTER,
    expiresMs: EXPIRES,
    nonce: "9f2c81d04c9e1f7a",
    ...(overrides as object),
  } as Parameters<typeof makeOffer>[0]);
}

/** Drive offer → accept, returning payer+payee views and the accept frame. */
function accepted(offer = baseOffer(), statement?: string) {
  const lock = generateHashLock();
  const accept = makeAccept(offer, { from: PAYEE_DID, statement: statement ?? lock.hash });
  const step = applyFrame(openContract(offer), accept, T0);
  expect(step.ok).toBe(true);
  return { offer, lock, accept, state: step.state };
}

describe("tclk frames — wire codec", () => {
  it("encodes a frame as one single-line ASCII message within the venue cap", () => {
    const offer = baseOffer({ job: a2aJob("task-3f", "ctx-1") });
    const line = encodeFrame(offer);
    expect(line.startsWith(TCLK_PREFIX)).toBe(true);
    expect(line.includes("\n")).toBe(false);
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    expect(line.length).toBeLessThanOrEqual(MAX_FRAME_CHARS);
  });

  it("round-trips through decode and is canonical (key order independent)", () => {
    const offer = baseOffer();
    const decoded = decodeFrame(encodeFrame(offer));
    expect(decoded).toEqual(offer);
    // Same fields in another key order must encode to the same bytes.
    const shuffled = Object.fromEntries(Object.entries(offer).reverse()) as unknown as OfferFrame;
    expect(encodeFrame(shuffled)).toBe(encodeFrame(offer));
  });

  it("escapes non-ASCII so the stored bytes equal the signed bytes", () => {
    const offer = baseOffer({ job: { proto: "a2a", id: "tâche-1" } });
    const line = encodeFrame(offer);
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    expect((decodeFrame(line) as OfferFrame).job?.id).toBe("tâche-1");
  });

  it("fails closed on unknown fields, missing fields, and bad values", () => {
    const offer = baseOffer();
    expect(() => encodeFrame({ ...offer, extra: 1 } as unknown as OfferFrame)).toThrow(/unknown field/);
    const { amount: _a, ...missing } = offer;
    expect(() => encodeFrame(missing as unknown as OfferFrame)).toThrow(/missing field/);
    expect(() => baseOffer({ amount: "0" })).toThrow(/amount/);
    expect(() => baseOffer({ claimByMs: REFUND_AFTER })).toThrow(/strictly before/);
    expect(() => baseOffer({ from: "did:web:evil" })).toThrow(/from is malformed/);
    expect(() => baseOffer({ rails: [] })).toThrow(/rails/);
  });

  it("rejects odd-length pre-signature scalar encodings", () => {
    expect(() => encodeFrame({
      type: "lock",
      from: PAYER_DID,
      contract: "0x" + "11".repeat(32),
      rail: "flop-htlc",
      ref: "escrow-42",
      presig: { nonce: "0x02" + "22".repeat(32), s: "0xabc" },
    })).toThrow(/presig\.s/);
  });

  it("tryDecodeFrame skips foreign and hostile lines instead of throwing", () => {
    expect(tryDecodeFrame("hello from ~alice")).toBeNull();
    expect(tryDecodeFrame('tclk1 {"type":"offer"}')).toBeNull();
    expect(tryDecodeFrame("tclk1 not json")).toBeNull();
    expect(tryDecodeFrame(encodeFrame(baseOffer()))).not.toBeNull();
  });

  it("binds the offer id to the terms — tampering is detected", () => {
    const offer = baseOffer();
    const tampered = { ...offer, amount: "2000000" };
    expect(() => decodeFrame(TCLK_PREFIX + JSON.stringify(tampered))).toThrow(/offer id mismatch/);
  });

  it("two offers with the same terms but different nonces serialize differently (dupe filter)", () => {
    const a = baseOffer({ nonce: "aaaaaaaaaaaaaaaa" });
    const b = baseOffer({ nonce: "bbbbbbbbbbbbbbbb" });
    expect(a.id).not.toBe(b.id);
    expect(encodeFrame(a)).not.toBe(encodeFrame(b));
  });

  it("requires payment keys for point locks", () => {
    expect(() => baseOffer({ lock: "point" })).toThrow(/paymentKey/);
    const payerKey = schnorrAdaptor.getPublicKey("0x" + "11".repeat(32))!;
    const offer = baseOffer({ lock: "point", paymentKey: payerKey });
    expect(() => makeAccept(offer, { from: PAYEE_DID, statement: generatePointLock().statement }))
      .toThrow(/paymentKey/);
  });

  it("rejects a statement that does not fit the offered lock kind", () => {
    const offer = baseOffer(); // hash lock
    const { statement } = generatePointLock();
    expect(() => makeAccept(offer, { from: PAYEE_DID, statement })).toThrow(/does not fit/);
  });
});

describe("tclk contract id", () => {
  it("is deterministic and binds every accept field", () => {
    const { offer, accept } = accepted();
    const core = {
      from: accept.from, ref: accept.ref, statement: accept.statement,
      paymentKey: accept.paymentKey, nonce: accept.nonce,
    };
    expect(contractId(offer, core)).toBe(accept.contract);
    expect(contractId(offer, { ...core, statement: generateHashLock().hash })).not.toBe(accept.contract);
  });
});

describe("tclk locks", () => {
  it("hash lock round-trips and verifies fail-closed", () => {
    const lock = generateHashLock();
    expect(verifyHashPreimage(lock.hash, lock.preimage)).toBe(true);
    expect(verifyHashPreimage(lock.hash, "0x" + "00".repeat(32))).toBe(false);
    expect(verifyHashPreimage(lock.hash, "not-hex")).toBe(false);
    expect(() => hashLockFromPreimage("0x1234")).toThrow(/32 bytes/);
  });

  it("verifySecret dispatches to the right lock kind", () => {
    const h = generateHashLock();
    const p = generatePointLock();
    expect(verifySecret("hash", h.hash, h.preimage)).toBe(true);
    expect(verifySecret("point", p.statement, p.witness)).toBe(true);
    expect(verifySecret("hash", h.hash, p.witness)).toBe(false);
    expect(verifySecret("point", p.statement, h.preimage)).toBe(false);
    expect(verifySecret("banana" as never, p.statement, p.witness)).toBe(false);
  });

  it("rejects unknown lock kinds in statement checks", () => {
    const h = generateHashLock();
    const p = generatePointLock();

    expect(isValidStatement("hash", h.hash)).toBe(true);
    expect(isValidStatement("point", p.statement)).toBe(true);
    expect(isValidStatement("hash", p.statement)).toBe(false);
    expect(isValidStatement("point", h.hash)).toBe(false);
    expect(isValidStatement("banana" as never, p.statement)).toBe(false);
  });

  it("validateDeadlines enforces both margins, fail-closed", () => {
    const offer = { claimByMs: CLAIM_BY, refundAfterMs: REFUND_AFTER };
    expect(validateDeadlines(offer, T0, 3_600_000, 3_600_000)).toBe(true);
    expect(validateDeadlines(offer, T0, 3_600_001, 3_600_000)).toBe(false); // claim window too short
    expect(validateDeadlines(offer, T0, 3_600_000, 3_600_001)).toBe(false); // refund gap too short
    expect(validateDeadlines(offer, T0, 0, 1)).toBe(false); // degenerate margins refused
  });

  it("validateDeadlines rejects malformed clocks and unvalidated offer times", () => {
    const offer = { claimByMs: CLAIM_BY, refundAfterMs: REFUND_AFTER };
    expect(validateDeadlines(offer, -Infinity, 1, 1)).toBe(false);
    expect(validateDeadlines(offer, -1, 1, 1)).toBe(false);
    expect(validateDeadlines({ ...offer, refundAfterMs: Infinity }, T0, 1, 1)).toBe(false);
    expect(validateDeadlines({ ...offer, claimByMs: 1.5 }, 0, 1, 1)).toBe(false);
    expect(validateDeadlines(offer, T0, Infinity, 1)).toBe(false);
  });
});

describe("tclk state machine", () => {
  it("runs the HTLC happy path: propose → accept → lock → reveal", () => {
    const { lock, state } = accepted();
    expect(state.status).toBe("accepted");
    expect(state.payerDid).toBe(PAYER_DID);
    expect(state.payeeDid).toBe(PAYEE_DID);

    const locked = applyFrame(state, {
      type: "lock", from: PAYER_DID, contract: state.contract!, rail: "flop-htlc", ref: "escrow-42",
    }, T0 + 1);
    expect(locked.ok).toBe(true);
    expect(locked.state.status).toBe("locked");

    const claimed = applyFrame(locked.state, {
      type: "reveal", from: PAYEE_DID, contract: state.contract!, ref: "escrow-42",
      secret: lock.preimage,
    }, T0 + 2);
    expect(claimed.ok).toBe(true);
    expect(claimed.state.status).toBe("claimed");
    expect(claimed.state.secret).toBe(lock.preimage);

    const receipt = applyFrame(claimed.state, {
      type: "receipt", from: PAYER_DID, contract: state.contract!, outcome: "claimed",
    }, T0 + 3);
    expect(receipt.ok).toBe(true);
    expect(receipt.state.status).toBe("claimed");

    const contradictoryReceipt = applyFrame(claimed.state, {
      type: "receipt", from: PAYER_DID, contract: state.contract!, outcome: "refunded",
    }, T0 + 3);
    expect(contradictoryReceipt.ok).toBe(false);
    expect(contradictoryReceipt.reason).toMatch(/does not match claimed/);
    expect(contradictoryReceipt.state).toBe(claimed.state);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
  ])("rejects %s nowMs without changing state", (_label, nowMs) => {
    const { state } = accepted();
    const step = applyFrame(state, {
      type: "lock", from: PAYER_DID, contract: state.contract!, rail: "flop-htlc", ref: "escrow-42",
    }, nowMs);

    expect(step.ok).toBe(false);
    expect(step.reason).toBe("tclk: nowMs must be a finite non-negative number");
    expect(step.state).toBe(state);
  });

  it("keeps exact expiry and refund deadline boundaries", () => {
    const { offer, accept, state } = accepted();
    expect(applyFrame(openContract(offer), accept, EXPIRES).ok).toBe(false);

    const locked = applyFrame(state, {
      type: "lock", from: PAYER_DID, contract: state.contract!, rail: "flop-htlc", ref: "escrow-42",
    }, T0);
    expect(locked.ok).toBe(true);
    expect(applyFrame(locked.state, {
      type: "refund", from: PAYER_DID, contract: state.contract!, ref: "escrow-42",
    }, REFUND_AFTER).ok).toBe(true);
  });

  it("payee-initiated offers assign roles correctly at accept", () => {
    const offer = makeOffer({
      from: PAYEE_DID, role: "payee", amount: "5", asset: "USDC", lock: "hash",
      rails: ["x402"], claimByMs: CLAIM_BY, refundAfterMs: REFUND_AFTER, expiresMs: EXPIRES,
    });
    const lock = generateHashLock();
    // For a payee-initiated offer the payee still mints the lock and sends the
    // statement inside the offer acceptance handshake; here the acceptor is the payer.
    const accept = makeAccept(offer, { from: PAYER_DID, statement: lock.hash });
    const step = applyFrame(openContract(offer), accept, T0);
    expect(step.ok).toBe(true);
    expect(step.state.payerDid).toBe(PAYER_DID);
    expect(step.state.payeeDid).toBe(PAYEE_DID);
  });

  it("rejects, without state change: wrong parties, expiry, tampered ids, wrong secret", () => {
    const { offer, lock, accept, state } = accepted();

    // Self-accept and expired accept.
    expect(applyFrame(openContract(offer), { ...accept, from: PAYER_DID }, T0).ok).toBe(false);
    expect(applyFrame(openContract(offer), accept, EXPIRES).ok).toBe(false);
    // Tampered contract id.
    expect(
      applyFrame(openContract(offer), { ...accept, contract: "0x" + "ab".repeat(32) }, T0).ok,
    ).toBe(false);

    const contract = state.contract!;
    // Only the payer locks; only an offered rail counts.
    expect(applyFrame(state, { type: "lock", from: PAYEE_DID, contract, rail: "flop-htlc", ref: "r" }, T0).ok).toBe(false);
    expect(applyFrame(state, { type: "lock", from: PAYER_DID, contract, rail: "evm-htlc", ref: "r" }, T0).ok).toBe(false);

    const locked = applyFrame(state, { type: "lock", from: PAYER_DID, contract, rail: "x402", ref: "r" }, T0).state;
    // Only the payee reveals, only with the right secret, only before the refund window.
    expect(applyFrame(locked, { type: "reveal", from: PAYER_DID, contract, ref: "r", secret: lock.preimage }, T0).ok).toBe(false);
    expect(applyFrame(locked, { type: "reveal", from: PAYEE_DID, contract, ref: "other", secret: lock.preimage }, T0).reason).toMatch(/different rail ref/);
    const wrong = applyFrame(locked, { type: "reveal", from: PAYEE_DID, contract, ref: "r", secret: "0x" + "00".repeat(32) }, T0);
    expect(wrong.ok).toBe(false);
    expect(wrong.state.status).toBe("locked");
    expect(applyFrame(locked, { type: "reveal", from: PAYEE_DID, contract, ref: "r", secret: lock.preimage }, REFUND_AFTER).ok).toBe(false);
    // Refund: payer only, and only once the window opens.
    expect(applyFrame(locked, { type: "refund", from: PAYER_DID, contract, ref: "other" }, REFUND_AFTER).reason).toMatch(/different rail ref/);
    expect(applyFrame(locked, { type: "refund", from: PAYER_DID, contract, ref: "r" }, REFUND_AFTER - 1).ok).toBe(false);
    expect(applyFrame(locked, { type: "refund", from: PAYEE_DID, contract, ref: "r" }, REFUND_AFTER).ok).toBe(false);
    const refunded = applyFrame(locked, { type: "refund", from: PAYER_DID, contract, ref: "r" }, REFUND_AFTER);
    expect(refunded.ok).toBe(true);
    expect(refunded.state.status).toBe("refunded");
  });

  it("is idempotent under replays — a duplicate frame is a rejected no-op", () => {
    const { accept, state } = accepted();
    const replay = applyFrame(state, accept, T0);
    expect(replay.ok).toBe(false);
    expect(replay.state).toBe(state);
  });

  it("cancel works pre-lock for parties only, and never after lock", () => {
    const { offer, state } = accepted();
    expect(applyFrame(openContract(offer), { type: "cancel", from: PAYER_DID, contract: "0x" + "00".repeat(32) }, T0).state.status).toBe("cancelled");
    expect(applyFrame(state, { type: "cancel", from: STRANGER_DID, contract: state.contract! }, T0).ok).toBe(false);
    const cancelled = applyFrame(state, { type: "cancel", from: PAYEE_DID, contract: state.contract! }, T0);
    expect(cancelled.state.status).toBe("cancelled");
    const locked = applyFrame(state, { type: "lock", from: PAYER_DID, contract: state.contract!, rail: "x402", ref: "r" }, T0).state;
    expect(applyFrame(locked, { type: "cancel", from: PAYER_DID, contract: state.contract! }, T0).ok).toBe(false);
  });

  it("rejects hostile/malformed frames without throwing", () => {
    const { state } = accepted();
    const step = applyFrame(state, { type: "lock", from: "nonsense" } as never, T0);
    expect(step.ok).toBe(false);
    expect(step.state).toBe(state);
  });
});

describe("tclk PTLC path (adaptor cycle)", () => {
  it("accept(Y) → lock(presig) → adapt with y → completed sig extracts the witness that opens Y", () => {
    const payerSecret = "0x" + "11".repeat(32);
    const payerKey = schnorrAdaptor.getPublicKey(payerSecret)!;
    const payeeKey = schnorrAdaptor.getPublicKey("0x" + "22".repeat(32))!;

    const offer = baseOffer({ lock: "point", paymentKey: payerKey });
    const ptlc = generatePointLock(); // payee mints (y, Y)
    const accept = makeAccept(offer, { from: PAYEE_DID, statement: ptlc.statement, paymentKey: payeeKey });
    let state: ContractState = applyFrame(openContract(offer), accept, T0).state;
    expect(state.status).toBe("accepted");
    expect(state.payerKey).toBe(payerKey);
    expect(state.payeeKey).toBe(payeeKey);

    // Payer pre-signs the rail's claim message under Y and announces the lock.
    const claimMsg = "0x" + "cd".repeat(32);
    const pre = schnorrAdaptor.preSign(payerSecret, claimMsg, ptlc.statement)!;
    expect(schnorrAdaptor.verifyPreSignature(payerKey, claimMsg, ptlc.statement, pre)).toBe(true);
    state = applyFrame(state, {
      type: "lock", from: PAYER_DID, contract: state.contract!, rail: "flop-htlc",
      ref: "escrow-7", presig: pre,
    }, T0).state;
    expect(state.status).toBe("locked");

    // Payee completes with y — the completed signature settles the rail…
    const sig = schnorrAdaptor.adapt(state.presig!, ptlc.witness)!;
    expect(schnorrAdaptor.verifySignature(payerKey, claimMsg, sig)).toBe(true);
    // …and hands y to anyone holding the pre-signature (atomic linkage).
    const extracted = schnorrAdaptor.extractWitness(state.presig!, sig)!;
    expect(verifyPointWitness(ptlc.statement, extracted)).toBe(true);

    // The reveal frame propagates the witness through the room.
    const claimed = applyFrame(state, {
      type: "reveal", from: PAYEE_DID, contract: state.contract!, ref: "escrow-7",
      secret: extracted,
    }, T0 + 1);
    expect(claimed.ok).toBe(true);
    expect(claimed.state.status).toBe("claimed");
  });
});

describe("tclk MemoryRail (reference rail predicates)", () => {
  function railFixture() {
    let now = T0;
    const rail = new MemoryRail("memory", () => now);
    const { lock, state } = accepted();
    return { rail, lock, terms: lockTerms(state), setNow: (t: number) => { now = t; } };
  }

  it("lock → claim with the right secret, strictly before the refund window", async () => {
    const { rail, lock, terms, setNow } = railFixture();
    const ref = await rail.lock(terms);
    expect(await rail.verifyLock(terms, ref)).toBe(true);
    await expect(rail.claim(ref, "0x" + "00".repeat(32))).rejects.toThrow(/secret/);
    setNow(REFUND_AFTER);
    await expect(rail.claim(ref, lock.preimage)).rejects.toThrow(/after refundAfterMs/);
    setNow(REFUND_AFTER - 1);
    await rail.claim(ref, lock.preimage);
    expect(rail.status(ref)).toBe("claimed");
    await expect(rail.refund(ref)).rejects.toThrow(/claimed/);
  });

  it("refund only at/after refundAfterMs, and only from locked", async () => {
    const { rail, terms, setNow } = railFixture();
    const ref = await rail.lock(terms);
    await expect(rail.refund(ref)).rejects.toThrow(/before refundAfterMs/);
    setNow(REFUND_AFTER);
    await rail.refund(ref);
    expect(rail.status(ref)).toBe("refunded");
    expect(await rail.verifyLock(terms, ref)).toBe(false);
  });

  it("verifyLock is fail-closed on unknown refs and mismatched terms", async () => {
    const { rail, terms } = railFixture();
    expect(await rail.verifyLock(terms, terms.contract)).toBe(false);
    const ref = await rail.lock(terms);
    expect(await rail.verifyLock({ ...terms, amount: "2" }, ref)).toBe(false);
    await expect(rail.lock(terms)).rejects.toThrow(/already holds/);
  });

  it("lockTerms refuses a contract that is not accepted yet", () => {
    expect(() => lockTerms(openContract(baseOffer()))).toThrow(/not accepted/);
  });
});

describe("tclk venue binding", () => {
  it("deal room and state note fit the venue's grammar and shard like DID notes", () => {
    const { state } = accepted();
    const room = dealRoom(state.contract!);
    expect(room).toMatch(/^mb-p-tclk-[0-9a-f]{16}$/);
    expect(room.length).toBeLessThanOrEqual(48);
    const note = stateNote(state.contract!);
    expect(note.ns).toBe(`tclk-${state.contract!.slice(2, 4)}`);
    expect(note.key).toBe(state.contract!.slice(4, 18));
    expect(() => stateNote("garbage")).toThrow(/malformed/);
  });

  it("names the rendezvous room the venue can actually list", () => {
    // No class prefix on purpose: mb-/p-/d- would make the board signed-only,
    // unenumerable or owned, and a board nobody can find seeds nothing.
    expect(OFFER_ROOM).toBe("tclk-offers");
    expect(OFFER_ROOM).toMatch(/^[a-z0-9][a-z0-9_-]{0,47}$/);
    expect(OFFER_ROOM.startsWith("p-")).toBe(false);
    expect(OFFER_ROOM.startsWith("mb-")).toBe(false);
    expect(OFFER_ROOM.startsWith("d-")).toBe(false);
    expect(OFFER_ROOM.startsWith("e-")).toBe(false);
  });

  it("capability tokens round-trip and parse fail-closed out of a whole DID note", () => {
    const token = capabilityToken(["flop-htlc", "x402"]);
    expect(token).toBe("tclk1:flop-htlc,x402");

    const note = `did:key:z6Mk${"f".repeat(44)} mailbox:mb-p-abc123 ${token}`;
    expect(parseCapabilityToken(note)).toEqual(["flop-htlc", "x402"]);

    // Absent, empty and malformed all read as "no advertised capability" rather than
    // as an empty rail set — this note is world-writable input.
    expect(parseCapabilityToken(`did:key:z6Mk${"f".repeat(44)} mailbox:mb-p-abc123`)).toBeNull();
    expect(parseCapabilityToken("tclk1:")).toBeNull();
    expect(parseCapabilityToken("tclk1:BAD RAIL")).toBeNull();
    expect(parseCapabilityToken("tclk1:,flop-htlc")).toBeNull();
    expect(parseCapabilityToken("tclk1:flop-htlc,,x402")).toBeNull();
    expect(parseCapabilityToken("tclk1:flop-htlc,")).toBeNull();
    // A space ends the token: the DID note is whitespace-delimited, so a rail list
    // cannot contain one and everything after it is a different token entirely.
    expect(parseCapabilityToken("tclk1:flop-htlc x402")).toEqual(["flop-htlc"]);
    expect(() => capabilityToken([])).toThrow(/at least one rail/);
    expect(() => capabilityToken(["Bad-Rail"])).toThrow(/unknown rail id/);
    expect(capabilityToken(["x402", "PaperRail"])).toBe("tclk1:paper,x402");
  });

  it("state-note values round-trip and parse fail-closed", () => {
    const maxRailRef = "x".repeat(256);
    expect(parseStateNoteValue(stateNoteValue("locked", "escrow-42"))).toEqual({ status: "locked", railRef: "escrow-42" });
    expect(parseStateNoteValue(stateNoteValue("locked", maxRailRef))).toEqual({ status: "locked", railRef: maxRailRef });
    expect(parseStateNoteValue(stateNoteValue("claimed"))).toEqual({ status: "claimed" });
    expect(parseStateNoteValue("owned by nobody at all")).toBeNull();
    expect(parseStateNoteValue("exploded")).toBeNull();
    expect(parseStateNoteValue("locked ")).toBeNull();
    expect(parseStateNoteValue("locked \n")).toBeNull();
    expect(parseStateNoteValue("locked \u2603")).toBeNull();
    expect(parseStateNoteValue(`locked ${"x".repeat(257)}`)).toBeNull();
    expect(() => stateNoteValue("locked", "has space")).toThrow(/printable ASCII/);
  });
});

describe("tclk interop mappings", () => {
  const statuses: TclkStatus[] = ["proposed", "accepted", "locked", "claimed", "refunded", "cancelled"];

  it("maps totally onto A2A task states", () => {
    expect(statuses.map(tclkStatusToA2A)).toEqual([
      "submitted", "submitted", "working", "completed", "failed", "canceled",
    ]);
  });

  it("maps totally onto Virtuals ACP phases", () => {
    expect(statuses.map(tclkStatusToAcpPhase)).toEqual([
      "request", "negotiation", "transaction", "completed", "rejected", "rejected",
    ]);
  });

  it("job refs bind offers to external protocols", () => {
    const offer = baseOffer({ job: acpJob(1234) });
    expect(offer.job).toEqual({ proto: "acp", id: "1234" });
    expect(a2aJob("t-1")).toEqual({ proto: "a2a", id: "t-1" });
    expect(a2aJob("t-1", "c-9")).toEqual({ proto: "a2a", id: "t-1", context: "c-9" });
  });
});
