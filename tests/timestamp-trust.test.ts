// SPDX-License-Identifier: Apache-2.0
//
// Tests for timestamp trust boundary (issue #96). Verify that foldTranscript emits
// warnings when metadata anomalies or deadline-sensitive transitions rely on unsigned
// venue timestamps. Reproduce the exact attack: tampered reveal.timestampMs flips
// claimed → refunded while all signatures still verify.

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vitest";

import {
  encodeFrame,
  dealRoom,
  foldTranscript,
  generateHashLock,
  makeAccept,
  makeOffer,
  verifyTranscriptRecord,
  type TranscriptRecord,
} from "../src/index.js";

const NOW = 1_735_000_000_000;
const BOARD = "tclk-offers";
const CLAIM_BY = NOW + 3_600_000; // +1h
const REFUND_AFTER = NOW + 7_200_000; // +2h

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

function baseDeal(expiresMs = NOW + 600_000) {
  const lock = generateHashLock();
  const offer = makeOffer({
    from: payer.did,
    role: "payer",
    amount: "1000",
    asset: "USDC",
    lock: "hash",
    rails: ["flop-htlc"],
    claimByMs: CLAIM_BY,
    refundAfterMs: REFUND_AFTER,
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

describe("timestamp trust boundary — issue #96 attack reproduction", () => {
  it("honest transcript → claimed, warnings only generic deadline disclosure", () => {
    const { lock, offer, accept } = baseDeal();
    const dealRoomName = dealRoom(accept.contract);

    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-42",
    };

    const revealFrame = {
      type: "reveal" as const,
      from: payee.did,
      contract: accept.contract,
      ref: "escrow-42",
      secret: lock.preimage,
    };

    const refundFrame = {
      type: "refund" as const,
      from: payer.did,
      contract: accept.contract,
      ref: "escrow-42",
    };

    // Honest timeline: reveal at +30min (before refund window), refund at +2h+5s (after window opens)
    const honestRecords = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW + 1000, payee, encodeFrame(accept)),
      record(dealRoomName, 1, NOW + 2000, payer, encodeFrame(lockFrame)),
      record(dealRoomName, 2, NOW + 1_800_000, payee, encodeFrame(revealFrame)), // +30min
      record(dealRoomName, 3, REFUND_AFTER + 5000, payer, encodeFrame(refundFrame)), // +2h+5s
    ];

    const folded = foldTranscript(honestRecords);

    // Reveal succeeds before refund window, refund rejected → claimed
    expect(folded.state?.status).toBe("claimed");
    expect(folded.steps[3].ok).toBe(true); // reveal accepted
    expect(folded.steps[4].ok).toBe(false); // refund rejected (already claimed)

    // Only generic deadline warning, no anomalies
    expect(folded.warnings).toHaveLength(1);
    expect(folded.warnings[0]).toMatch(/unsigned metadata.*deadline-sensitive frames/);
  });

  it("tampered reveal.timestampMs → refunded, warnings include backwards timestamp", () => {
    const { lock, offer, accept } = baseDeal();
    const dealRoomName = dealRoom(accept.contract);

    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-42",
    };

    const revealFrame = {
      type: "reveal" as const,
      from: payee.did,
      contract: accept.contract,
      ref: "escrow-42",
      secret: lock.preimage,
    };

    const refundFrame = {
      type: "refund" as const,
      from: payer.did,
      contract: accept.contract,
      ref: "escrow-42",
    };

    // Attack: tamper reveal.timestampMs to be AFTER refund window (but signature still verifies)
    const honestRevealRecord = record(dealRoomName, 2, NOW + 1_800_000, payee, encodeFrame(revealFrame));
    const tamperedRevealRecord = { ...honestRevealRecord, timestampMs: REFUND_AFTER + 10_000 };

    // Signature still verifies because timestampMs is not in the signed preimage
    expect(verifyTranscriptRecord(tamperedRevealRecord).ok).toBe(true);

    const tamperedRecords = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW + 1000, payee, encodeFrame(accept)),
      record(dealRoomName, 1, NOW + 2000, payer, encodeFrame(lockFrame)),
      tamperedRevealRecord, // reveal now appears at +2h+10s
      record(dealRoomName, 3, REFUND_AFTER + 5000, payer, encodeFrame(refundFrame)), // +2h+5s
    ];

    const folded = foldTranscript(tamperedRecords);

    // Reveal rejected (after refund window), refund succeeds → refunded (flipped outcome!)
    expect(folded.state?.status).toBe("refunded");
    expect(folded.steps[3].ok).toBe(false); // reveal rejected
    expect(folded.steps[4].ok).toBe(true); // refund accepted

    // Warnings include backwards timestamp (seq 2 @ +2h+10s, then seq 3 @ +2h+5s)
    expect(folded.warnings.length).toBeGreaterThanOrEqual(2);
    const backwardsWarning = folded.warnings.find(w => w.includes("backwards"));
    expect(backwardsWarning).toBeDefined();
    expect(backwardsWarning).toMatch(/backwards timestamp/);
  });

  it("verifyTranscriptRecord still returns ok:true on tampered timestampMs", () => {
    const { offer } = baseDeal();
    const honest = record(BOARD, 1, NOW, payer, encodeFrame(offer));
    const tampered = { ...honest, timestampMs: NOW + 999_999_999 };

    // Both verify because timestampMs is not covered by signature
    expect(verifyTranscriptRecord(honest).ok).toBe(true);
    expect(verifyTranscriptRecord(tampered).ok).toBe(true);
  });
});

