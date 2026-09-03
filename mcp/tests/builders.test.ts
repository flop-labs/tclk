// SPDX-License-Identifier: Apache-2.0
//
// Every builder's line must survive `tclk_decode` back into the frame it built — the
// round trip is what makes the line a shared transcript rather than this server's
// private encoding.

import { describe, expect, it } from "vitest";

import { createHandlers } from "../src/tools.js";
import { HASH_OFFER, PAYEE_DID, PAYER_DID, PAYMENT_KEY } from "./fixtures.js";

const h = createHandlers({ env: {} });

function roundTrip(built: { frame: unknown; line: string }) {
  expect(built.line.startsWith("tclk1 ")).toBe(true);
  const decoded = h.tclk_decode({ line: built.line });
  expect(decoded.ok).toBe(true);
  expect(decoded.ok && decoded.frame).toEqual(built.frame);
}

describe("offer and accept", () => {
  it("builds an offer whose line decodes back, and warns the id is not the contract", () => {
    const offer = h.tclk_make_offer(HASH_OFFER);
    roundTrip(offer);
    expect(offer.frame).toMatchObject({ type: "offer", from: PAYER_DID, lock: "hash" });
    expect(offer.dealNote).toMatch(/accept frame/);
  });

  it("mints a hash lock on accept and returns the secret exactly once", () => {
    const offer = h.tclk_make_offer(HASH_OFFER);
    const accept = h.tclk_accept_offer({ offer: offer.line, from: PAYEE_DID });
    roundTrip(accept);

    expect(accept.contract).toMatch(/^0x[0-9a-f]{64}$/);
    expect(accept.statement).toMatch(/^0x[0-9a-f]{64}$/);
    expect(accept.secret).toMatch(/^0x[0-9a-f]{64}$/);
    expect(accept.warning).toMatch(/keep `secret` private/);
    // The secret is the caller's; it is never echoed by the accept LINE that goes public.
    expect(accept.line).not.toContain(accept.secret.slice(2));
    expect(h.tclk_verify_secret({ lock: "hash", statement: accept.statement, secret: accept.secret }))
      .toEqual({ valid: true });

    expect(accept.dealRoom).toBe(`mb-p-tclk-${accept.contract.slice(2, 18)}`);
    expect(accept.stateNote).toEqual({
      ns: `tclk-${accept.contract.slice(2, 4)}`,
      key: accept.contract.slice(4, 18),
    });
  });

  it("mints a point lock and takes the acceptor's payment key from the environment", () => {
    const withKey = createHandlers({ env: { TCLK_PAYMENT_KEY: PAYMENT_KEY } });
    const paymentKey = withKey.tclk_whoami().paymentPublicKey!;
    const offer = withKey.tclk_make_offer({ ...HASH_OFFER, lock: "point", paymentKey });
    const accept = withKey.tclk_accept_offer({ offer: offer.line, from: PAYEE_DID });

    expect(accept.statement).toMatch(/^0x[0-9a-f]{66}$/);
    expect(
      withKey.tclk_verify_secret({ lock: "point", statement: accept.statement, secret: accept.secret }),
    ).toEqual({ valid: true });
  });

  it("refuses a point offer with no acceptor payment key anywhere", () => {
    const withKey = createHandlers({ env: { TCLK_PAYMENT_KEY: PAYMENT_KEY } });
    const paymentKey = withKey.tclk_whoami().paymentPublicKey!;
    const offer = withKey.tclk_make_offer({ ...HASH_OFFER, lock: "point", paymentKey });
    expect(() => h.tclk_accept_offer({ offer: offer.line, from: PAYEE_DID })).toThrow(
      /point lock, which requires the acceptor's paymentKey/,
    );
  });

  it("refuses to accept a line that is not an offer", () => {
    const cancel = h.tclk_make_cancel({ from: PAYER_DID, contract: `0x${"ab".repeat(32)}` });
    expect(() => h.tclk_accept_offer({ offer: cancel.line, from: PAYEE_DID })).toThrow(
      /expected an offer line/,
    );
  });
});

describe("thin builders", () => {
  const contract = `0x${"ab".repeat(32)}`;

  it("round-trips lock, reveal, refund, cancel and receipt", () => {
    roundTrip(h.tclk_make_lock({ from: PAYER_DID, contract, rail: "flop-htlc", ref: "escrow-7" }));
    roundTrip(h.tclk_make_reveal({ from: PAYEE_DID, contract, secret: `0x${"11".repeat(32)}` }));
    roundTrip(h.tclk_make_refund({ from: PAYER_DID, contract, reason: "deadline passed" }));
    roundTrip(h.tclk_make_cancel({ from: PAYER_DID, contract }));
    roundTrip(
      h.tclk_make_receipt({ from: PAYEE_DID, contract, outcome: "claimed", rail: "flop-htlc", ref: "escrow-7" }),
    );
  });

  it("fails closed on a malformed field rather than coercing it", () => {
    expect(() => h.tclk_make_lock({ from: PAYER_DID, contract: "0xdead", rail: "flop-htlc", ref: "r" })).toThrow(
      /contract is malformed/,
    );
    expect(() => h.tclk_make_receipt({ from: PAYER_DID, contract, outcome: "settled" as never })).toThrow(
      /outcome must be/,
    );
  });
});

describe("tclk_decode", () => {
  it("answers with a structured reason instead of throwing", () => {
    expect(h.tclk_decode({ line: "hello room" })).toEqual({
      ok: false,
      error: expect.stringContaining("not a tclk/1 line"),
    });
    expect(h.tclk_decode({ line: "tclk1 {not json" })).toEqual({
      ok: false,
      error: expect.stringContaining("not valid JSON"),
    });
    expect(h.tclk_decode({ line: 'tclk1 {"type":"cancel"}' })).toEqual({
      ok: false,
      error: expect.stringContaining("missing field"),
    });
  });
});
