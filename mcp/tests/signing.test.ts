// SPDX-License-Identifier: Apache-2.0
//
// The signed lane's client half, against the service contract: did:key derivation, the
// canonical string, and the signature spelling technocore accepts. No network.

import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 as base58btc } from "@scure/base";

import {
  canonicalMessage,
  didFromPublicKey,
  loadSigner,
  nextNonce,
  signerFromSeed,
  sweep,
} from "../src/signing.js";

// RFC 8032 §7.1 test vector 1's secret key — a fixed seed, so the DID below is a vector
// and not whatever the implementation happens to produce today.
const SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUBLIC_HEX = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** An independent base58btc, so the DID is cross-checked rather than self-asserted. */
function base58(raw: Uint8Array): string {
  let n = 0n;
  for (const byte of raw) n = n * 256n + BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const seed = hexToBytes(SEED_HEX);

describe("did:key derivation", () => {
  it("derives the multicodec base58btc did from a fixed seed", () => {
    const publicKey = ed25519.getPublicKey(seed);
    expect(Buffer.from(publicKey).toString("hex")).toBe(PUBLIC_HEX);

    const expected = `did:key:z${base58(Uint8Array.from([0xed, 0x01, ...publicKey]))}`;
    expect(didFromPublicKey(publicKey)).toBe(expected);
    expect(signerFromSeed(seed).did).toBe(expected);
    // The shape the venue's DID grammar (and tclk's own frame validator) enforces.
    expect(expected).toMatch(/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/);
  });

  // The test above rebuilds the expected DID from the same 0xed,0x01 multicodec
  // constant the implementation uses, so a wrong prefix would satisfy both. This one
  // takes ground truth from outside: the canonical Ed25519 identifier published in the
  // W3C CCG did:key specification. Decode it, hand the raw public key back to our
  // encoder, and the exact published string has to come out.
  it("reproduces a published did:key identifier from its own public key", () => {
    const published = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
    const decoded = base58btc.decode(published.slice("did:key:z".length));

    expect(decoded).toHaveLength(34);
    expect(decoded[0]).toBe(0xed); // multicodec ed25519-pub
    expect(decoded[1]).toBe(0x01);
    expect(didFromPublicKey(decoded.slice(2))).toBe(published);
  });

  it("accepts the hex and base64url spellings of TECHNOCORE_SIGNING_KEY", () => {
    const base64url = Buffer.from(seed).toString("base64url");
    expect(loadSigner(SEED_HEX).did).toBe(signerFromSeed(seed).did);
    expect(loadSigner(`0x${SEED_HEX}`).did).toBe(signerFromSeed(seed).did);
    expect(loadSigner(base64url).did).toBe(signerFromSeed(seed).did);
  });

  it("refuses a malformed seed without echoing it", () => {
    expect(() => loadSigner("deadbeef")).toThrow(/32-byte Ed25519 seed/);
    expect(() => loadSigner("deadbeef")).not.toThrow(/deadbeef/);
  });
});

describe("canonical string and signature", () => {
  it("signs `<room>|<nonce>|<text>` verifiably, in canonical unpadded base64url", () => {
    const signer = signerFromSeed(seed);
    const canonical = canonicalMessage("lobby", 1730000000000, "tclk1 {}");
    expect(canonical).toBe("lobby|1730000000000|tclk1 {}");

    const sig = signer.sign(canonical);
    // 86 characters, unpadded, and canonical: sixteen strings decode to the same 64
    // bytes, so the final character must be the one the encoder produces.
    expect(sig).toHaveLength(86);
    expect(sig).not.toContain("=");
    expect(sig).toMatch(/^[A-Za-z0-9_-]{85}[AQgw]$/);

    const raw = Buffer.from(sig, "base64url");
    expect(raw).toHaveLength(64);
    expect(
      ed25519.verify(new Uint8Array(raw), new TextEncoder().encode(canonical), ed25519.getPublicKey(seed)),
    ).toBe(true);
  });

  it("signs the swept text, not the text as typed", () => {
    // U+200B (Cf) and the newline (Cc) both become spaces; then the ends are trimmed.
    expect(sweep("  a\u200bb\nc  ")).toBe("a b c");
    expect(sweep("plain")).toBe("plain");
  });
});

describe("nonces", () => {
  it("are strictly increasing within the process", () => {
    const nonces = [nextNonce(), nextNonce(), nextNonce()];
    expect(nonces[1]).toBeGreaterThan(nonces[0]);
    expect(nonces[2]).toBeGreaterThan(nonces[1]);
    expect(nonces[0]).toBeGreaterThan(1_700_000_000_000);
  });
});
