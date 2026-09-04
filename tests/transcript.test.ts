// SPDX-License-Identifier: Apache-2.0

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vitest";

import {
  encodeFrame,
  dealRoom,
  dealRoomSpan,
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

describe("derived deal-room continuity", () => {
  function rows() {
    const { lock, offer, accept } = deal();
    const room = dealRoom(accept.contract);
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
    const refund = { type: "refund" as const, from: payer.did, contract: accept.contract };
    return {
      contract: accept.contract,
      room,
      board: [
        record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
        record(BOARD, 2, NOW, payee, encodeFrame(accept)),
      ],
      lockRow: record(room, 1, NOW + 1, payer, encodeFrame(lockFrame)),
      revealRow: record(room, 2, NOW + 2, payee, encodeFrame(reveal)),
      refundRow: (seq: number) =>
        record(room, seq, NOW + 7_200_001, payer, encodeFrame(refund)),
    };
  }

  it("counts a whole deal room as gap free, and ignores the board rows", () => {
    const supplied = rows();
    expect(
      dealRoomSpan([...supplied.board, supplied.lockRow, supplied.revealRow], supplied.contract),
    ).toEqual({
      room: supplied.room,
      count: 2,
      firstSeq: 1,
      lastSeq: 2,
      gapFree: true,
    });
  });

  it("detects the deleted reveal that folds a claimed deal to refunded with no bad step", () => {
    const supplied = rows();
    const censored = [...supplied.board, supplied.lockRow, supplied.refundRow(3)];

    const folded = foldTranscript(censored);
    expect(folded.state?.status).toBe("refunded");
    expect(folded.steps.every((step) => step.ok)).toBe(true);

    expect(dealRoomSpan(censored, supplied.contract)).toMatchObject({
      count: 2,
      firstSeq: 1,
      lastSeq: 3,
      gapFree: false,
    });
  });

  it("does not detect the same deletion once the kept rows are renumbered", () => {
    const supplied = rows();
    // `seq` is venue metadata outside the signed `room|nonce|line` preimage, so the refund
    // still verifies at 2. This pins the limit rather than claiming it away: counting catches
    // a careless editor, and "no gap detected" must never be read as "transcript complete".
    const renumbered = [...supplied.board, supplied.lockRow, supplied.refundRow(2)];
    expect(foldTranscript(renumbered).state?.status).toBe("refunded");
    expect(dealRoomSpan(renumbered, supplied.contract).gapFree).toBe(true);
  });

  it("does not let an unsigned row close a hole", () => {
    const supplied = rows();
    const padding = { ...supplied.revealRow, nonce: null, signature: null };
    const padded = [...supplied.board, supplied.lockRow, padding, supplied.refundRow(3)];

    expect(dealRoomSpan(padded, supplied.contract)).toMatchObject({
      count: 2,
      lastSeq: 3,
      gapFree: false,
    });
  });
});
