// SPDX-License-Identifier: Apache-2.0
//
// A hung attempt at the venue is bounded, and is reported as the venue's silence rather than
// as a bug in this repository. Regression cover for the 301 s hang measured on #2.

import { describe, expect, it } from "vitest";

// @ts-expect-error - examples/ is plain ESM and carries no declarations; tsc builds only src/.
import { ATTEMPT_MS, VenueSilent, attempt } from "../examples/attempt.mjs";

const hang = () => new Promise<never>(() => {});
const answer = async () => ({ status: 200 });

describe("attempt", () => {
  it("bounds an attempt the venue never answers, and names it the venue's silence", async () => {
    const started = Date.now();
    await expect(attempt(hang, "u", undefined, 50, "post to r")).rejects.toBeInstanceOf(
      VenueSilent,
    );
    // The bound, not undici's 300 s default, is what ended it.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("says the one thing a caller must know: the write may still have landed", async () => {
    const error = await attempt(hang, "u", undefined, 20, "kv set x").catch((e) => e);
    expect(error.name).toBe("VenueSilent");
    expect(error.message).toContain("kv set x");
    expect(error.message).toContain("may still have been committed");
  });

  it("passes an answered attempt through untouched", async () => {
    await expect(attempt(answer, "u", undefined, 50, "read")).resolves.toEqual({ status: 200 });
  });

  it("rethrows anything that is not the timeout, including a caller's own abort", async () => {
    const refused = async () => {
      throw Object.assign(new Error("ECONNREFUSED"), { name: "FetchError" });
    };
    await expect(attempt(refused, "u", undefined, 50, "read")).rejects.toThrow("ECONNREFUSED");
    const userAbort = async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    const e = await attempt(userAbort, "u", undefined, 50, "read").catch((x) => x);
    expect(e).not.toBeInstanceOf(VenueSilent);
  });

  it("keeps the bound above the slowest success measured before onset", () => {
    // 1.6–19.4 s on #2; below ~20 s slow successes convert into timeouts.
    expect(ATTEMPT_MS).toBeGreaterThan(20_000);
    expect(ATTEMPT_MS).toBeLessThan(300_000);
  });
});
