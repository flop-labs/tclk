/**
 * Tests for PTLC point-lock minting.
 *
 * `generatePointLock` rejection-samples a scalar, so it is the one generator with a loop
 * around the CSPRNG. The loop must not become a way to *lose* a CSPRNG failure:
 * `randomU8a` throws when no Web Crypto is available, and that refusal has to leave the
 * loop the way it leaves `generateHashLock` and `generateSalt`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  generatePointLock,
  pointLockFromWitness,
  verifyPointWitness,
  isValidPointStatement,
  SECP256K1_N,
} from "../src/points.js";
import { generateHashLock } from "../src/locks.js";
import { generateSalt } from "../src/commitments.js";

const OUT_OF_RANGE = new Uint8Array(32).fill(0xff); // > n
const IN_RANGE = new Uint8Array(32).fill(0x01);

afterEach(() => {
  vi.restoreAllMocks();
});

/** How many 32-byte witness draws the spy saw (ignoring the curve's 16-byte blinding). */
function draws32(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((c) => (c[0] as Uint8Array | undefined)?.length === 32).length;
}

describe("generatePointLock", () => {
  it("mints a lock whose witness opens its own statement", () => {
    const lock = generatePointLock();
    expect(lock.witness).toMatch(/^0x[0-9a-f]{64}$/);
    expect(isValidPointStatement(lock.statement)).toBe(true);
    expect(verifyPointWitness(lock.statement, lock.witness)).toBe(true);
    expect(BigInt(lock.witness)).toBeGreaterThan(0n);
    expect(BigInt(lock.witness)).toBeLessThan(SECP256K1_N);
  });

  it("retries past an out-of-range draw", () => {
    // Count witness draws only: @noble/curves also pulls 16 bytes to blind the scalar
    // multiplication, so total CSPRNG calls are not the same thing as attempts.
    const spy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementationOnce(() => OUT_OF_RANGE.slice() as never)
      .mockImplementationOnce(() => IN_RANGE.slice() as never);
    const lock = generatePointLock();
    expect(draws32(spy)).toBe(2);
    expect(lock).toEqual(pointLockFromWitness(IN_RANGE));
  });

  it("propagates a CSPRNG refusal raised by the curve's own blinding", () => {
    // The same defect reached through @noble/curves: `randomU8a` succeeds, then the
    // blinding draw inside `pointLockFromWitness` fails. Catching the whole call meant
    // this too became a silent retry forever.
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((a: Uint8Array) => {
      if (a.length === 32) return IN_RANGE.slice();
      throw new Error("tclk: no Web Crypto CSPRNG available (crypto.getRandomValues)");
    }) as never);
    expect(() => generatePointLock()).toThrow(/no Web Crypto CSPRNG available/);
  });

  it("propagates a CSPRNG refusal instead of spinning on it", () => {
    // The regression: catching the draw swallowed this, and the retry loop then span
    // synchronously and forever -- no error, and no timer or signal able to interrupt it.
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
      throw new Error("tclk: no Web Crypto CSPRNG available (crypto.getRandomValues)");
    });
    expect(() => generatePointLock()).toThrow(/no Web Crypto CSPRNG available/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of unusable draws", () => {
    const spy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation(() => OUT_OF_RANGE.slice() as never);
    expect(() => generatePointLock()).toThrow(/no scalar in \[1, n\)/);
    expect(draws32(spy)).toBeLessThanOrEqual(16);
  });

  it("fails the same way the other secret generators do", () => {
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
      throw new Error("tclk: no Web Crypto CSPRNG available (crypto.getRandomValues)");
    });
    for (const mint of [generatePointLock, generateHashLock, generateSalt]) {
      expect(mint).toThrow(/no Web Crypto CSPRNG available/);
    }
  });
});
