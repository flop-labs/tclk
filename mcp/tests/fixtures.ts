// SPDX-License-Identifier: Apache-2.0
//
// Shared test material: two fixed identities and a clock, so every transcript test folds
// deterministically. No network anywhere in this suite.

import { signerFromSeed } from "../src/signing.js";

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const PAYER_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
export const PAYEE_SEED = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";

export const PAYER_DID = signerFromSeed(hexToBytes(PAYER_SEED)).did;
export const PAYEE_DID = signerFromSeed(hexToBytes(PAYEE_SEED)).did;

/** A third identity: party to nothing, able to write into any room the two parties use. */
export const STRANGER_SEED = "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7";
export const STRANGER_DID = signerFromSeed(hexToBytes(STRANGER_SEED)).did;

/** A 32-byte secp256k1 scalar, valid for `TCLK_PAYMENT_KEY`. */
export const PAYMENT_KEY = "1111111111111111111111111111111111111111111111111111111111111111";

export const NOW = 1_735_000_000_000;

/** A hash-lock offer whose windows are all open at `NOW`. */
export const HASH_OFFER = {
  from: PAYER_DID,
  role: "payer" as const,
  amount: "1000",
  asset: "USDC",
  lock: "hash" as const,
  rails: ["flop-htlc"],
  claimByMs: NOW + 3_600_000,
  refundAfterMs: NOW + 7_200_000,
  expiresMs: NOW + 600_000,
  nonce: "00112233445566778899aabb",
};

/** A minimal `fetch` double: records every call, answers from a queue. */
export function fakeFetch(responses: { status?: number; body: string; json?: unknown }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const queue = [...responses];
  const fetchLike = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected fetch: ${url}`);
    const body = next.json !== undefined ? JSON.stringify(next.json) : next.body;
    return new Response(body, {
      status: next.status ?? 200,
      headers: { "content-type": next.json !== undefined ? "application/json" : "text/plain" },
    });
  };
  return { calls, fetchLike };
}
