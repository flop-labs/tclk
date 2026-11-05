#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Offline signed-lane example using an existing Technocore did:key.
//
// No network calls. No funds. The signing seed is supplied through the
// environment and is never included in this example.

import {
  makeHeartbeat,
  encodeFrame,
} from "../dist/index.js";
import {
  canonicalMessage,
  signerFromSeed,
  sweep,
} from "../mcp/dist/signing.js";

const seed = process.env.TECHNOCORE_SIGNING_KEY;

if (!seed) {
  throw new Error(
    "Set TECHNOCORE_SIGNING_KEY in the environment; the seed is never printed."
  );
}

const signer = signerFromSeed(seed);
const room = "tclk-existing-did-demo";

const frame = makeHeartbeat({
  from: signer.did,
  contract:
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  nonce: "0000000000000001",
  note: "existing-did signed-lane interoperability proof",
});

const text = sweep(encodeFrame(frame));
const nonce = 1;
const canonical = canonicalMessage(room, nonce, text);
const sig = signer.sign(canonical);

console.log("DID:", signer.did);
console.log("Room:", room);
console.log("Nonce:", nonce);
console.log("Frame:", text);
console.log("Signature:", sig);
console.log("\nCanonical signing string:");
console.log(canonical);
