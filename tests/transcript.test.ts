// SPDX-License-Identifier: Apache-2.0

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vitest";

import {
  encodeFrame,
  dealRoom,
  findContractHandshake,
  foldTranscript,
  generateHashLock,
  makeAccept,
  makeOffer,
  parseTranscriptExport,
  type TranscriptRecord,
} from "../src/index.js";

const NOW = 1_735_000_000_000;
const BOARD = "tclk-offers";

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((part) => Number.parseInt(part, 16)));
}

function identity(seedHex: string) {
  const seed = bytes(seedHex);
  const publicKey = ed25519.getPublicKey(seed);
  const tagged = Uint8Array.from([0xed, 0x01, ...publicKey]);
  return {
    did: `did:key:z${base58.encode(tagged)}`,
    sign(canonical: string) {
      return base64urlnopad.encode(ed25519.sign(new TextEncoder().encode(canonical), seed));
    },
  };
}

const payer = identity("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const payee = identity("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
const stranger = identity("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7");

function record(
  room: string,
  seq: number,
  timestampMs: number,
  signer: ReturnType<typeof identity>,
  line: string,
): TranscriptRecord {
  const nonce = String(10_000 + seq);
  return {
    room,
    seq,
    timestampMs,
    sender: signer.did,
    nonce,
    signature: signer.sign(`${room}|${nonce}|${line}`),
    line,
  };
}

function deal(expiresMs = NOW + 60_000) {
  const lock = generateHashLock();
  const offer = makeOffer({
    from: payer.did,
    role: "payer",
    amount: "1000",
    asset: "USDC",
    lock: "hash",
    rails: ["flop-htlc"],
    claimByMs: NOW + 3_600_000,
    refundAfterMs: NOW + 7_200_000,
    expiresMs,
    nonce: "0011223344556677",
  });
  const accept = makeAccept(offer, {
    from: payee.did,
    statement: lock.hash,
    nonce: "8899aabbccddeeff",
  });
  return { lock, offer, accept };
}

describe("trusted transcript records", () => {
  it("authenticates and folds a complete deal at each record's own timestamp", () => {
    const { lock, offer, accept } = deal();
    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-42",
    };
    const reveal = {
      type: "reveal" as const,
      from: payee.did,
      contract: accept.contract,
      secret: lock.preimage,
    };
    const folded = foldTranscript([
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW, payee, encodeFrame(accept)),
      record(dealRoom(accept.contract), 1, NOW + 1, payer, encodeFrame(lockFrame)),
      record(dealRoom(accept.contract), 2, NOW + 2, payee, encodeFrame(reveal)),
    ]);

    expect(folded.steps.map((step) => step.ok)).toEqual([true, true, true, true]);
    expect(folded.state?.status).toBe("claimed");
  });

  it("rejects a validly signed record when the frame claims a different sender", () => {
    const { offer, accept } = deal();
    const forgedLock = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-does-not-exist",
    };
    const folded = foldTranscript([
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW, payee, encodeFrame(accept)),
      record(dealRoom(accept.contract), 1, NOW + 1, stranger, encodeFrame(forgedLock)),
    ]);

    expect(folded.state?.status).toBe("accepted");
    expect(folded.steps[2]).toMatchObject({
      ok: false,
      reason: "lock.from does not match the record sender",
    });
  });

  it("rejects a valid post-accept frame outside the contract's derived deal room", () => {
    const { offer, accept } = deal();
    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-wrong-room",
    };
    const folded = foldTranscript([
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW, payee, encodeFrame(accept)),
      record("lobby", 3, NOW + 1, payer, encodeFrame(lockFrame)),
    ]);

    expect(folded.state?.status).toBe("accepted");
    expect(folded.steps[2]).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/derived deal room/),
    });
  });

  it("rejects unsigned records and malformed timestamps without a fallback clock", () => {
    const { offer } = deal();
    const unsigned = record(BOARD, 1, NOW, payer, encodeFrame(offer));
    unsigned.signature = null;
    const malformedTime = record(BOARD, 2, NOW, payer, encodeFrame(offer));
    malformedTime.timestampMs = Number.NaN;

    const tampered = record(BOARD, 3, NOW, payer, encodeFrame(offer));
    tampered.line += " ";

    const folded = foldTranscript([unsigned, malformedTime, tampered]);
    expect(folded.state).toBeNull();
    expect(folded.steps[0].reason).toBe("record is unsigned");
    expect(folded.steps[1].reason).toMatch(/timestampMs/);
    expect(folded.steps[2].reason).toBe("record signature does not verify");
  });

  it("judges a refund at the refund record's timestamp", () => {
    const { offer, accept } = deal(NOW + 7_800_000);
    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-43",
    };
    const refund = { type: "refund" as const, from: payer.did, contract: accept.contract };
    const folded = foldTranscript([
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW, payee, encodeFrame(accept)),
      record(dealRoom(accept.contract), 1, NOW + 1, payer, encodeFrame(lockFrame)),
      record(dealRoom(accept.contract), 2, offer.refundAfterMs, payer, encodeFrame(refund)),
    ]);

    expect(folded.state?.status).toBe("refunded");
    expect(folded.steps.map((step) => step.ok)).toEqual([true, true, true, true]);
  });

  it("parses exports strictly and preserves the signed bytes", () => {
    const { offer } = deal();
    const line = encodeFrame(offer);
    const signed = record(BOARD, 7, NOW, payer, line);
    const raw = JSON.stringify({
      seq: signed.seq,
      ts: new Date(signed.timestampMs).toISOString(),
      from: signed.sender,
      nonce: signed.nonce,
      sig: signed.signature,
      text: signed.line,
    });

    expect(parseTranscriptExport(BOARD, `${raw}\n`)).toEqual([signed]);
    expect(() => parseTranscriptExport(BOARD, `${raw}\nnot json\n`)).toThrow(/line 2/);

    const withoutTimezone = JSON.stringify({
      ...JSON.parse(raw),
      ts: "2026-01-01T00:00:00",
    });
    const localeTimestamp = JSON.stringify({
      ...JSON.parse(raw),
      ts: "January 1, 2026 00:00:00",
    });
    expect(() => parseTranscriptExport(BOARD, withoutTimezone)).toThrow(/timezone-qualified/);
    expect(() => parseTranscriptExport(BOARD, localeTimestamp)).toThrow(/timezone-qualified/);
  });

  it("never synthesizes offer-before-accept order while selecting a board handshake", () => {
    const { offer, accept } = deal();
    const earlyAccept = record(BOARD, 1, NOW - 1, payee, encodeFrame(accept));
    const laterOffer = record(BOARD, 2, NOW, payer, encodeFrame(offer));

    expect(() => findContractHandshake(
      [earlyAccept, laterOffer],
      accept.contract,
    )).toThrow(/no preceding authenticated offer/);

    const offerRecord = record(BOARD, 1, NOW - 1, payer, encodeFrame(offer));
    const acceptRecord = record(BOARD, 2, NOW, payee, encodeFrame(accept));
    expect(findContractHandshake(
      [offerRecord, acceptRecord],
      accept.contract,
    )).toEqual({ offer: offerRecord, accept: acceptRecord });
  });
});

