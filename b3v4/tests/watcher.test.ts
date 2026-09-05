/**
 * Tests for the B3V4 accept watcher — cursor-based polling.
 *
 * These tests specifically cover:
 * - TAIL_WINDOW_RACE root cause
 * - Intra-batch gap detection
 * - Generation change detection
 * - Restart-after-expiry behavior
 */

import { describe, it, expect } from "vitest";

import {
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  type OfferFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { signerFromSeed } from "@flop-labs/tclk-mcp/dist/signing.js";
import { canonicalMessage, sweep } from "@flop-labs/tclk-mcp/dist/signing.js";

import { watchForAccept } from "../src/watcher.js";
import { createMockVenueIO } from "../src/venue-io.js";
import type { VenueSigner } from "../src/types.js";

// ── Test fixtures ────────────────────────────────────────────────────────────

const PAYER_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PAYEE_SEED = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";

const payerSigner = signerFromSeed(hexToBytes(PAYER_SEED));
const payeeSigner = signerFromSeed(hexToBytes(PAYEE_SEED));

const PAYER_DID = payerSigner.did;
const PAYEE_DID = payeeSigner.did;

const T0 = Date.now() + 3600_000;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function createSignedRecord(
  room: string,
  line: string,
  signer: { did: string; sign: (canonical: string) => string },
  seq: number,
  timestampMs: number,
): TranscriptRecord {
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

function makeTestAccept(offer: OfferFrame) {
  const lock = generateHashLock();
  const accept = makeAccept(offer, { from: PAYEE_DID, statement: lock.hash });
  return { accept, lock };
}

function makeTestOffer() {
  return makeOffer({
    from: PAYER_DID,
    role: "payer",
    lock: "hash",
    amount: "1",
    asset: "PAPER",
    rails: ["paper"],
    claimByMs: T0 + 30 * 60_000,
    refundAfterMs: T0 + 60 * 60_000,
    expiresMs: T0 + 10 * 60_000,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("B3V4 watcher — TAIL_WINDOW_RACE fix", () => {
  it("A. target historical case: offer seq 184200, accept seq 184217", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);

    venue.addRoomData("tclk-offers", [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
    ]);

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      maxPolls: 3,
      pollIntervalMs: 100,
    });

    expect(state.offerFound).toBe(true);
    expect(state.acceptFound).toBe(false);
  });

  it("B. >50 messages arrive after accept before next poll", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);

    const records: TranscriptRecord[] = [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
    ];

    // Add contiguous fillers from 184201 to 184216
    for (let i = 1; i <= 16; i++) {
      records.push(
        createSignedRecord("tclk-offers", "filler " + i, payerSigner, 184200 + i, T0 + i * 100),
      );
    }

    // Accept at 184217 (contiguous)
    records.push(
      createSignedRecord("tclk-offers", encodeFrame(accept), payeeSigner, 184217, T0 + 24000),
    );

    // Add 60 more contiguous fillers after accept
    for (let i = 0; i < 60; i++) {
      records.push(
        createSignedRecord("tclk-offers", "filler " + (17 + i), payerSigner, 184218 + i, T0 + 25000 + i * 100),
      );
    }

    venue.addRoomData("tclk-offers", records);

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      maxPolls: 3,
      pollIntervalMs: 100,
    });

    expect(state.offerFound).toBe(true);
    expect(state.acceptFound).toBe(true);
  });

  it("C. accept not in current tail window but after cursor", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);

    // Contiguous records: offer at 184200, fillers 184201..184216
    const records: TranscriptRecord[] = [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
    ];
    for (let i = 1; i <= 16; i++) {
      records.push(
        createSignedRecord("tclk-offers", "filler " + i, payerSigner, 184200 + i, T0 + i * 100),
      );
    }

    venue.addRoomData("tclk-offers", records);

    const state1 = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      maxPolls: 1,
      pollIntervalMs: 100,
    });

    expect(state1.offerFound).toBe(true);
    expect(state1.acceptFound).toBe(false);

    // Add contiguous accept after fillers
    venue.roomData.get("tclk-offers")!.push(
      createSignedRecord("tclk-offers", encodeFrame(accept), payeeSigner, 184217, T0 + 24000),
    );

    const state2 = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      maxPolls: 3,
      pollIntervalMs: 100,
    });

    expect(state2.offerFound).toBe(true);
    expect(state2.acceptFound).toBe(true);
  });

  it("D. no accept until expiry returns correct state", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();

    venue.addRoomData("tclk-offers", [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
    ]);

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 300,
      maxPolls: 2,
      pollIntervalMs: 100,
    });

    expect(state.offerFound).toBe(true);
    expect(state.acceptFound).toBe(false);
  });

  it("E. accept timestamp before expiry but processed after wall-clock expiry", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);

    const acceptRecord = createSignedRecord(
      "tclk-offers",
      encodeFrame(accept),
      payeeSigner,
      184217,
      T0 + 120_000,
    );

    // Contiguous records: 184200, 184201..184216, 184217
    const records: TranscriptRecord[] = [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
    ];
    for (let i = 1; i <= 16; i++) {
      records.push(
        createSignedRecord("tclk-offers", "filler " + i, payerSigner, 184200 + i, T0 + i * 100),
      );
    }
    records.push(acceptRecord);

    venue.addRoomData("tclk-offers", records);

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      maxPolls: 3,
      pollIntervalMs: 100,
    });

    expect(state.acceptFound).toBe(true);
  });

  it("F. accept timestamp after expiry is rejected", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);

    const acceptRecord = createSignedRecord(
      "tclk-offers",
      encodeFrame(accept),
      payeeSigner,
      184217,
      T0 + 10 * 60_000 + 1,
    );

    venue.addRoomData("tclk-offers", [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
      acceptRecord,
    ]);

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      maxPolls: 3,
      pollIntervalMs: 100,
    });

    expect(state.acceptFound).toBe(false);
  });

  it("G. malformed unrelated records do not block cursor", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);

    // Contiguous records with malformed ones
    const records: TranscriptRecord[] = [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
    ];

    // Add malformed records at contiguous seqs
    for (let i = 1; i <= 5; i++) {
      records.push({
        room: "tclk-offers",
        seq: 184200 + i,
        timestampMs: T0 + 1000 + i * 100,
        sender: "malformed",
        nonce: null,
        signature: null,
        line: "not a tclk frame",
      });
    }

    // Contiguous accept at 184206
    records.push(
      createSignedRecord("tclk-offers", encodeFrame(accept), payeeSigner, 184206, T0 + 24000),
    );

    venue.addRoomData("tclk-offers", records);

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      maxPolls: 3,
      pollIntervalMs: 100,
    });

    expect(state.offerFound).toBe(true);
    expect(state.acceptFound).toBe(true);
  });

  it("H. cursor gap detection — records with seq gaps", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();

    venue.addRoomData("tclk-offers", [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
      createSignedRecord("tclk-offers", "gap filler", payerSigner, 184217, T0 + 1000),
    ]);

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      maxPolls: 3,
      pollIntervalMs: 100,
    });

    expect(state.gapDetected).toBe(true);
    expect(state.gapRange).toBe("184201..184216");
  });

  it("I. 429/503 do not cause cursor loss", async () => {
    let callCount = 0;
    const venue = createMockVenueIO();
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);

    // Contiguous records
    const records: TranscriptRecord[] = [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
    ];
    for (let i = 1; i <= 16; i++) {
      records.push(
        createSignedRecord("tclk-offers", "filler " + i, payerSigner, 184200 + i, T0 + i * 100),
      );
    }
    records.push(
      createSignedRecord("tclk-offers", encodeFrame(accept), payeeSigner, 184217, T0 + 24000),
    );

    venue.addRoomData("tclk-offers", records);

    const originalReadRoom = venue.readRoom.bind(venue);
    venue.readRoom = async (...args) => {
      callCount++;
      if (callCount === 1) throw new Error("503 Service Unavailable");
      return originalReadRoom(...args);
    };

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      maxPolls: 5,
      pollIntervalMs: 100,
    });

    expect(state.offerFound).toBe(true);
    expect(state.acceptFound).toBe(true);
  });

  it("J. >200 backlog drains multiple pages within single poll", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);

    const records: TranscriptRecord[] = [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
    ];

    for (let i = 0; i < 248; i++) {
      records.push(
        createSignedRecord("tclk-offers", "filler " + i, payerSigner, 184201 + i, T0 + 1000 + i * 100),
      );
    }

    records.push(
      createSignedRecord("tclk-offers", encodeFrame(accept), payeeSigner, 184449, T0 + 25000),
    );

    venue.addRoomData("tclk-offers", records);

    let readCallCount = 0;
    venue.readRoom = async (room: string, since?: number) => {
      readCallCount++;
      const allRecords = venue.roomData.get(room) ?? [];
      const filtered = since !== undefined
        ? allRecords.filter((r) => r.seq > since)
        : allRecords;
      return { records: filtered.slice(0, 50), generation: 1, lastSeq: filtered[Math.min(49, filtered.length - 1)]?.seq ?? null };
    };

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      maxPolls: 5,
      pollIntervalMs: 100,
    });

    expect(state.offerFound).toBe(true);
    expect(state.acceptFound).toBe(true);
    expect(state.recordsProcessed).toBeGreaterThanOrEqual(250);
    expect(state.drainCycles).toBeGreaterThan(1);
    expect(readCallCount).toBeGreaterThan(1);
  });
});

