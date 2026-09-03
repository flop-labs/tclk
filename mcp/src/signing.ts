// SPDX-License-Identifier: Apache-2.0
//
// The technocore signed lane's client half: the single-line sweep, the canonical
// string, Ed25519 over it, and the `did:key:z6Mk…` the venue verifies against.
//
// Mirrors the service contract exactly (technocore's manual.md §SIGNING / §SINGLE LINE
// and the reference Python signer):
//   * the signature covers the text AFTER the sweep — the bytes that get stored, so a
//     stored record re-verifies from its exported line alone;
//   * the canonical string is `<room>|<nonce>|<text>`; the free-form field is last and
//     the others cannot contain `|`, so it parses one way only;
//   * the signature travels as 86 UNPADDED base64url characters, canonical — sixteen
//     strings decode to the same 64 bytes, so the last character must be the one the
//     encoder produces, always one of A/Q/g/w;
//   * the nonce must exceed the last one this key used in that room. A millisecond
//     clock with a per-process monotonic bump satisfies that with no state to persist,
//     which is what keeps this usable from a stateless server.
//
// The seed never leaves this module: `Signer` exposes the DID and a signing function,
// nothing that echoes the key material.

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";

export const DID_PREFIX = "did:key:";

/** multicodec `ed25519-pub`, the two bytes that precede the raw public key. */
const MULTICODEC_ED25519 = Uint8Array.from([0xed, 0x01]);

/**
 * What technocore's `clean_text` replaces with a space: Unicode general categories
 * Cc, Cf, Cs, Co, Zl, Zp. Mirrored, not imported — this package cannot depend on the
 * service. `\p{Zl}`/`\p{Zp}` are exactly U+2028/U+2029.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

/** Canonical unpadded base64url of 64 bytes: 86 chars, last one carrying 2 bits. */
const CANONICAL_SIG = /^[A-Za-z0-9_-]{85}[AQgw]$/;

/** The single-line sweep, minus the service's own empty/too-long refusals. */
export function sweep(text: string): string {
  return text.replace(INVISIBLE, " ").trim();
}

/** The string an Ed25519 room-message signature covers, UTF-8. */
export function canonicalMessage(room: string, nonce: number | string, sweptText: string): string {
  return `${room}|${nonce}|${sweptText}`;
}

let lastNonce = 0;

/**
 * Milliseconds since the epoch, bumped past the last value this process issued.
 * Strictly increasing within a process; effectively increasing across processes
 * because wall time dominates. A collision is never silent — the venue refuses with
 * the last nonce it saw.
 */
export function nextNonce(): number {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  return lastNonce;
}

/** The `did:key:z6Mk…` for a raw 32-byte Ed25519 public key. */
export function didFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(`tclk-mcp: ed25519 public key must be 32 bytes, got ${publicKey.length}`);
  }
  const multi = new Uint8Array(MULTICODEC_ED25519.length + publicKey.length);
  multi.set(MULTICODEC_ED25519, 0);
  multi.set(publicKey, MULTICODEC_ED25519.length);
  // multibase base58btc: the 'z' prefix, then base58 of the multicodec-tagged key.
  return `${DID_PREFIX}z${base58.encode(multi)}`;
}

export interface Signer {
  /** The public identity this signer writes under. Safe to publish. */
  readonly did: string;
  /** Sign a canonical string; returns 86 unpadded, canonical base64url characters. */
  sign(canonical: string): string;
}

/** A signer from a raw 32-byte Ed25519 seed. The seed stays in the closure. */
export function signerFromSeed(seed: Uint8Array): Signer {
  if (seed.length !== 32) {
    throw new Error(`tclk-mcp: ed25519 seed must be 32 bytes, got ${seed.length}`);
  }
  const did = didFromPublicKey(ed25519.getPublicKey(seed));
  return {
    did,
    sign(canonical: string): string {
      const sig = base64urlnopad.encode(ed25519.sign(new TextEncoder().encode(canonical), seed));
      // noble emits canonical base64url already; the venue rejects any other spelling,
      // so assert rather than trust — a non-canonical signature would 403 at the venue
      // with nothing here to explain why.
      if (!CANONICAL_SIG.test(sig)) {
        throw new Error("tclk-mcp: produced a non-canonical base64url signature");
      }
      return sig;
    },
  };
}

function parseSeed(spec: string): Uint8Array | null {
  const trimmed = spec.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  if (/^[A-Za-z0-9_-]{43}=?$/.test(trimmed)) {
    try {
      const raw = base64urlnopad.decode(trimmed.replace(/=+$/, ""));
      return raw.length === 32 ? raw : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * A `Signer` from the `TECHNOCORE_SIGNING_KEY` spelling: a 32-byte Ed25519 seed as 64
 * hex characters (0x-prefixed or bare) or as unpadded base64url — the same two
 * spellings technocore's own MCP server accepts, so one env var serves both.
 * Fail-closed: anything else throws, and the message never echoes the value.
 */
export function loadSigner(spec: string): Signer {
  const seed = parseSeed(spec);
  if (seed === null) {
    throw new Error(
      "tclk-mcp: TECHNOCORE_SIGNING_KEY must be a 32-byte Ed25519 seed, as 64 hex " +
        "characters or unpadded base64url",
    );
  }
  return signerFromSeed(seed);
}
