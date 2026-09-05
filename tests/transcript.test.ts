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
  checkNonceOrder,
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

describe("checkNonceOrder", () => {
  // `nonce` here is the frame's own field, which exists to defeat the venue's
  // duplicate-text filter — distinct from the record nonce this check reads.
  function heartbeat(contract: string, nonce: string) {
    return { type: "heartbeat" as const, from: payee.did, contract, nonce };
  }

  it("reports nothing on a deal supplied in the order it was signed", () => {
    const { lock, offer, accept } = deal();
    const room = dealRoom(accept.contract);
    expect(checkNonceOrder([
      record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
      record(BOARD, 2, NOW, payee, encodeFrame(accept)),
      record(room, 1, NOW + 1, payer, encodeFrame({
        type: "lock", from: payer.did, contract: accept.contract, rail: "flop-htlc", ref: "escrow-42",
      })),
      record(room, 2, NOW + 2, payee, encodeFrame({
        type: "reveal", from: payee.did, contract: accept.contract, secret: lock.preimage,
      })),
    ])).toEqual([]);
  });

  it("catches two records of one signer supplied out of the order that signer numbered them", () => {
    const { accept } = deal();
    const room = dealRoom(accept.contract);
    const first = record(room, 2, NOW + 2, payee, encodeFrame(heartbeat(accept.contract, "aa11bb22cc33dd44")));
    const second = record(room, 3, NOW + 3, payee, encodeFrame(heartbeat(accept.contract, "bb22cc33dd44ee55")));

    expect(checkNonceOrder([second, first])).toMatchObject([
      { room, sender: payee.did, index: 1, previousIndex: 0 },
    ]);
  });

  it("still catches the swap when the supplier renumbers seq and ts to hide it", () => {
    const { accept } = deal();
    const room = dealRoom(accept.contract);
    const first = record(room, 2, NOW + 2, payee, encodeFrame(heartbeat(accept.contract, "aa11bb22cc33dd44")));
    const second = record(room, 3, NOW + 3, payee, encodeFrame(heartbeat(accept.contract, "bb22cc33dd44ee55")));

    // seq and ts are venue metadata and outside the signature, so a supplier may
    // rewrite them freely; the nonce inside the preimage cannot follow.
    const disguised = [
      { ...second, seq: 2, timestampMs: NOW + 2 },
      { ...first, seq: 3, timestampMs: NOW + 3 },
    ];
    expect(disguised.map((r) => r.seq)).toEqual([2, 3]);
    expect(checkNonceOrder(disguised)).toHaveLength(1);
  });

  it("does not fault two signers whose records interleave", () => {
    const { accept } = deal();
    const room = dealRoom(accept.contract);
    // The payee's nonce is lower than the payer's, and it arrives second. Ordering
    // between two signers is not attested, so this is not an ordering fault.
    const payerRow = record(room, 9, NOW + 9, payer, encodeFrame({
      type: "lock", from: payer.did, contract: accept.contract, rail: "flop-htlc", ref: "escrow-42",
    }));
    const payeeRow = record(room, 1, NOW + 1, payee, encodeFrame(heartbeat(accept.contract, "cc33dd44ee55ff66")));
    expect(BigInt(payeeRow.nonce as string) < BigInt(payerRow.nonce as string)).toBe(true);
    expect(checkNonceOrder([payerRow, payeeRow])).toEqual([]);
  });

  it("ignores a record whose signature does not verify, since its nonce is asserted only", () => {
    const { accept } = deal();
    const room = dealRoom(accept.contract);
    const first = record(room, 2, NOW + 2, payee, encodeFrame(heartbeat(accept.contract, "aa11bb22cc33dd44")));
    const second = record(room, 3, NOW + 3, payee, encodeFrame(heartbeat(accept.contract, "bb22cc33dd44ee55")));
    const forged = { ...first, signature: second.signature };

    expect(checkNonceOrder([second, forged])).toEqual([]);
  });
});