describe("B3V4 watcher — gap detection", () => {
  it("K. intra-batch gap — cursor=184200, next seq=184250", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();

    venue.addRoomData("tclk-offers", [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
      createSignedRecord("tclk-offers", "after gap", payerSigner, 184250, T0 + 50000),
    ]);

    venue.readRoom = async (room: string, since?: number) => {
      const allRecords = venue.roomData.get(room) ?? [];
      const filtered = since !== undefined
        ? allRecords.filter((r) => r.seq > since)
        : allRecords;
      return { records: filtered.slice(0, 1), generation: 1, lastSeq: filtered[0]?.seq ?? null };
    };

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      maxPolls: 3,
      pollIntervalMs: 100,
    });

    expect(state.gapDetected).toBe(true);
    expect(state.gapRange).toBe("184201..184249");
    expect(state.cursor).toBe(184200);
    expect(state.continuityEstablished).toBe(false);
  });

  it("O. intra-batch gap — process 184201, detect gap at 184250", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();

    venue.addRoomData("tclk-offers", [
      createSignedRecord("tclk-offers", "next", payerSigner, 184201, T0 + 1000),
      createSignedRecord("tclk-offers", "after gap", payerSigner, 184250, T0 + 50000),
    ]);

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184201,
      offerExpiresMs: T0 + 10 * 60_000,
      maxPolls: 5,
      pollIntervalMs: 100,
    });

    expect(state.offerFound).toBe(false);
    expect(state.gapDetected).toBe(true);
    expect(state.gapRange).toBe("184202..184249");
    expect(state.cursor).toBe(184201);
    expect(state.recordsProcessed).toBe(1);
    expect(state.continuityEstablished).toBe(false);
  });

  it("duplicates do not mask later newer records in the same room", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();

    let readCount = 0;
    venue.readRoom = async () => {
      readCount++;
      if (readCount === 1) {
        return {
          records: [
            createSignedRecord("tclk-offers", "stale duplicate", payerSigner, 184201, T0 + 1000),
          ],
          generation: 1,
          lastSeq: 184201,
        };
      }
      return {
        records: [
          createSignedRecord("tclk-offers", "after gap", payerSigner, 184250, T0 + 50000),
        ],
        generation: 1,
        lastSeq: 184250,
      };
    };

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184202,
      offerExpiresMs: T0 + 10 * 60_000,
      initialGeneration: 1,
      maxPolls: 3,
      pollIntervalMs: 100,
    });

    expect(state.gapDetected).toBe(true);
    expect(state.gapRange).toBe("184202..184249");
    expect(state.cursor).toBe(184201);
    expect(state.continuityEstablished).toBe(false);
  });
});

