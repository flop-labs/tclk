// SPDX-License-Identifier: Apache-2.0
//
// Run from a built checkout: node examples/offline-offer.mjs
// A frame-codec exercise only: no identity generation, signing, posting or settlement.
import assert from "node:assert/strict";
import { createHandlers } from "../mcp/dist/index.js";

let networkAttempts = 0;
const handlers = createHandlers({
  env: {}, // Do not inherit signing/payment keys or venue settings from the shell.
  fetch: async () => {
    networkAttempts += 1;
    throw new Error("This example must remain offline");
  },
});

// A syntax-only placeholder, as in the golden-vector tests; it represents no signer.
// Fixed timestamps and nonce make this a repeatable fixture, not a live offer.
const offer = handlers.tclk_make_offer({
  from: "did:key:z6Mk" + "f".repeat(44),
  role: "payer",
  amount: "1000000",
  asset: "FLOP",
  lock: "hash",
  rails: ["paper"],
  expiresMs: 1_756_700_600_000,
  claimByMs: 1_756_703_600_000,
  refundAfterMs: 1_756_707_200_000,
  nonce: "9f2c81d04c9e1f7a",
});

const decoded = handlers.tclk_decode({ line: offer.line });
assert.equal(decoded.ok, true);
assert.deepEqual(decoded.frame, offer.frame);
assert.equal(networkAttempts, 0);

console.log("PASS: offer frame built and decoded unchanged");
console.log("Network calls: 0; signing keys supplied: 0");
console.log("Offer only: no accept, contract, signature or payment");
