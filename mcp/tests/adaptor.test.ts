// SPDX-License-Identifier: Apache-2.0
//
// The PTLC linkage the adaptor tools exist for: a pre-signature completed with the point
// lock's witness yields a valid signature, and extracting from the pair hands back that
// same witness — which is exactly what opens the lock.

import { describe, expect, it } from "vitest";

import { createHandlers } from "../src/tools.js";
import { HASH_OFFER, PAYEE_DID, PAYMENT_KEY } from "./fixtures.js";

const h = createHandlers({ env: { TCLK_PAYMENT_KEY: PAYMENT_KEY } });
const MSG = `0x${"5a".repeat(32)}`;

describe("adaptor round trip", () => {
  it("pre-signs, adapts and extracts the witness that opens the point lock", () => {
    const paymentKey = h.tclk_whoami().paymentPublicKey!;
    const offer = h.tclk_make_offer({ ...HASH_OFFER, lock: "point", paymentKey });
    const accept = h.tclk_accept_offer({ offer: offer.line, from: PAYEE_DID });

    const pre = h.tclk_adaptor_presign({ msg: MSG, statement: accept.statement });
    if (!pre.ok) throw new Error(pre.error);
    expect(h.tclk_adaptor_verify({ publicKey: paymentKey, msg: MSG, statement: accept.statement, presig: pre.presig }))
      .toEqual({ kind: "presignature", valid: true });

    const adapted = h.tclk_adaptor_adapt({ presig: pre.presig, witness: accept.secret });
    if (!adapted.ok) throw new Error(adapted.error);
    expect(h.tclk_adaptor_verify({ publicKey: paymentKey, msg: MSG, signature: adapted.signature }))
      .toEqual({ kind: "signature", valid: true });

    const extracted = h.tclk_adaptor_extract({ presig: pre.presig, signature: adapted.signature });
    if (!extracted.ok) throw new Error(extracted.error);
    expect(extracted.witness).toBe(accept.secret);
    expect(h.tclk_verify_secret({ lock: "point", statement: accept.statement, secret: extracted.witness }))
      .toEqual({ valid: true });
  });

  it("wants exactly one of `presig` or `signature`", () => {
    const publicKey = h.tclk_whoami().paymentPublicKey!;
    const presig = { nonce: publicKey, s: `0x${"01".repeat(32)}` };
    expect(() => h.tclk_adaptor_verify({ publicKey, msg: MSG })).toThrow(/exactly one/);
    expect(() => h.tclk_adaptor_verify({ publicKey, msg: MSG, presig, signature: presig })).toThrow(
      /exactly one/,
    );
    expect(() => h.tclk_adaptor_verify({ publicKey, msg: MSG, presig })).toThrow(/needs `statement`/);
  });
});

describe("no payment key", () => {
  it("names the environment variable to set instead of failing blank", () => {
    const result = createHandlers({ env: {} }).tclk_adaptor_presign({ msg: MSG, statement: `0x02${"11".repeat(32)}` });
    expect(result).toMatchObject({ ok: false, error: "no payment key" });
    expect(result.ok === false && result.hint).toContain("TCLK_PAYMENT_KEY");
  });
});