describe("B3V4 watcher — generation handling", () => {
  it("P. generation change + empty response => fail closed", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();

    venue.addRoomData("tclk-offers", [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
    ]);
    venue.setGeneration("tclk-offers", 1);

    let readCount = 0;
    venue.readRoom = async (room: string, since?: number) => {
      readCount++;
      if (readCount === 1) {
        return { records: [], generation: 1, lastSeq: null };
      }
      // Generation changes on second read
      return { records: [], generation: 2, lastSeq: null };
    };

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      initialGeneration: 1,
      maxPolls: 3,
      pollIntervalMs: 100,
    });

    expect(state.generationChanged).toBe(true);
    expect(state.continuityEstablished).toBe(false);
    expect(state.acceptFound).toBe(false);
  });

  it("Q. generation change + new low seq records => fail closed", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();

    venue.addRoomData("tclk-offers", [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
    ]);

    let readCount = 0;
    venue.readRoom = async (room: string, since?: number) => {
      readCount++;
      if (readCount === 1) {
        // First read: offer with generation=1
        return { records: [venue.roomData.get(room)![0]], generation: 1, lastSeq: 184200 };
      }
      if (readCount === 2) {
        // Second read: generation changes to 2 with new low seq records
        return {
          records: [createSignedRecord("tclk-offers", "new gen", payerSigner, 1, T0 + 100000)],
          generation: 2,
          lastSeq: 1,
        };
      }
      return { records: [], generation: 2, lastSeq: null };
    };

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      initialGeneration: 1,
      maxPolls: 5,
      pollIntervalMs: 100,
    });

    expect(state.generationChanged).toBe(true);
    // The new-generation records should NOT be processed as continuation
    expect(state.cursor).toBe(184200);
    expect(state.continuityEstablished).toBe(false);
    expect(state.acceptFound).toBe(false);
  });

  it("R. normal unchanged-generation empty catch-up", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();

    venue.addRoomData("tclk-offers", [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
    ]);
    venue.setGeneration("tclk-offers", 1);

    let readCount = 0;
    venue.readRoom = async (room: string, since?: number) => {
      readCount++;
      const allRecords = venue.roomData.get(room) ?? [];
      const filtered = since !== undefined
        ? allRecords.filter((r) => r.seq > since)
        : allRecords;
      return { records: filtered.slice(0, 1), generation: 1, lastSeq: filtered[0]?.seq ?? null };
    };

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      initialGeneration: 1,
      maxPolls: 3,
      pollIntervalMs: 100,
    });

    expect(state.offerFound).toBe(true);
    expect(state.continuityEstablished).toBe(true);
    expect(state.generationChanged).toBe(false);
  });
});

