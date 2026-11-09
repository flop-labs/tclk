// SPDX-License-Identifier: Apache-2.0
//
// Regression test for: tclk_whoami throws when TCLK_PAYMENT_KEY is set but is not
// a valid secp256k1 scalar.
//
// Root cause: createHandlers only format-checks TCLK_PAYMENT_KEY (normalizeScalar:
// 64 hex chars). A well-formed but out-of-range scalar (0, or >= n) passes
// construction, and the failure only surfaces later as a throw from tclk_whoami
// (via paymentPublicKey -> getPublicKey -> null -> fail) or from tclk_accept_offer
// on a point lock. A read-only identity query should never fail because of a bad
// payment key, and a bad key should fail fast at startup.
//
// Fix: validate the scalar at construction in createHandlers (mcp/src/tools.ts):
// after normalizeScalar, call schnorrAdaptor.getPublicKey(paymentKey) and fail if
// it returns null. Then a bad key throws at createHandlers, before any tool runs.
//
// Fails without the fix (createHandlers accepts the bad key; the throw moves to
// tclk_whoami). Passes with the fix.

import { describe, expect, it } from "vitest";

import { createHandlers } from "../src/tools.js";

describe("TCLK_PAYMENT_KEY scalar validation at construction", () => {
  it("rejects an all-zero payment key at construction, not from tclk_whoami", () => {
    expect(() =>
      createHandlers({ env: { TCLK_PAYMENT_KEY: `0x${"00".repeat(32)}` } }),
    ).toThrow(/TCLK_PAYMENT_KEY is not a valid secp256k1 scalar/);
  });

  it("rejects a payment key >= n at construction", () => {
    expect(() =>
      createHandlers({ env: { TCLK_PAYMENT_KEY: `0x${"ff".repeat(32)}` } }),
    ).toThrow(/TCLK_PAYMENT_KEY is not a valid secp256k1 scalar/);
  });

  it("still accepts a valid payment key and reports its public key from whoami", () => {
    const h = createHandlers({ env: { TCLK_PAYMENT_KEY: `0x${"00".repeat(31)}01` } });
    expect(h.tclk_whoami().paymentPublicKey).toBe(
      "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    );
  });

  it("still accepts no payment key at all (whoami reports null)", () => {
    const h = createHandlers({ env: {} });
    expect(h.tclk_whoami().paymentPublicKey).toBeNull();
  });
});
