/**
 * Tests for the `hexToU8a` fail-closed boundary.
 *
 * `hex.ts` documents `hexToU8a` as throwing on anything `isHex` rejects. Two properties
 * hold that boundary up, and both are load-bearing for callers that decode secrets:
 * every non-hex input is refused (no silent empty array), and the refusal describes the
 * input's shape rather than quoting it.
 */

import { describe, it, expect } from "vitest";

import { hexToU8a, isHex, u8aToHex } from "../src/hex.js";
import { hashLockFromPreimage, pointLockFromWitness } from "../src/index.js";

const ODD = "0x0a1";
const SECRET_ODD = "0x" + "de".repeat(31) + "a";

describe("hexToU8a", () => {
  it("decodes `0x` to zero bytes", () => {
    expect(hexToU8a("0x")).toEqual(new Uint8Array());
    expect(u8aToHex(hexToU8a("0x"))).toBe("0x");
  });

  it("round-trips through u8aToHex", () => {
    const hex = "0x" + "00ff7f80".repeat(4);
    expect(u8aToHex(hexToU8a(hex))).toBe(hex);
  });

  it("throws on every input isHex rejects", () => {
    for (const bad of ["", "0", "ff", "0X00", ODD, "0xzz", "0x 00", " 0x00"]) {
      expect(isHex(bad)).toBe(false);
      expect(() => hexToU8a(bad)).toThrow();
    }
  });

  it("refuses the empty string rather than returning an empty array", () => {
    // `0x` is the spelling for zero bytes. `""` is not hex, and decoding it to the same
    // value would make the two indistinguishable to a caller that only checks length.
    expect(() => hexToU8a("")).toThrow();
  });

  it("never echoes the input in the refusal", () => {
    expect(() => hexToU8a(SECRET_ODD)).toThrow(/65 chars/);
    try {
      hexToU8a(SECRET_ODD);
      expect.unreachable("expected a throw");
    } catch (err) {
      expect(String(err)).not.toContain("de");
      expect(String(err)).not.toContain(SECRET_ODD);
    }
  });

  it("survives a non-string from untyped callers", () => {
    expect(() => hexToU8a(undefined as unknown as string)).toThrow(/undefined/);
    expect(() => hexToU8a(null as unknown as string)).toThrow();
  });
});

describe("secret-decoding callers stay fail-closed", () => {
  it("refuses a malformed preimage without quoting it", () => {
    expect(() => hashLockFromPreimage(SECRET_ODD)).toThrow();
    expect(() => hashLockFromPreimage(SECRET_ODD)).not.toThrow(/de/);
  });

  it("refuses a malformed witness without quoting it", () => {
    expect(() => pointLockFromWitness(SECRET_ODD)).toThrow();
    expect(() => pointLockFromWitness(SECRET_ODD)).not.toThrow(/de/);
  });
});
