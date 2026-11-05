// SPDX-License-Identifier: Apache-2.0
//
// Probe: a window read whose messages skip a seq inside [first_seq, last_seq].
// Documents what `tclk_read_room` reports today when the venue response has a hole.

import { describe, expect, it } from "vitest";

import { dealRoom, type TranscriptRecord } from "@flop-labs/tclk";

import { canonicalMessage, signerFromSeed } from "../src/signing.js";
import { createHandlers } from "../src/tools.js";
import {
  HASH_OFFER, NOW, PAYEE_DID, PAYEE_SEED, PAYER_DID, PAYER_SEED, fakeFetch, hexToBytes,
} from "./fixtures.js";

const payer = signerFromSeed(hexToBytes(PAYER_SEED));
const payee = signerFromSeed(hexToBytes(PAYEE_SEED));
const h0 = createHandlers({ env: {} });

function signed(room: string, seq: number, ts: number, who: "payer" | "payee", text: string) {
  const signer = who === "payer" ? payer : payee;
  const nonce = 1000 + seq;
  return {
    seq,
    ts: new Date(ts).toISOString(),
    from: signer.did,
    nonce: String(nonce),
    sig: signer.sign(canonicalMessage(room, nonce, text)),
    text,
  };
}

describe("tclk_read_room window with a hole inside [first_seq, last_seq]", () => {
  it("reports no gap, and the folded outcome flips from claimed to refunded", async () => {
    const offer = h0.tclk_make_offer(HASH_OFFER);
    const accept = h0.tclk_accept_offer({ offer: offer.line, from: PAYEE_DID });
    const lock = h0.tclk_make_lock({ from: PAYER_DID, contract: accept.contract, rail: "flop-htlc", ref: "escrow-1" });
    const reveal = h0.tclk_make_reveal({ from: PAYEE_DID, contract: accept.contract, ref: "escrow-1", secret: accept.secret });
    const refund = h0.tclk_make_refund({ from: PAYER_DID, contract: accept.contract, ref: "escrow-1", reason: "late" });

    const room = dealRoom(accept.contract);
    const late = HASH_OFFER.refundAfterMs;
    const full = [
      signed(room, 1, NOW + 1, "payer", lock.line),
      signed(room, 2, NOW + 2, "payee", reveal.line),
      signed(room, 3, late, "payer", refund.line),
    ];
    const served = [full[0]!, full[2]!]; // the venue response omits the real reveal (seq 2)

    const offerRecords: TranscriptRecord[] = [
      { room: "tclk-offers", seq: 1, timestampMs: NOW - 2, ...rec("tclk-offers", 1, "payer", offer.line) },
      { room: "tclk-offers", seq: 2, timestampMs: NOW - 1, ...rec("tclk-offers", 2, "payee", accept.line) },
    ];

    const fold = (messages: ReturnType<typeof signed>[]) => {
      const { fetchLike } = fakeFetch([
        { body: "", json: { room, count: messages.length, first_seq: 1, last_seq: 3, messages } },
      ]);
      const h = createHandlers({ env: {}, fetch: fetchLike });
      return h.tclk_read_room({ room }).then((view) => ({
        view,
        result: h.tclk_apply_transcript({ records: [...offerRecords, ...view.records] }),
      }));
    };

    const honest = await fold(full);
    const dropped = await fold(served);

    expect(honest.result.status).toBe("claimed");
    expect(dropped.result.status).toBe("refunded");

    // The fold cannot see the hole, so the read has to: it names the seq the venue skipped.
    expect(dropped.view.records.map((r) => r.seq)).toEqual([1, 3]);
    expect(dropped.view.malformed).toEqual([]);
    expect(dropped.view.firstSeq).toBe(1);
    expect(dropped.view.lastSeq).toBe(3);
    expect(dropped.view.missing).toEqual([{ from: 2, to: 2 }]);
    expect(honest.view.missing).toEqual([]);
  });

  // Inconsistent-envelope fixtures: the bounds (first_seq/last_seq) extend past the served
  // messages. The current server never produces this shape (it moves its bounds with a
  // dropped head or tail), so these only exercise the arithmetic against a hostile or
  // buggy venue.
  it("inconsistent-envelope fixtures: names leading, trailing and multi-seq holes, and counts a malformed envelope as present", async () => {
    const ok = (seq: number) => ({ seq, ts: "2026-01-01T00:00:00Z", from: "~x", text: "gm" });
    const run = async (first_seq: number | null | undefined, last_seq: number, messages: unknown[]) => {
      const { fetchLike } = fakeFetch([{ body: "", json: { room: "lobby", count: messages.length, first_seq, last_seq, messages } }]);
      return createHandlers({ env: {}, fetch: fetchLike }).tclk_read_room({ room: "lobby" });
    };

    expect((await run(5, 12, [ok(7), ok(8), ok(11)])).missing).toEqual([
      { from: 5, to: 6 },
      { from: 9, to: 10 },
      { from: 12, to: 12 },
    ]);
    // A message whose envelope will not normalize still occupies its seq.
    const bad = { seq: 9, ts: "2026-01-01T00:00:00Z", from: 7, text: "x", nonce: "nope" };
    const view = await run(7, 9, [ok(7), ok(8), bad]);
    expect(view.malformed.map((m) => m.seq)).toEqual([9]);
    expect(view.missing).toEqual([]);
    // No first_seq from the venue: the lowest served seq is the lower bound, not a hole.
    expect((await run(undefined, 10, [ok(8), ok(10)])).missing).toEqual([{ from: 9, to: 9 }]);
    expect((await run(null, 10, [ok(8), ok(10)])).firstSeq).toBeNull();
  });

  it("real-server shape: a dropped head or tail moves the bounds, so missing is empty", async () => {
    const ok = (seq: number) => ({ seq, ts: "2026-01-01T00:00:00Z", from: "~x", text: "gm" });
    // Seqs 1 and 4 were dropped; the server reports bounds 2..3, not 1..4.
    const { fetchLike } = fakeFetch([
      { body: "", json: { room: "lobby", count: 2, first_seq: 2, last_seq: 3, messages: [ok(2), ok(3)] } },
    ]);
    const view = await createHandlers({ env: {}, fetch: fetchLike }).tclk_read_room({ room: "lobby" });
    expect(view.firstSeq).toBe(2);
    expect(view.lastSeq).toBe(3);
    expect(view.missing).toEqual([]);
  });

  it("stays bounded by the message count when the venue claims an enormous window", async () => {
    const { fetchLike } = fakeFetch([
      { body: "", json: { room: "lobby", count: 1, first_seq: 1, last_seq: Number.MAX_SAFE_INTEGER, messages: [{ seq: 5, ts: "2026-01-01T00:00:00Z", from: "~x", text: "gm" }] } },
    ]);
    const view = await createHandlers({ env: {}, fetch: fetchLike }).tclk_read_room({ room: "lobby" });
    expect(view.missing).toEqual([
      { from: 1, to: 4 },
      { from: 6, to: Number.MAX_SAFE_INTEGER },
    ]);
  });
});

function rec(room: string, seq: number, who: "payer" | "payee", line: string) {
  const signer = who === "payer" ? payer : payee;
  const nonce = 500 + seq;
  return {
    sender: signer.did,
    nonce: String(nonce),
    signature: signer.sign(canonicalMessage(room, nonce, line)),
    line,
  };
}