describe("B3V4 watcher — restart-after-expiry", () => {
  it("S. restart after expiry + unchanged generation + pre-expiry accept", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();
    const { accept } = makeTestAccept(offer);

    const acceptRecord = createSignedRecord(
      "tclk-offers",
      encodeFrame(accept),
      payeeSigner,
      184217,
      T0 + 120_000,
    );

    // Contiguous records
    const records: TranscriptRecord[] = [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
    ];
    for (let i = 1; i <= 16; i++) {
      records.push(
        createSignedRecord("tclk-offers", "filler " + i, payerSigner, 184200 + i, T0 + i * 100),
      );
    }
    records.push(acceptRecord);

    venue.addRoomData("tclk-offers", records);
    venue.setGeneration("tclk-offers", 1);

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      initialGeneration: 1,
      maxPolls: 5,
      pollIntervalMs: 100,
    });

    expect(state.offerFound).toBe(true);
    expect(state.acceptFound).toBe(true);
    expect(state.acceptRecord?.timestampMs).toBeLessThan(T0 + 10 * 60_000);
    expect(state.continuityEstablished).toBe(false);
  });

  it("T. restart after expiry + generation changed => fail closed", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();

    venue.addRoomData("tclk-offers", [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
    ]);

    let readCount = 0;
    venue.readRoom = async (room: string, since?: number) => {
      readCount++;
      if (readCount === 1) {
        return { records: [], generation: 1, lastSeq: null };
      }
      return { records: [], generation: 2, lastSeq: null };
    };

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      initialGeneration: 1,
      maxPolls: 3,
      pollIntervalMs: 100,
    });

    expect(state.generationChanged).toBe(true);
    expect(state.continuityEstablished).toBe(false);
    expect(state.acceptFound).toBe(false);
  });

  it("U. restart after expiry + no accept + unchanged generation", async () => {
    const venue = createMockVenueIO();
    const offer = makeTestOffer();

    venue.addRoomData("tclk-offers", [
      createSignedRecord("tclk-offers", encodeFrame(offer), payerSigner, 184200, T0),
    ]);
    venue.setGeneration("tclk-offers", 1);

    const state = await watchForAccept({
      venue,
      offerId: offer.id,
      payerDid: PAYER_DID,
      offerPublishSeq: 184200,
      offerExpiresMs: T0 + 10 * 60_000,
      initialGeneration: 1,
      maxPolls: 5,
      pollIntervalMs: 100,
    });

    expect(state.offerFound).toBe(true);
    expect(state.acceptFound).toBe(false);
    expect(state.continuityEstablished).toBe(true);
    expect(state.generationChanged).toBe(false);
  });
});
