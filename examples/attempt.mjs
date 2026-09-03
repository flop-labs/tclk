// SPDX-License-Identifier: Apache-2.0
//
// One bounded attempt at the venue. `fetch` here inherits undici's `headersTimeout`, which is
// 300 s: an attempt the venue accepts and never answers holds the run for five minutes, and
// then rejects with `UND_ERR_HEADERS_TIMEOUT` — a thrown error, not a response, so it never
// reaches a `res.status` check. It surfaces through the module-level `await` into
// `reportAndExit`'s catch-all branch and prints as "a bug in this script or the library",
// with a stack, during a venue incident in which the library did nothing wrong.
//
// Measured on issue #2: a hung attempt rejected after 301.1 s. Successful KV round-trips just
// before onset ran 1.6–19.4 s, so the bound sits above that; below ~20 s slow successes start
// turning into timeouts.
//
// Pure apart from the timer, and the fetch is passed in, so a test can hang one.

/** Per-attempt bound. Above the slowest observed success, far below the 300 s default. */
export const ATTEMPT_MS = 25_000;

/**
 * The venue took the request and did not answer within the bound. Distinct from VenueError
 * on purpose: a refusal carries the venue's verdict; this carries none, and the write it
 * was making may still have landed — which is the thing a caller must know before retrying.
 */
export class VenueSilent extends Error {
  constructor(what, ms) {
    super(
      `${what}: no response within ${ms / 1000}s. The request may still have been ` +
        "committed — read the venue back before repeating a write.",
    );
    this.name = "VenueSilent";
    this.what = what;
    this.ms = ms;
  }
}

/**
 * Run one attempt under `ms`. A timeout becomes VenueSilent; every other failure — a refused
 * connection, a user abort, a bug — is rethrown untouched, because only the timeout is the
 * venue's silence and only the timeout carries the "may have landed" ambiguity.
 *
 * The bound is enforced HERE, by racing a timer, not delegated to the fetch. A real fetch
 * honours `signal` and tears the socket down, which is why it is still passed; but a bound
 * that only holds when the callee cooperates is not a bound, and the test's hung fetch is
 * exactly a callee that does not.
 */
export async function attempt(fetchImpl, url, init, ms, what) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new VenueSilent(what, ms)), ms);
  });
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) }), expired]);
  } catch (error) {
    if (error instanceof VenueSilent) throw error;
    if (error && error.name === "TimeoutError") throw new VenueSilent(what, ms);
    throw error;
  } finally {
    clearTimeout(timer); // a fast answer must not keep the process alive for the full bound
  }
}
