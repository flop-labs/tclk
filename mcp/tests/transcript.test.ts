// SPDX-License-Identifier: Apache-2.0
//
// Folding a room transcript: a full happy path, a refund path, and the fail-closed
// behaviour that matters most — hostile and out-of-order lines get a verdict, not a
// throw, and money-state only advances on frames that verify.

import { describe, expect, it } from "vitest";

import { createHandlers } from "../src/tools.js";
import { HASH_OFFER, NOW, PAYEE_DID, PAYER_DID } from "./fixtures.js";

const h = createHandlers({ env: {} });

function openDeal(offerFields = HASH_OFFER) {
  const offer = h.tclk_make_offer(offerFields);
  const accept = h.tclk_accept_offer({ offer: offer.line, from: PAYEE_DID });
  return { offer, accept };
}

describe("happy path", () => {
  it("folds offer → accept → lock → reveal → receipt to claimed", () => {
    const { offer, accept } = openDeal();
    const lock = h.tclk_make_lock({
      from: PAYER_DID,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-42",
    });
    const reveal = h.tclk_make_reveal({
      from: PAYEE_DID,
      contract: accept.contract,
      secret: accept.secret,
    });
    const receipt = h.tclk_make_receipt({
      from: PAYER_DID,
      contract: accept.contract,
      outcome: "claimed",
      rail: "flop-htlc",
      ref: "escrow-42",
    });

    const result = h.tclk_apply_transcript({
      lines: [offer.line, accept.line, lock.line, reveal.line, receipt.line],
      nowMs: NOW,
    });

    expect(result.steps.map((s) => s.ok)).toEqual([true, true, true, true, true]);
    expect(result.status).toBe("claimed");
    expect(result.contract).toBe(accept.contract);
    expect(result.parties).toEqual({
      payer: PAYER_DID,
      payee: PAYEE_DID,
      payerKey: null,
      payeeKey: null,
    });
    expect(result.rail).toBe("flop-htlc");
    expect(result.railRef).toBe("escrow-42");

    // The revealed secret is in the transcript the caller already holds; this server
    // reports only that one exists.
    expect(result.secretRevealed).toBe(true);
    expect(JSON.stringify(result)).not.toContain(accept.secret.slice(2));
  });
});

describe("refund path", () => {
  // The machine folds a whole transcript at ONE wall clock, so a transcript that reaches
  // a refund must be an offer whose `expiresMs` outlives its own refund window —
  // otherwise the accept, replayed at refund time, is (correctly) rejected as expired.
  const lateExpiry = { ...HASH_OFFER, expiresMs: HASH_OFFER.refundAfterMs + 600_000 };

  it("folds offer → accept → lock → refund to refunded once the window is open", () => {
    const { offer, accept } = openDeal(lateExpiry);
    const lock = h.tclk_make_lock({
      from: PAYER_DID,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-43",
    });
    const refund = h.tclk_make_refund({
      from: PAYER_DID,
      contract: accept.contract,
      reason: "payee never revealed",
    });

    const open = h.tclk_apply_transcript({
      lines: [offer.line, accept.line, lock.line, refund.line],
      nowMs: lateExpiry.refundAfterMs + 1,
    });
    expect(open.steps.map((s) => s.ok)).toEqual([true, true, true, true]);
    expect(open.status).toBe("refunded");
    expect(open.secretRevealed).toBe(false);

    // Same transcript, one millisecond before the window: the refund is refused and the
    // contract stays locked.
    const early = h.tclk_apply_transcript({
      lines: [offer.line, accept.line, lock.line, refund.line],
      nowMs: lateExpiry.refundAfterMs - 1,
    });
    expect(early.status).toBe("locked");
    expect(early.steps[3]).toMatchObject({ ok: false, reason: "refund window not open yet" });
  });
});

describe("fail-closed folding", () => {
  it("gives garbage and out-of-turn frames a verdict, never a throw", () => {
    const { offer, accept } = openDeal();
    const stolenReveal = h.tclk_make_reveal({
      from: PAYER_DID,
      contract: accept.contract,
      secret: accept.secret,
    });

    const result = h.tclk_apply_transcript({
      lines: [
        "gm everyone",
        offer.line,
        "tclk1 {\"type\":\"lock\"}",
        accept.line,
        stolenReveal.line,
      ],
      nowMs: NOW,
    });

    expect(result.steps[0]).toMatchObject({ ok: false });
    expect(result.steps[1]).toMatchObject({ ok: true, type: "offer" });
    expect(result.steps[2]).toMatchObject({ ok: false });
    expect(result.steps[3]).toMatchObject({ ok: true, type: "accept" });
    // Never locked, so the reveal cannot land — and the payer is not the payee anyway.
    expect(result.steps[4]).toMatchObject({ ok: false, reason: "reveal in status accepted" });
    expect(result.status).toBe("accepted");
    expect(result.secretRevealed).toBe(false);
  });

  it("refuses a transcript with no offer to open from", () => {
    expect(() => h.tclk_apply_transcript({ lines: ["gm", "still not a frame"] })).toThrow(
      /no offer frame/,
    );
  });
});