describe("strict deadline folding (#96)", () => {
  function revealDeal() {
    const { lock, offer, accept } = deal();
    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-96",
    };
    const reveal = {
      type: "reveal" as const,
      from: payee.did,
      contract: accept.contract,
      secret: lock.preimage,
    };
    return [
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW, payee, encodeFrame(accept)),
      record(dealRoom(accept.contract), 1, NOW + 1, payer, encodeFrame(lockFrame)),
      record(dealRoom(accept.contract), 2, NOW + 2, payee, encodeFrame(reveal)),
    ];
  }

  it("plain fold still trusts venue time and reaches claimed", () => {
    const folded = foldTranscript(revealDeal());
    expect(folded.state?.status).toBe("claimed");
    expect(folded.steps.map((step) => step.ok)).toEqual([true, true, true, true]);
  });

  it("strict fold refuses to certify a claim that rests on the unsigned timestamp", () => {
    const folded = foldTranscript(revealDeal(), { strictDeadlines: true });
    expect(folded.steps.slice(0, 3).map((step) => step.ok)).toEqual([true, true, true]);
    expect(folded.steps[3]).toMatchObject({
      type: "reveal",
      ok: false,
      reason: expect.stringMatching(/unsigned venue timestamp/),
    });
    expect(folded.state?.status).toBe("locked");
  });

  it("the reveal signature still verifies after its timestamp is moved past the refund window", () => {
    const records = revealDeal();
    const forged = { ...records[3], timestampMs: records[3].timestampMs + 7_200_000 };
    // Only timestampMs changed. The signature covers room|nonce|line, so the record still
    // authenticates, and the plain fold now rejects the reveal and holds at locked. Same
    // signed bytes, a different terminal outcome, decided entirely by venue time. That is #96.
    const plain = foldTranscript([records[0], records[1], records[2], forged]);
    expect(plain.steps[3]).toMatchObject({ ok: false, reason: expect.stringMatching(/refund window/) });
    expect(plain.state?.status).toBe("locked");
  });

  it("strict fold refuses a refund verdict too", () => {
    const { offer, accept } = deal(NOW + 7_800_000);
    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-96r",
    };
    const refund = { type: "refund" as const, from: payer.did, contract: accept.contract };
    const records = [
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW, payee, encodeFrame(accept)),
      record(dealRoom(accept.contract), 1, NOW + 1, payer, encodeFrame(lockFrame)),
      record(dealRoom(accept.contract), 2, offer.refundAfterMs, payer, encodeFrame(refund)),
    ];
    expect(foldTranscript(records).state?.status).toBe("refunded");
    const strict = foldTranscript(records, { strictDeadlines: true });
    expect(strict.steps[3]).toMatchObject({
      type: "refund",
      ok: false,
      reason: expect.stringMatching(/unsigned venue timestamp/),
    });
    expect(strict.state?.status).toBe("locked");
  });

  it("does not guard the accept or lock deadlines, which still read unsigned time", () => {
    // strictDeadlines refuses only the terminal reveal and refund verdicts. accept and lock
    // also gate on the record's unsigned timestampMs (offer.expiresMs and offer.refundAfterMs
    // in src/machine.ts), so editing one of those flips the fold before it ever reaches locked
    // and strict mode stays silent. This pins that remaining trust boundary.
    const { lock, offer, accept } = deal();
    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-96l",
    };
    const reveal = {
      type: "reveal" as const,
      from: payee.did,
      contract: accept.contract,
      secret: lock.preimage,
    };
    const honest = [
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW, payee, encodeFrame(accept)),
      record(dealRoom(accept.contract), 1, NOW + 1, payer, encodeFrame(lockFrame)),
      record(dealRoom(accept.contract), 2, NOW + 2, payee, encodeFrame(reveal)),
    ];
    // With honest timestamps strict mode holds at locked, the PR's safe stop.
    const honestStrict = foldTranscript(honest, { strictDeadlines: true });
    expect(honestStrict.state?.status).toBe("locked");

    // Move only the lock's unsigned timestamp to the refund boundary. The signature covers
    // room|nonce|line, so the record still authenticates.
    const forged = [...honest];
    forged[2] = { ...honest[2], timestampMs: offer.refundAfterMs };
    const strict = foldTranscript(forged, { strictDeadlines: true });

    // The lock is refused by the ordinary machine guard, not the strict #96 guard, so the
    // fold stalls at accepted. The outcome diverged before locked, driven by unsigned time,
    // and no step carries the #96 refusal reason.
    expect(strict.steps[2]).toMatchObject({
      type: "lock",
      ok: false,
      reason: "refund window is already open",
    });
    expect(strict.state?.status).toBe("accepted");
    expect(honestStrict.state?.status).not.toBe(strict.state?.status);
    expect(strict.steps.some((step) => /unsigned venue timestamp/.test(step.reason ?? ""))).toBe(false);

    // strictDeadlines changed nothing on this path: the plain fold of the same forged records
    // stalls at accepted too. The flag never reaches the accept or lock guards.
    expect(foldTranscript(forged).state?.status).toBe("accepted");
  });

  it("terminal state alone never upgrades evidence: terminal is rail-required, all else coordination-only", () => {
    // The fold has no rail-authoritative input, so a terminal verdict rests on the signed
    // transcript plus unsigned venue time. terminalEvidence must report every terminal
    // status as rail-required, never as anything a consumer could read as settled, and a
    // non-terminal or empty fold as coordination-only. This is the trust boundary the result
    // carries alongside state.status, so a caller reads it rather than the status.

    // claimed, reached only through venue time, still classifies rail-required.
    const claimed = foldTranscript(revealDeal());
    expect(claimed.state?.status).toBe("claimed");
    expect(claimed.terminalEvidence).toBe("rail-required");

    // refunded, the other time-driven terminal, is rail-required too.
    const { offer, accept } = deal(NOW + 7_800_000);
    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-96e",
    };
    const refund = { type: "refund" as const, from: payer.did, contract: accept.contract };
    const refunded = foldTranscript([
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW, payee, encodeFrame(accept)),
      record(dealRoom(accept.contract), 1, NOW + 1, payer, encodeFrame(lockFrame)),
      record(dealRoom(accept.contract), 2, offer.refundAfterMs, payer, encodeFrame(refund)),
    ]);
    expect(refunded.state?.status).toBe("refunded");
    expect(refunded.terminalEvidence).toBe("rail-required");

    // cancelled is terminal, so rail-required, even though it never turned on a deadline.
    const cancel = { type: "cancel" as const, from: payee.did, contract: accept.contract };
    const cancelled = foldTranscript([
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW, payee, encodeFrame(accept)),
      record(dealRoom(accept.contract), 1, NOW + 1, payee, encodeFrame(cancel)),
    ]);
    expect(cancelled.state?.status).toBe("cancelled");
    expect(cancelled.terminalEvidence).toBe("rail-required");

    // A clean strict fold that safely holds at locked is non-terminal, so coordination-only.
    // The clean strict fold is not settlement evidence, which is the boundary that matters.
    const heldAtLocked = foldTranscript(revealDeal(), { strictDeadlines: true });
    expect(heldAtLocked.state?.status).toBe("locked");
    expect(heldAtLocked.terminalEvidence).toBe("coordination-only");

    // An empty fold has no state at all, coordination-only and never rail-required.
    expect(foldTranscript([]).terminalEvidence).toBe("coordination-only");
  });
});
