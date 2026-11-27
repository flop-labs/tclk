// SPDX-License-Identifier: Apache-2.0
// Synthetic, public test identity only. Never used on a venue.
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";

export const NONCE = "1730000000000000001";
export const ROOM = "nonce-test";
export const TEXT = '{"nonce":123,"no\\u006ece":456} synthetic signed text';
const seed = new Uint8Array(32).fill(7);
const sender = "did:key:z" + base58.encode(
  Uint8Array.from([0xed, 1, ...ed25519.getPublicKey(seed)]),
);
const sig = base64urlnopad.encode(
  ed25519.sign(new TextEncoder().encode(`${ROOM}|${NONCE}|${TEXT}`), seed),
);

export function wireRow(key = "nonce", token = NONCE): string {
  return JSON.stringify({
    seq: 1, ts: "2026-01-01T00:00:00Z", from: sender, text: TEXT, sig, nonce: NONCE,
  }).replace(`"nonce":"${NONCE}"`, `"${key}":${token}`);
}

export function responseBody(full: boolean, key = "nonce", token = NONCE): string {
  const row = wireRow(key, token);
  return full ? row + "\n" : `{"room":"${ROOM}","messages":[${row}],"last_seq":1,"count":1}`;
}