describe("timestamp trust boundary — seq gap detection", () => {
  it("emits warning on seq gap in same room", () => {
    const { offer } = baseDeal();
    const records = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 3, NOW + 1000, payer, encodeFrame(offer)), // gap: 1 → 3
      record(BOARD, 4, NOW + 2000, payer, encodeFrame(offer)),
    ];

    const folded = foldTranscript(records);
    expect(folded.warnings.some(w => w.includes("seq gap") && w.includes("seq 1") && w.includes("3"))).toBe(true);
  });

  it("emits warning only once per room for multiple gaps", () => {
    const { offer } = baseDeal();
    const records = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 3, NOW + 1000, payer, encodeFrame(offer)), // first gap
      record(BOARD, 7, NOW + 2000, payer, encodeFrame(offer)), // second gap
    ];

    const folded = foldTranscript(records);
    const gapWarnings = folded.warnings.filter(w => w.includes("gap"));
    expect(gapWarnings).toHaveLength(1);
  });

  it("tracks seq gaps independently per room", () => {
    const { offer, accept } = baseDeal();
    const dealRoomName = dealRoom(accept.contract);

    const records = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 3, NOW + 1000, payee, encodeFrame(accept)), // gap in BOARD
      record(dealRoomName, 1, NOW + 2000, payer, encodeFrame({
        type: "lock" as const,
        from: payer.did,
        contract: accept.contract,
        rail: "flop-htlc",
        ref: "r1",
      })),
      record(dealRoomName, 5, NOW + 3000, payer, encodeFrame({
        type: "cancel" as const,
        from: payer.did,
        contract: accept.contract,
      })), // gap in deal room
    ];

    const folded = foldTranscript(records);
    expect(folded.warnings.filter(w => w.includes("gap"))).toHaveLength(2);
  });
});

describe("timestamp trust boundary — seq ordering violations", () => {
  it("emits warning when seq not strictly increasing", () => {
    const { offer } = baseDeal();
    const records = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 3, NOW + 1000, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW + 2000, payer, encodeFrame(offer)), // 3 → 2 backwards
    ];

    const folded = foldTranscript(records);
    expect(folded.warnings.some(w => w.includes("not greater than"))).toBe(true);
  });

  it("emits warning on duplicate seq", () => {
    const { offer } = baseDeal();
    const records = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW + 1000, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW + 2000, payer, encodeFrame(offer)), // duplicate seq 2
    ];

    const folded = foldTranscript(records);
    expect(folded.warnings.some(w => w.includes("not greater than"))).toBe(true);
  });

  it("emits ordering warning only once per room", () => {
    const { offer } = baseDeal();
    const records = [
      record(BOARD, 5, NOW, payer, encodeFrame(offer)),
      record(BOARD, 3, NOW + 1000, payer, encodeFrame(offer)), // first violation
      record(BOARD, 1, NOW + 2000, payer, encodeFrame(offer)), // second violation
    ];

    const folded = foldTranscript(records);
    const orderWarnings = folded.warnings.filter(w => w.includes("not greater than"));
    expect(orderWarnings).toHaveLength(1);
  });
});

describe("timestamp trust boundary — backwards timestamp detection", () => {
  it("emits warning when timestamp goes backwards", () => {
    const { offer } = baseDeal();
    const records = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW + 5000, payer, encodeFrame(offer)),
      record(BOARD, 3, NOW + 2000, payer, encodeFrame(offer)), // time goes backwards
    ];

    const folded = foldTranscript(records);
    expect(folded.warnings.some(w => w.includes("backwards timestamp"))).toBe(true);
  });

  it("emits backwards warning only once per room", () => {
    const { offer } = baseDeal();
    const records = [
      record(BOARD, 1, NOW + 10_000, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW + 5_000, payer, encodeFrame(offer)), // first backwards
      record(BOARD, 3, NOW + 3_000, payer, encodeFrame(offer)), // second backwards
    ];

    const folded = foldTranscript(records);
    const backwardsWarnings = folded.warnings.filter(w => w.includes("backwards"));
    expect(backwardsWarnings).toHaveLength(1);
  });
});

