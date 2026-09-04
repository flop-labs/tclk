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

  it("reads post-accept frames from the board only in offer-room mode", () => {
    // A payer refused a new room by the venue's per-client rate_rooms_per_day announces the
    // lock on tclk-offers. Strict stays strict; offer-room mode folds the same records to
    // claimed.
    const { lock, offer, accept } = deal();
    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-on-the-board",
    };
    const reveal = {
      type: "reveal" as const,
      from: payee.did,
      contract: accept.contract,
      ref: "escrow-on-the-board",
      secret: lock.preimage,
    };
    const records = [
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW, payee, encodeFrame(accept)),
      record(BOARD, 3, NOW + 1, payer, encodeFrame(lockFrame)),
      record(BOARD, 4, NOW + 2, payee, encodeFrame(reveal)),
    ];

    const strict = foldTranscript(records);
    expect(strict.state?.status).toBe("accepted");
    expect(strict.steps[2]).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/derived deal room/),
    });

    const relaxed = foldTranscript(records, { roomBinding: "offer-room" });
    expect(relaxed.steps.map((step) => step.ok)).toEqual([true, true, true, true]);
    expect(relaxed.state?.status).toBe("claimed");
    expect(relaxed.state?.secret).toBe(lock.preimage);

    // One room per mode: in offer-room mode the derived room is the wrong room.
    const mixed = foldTranscript(
      [records[0], records[1], record(dealRoom(accept.contract), 1, NOW + 1, payer, encodeFrame(lockFrame))],
      { roomBinding: "offer-room" },
    );
    expect(mixed.state?.status).toBe("accepted");
    expect(mixed.steps[2]).toMatchObject({ ok: false, reason: "lock must be posted in tclk-offers" });
  });

  it("gives one answer regardless of how two rooms' records are interleaved", () => {
    // Regression for the review on #62: a valid payer cancel on the board and a valid payer
    // lock in the derived room, same millisecond. With both rooms admitted the verdict would
    // depend on caller order; with one room per mode it does not.
    const { offer, accept } = deal();
    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-tie",
    };
    const cancel = { type: "cancel" as const, from: payer.did, contract: accept.contract };
    const board = [
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW, payee, encodeFrame(accept)),
    ];
    const cancelOnBoard = record(BOARD, 3, NOW + 1, payer, encodeFrame(cancel));
    const lockInRoom = record(dealRoom(accept.contract), 1, NOW + 1, payer, encodeFrame(lockFrame));

    for (const tail of [[cancelOnBoard, lockInRoom], [lockInRoom, cancelOnBoard]]) {
      expect(foldTranscript([...board, ...tail]).state?.status).toBe("locked");
      expect(foldTranscript([...board, ...tail], { roomBinding: "offer-room" }).state?.status)
        .toBe("cancelled");
    }
  });

  it("keeps every other guard in offer-room mode", () => {
    const { lock, offer, accept } = deal();
    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-44",
    };
    const strangerReveal = {
      type: "reveal" as const,
      from: stranger.did,
      contract: accept.contract,
      ref: "escrow-44",
      secret: lock.preimage,
    };
    const wrongSecret = {
      type: "reveal" as const,
      from: payee.did,
      contract: accept.contract,
      ref: "escrow-44",
      secret: `0x${"00".repeat(32)}`,
    };
    const folded = foldTranscript(
      [
        record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
        record(BOARD, 2, NOW, payee, encodeFrame(accept)),
        record("lobby", 3, NOW + 1, payer, encodeFrame(lockFrame)),
        record(BOARD, 4, NOW + 2, payer, encodeFrame(lockFrame)),
        record(BOARD, 5, NOW + 3, stranger, encodeFrame(strangerReveal)),
        record(BOARD, 6, NOW + 4, payee, encodeFrame(wrongSecret)),
      ],
      { roomBinding: "offer-room" },
    );

    expect(folded.steps[2]).toMatchObject({
      ok: false,
      reason: "lock must be posted in tclk-offers",
    });
    expect(folded.steps[3]).toMatchObject({ ok: true, type: "lock" });
    expect(folded.steps[4]).toMatchObject({ ok: false, reason: "only the payee reveals" });
    expect(folded.steps[5]).toMatchObject({
      ok: false,
      reason: "secret does not open the statement",
    });
    expect(folded.state?.status).toBe("locked");

    // An offer or accept never moves off the board, in either mode.
    const offRoomAccept = foldTranscript(
      [
        record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
        record(dealRoom(accept.contract), 1, NOW, payee, encodeFrame(accept)),
      ],
      { roomBinding: "offer-room" },
    );
    expect(offRoomAccept.state?.status).toBe("proposed");
    expect(offRoomAccept.steps[1]).toMatchObject({
      ok: false,
      reason: "accept must be posted in tclk-offers",
    });

    expect(() => foldTranscript([], { roomBinding: "lenient" as never })).toThrow(/roomBinding/);
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
