// SPDX-License-Identifier: Apache-2.0
//
// Internal byte/hex helpers. These replace the `@polkadot/util` primitives the reference
// implementation used, with byte-identical semantics for every input the protocol can see:
//
//  - `u8aToHex`  → `0x` + lowercase hex (`0x` for an empty array).
//  - `isHex`     → `0x`-prefixed, hex digits only, even length (`0x` itself counts).
//  - `hexToU8a`  → throws on anything `isHex` rejects (odd length included) — the
//                  fail-closed boundary every `try { … } catch { return false }` relies on.
//  - `randomU8a` → Web Crypto CSPRNG, via the `crypto` global rather than `node:crypto`.
//                  That global is standard on Node 18+, browsers, Cloudflare Workers, Deno
//                  and Bun, so the library stays runtime-agnostic and pulls in no builtins.
//
// Not part of the public API; the barrel does not re-export them.

const HEX_REGEX = /^0x[\da-fA-F]+$/;

/** True iff `value` is a `0x`-prefixed, even-length hex string (or bare `0x`). */
export function isHex(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "0x" || HEX_REGEX.test(value)) &&
    value.length % 2 === 0
  );
}

/** `0x` + lowercase hex. */
export function u8aToHex(value: Uint8Array): string {
  let out = "0x";
  for (const byte of value) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Decode `0x`-hex to bytes. Throws on non-hex or odd-length input (fail-closed).
 *
 * `0x` is the spelling for zero bytes; `""` is not hex and is refused like any other
 * malformed input. The refusal carries the input's length, never its value —
 * `hashLockFromPreimage` and `pointLockFromWitness` decode secret preimages and
 * witnesses through here, and an echoed secret lands in whatever log catches the throw.
 */
export function hexToU8a(value: string): Uint8Array {
  if (!isHex(value)) {
    // `isHex` is a type guard, so it narrows `value` to `never` in this branch; widen it
    // back, because untyped callers can still reach this line with a non-string.
    const seen = value as unknown;
    const shape = typeof seen === "string" ? `${seen.length} chars` : typeof seen;
    throw new Error(`tclk: expected 0x-prefixed even-length hex, got ${shape}`);
  }
  const body = value.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** UTF-8 encode. */
export function stringToU8a(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Concatenate byte arrays. */
export function u8aConcat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** `length` cryptographically random bytes. */
export function randomU8a(length: number): Uint8Array {
  // Fail closed and loudly: a silent Math.random() fallback would mint guessable
  // preimages and witnesses, which is a stolen payment rather than a degraded one.
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("tclk: no Web Crypto CSPRNG available (crypto.getRandomValues)");
  }
  return crypto.getRandomValues(new Uint8Array(length));
}
