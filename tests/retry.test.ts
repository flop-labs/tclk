// SPDX-License-Identifier: Apache-2.0
//
// The example's retry policy. Regression cover for #2: a transient 5xx from the venue
// killed a run mid-deal because `req()` looped only on 429, and a run that dies between
// `lock` and `reveal` sits until `refundAfterMs` on a rail that held value.

import { describe, expect, it } from "vitest";

// @ts-expect-error - examples/ is plain ESM and carries no declarations; tsc builds only src/.
import { RETRIABLE_SERVER_STATUS, RETRY_LIMIT, retryPlan } from "../examples/retry.mjs";

describe("retryPlan", () => {
  it("retries every server status the venue never chose", () => {
    // The bug: each of these returned straight through and threw at the call site.
    for (const status of [500, 502, 503, 504]) {
      const plan = retryPlan(status, null, 0);
      expect(plan.retry, `status ${status} must be retried`).toBe(true);
      expect(plan.waitMs).toBeGreaterThan(0);
      expect(plan.why).toContain(String(status));
    }
  });

  it("backs off geometrically and then gives up", () => {
    expect(retryPlan(503, null, 0).waitMs).toBe(1000);
    expect(retryPlan(503, null, 1).waitMs).toBe(2000);
    expect(retryPlan(503, null, 2).waitMs).toBe(4000);

    const exhausted = retryPlan(503, null, RETRY_LIMIT);
    expect(exhausted.retry).toBe(false);
    // The caller turns this into a VenueError carrying the venue's own line, so the
    // reason still has to name what happened.
    expect(exhausted.why).toContain("503");
  });

  it("obeys retry-after on a 429, and falls back when it is absent or nonsense", () => {
    expect(retryPlan(429, "12", 0).waitMs).toBe(12_000);
    expect(retryPlan(429, null, 0).waitMs).toBe(5000);
    for (const bad of ["0", "-1", "soon", "", "NaN"]) {
      expect(retryPlan(429, bad, 0).waitMs, `retry-after: ${bad}`).toBe(5000);
    }
  });

  it("never retries a refusal the venue meant", () => {
    // A 403 is a considered answer — a used nonce, an unowned room. Repeating it cannot
    // change it and spends the caller's per-minute budget discovering that.
    for (const status of [200, 400, 403, 404, 409, 422]) {
      expect(retryPlan(status, null, 0).retry, `status ${status}`).toBe(false);
    }
  });

  it("does not treat 501 or 505 as transient", () => {
    // "Not implemented" and "version not supported" are permanent; retrying is noise.
    expect(RETRIABLE_SERVER_STATUS.has(501)).toBe(false);
    expect(retryPlan(501, null, 0).retry).toBe(false);
    expect(retryPlan(505, null, 0).retry).toBe(false);
  });
});