describe("timestamp trust boundary — generic deadline warning", () => {
  it("emits generic warning when accept frame succeeds", () => {
    const { offer, accept } = baseDeal();
    const records = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW + 1000, payee, encodeFrame(accept)),
    ];

    const folded = foldTranscript(records);
    expect(folded.warnings.some(w => w.includes("unsigned metadata"))).toBe(true);
  });

  it("emits generic warning when lock frame succeeds", () => {
    const { offer, accept } = baseDeal();
    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-1",
    };

    const records = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW + 1000, payee, encodeFrame(accept)),
      record(dealRoom(accept.contract), 1, NOW + 2000, payer, encodeFrame(lockFrame)),
    ];

    const folded = foldTranscript(records);
    expect(folded.warnings.some(w => w.includes("unsigned metadata"))).toBe(true);
  });

  it("emits generic warning when reveal frame succeeds", () => {
    const { lock, offer, accept } = baseDeal();
    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-2",
    };
    const revealFrame = {
      type: "reveal" as const,
      from: payee.did,
      contract: accept.contract,
      ref: "escrow-2",
      secret: lock.preimage,
    };

    const records = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW + 1000, payee, encodeFrame(accept)),
      record(dealRoom(accept.contract), 1, NOW + 2000, payer, encodeFrame(lockFrame)),
      record(dealRoom(accept.contract), 2, NOW + 3000, payee, encodeFrame(revealFrame)),
    ];

    const folded = foldTranscript(records);
    expect(folded.warnings.some(w => w.includes("unsigned metadata"))).toBe(true);
  });

  it("emits generic warning when refund frame succeeds", () => {
    const { offer, accept } = baseDeal(NOW + 8_000_000);
    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-3",
    };
    const refundFrame = {
      type: "refund" as const,
      from: payer.did,
      contract: accept.contract,
      ref: "escrow-3",
    };

    const records = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW + 1000, payee, encodeFrame(accept)),
      record(dealRoom(accept.contract), 1, NOW + 2000, payer, encodeFrame(lockFrame)),
      record(dealRoom(accept.contract), 2, REFUND_AFTER + 1000, payer, encodeFrame(refundFrame)),
    ];

    const folded = foldTranscript(records);
    expect(folded.warnings.some(w => w.includes("unsigned metadata"))).toBe(true);
  });

  it("does NOT emit generic warning when no deadline frames present", () => {
    const { offer } = baseDeal();
    const anotherOffer = makeOffer({
      from: payee.did,
      role: "payee",
      amount: "2000000",
      asset: "USDC",
      lock: "hash",
      rails: ["flop-htlc"],
      claimByMs: NOW + 3_600_000,
      refundAfterMs: NOW + 7_200_000,
      expiresMs: NOW + 600_000,
      nonce: "abcd1234",
    });

    const records = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW + 1000, payee, encodeFrame(anotherOffer)),
    ];

    const folded = foldTranscript(records);
    expect(folded.warnings.some(w => w.includes("unsigned metadata"))).toBe(false);
  });

  it("does NOT emit generic warning when all deadline frames rejected", () => {
    const { offer, accept } = baseDeal(NOW + 100); // expires almost immediately
    const records = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW + 200, payee, encodeFrame(accept)), // expired, rejected
    ];

    const folded = foldTranscript(records);
    expect(folded.steps[1].ok).toBe(false);
    expect(folded.warnings.some(w => w.includes("unsigned metadata"))).toBe(false);
  });
});

describe("timestamp trust boundary — combined scenarios", () => {
  it("emits multiple anomaly warnings plus generic warning", () => {
    const { lock, offer, accept } = baseDeal();
    const dealRoomName = dealRoom(accept.contract);

    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-4",
    };

    const revealFrame = {
      type: "reveal" as const,
      from: payee.did,
      contract: accept.contract,
      ref: "escrow-4",
      secret: lock.preimage,
    };

    const records = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      record(BOARD, 3, NOW + 1000, payee, encodeFrame(accept)), // gap: 1 → 3
      record(dealRoomName, 2, NOW + 3000, payer, encodeFrame(lockFrame)),
      record(dealRoomName, 3, NOW + 2000, payee, encodeFrame(revealFrame)), // backwards time
    ];

    const folded = foldTranscript(records);
    expect(folded.warnings.length).toBeGreaterThanOrEqual(3);
    expect(folded.warnings.some(w => w.includes("gap"))).toBe(true);
    expect(folded.warnings.some(w => w.includes("backwards"))).toBe(true);
    expect(folded.warnings.some(w => w.includes("unsigned metadata"))).toBe(true);
  });

  it("skips anomaly checks for unsigned records", () => {
    const { offer } = baseDeal();

    const unsigned = record(BOARD, 2, NOW + 1000, payer, encodeFrame(offer));
    unsigned.signature = null;
    unsigned.nonce = null;

    const records = [
      record(BOARD, 1, NOW, payer, encodeFrame(offer)),
      unsigned, // unverified, should be skipped
      record(BOARD, 4, NOW + 2000, payer, encodeFrame(offer)), // gap 1 → 4
    ];

    const folded = foldTranscript(records);
    const gapWarning = folded.warnings.find(w => w.includes("gap"));
    expect(gapWarning).toBeDefined();
    expect(gapWarning).toMatch(/seq 1.*4/); // gap is 1 → 4, seq 2 was skipped
  });
});

