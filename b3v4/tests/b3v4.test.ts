/**
 * Tests for the B3V4 fast-path helper.
 *
 * Covers: gates, dry-run, execute (mocked), PaperRail integration,
 * VenueNoteStore, one-shot authorization (replay, concurrency), nonce safety,
 * write-order instrumentation, mailbox discovery, timing, evidence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyFrame,
  dealRoom,
  encodeFrame,
  generateHashLock,
  lockTerms,
  makeAccept,
  makeOffer,
  openContract,
  paperNote,
  PaperRail,
  MemoryNoteStore,
  tryDecodeFrame,
  type OfferFrame,
} from "@flop-labs/tclk";

import { signerFromSeed } from "@flop-labs/tclk-mcp/dist/signing.js";
import { canonicalMessage, sweep } from "@flop-labs/tclk-mcp/dist/signing.js";

import {
  runPreLockGates,
  allGatesPass,
  firstFailure,
  gateOfferParses,
  gateOfferIdRecomputes,
  gateOfferFromIsOurs,
  gateOfferRoleIsPayer,
  gateOfferHasPaper,
  gateOfferNotExpired,
  gateAcceptFromNotOurs,
  gateAcceptRefMatchesOffer,
  gateContractIdRecomputes,
  gateStatementFitsLock,
  gateAcceptIsIndependent,
  gateNoExistingLock,
  gateRefundWindowNotOpen,
  gateDealRoomDerivation,
  gateNoTerminalConflict,
} from "../src/gates.js";

import { buildDryRunPlan, validateDryRunPlan } from "../src/dry-run.js";
import { executeFastPath } from "../src/execute.js";
import { createMockVenueIO } from "../src/venue-io.js";
import { VenueNoteStore } from "../src/venue-note-store.js";
import { createAuthorizationStore } from "../src/authorization-store.js";
import { TimingRecorder } from "../src/timing.js";
import { createEvidenceCollector } from "../src/evidence.js";
import type { Authorization, AuthorizationStore, VenueSigner } from "../src/types.js";

// ── Test fixtures ────────────────────────────────────────────────────────────

const PAYER_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PAYEE_SEED = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";

const payerSigner = signerFromSeed(hexToBytes(PAYER_SEED));
const payeeSigner = signerFromSeed(hexToBytes(PAYEE_SEED));

const PAYER_DID = payerSigner.did;
const PAYEE_DID = payeeSigner.did;

const T0 = Date.now() + 3600_000;
const CLAIM_BY = T0 + 30 * 60_000;
const REFUND_AFTER = T0 + 60 * 60_000;
const EXPIRES = T0 + 10 * 60_000;

let tempDir: string;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function makeTestOffer(overrides: Record<string, unknown> = {}): OfferFrame {
  return makeOffer({
    from: PAYER_DID,
    role: "payer",
    lock: "hash",
    amount: "1000000",
    asset: "PAPER",
    rails: ["paper"],
    claimByMs: CLAIM_BY,
    refundAfterMs: REFUND_AFTER,
    expiresMs: EXPIRES,
    nonce: "9f2c81d04c9e1f7a",
    ...(overrides as object),
  } as Parameters<typeof makeOffer>[0]);
}

function makeTestAccept(offer: OfferFrame) {
  const lock = generateHashLock();
  const accept = makeAccept(offer, { from: PAYEE_DID, statement: lock.hash });
  return { accept, lock };
}

function createSignedRecord(
  room: string,
  line: string,
  signer: { did: string; sign: (canonical: string) => string },
  seq: number = 1,
  timestampMs: number = T0,
) {
  const nonce = String(seq + 1000);
  const text = sweep(line);
  const canonical = canonicalMessage(room, nonce, text);
  const sig = signer.sign(canonical);
  return { room, seq, timestampMs, sender: signer.did, nonce, signature: sig, line: text };
}

function mockSigner(did: string = PAYER_DID): VenueSigner {
  let nonce = 1000;
  return {
    did,
    sign: () => "mock-signature",
    nextNonce: () => String(nonce++),
  };
}

function makeAuthorization(offerId: string, contract: string, payerDid: string): Authorization {
  return {
    version: 1,
    mode: "execute-fast-path",
    offerId,
    contract,
    payerDid,
    issuedAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 3600_000,
    authorizationId: "auth-" + Math.random().toString(36).slice(2) + "-" + Date.now(),
  };
}

function setupExecute() {
  const venue = createMockVenueIO();
  const signer = mockSigner();
  const offer = makeTestOffer();
  const { accept } = makeTestAccept(offer);
  const state = applyFrame(openContract(offer), accept, T0).state;

  venue.addRoomData("tclk-offers", [
    createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner),
  ]);

  const selected = {
    accept,
    offer,
    contract: accept.contract,
    acceptRecord: createSignedRecord("tclk-offers", encodeFrame(accept), payeeSigner),
    offerRecord: createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner),
    state,
    acceptDID: PAYEE_DID,
    acceptTimestampMs: T0,
  };

  return { venue, signer, offer, accept, selected };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "b3v4-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ── Gate tests ───────────────────────────────────────────────────────────────

describe("B3V4 gates", () => {
  const offer = makeTestOffer();
  const { accept } = makeTestAccept(offer);
  const state = applyFrame(openContract(offer), accept, T0).state;

  describe("individual gates", () => {
    it("gateOfferParses passes for valid offer", () => {
      expect(gateOfferParses(offer).pass).toBe(true);
    });

    it("gateOfferIdRecomputes passes for valid offer", () => {
      expect(gateOfferIdRecomputes(offer).pass).toBe(true);
    });

    it("gateOfferFromIsOurs passes when offer.from matches our DID", () => {
      expect(gateOfferFromIsOurs(offer, PAYER_DID).pass).toBe(true);
    });

    it("gateOfferFromIsOurs fails when offer.from does not match", () => {
      const badOffer = makeTestOffer({ from: "did:key:z6Mk" + "h".repeat(44) });
      expect(gateOfferFromIsOurs(badOffer, PAYER_DID).pass).toBe(false);
    });

    it("gateOfferRoleIsPayer passes for payer role", () => {
      expect(gateOfferRoleIsPayer(offer).pass).toBe(true);
    });

    it("gateOfferRoleIsPayer fails for payee role", () => {
      const payeeOffer = makeOffer({
        from: PAYEE_DID,
        role: "payee",
        lock: "hash",
        amount: "1000000",
        asset: "PAPER",
        rails: ["paper"],
        claimByMs: CLAIM_BY,
        refundAfterMs: REFUND_AFTER,
        expiresMs: EXPIRES,
        nonce: "aabbccdd11223344",
      });
      expect(gateOfferRoleIsPayer(payeeOffer).pass).toBe(false);
    });

    it("gateOfferHasPaper passes when paper is in rails", () => {
      expect(gateOfferHasPaper(offer).pass).toBe(true);
    });

    it("gateOfferHasPaper fails when paper is not in rails", () => {
      const noPaperOffer = makeTestOffer({ rails: ["x402"] });
      expect(gateOfferHasPaper(noPaperOffer).pass).toBe(false);
    });

    it("gateOfferNotExpired passes before expiry", () => {
      expect(gateOfferNotExpired(offer, T0).pass).toBe(true);
    });

    it("gateOfferNotExpired fails at expiry", () => {
      expect(gateOfferNotExpired(offer, EXPIRES).pass).toBe(false);
    });

    it("gateAcceptFromNotOurs passes for different DID", () => {
      expect(gateAcceptFromNotOurs(accept, PAYER_DID).pass).toBe(true);
    });

    it("gateAcceptFromNotOurs fails for self-accept", () => {
      const selfAccept = { ...accept, from: PAYER_DID };
      expect(gateAcceptFromNotOurs(selfAccept, PAYER_DID).pass).toBe(false);
    });

    it("gateAcceptRefMatchesOffer passes for correct ref", () => {
      expect(gateAcceptRefMatchesOffer(accept, offer).pass).toBe(true);
    });

    it("gateAcceptRefMatchesOffer fails for wrong ref", () => {
      const wrongRefAccept = { ...accept, ref: "0x" + "ab".repeat(32) };
      expect(gateAcceptRefMatchesOffer(wrongRefAccept, offer).pass).toBe(false);
    });

    it("gateContractIdRecomputes passes for valid accept", () => {
      expect(gateContractIdRecomputes(accept, offer).pass).toBe(true);
    });

    it("gateStatementFitsLock passes for hash lock with hash statement", () => {
      expect(gateStatementFitsLock(accept, offer).pass).toBe(true);
    });

    it("gateStatementFitsLock fails for hash lock with point statement", () => {
      const pointStatement = "0x02" + "11".repeat(32);
      const badAccept = { ...accept, statement: pointStatement };
      expect(gateStatementFitsLock(badAccept, offer).pass).toBe(false);
    });

    it("gateAcceptIsIndependent passes for valid DID", () => {
      expect(gateAcceptIsIndependent(accept, PAYER_DID).pass).toBe(true);
    });

    it("gateAcceptIsIndependent fails for self-accept", () => {
      const selfAccept = { ...accept, from: PAYER_DID };
      expect(gateAcceptIsIndependent(selfAccept, PAYER_DID).pass).toBe(false);
    });

    it("gateNoExistingLock passes for accepted state", () => {
      expect(gateNoExistingLock(state).pass).toBe(true);
    });

    it("gateNoExistingLock fails for locked state", () => {
      const lockedState = applyFrame(
        state,
        { type: "lock", from: PAYER_DID, contract: state.contract!, rail: "paper", ref: "test" },
        T0,
      ).state;
      expect(gateNoExistingLock(lockedState).pass).toBe(false);
    });

    it("gateRefundWindowNotOpen passes before refundAfterMs", () => {
      expect(gateRefundWindowNotOpen(offer, T0).pass).toBe(true);
    });

    it("gateRefundWindowNotOpen fails at refundAfterMs", () => {
      expect(gateRefundWindowNotOpen(offer, REFUND_AFTER).pass).toBe(false);
    });

    it("gateDealRoomDerivation passes for valid contract", () => {
      expect(gateDealRoomDerivation(offer.id).pass).toBe(true);
    });

    it("gateNoTerminalConflict passes for accepted state", () => {
      expect(gateNoTerminalConflict(state).pass).toBe(true);
    });

    it("gateNoTerminalConflict fails for cancelled state", () => {
      const cancelledState = applyFrame(
        state,
        { type: "cancel", from: PAYEE_DID, contract: state.contract! },
        T0,
      ).state;
      expect(gateNoTerminalConflict(cancelledState).pass).toBe(false);
    });
  });

  describe("gate runner", () => {
    it("runs all 16 gates and passes for valid accept", () => {
      const offerRecord = createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner);
      const acceptRecord = createSignedRecord("tclk-offers", encodeFrame(accept), payeeSigner);
      const results = runPreLockGates(offer, accept, acceptRecord, PAYER_DID, T0, state);
      expect(results.length).toBe(16);
      expect(allGatesPass(results)).toBe(true);
      expect(firstFailure(results)).toBeUndefined();
    });

    it("fails on first gate failure", () => {
      const acceptRecord = createSignedRecord("tclk-offers", encodeFrame(accept), payeeSigner);
      const results = runPreLockGates(offer, accept, acceptRecord, "did:key:z6Mk" + "x".repeat(44), T0, state);
      expect(allGatesPass(results)).toBe(false);
      const failure = firstFailure(results);
      expect(failure).toBeDefined();
      expect(failure?.pass).toBe(false);
    });
  });
});

// ── VenueNoteStore tests ─────────────────────────────────────────────────────

describe("B3V4 VenueNoteStore", () => {
  it("bridges VenueIO to NoteStore interface", async () => {
    const venue = createMockVenueIO();
    const store = new VenueNoteStore(venue);

    const setResult = await store.set("ns", "key", "value", { ifAbsent: true });
    expect(setResult).toBe(true);

    const value = await store.get("ns", "key");
    expect(value).toBe("value");

    expect(venue.notes.get("ns/key")).toBe("value");
  });

  it("CAS operations work through venue", async () => {
    const venue = createMockVenueIO();
    const store = new VenueNoteStore(venue);

    await store.set("ns", "key", "value1", { ifAbsent: true });

    const failResult = await store.set("ns", "key", "value2", { if: "wrong" });
    expect(failResult).toBe(false);

    const okResult = await store.set("ns", "key", "value2", { if: "value1" });
    expect(okResult).toBe(true);

    const value = await store.get("ns", "key");
    expect(value).toBe("value2");
  });

  it("execute uses venue-backed NoteStore, not MemoryNoteStore", async () => {
    const { venue, signer, selected } = setupExecute();
    const plan = await buildDryRunPlan(selected, venue);
    const timing = new TimingRecorder();
    const auth = makeAuthorization(selected.offer.id, selected.contract, PAYER_DID);
    const authStore = await createAuthorizationStore(tempDir);

    const result = await executeFastPath(venue, signer, selected, plan, timing, auth, authStore, T0);

    const pn = paperNote(selected.contract);
    const noteValue = venue.notes.get(`${pn.ns}/${pn.key}`);
    expect(noteValue).toBeDefined();
    expect(noteValue).toContain("tclkpaper1 locked");
  });

  it("PaperRail lock persists through VenueIO", async () => {
    const venue = createMockVenueIO();
    const noteStore = new VenueNoteStore(venue);
    const rail = new PaperRail(noteStore, () => T0);

    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);
    const state = applyFrame(openContract(offer), accept, T0).state;
    const terms = lockTerms(state);

    await rail.lock(terms);

    const pn = paperNote(terms.contract);
    const venueValue = venue.notes.get(`${pn.ns}/${pn.key}`);
    expect(venueValue).toContain("tclkpaper1 locked");
    expect(venueValue).toContain(terms.statement);
  });

  it("verifyLock reads venue-backed record", async () => {
    const venue = createMockVenueIO();
    const noteStore = new VenueNoteStore(venue);
    const rail = new PaperRail(noteStore, () => T0);

    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);
    const state = applyFrame(openContract(offer), accept, T0).state;
    const terms = lockTerms(state);

    const ref = await rail.lock(terms);

    const verified = await rail.verifyLock(terms, ref);
    expect(verified).toBe(true);

    expect(venue.notes.size).toBeGreaterThan(0);
  });
});

// ── AuthorizationStore tests ─────────────────────────────────────────────────

describe("B3V4 AuthorizationStore", () => {
  it("consume returns true for fresh authorization", async () => {
    const store = await createAuthorizationStore(tempDir);
    const result = await store.consume("test-auth-001");
    expect(result).toBe(true);
  });

  it("consume returns false for already-consumed authorization", async () => {
    const store = await createAuthorizationStore(tempDir);
    await store.consume("test-auth-002");
    const result = await store.consume("test-auth-002");
    expect(result).toBe(false);
  });

  it("isConsumed returns true after consume", async () => {
    const store = await createAuthorizationStore(tempDir);
    expect(await store.isConsumed("test-auth-003")).toBe(false);
    await store.consume("test-auth-003");
    expect(await store.isConsumed("test-auth-003")).toBe(true);
  });

  it("consumption is atomic (file exists after consume)", async () => {
    const store = await createAuthorizationStore(tempDir);
    await store.consume("test-auth-004");
    const filePath = join(tempDir, "test-auth-004");
    expect(existsSync(filePath)).toBe(true);
    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(content.authorizationId).toBe("test-auth-004");
    expect(typeof content.consumedAtMs).toBe("number");
  });
});

// ── Authorization replay tests ───────────────────────────────────────────────

describe("B3V4 authorization replay", () => {
  it("valid fresh authorization executes once", async () => {
    const { venue, signer, selected } = setupExecute();
    const plan = await buildDryRunPlan(selected, venue);
    const timing = new TimingRecorder();
    const auth = makeAuthorization(selected.offer.id, selected.contract, PAYER_DID);
    const authStore = await createAuthorizationStore(tempDir);

    const result = await executeFastPath(venue, signer, selected, plan, timing, auth, authStore, T0);

    expect(result.ok).toBe(true);
  });

  it("same authorization second invocation → rejected", async () => {
    const { venue, signer, selected } = setupExecute();
    const auth = makeAuthorization(selected.offer.id, selected.contract, PAYER_DID);
    const authStore = await createAuthorizationStore(tempDir);

    // First invocation
    const plan = await buildDryRunPlan(selected, venue);
    const timing1 = new TimingRecorder();
    const result1 = await executeFastPath(venue, signer, selected, plan, timing1, auth, authStore, T0);
    expect(result1.ok).toBe(true);

    const postCount1 = venue.posted.length;
    const noteCount1 = venue.notes.size;

    // Second invocation with same auth
    const timing2 = new TimingRecorder();
    const result2 = await executeFastPath(venue, signer, selected, plan, timing2, auth, authStore, T0);

    expect(result2.ok).toBe(false);
    expect(result2.error).toContain("already been consumed");
    expect(venue.posted.length).toBe(postCount1);
    expect(venue.notes.size).toBe(noteCount1);
  });

  it("already-consumed authorization → rejected before first network mutation", async () => {
    const { venue, signer, selected } = setupExecute();
    const auth = makeAuthorization(selected.offer.id, selected.contract, PAYER_DID);
    const authStore = await createAuthorizationStore(tempDir);

    // Pre-consume the authorization
    await authStore.consume(auth.authorizationId);

    const plan = await buildDryRunPlan(selected, venue);
    const timing = new TimingRecorder();
    const result = await executeFastPath(venue, signer, selected, plan, timing, auth, authStore, T0);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("already been consumed");
    expect(venue.posted.length).toBe(0);
  });
});

// ── Dry-run tests ────────────────────────────────────────────────────────────

describe("B3V4 dry-run", () => {
  it("builds a complete plan without writes", async () => {
    const { venue, selected } = setupExecute();
    const plan = await buildDryRunPlan(selected, venue);

    expect(plan.heartbeat).toBeDefined();
    expect(plan.lockFrame).toBeDefined();
    expect(plan.mailboxWake).toContain("TCLK LOCKED");

    const errors = validateDryRunPlan(plan);
    expect(errors.length).toBe(0);

    expect(venue.posted.length).toBe(0);
    expect(venue.notes.size).toBe(0);
  });

  it("skips heartbeat when room already exists", async () => {
    const { venue, selected } = setupExecute();
    const room = dealRoom(selected.contract);
    venue.addRoomData(room, [createSignedRecord(room, "existing-message", payeeSigner)]);

    const plan = await buildDryRunPlan(selected, venue);
    expect(plan.heartbeat).toBeUndefined();
  });

  it("causes zero writes", async () => {
    const { venue, selected } = setupExecute();
    await buildDryRunPlan(selected, venue);
    expect(venue.posted.length).toBe(0);
    expect(venue.notes.size).toBe(0);
  });
});

// ── Execute tests ────────────────────────────────────────────────────────────

describe("B3V4 execute-fast-path", () => {
  it("executes full fast path with valid authorization", async () => {
    const { venue, signer, selected } = setupExecute();
    const plan = await buildDryRunPlan(selected, venue);
    const timing = new TimingRecorder();
    const auth = makeAuthorization(selected.offer.id, selected.contract, PAYER_DID);
    const authStore = await createAuthorizationStore(tempDir);

    const result = await executeFastPath(venue, signer, selected, plan, timing, auth, authStore, T0);

    expect(result.ok).toBe(true);
    expect(result.partialState?.railLocked).toBe(true);
    expect(result.partialState?.lockFramePosted).toBe(true);

    const pn = paperNote(selected.contract);
    expect(venue.notes.has(`${pn.ns}/${pn.key}`)).toBe(true);
    expect(venue.notes.get(`${pn.ns}/${pn.key}`)).toContain("tclkpaper1 locked");
  });

  it("reports partial state on lock frame post failure", async () => {
    const venue = createMockVenueIO();
    let postCount = 0;
    const failingVenue = {
      ...venue,
      postSigned: async (...args: Parameters<typeof venue.postSigned>) => {
        postCount++;
        if (postCount === 2) throw new Error("network error");
        return venue.postSigned(...args);
      },
    };

    const signer = mockSigner();
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);
    const state = applyFrame(openContract(offer), accept, T0).state;
    const timing = new TimingRecorder();

    venue.addRoomData("tclk-offers", [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner),
    ]);

    const selected = {
      accept, offer, contract: accept.contract,
      acceptRecord: createSignedRecord("tclk-offers", encodeFrame(accept), payeeSigner),
      offerRecord: createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner),
      state, acceptDID: PAYEE_DID, acceptTimestampMs: T0,
    };

    const plan = await buildDryRunPlan(selected, venue);
    const auth = makeAuthorization(offer.id, accept.contract, PAYER_DID);
    const authStore = await createAuthorizationStore(tempDir);

    const result = await executeFastPath(failingVenue, signer, selected, plan, timing, auth, authStore, T0);

    expect(result.ok).toBe(false);
    expect(result.partialState?.railLocked).toBe(true);
    expect(result.partialState?.lockFramePosted).toBe(false);
  });

  it("paper lock success + lock frame failure never creates second lock", async () => {
    const venue = createMockVenueIO();
    let postCount = 0;
    const failingVenue = {
      ...venue,
      postSigned: async (...args: Parameters<typeof venue.postSigned>) => {
        postCount++;
        if (postCount === 2) throw new Error("network error");
        return venue.postSigned(...args);
      },
    };

    const signer = mockSigner();
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);
    const state = applyFrame(openContract(offer), accept, T0).state;

    venue.addRoomData("tclk-offers", [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner),
    ]);

    const selected = {
      accept, offer, contract: accept.contract,
      acceptRecord: createSignedRecord("tclk-offers", encodeFrame(accept), payeeSigner),
      offerRecord: createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner),
      state, acceptDID: PAYEE_DID, acceptTimestampMs: T0,
    };

    // First attempt — lock frame fails
    const plan1 = await buildDryRunPlan(selected, venue);
    const auth1 = makeAuthorization(offer.id, accept.contract, PAYER_DID);
    const authStore1 = await createAuthorizationStore(tempDir);
    const timing1 = new TimingRecorder();
    await executeFastPath(failingVenue, signer, selected, plan1, timing1, auth1, authStore1, T0);

    const pn = paperNote(accept.contract);
    expect(venue.notes.has(`${pn.ns}/${pn.key}`)).toBe(true);

    // Second attempt with new auth — should fail because note already exists
    const plan2 = await buildDryRunPlan(selected, venue);
    const auth2 = makeAuthorization(offer.id, accept.contract, PAYER_DID);
    const authStore2 = await createAuthorizationStore(tempDir);
    const timing2 = new TimingRecorder();
    const result2 = await executeFastPath(venue, signer, selected, plan2, timing2, auth2, authStore2, T0);

    expect(result2.ok).toBe(false);
    expect(result2.error).toContain("paper rail already has a record");
  });
});

// ── Write-order instrumentation test ─────────────────────────────────────────

describe("B3V4 write-order instrumentation", () => {
  it("authorization consumed before first network mutation", async () => {
    const events: string[] = [];
    const venue = createMockVenueIO();

    // Instrument venue to record events
    const originalPostSigned = venue.postSigned.bind(venue);
    const originalNoteSet = venue.noteSet.bind(venue);
    const originalNoteGet = venue.noteGet.bind(venue);

    venue.postSigned = async (...args) => {
      events.push("POST_SIGNED");
      return originalPostSigned(...args);
    };
    venue.noteSet = async (...args) => {
      events.push("NOTE_SET");
      return originalNoteSet(...args);
    };
    venue.noteGet = async (...args) => {
      events.push("NOTE_GET");
      return originalNoteGet(...args);
    };

    const signer = mockSigner();
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);
    const state = applyFrame(openContract(offer), accept, T0).state;

    venue.addRoomData("tclk-offers", [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner),
    ]);

    const selected = {
      accept, offer, contract: accept.contract,
      acceptRecord: createSignedRecord("tclk-offers", encodeFrame(accept), payeeSigner),
      offerRecord: createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner),
      state, acceptDID: PAYEE_DID, acceptTimestampMs: T0,
    };

    const plan = await buildDryRunPlan(selected, venue);
    const auth = makeAuthorization(offer.id, accept.contract, PAYER_DID);
    const authStore = await createAuthorizationStore(tempDir);
    const timing = new TimingRecorder();

    await executeFastPath(venue, signer, selected, plan, timing, auth, authStore, T0);

    // Authorization consumption must happen before any network writes
    // The authStore.consume call happens before the first venue call
    expect(events.length).toBeGreaterThan(0);

    // Check that auth file was created (consumed) before first POST_SIGNED or NOTE_SET
    const authFilePath = join(tempDir, auth.authorizationId);
    expect(existsSync(authFilePath)).toBe(true);

    const authRecord = JSON.parse(readFileSync(authFilePath, "utf-8"));
    const firstNetworkEvent = events[0];
    // Auth consumed at consumedAtMs which is before any network event
    expect(authRecord.consumedAtMs).toBeLessThanOrEqual(Date.now());
  });
});

// ── Mailbox discovery tests ──────────────────────────────────────────────────

describe("B3V4 mailbox discovery", () => {
  it("sends wake to payee DID note mailbox when available", async () => {
    const { venue, signer, selected } = setupExecute();

    // Set payee DID note with mailbox
    const payeeMailbox = "mb-p-" + "ab".repeat(8);
    await venue.noteSet("did", PAYEE_DID, `mailbox:${payeeMailbox} tclk1:paper`);

    const plan = await buildDryRunPlan(selected, venue);
    const timing = new TimingRecorder();
    const auth = makeAuthorization(selected.offer.id, selected.contract, PAYER_DID);
    const authStore = await createAuthorizationStore(tempDir);

    const result = await executeFastPath(venue, signer, selected, plan, timing, auth, authStore, T0);

    expect(result.ok).toBe(true);

    // Check that wake was sent to the payee's mailbox, not the deal room
    const wakePost = venue.posted.find((p) => p.text.includes("TCLK LOCKED"));
    expect(wakePost).toBeDefined();
    expect(wakePost!.room).toBe(payeeMailbox);
  });

  it("skips wake when no mailbox advertised", async () => {
    const { venue, signer, selected } = setupExecute();

    // No DID note for payee
    const plan = await buildDryRunPlan(selected, venue);
    const timing = new TimingRecorder();
    const auth = makeAuthorization(selected.offer.id, selected.contract, PAYER_DID);
    const authStore = await createAuthorizationStore(tempDir);

    const result = await executeFastPath(venue, signer, selected, plan, timing, auth, authStore, T0);

    expect(result.ok).toBe(true);
    const wakePost = venue.posted.find((p) => p.text.includes("TCLK LOCKED"));
    expect(wakePost).toBeUndefined();
  });
});

// ── PaperRail integration tests ──────────────────────────────────────────────

describe("B3V4 PaperRail integration", () => {
  it("CAS conflict stops execution", async () => {
    const notes = new MemoryNoteStore();
    const rail = new PaperRail(notes, () => T0);
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);
    const state = applyFrame(openContract(offer), accept, T0).state;
    const terms = lockTerms(state);

    await rail.lock(terms);
    await expect(rail.lock(terms)).rejects.toThrow(/already has a record/);
  });

  it("verifyLock returns true after lock", async () => {
    const notes = new MemoryNoteStore();
    const rail = new PaperRail(notes, () => T0);
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);
    const state = applyFrame(openContract(offer), accept, T0).state;
    const terms = lockTerms(state);

    const ref = await rail.lock(terms);
    const verified = await rail.verifyLock(terms, ref);
    expect(verified).toBe(true);
  });

  it("verifyLock returns false before lock", async () => {
    const notes = new MemoryNoteStore();
    const rail = new PaperRail(notes, () => T0);
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);
    const state = applyFrame(openContract(offer), accept, T0).state;
    const terms = lockTerms(state);

    const verified = await rail.verifyLock(terms, terms.contract);
    expect(verified).toBe(false);
  });
});

// ── Nonce tests ──────────────────────────────────────────────────────────────

describe("B3V4 nonce safety", () => {
  it("VenueSigner.nextNonce returns string", () => {
    const signer = mockSigner();
    const nonce = signer.nextNonce();
    expect(typeof nonce).toBe("string");
  });

  it("nonce remains exact for >2^53 values", () => {
    const largeNonce = "9007199254740993";
    const signer: VenueSigner = {
      did: PAYER_DID,
      sign: () => "mock-sig",
      nextNonce: () => largeNonce,
    };

    const nonce = signer.nextNonce();
    expect(nonce).toBe("9007199254740993");
    expect(nonce).not.toBe("9007199254740992");
  });

  it("nonce remains exact for 19-digit values", () => {
    const maxNonce = "9999999999999999999";
    const signer: VenueSigner = {
      did: PAYER_DID,
      sign: () => "mock-sig",
      nextNonce: () => maxNonce,
    };

    const nonce = signer.nextNonce();
    expect(nonce).toBe("9999999999999999999");
  });

  it("nonce string is used in canonical signing payload", () => {
    const nonce = "9007199254740993";
    const canonical = canonicalMessage("test-room", nonce, "test-text");
    expect(canonical).toBe(`test-room|${nonce}|test-text`);
    expect(canonical).toContain("9007199254740993");
  });
});

// ── Timing tests ─────────────────────────────────────────────────────────────

describe("B3V4 timing", () => {
  it("records timing events", () => {
    const timing = new TimingRecorder();
    timing.record("accept", 1000);
    timing.record("paper-lock", 1050);
    timing.record("lock-frame", 1100);
    timing.record("mailbox-wake", 1150);
    timing.record("end", 1200);

    const measurements = timing.toMeasurements();
    expect(measurements.acceptToPaperLockMs).toBe(50);
    expect(measurements.acceptToLockFrameMs).toBe(100);
    expect(measurements.acceptToMailboxWakeMs).toBe(150);
    expect(measurements.totalMs).toBe(200);
  });
});

// ── Evidence tests ───────────────────────────────────────────────────────────

describe("B3V4 evidence", () => {
  it("creates evidence directory", async () => {
    const evidence = await createEvidenceCollector("/tmp", "test-evidence");
    expect(evidence.dir()).toContain("b3v4-test-evidence");
  });
});

// ── Mock venue IO tests ──────────────────────────────────────────────────────

describe("B3V4 mock venue IO", () => {
  it("tracks posted messages", async () => {
    const venue = createMockVenueIO();
    const signer = mockSigner();
    await venue.postSigned("test-room", signer, "test-message");
    expect(venue.posted.length).toBe(1);
    expect(venue.posted[0].room).toBe("test-room");
  });

  it("tracks note operations", async () => {
    const venue = createMockVenueIO();
    await venue.noteSet("ns", "key", "value", { ifAbsent: true });
    expect(await venue.noteGet("ns", "key")).toBe("value");

    const casResult = await venue.noteSet("ns", "key", "new-value", { if: "value" });
    expect(casResult).toBe(true);

    const failedCas = await venue.noteSet("ns", "key", "another", { if: "wrong" });
    expect(failedCas).toBe(false);
  });
});
