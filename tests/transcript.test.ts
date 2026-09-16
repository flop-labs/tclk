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

  it("binds post-accept frames to the board when the derived room holds none", () => {
    // A payer the venue refused a new room (service-wide cap, or the per-client
    // rate_rooms_per_day budget) announces the lock on tclk-offers. Nothing in the derived
    // room contradicts it, so the board binds and the deal folds to claimed.
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

    const folded = foldTranscript(records);
    expect(folded.steps.map((step) => step.ok)).toEqual([true, true, true, true]);
    expect(folded.state?.status).toBe("claimed");
    expect(folded.state?.secret).toBe(lock.preimage);
    expect(folded.roomBinding).toBe("offer-room");
    expect(folded.equivocation).toBe(false);

    // Party-signed evidence in the derived deal room takes the binding back, and a board
    // record for the same contract is then the wrong room.
    const inDerivedRoom = record(
      dealRoom(accept.contract), 1, NOW + 1, payer, encodeFrame(lockFrame),
    );
    const contested = foldTranscript([...records.slice(0, 3), inDerivedRoom]);
    expect(contested.roomBinding).toBe("strict");
    expect(contested.equivocation).toBe(true);
    expect(contested.steps[2]).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/derived deal room .*both rooms/s),
    });
    expect(contested.steps[3]).toMatchObject({ ok: true, type: "lock" });
    expect(contested.state?.status).toBe("locked");
  });

  it("does not let a stranger's record move the room binding", () => {
    // Only a party of this contract is evidence. A stranger writing in the derived room
    // must not be able to pull a board-bound deal back to strict — that would be a way to
    // erase a refused payer's lock — and a stranger on the board must not loosen a
    // derived-room deal either.
    const { offer, accept } = deal();
    const lockFrame = {
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-stranger",
    };
    const strangerLock = { ...lockFrame, from: stranger.did };
    const board = [
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW, payee, encodeFrame(accept)),
    ];

    const boardBound = foldTranscript([
      ...board,
      record(dealRoom(accept.contract), 1, NOW + 1, stranger, encodeFrame(strangerLock)),
      record(BOARD, 3, NOW + 2, payer, encodeFrame(lockFrame)),
    ]);
    expect(boardBound.roomBinding).toBe("offer-room");
    expect(boardBound.equivocation).toBe(false);
    expect(boardBound.state?.status).toBe("locked");

    const roomBound = foldTranscript([
      ...board,
      record(BOARD, 3, NOW + 1, stranger, encodeFrame(strangerLock)),
      record(dealRoom(accept.contract), 1, NOW + 2, payer, encodeFrame(lockFrame)),
    ]);
    expect(roomBound.roomBinding).toBe("strict");
    expect(roomBound.equivocation).toBe(false);
    expect(roomBound.state?.status).toBe("locked");
  });

  it("gives one answer for one record set, however it is interleaved or entered", () => {
    // Regression for the two reviews on #62. A valid payer cancel on the board and a valid
    // payer lock in the derived room, same millisecond: with both rooms admitted the verdict
    // followed caller order, and with a caller-chosen mode it followed the option. Neither
    // is a choice any more — the records decide, and the fold says which room bound.
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
      const folded = foldTranscript([...board, ...tail]);
      expect(folded.state?.status).toBe("locked");
      expect(folded.roomBinding).toBe("strict");
      expect(folded.equivocation).toBe(true);
    }
  });

  it("keeps every other guard where the board binds", () => {
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
    const folded = foldTranscript([
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW, payee, encodeFrame(accept)),
      record("lobby", 3, NOW + 1, payer, encodeFrame(lockFrame)),
      record(BOARD, 4, NOW + 2, payer, encodeFrame(lockFrame)),
      record(BOARD, 5, NOW + 3, stranger, encodeFrame(strangerReveal)),
      record(BOARD, 6, NOW + 4, payee, encodeFrame(wrongSecret)),
    ]);

    // A foreign room is neither the board nor the derived room: no evidence, still rejected.
    expect(folded.roomBinding).toBe("offer-room");
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

    // An offer or accept never moves off the board, whichever room binds after it.
    const offRoomAccept = foldTranscript([
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(dealRoom(accept.contract), 1, NOW, payee, encodeFrame(accept)),
    ]);
    expect(offRoomAccept.state?.status).toBe("proposed");
    expect(offRoomAccept.roomBinding).toBe("strict");
    expect(offRoomAccept.steps[1]).toMatchObject({
      ok: false,
      reason: "accept must be posted in tclk-offers",
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
