// SPDX-License-Identifier: Apache-2.0
//
// The retry policy `examples/live-deal.mjs` uses, as a pure function so it can be tested
// without a network. `req()` there does the sleeping and the fetching; everything that
// decides *whether* to wait and *how long* lives here.
//
// Two retriable classes, for different reasons:
//
//   429  the venue chose to refuse and said when to come back. Its `retry-after` is an
//        instruction, so it wins over any local schedule.
//   5xx  the venue did not choose anything — it was overloaded or a proxy answered for it.
//        Nothing states when to return, so back off geometrically and give up.
//
// A 4xx that is not 429 is the venue's considered answer and is never retried: repeating a
// refused write cannot make it succeed and spends the caller's budget finding that out.

/** How many waits before giving up and handing the response back to the caller. */
export const RETRY_LIMIT = 3;

/** Statuses where the venue never formed an opinion, so asking again can differ. */
export const RETRIABLE_SERVER_STATUS = new Set([500, 502, 503, 504]);

/** The venue's own default when it refuses without naming a delay, in seconds. */
const DEFAULT_RATE_LIMIT_WAIT_S = 5;

/** First backoff step for a 5xx, doubling per attempt: 1s, 2s, 4s. */
const SERVER_BACKOFF_BASE_MS = 1000;

/**
 * Decide what to do about one response.
 *
 * `retryAfter` is the raw `retry-after` header value (string or null) — parsed here rather
 * than by the caller so the "it said 0, or `-1`, or a date" cases have one home.
 *
 * Deliberately no jitter: one script making one deal is not a thundering herd, and a
 * deterministic schedule is one a reader can predict and a test can assert.
 *
 * @returns {{retry: boolean, waitMs: number, why: string}}
 */
export function retryPlan(status, retryAfter, attempt) {
  const no = { retry: false, waitMs: 0, why: "" };

  if (status === 429) {
    if (attempt >= RETRY_LIMIT) {
      return { ...no, why: `still rate limited after ${attempt} waits` };
    }
    const stated = Number(retryAfter);
    const seconds = Number.isFinite(stated) && stated > 0 ? stated : DEFAULT_RATE_LIMIT_WAIT_S;
    return {
      retry: true,
      waitMs: seconds * 1000,
      why: `rate limited — waiting ${seconds}s, as the venue asked`,
    };
  }

  if (RETRIABLE_SERVER_STATUS.has(status)) {
    if (attempt >= RETRY_LIMIT) {
      return { ...no, why: `venue still returning ${status} after ${attempt} retries` };
    }
    const waitMs = SERVER_BACKOFF_BASE_MS * 2 ** attempt;
    return {
      retry: true,
      waitMs,
      why: `venue returned ${status} — retrying in ${waitMs / 1000}s`,
    };
  }

  return no;
}
