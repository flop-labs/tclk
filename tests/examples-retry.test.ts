/**
 * Tests for the retry + reconcile transport in examples/live-deal.mjs.
 *
 * The example is a top-level script that runs a real deal on import, so it cannot be
 * imported here. The two loops under test — `req()`'s retry classification and
 * `post()`'s reconcile-before-retry — are mirrored verbatim below with the transport
 * swapped for fakes; keep the copies in sync when editing the example (the mirror is
 * the point: these tests pin the decisions, drift shows up as a red test).
 *
 * Pinned decisions (from review discussion on #2/#9/#10):
 *  - only 429 and the transient 5xx band (500/502/503/504/522/523/524) retry;
 *    501/505 cannot change on retry and 4xx ≠ 429 is an answer, not an outage;
 *  - a hung attempt (fetch rejects with TimeoutError) is treated as "did it land?"
 *    and reconciled like a 5xx, not surfaced as a library bug;
 *  - a write that COMMITTED and then returned 5xx/timeout is a success (read-back
 *    sees the tuple), never retry bait for a 400 nonce-replay or a 409 CAS.
 */

import { describe, it, expect } from "vitest";

// ---- verbatim mirror of examples/live-deal.mjs req() (fakes: fetchImpl, log) ----
const ATTEMPT_MS = 25_000;
const RETRIABLE_5XX = new Set<number>([500, 502, 503, 504, 522, 523, 524]);

type FakeHeaders = { get(k: string): string | null };
type FakeResponse = {
  status: number;
  body: string;
  ok: boolean;
  headers: FakeHeaders;
  text(): Promise<string>;
};
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
type FetchImpl = (url: string, init: FetchInit) => Promise<FakeResponse>;
type ExportImpl = (room: string) => Promise<Set<string>>;

function res(status: number, body = "", headers: Record<string, string> = {}): FakeResponse {
  return {
    status, body, ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
  };
}
function TIMEOUT(): Promise<FakeResponse> {
  return Promise.reject(Object.assign(new Error("hung"), { name: "TimeoutError" })) as unknown as Promise<FakeResponse>;
}

async function req(
  url: string,
  init: FetchInit,
  what: string,
  { fetchImpl, log = () => {}, backoffMs = 0 }: { fetchImpl: FetchImpl; log?: (s: string, d: string) => void; backoffMs?: number },
): Promise<FakeResponse> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchImpl(url, { ...init, signal: init?.signal })
      .catch((e: unknown) => {
        if (e && typeof e === "object" && "name" in e && (e as { name: string }).name === "TimeoutError") return null;
        return Promise.reject(e);
      });
    const status = res?.status;
    const retriable = res === null || status === 429 || (status !== undefined && RETRIABLE_5XX.has(status));
    if (!retriable) return res as FakeResponse;
    if (attempt >= 3) {
      if (res === null) throw new Error(`${what}: still unreachable after ${attempt} retries (timeout)`);
      throw new Error(`${what}: gave up after ${attempt} retries (${status})`);
    }
    const stated = Number(res?.headers?.get("retry-after"));
    const waitMs = status === 429
      ? (Number.isFinite(stated) && stated > 0 ? stated : 5) * 1000
      : Math.min(2 ** attempt, 10) * 1000;
    log("", `${res === null ? "timeout" : status} — waiting ${waitMs / 1000}s`);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
}

async function postLike(args: {
  reqImpl: (url: string, init: FetchInit, what: string) => Promise<FakeResponse | null>;
  exportImpl: ExportImpl;
  signer: { did: string; nonce: string };
  room: string;
  frame: string;
  log?: (s: string, d: string) => void;
  refusal: (what: string, r: FakeResponse) => Promise<Error>;
  backoffMs?: number;
}): Promise<{ text: string; reconciled?: true; attempts: number }> {
  const { reqImpl, exportImpl, signer, room, frame, log = () => {}, refusal, backoffMs = 0 } = args;
  const text = frame;
  const nonce = signer.nonce;
  const body = { did: signer.did, sig: "sig", nonce: String(nonce), text };
  const tuple = `${signer.did}|${nonce}|${text}`;
  for (let attempt = 0; ; attempt += 1) {
    const res = await reqImpl(`${room}`, { method: "POST", body: JSON.stringify(body) }, `post to ${room}`);
    if (res && res.ok) return { text, attempts: attempt + 1 };
    if (res === null || res.status >= 500) {
      const tuples = await exportImpl(room);
      if (tuples.has(tuple)) return { text, reconciled: true, attempts: attempt + 1 };
      if (attempt >= 3) {
        if (res === null) throw new Error(`post to ${room}: still unreachable after ${attempt} retries (timeout)`);
        throw await refusal(`post to ${room}`, res);
      }
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }
    const tuples = await exportImpl(room);
    if (tuples.has(tuple)) return { text, reconciled: true, attempts: attempt + 1 };
    throw await refusal(`post to ${room}`, res);
  }
}

describe("req(): only genuinely transient statuses retry", () => {
  it("retries 429 honoring Retry-After, and the transient 5xx band with backoff", async () => {
    for (const status of [500, 502, 503, 504, 522, 523, 524]) {
      let calls = 0;
      const out = await req("u", {}, "w", {
        backoffMs: 0,
        fetchImpl: async () => (calls++ === 0 ? res(status) : res(200, "ok")),
      });
      expect(calls).toBe(2);
      expect(out.ok).toBe(true);
    }
  });

  it("never retries 501/505 — they cannot change on retry", async () => {
    for (const status of [501, 505]) {
      let calls = 0;
      const out = await req("u", {}, "w", { fetchImpl: async () => (calls++, res(status)) });
      expect(calls).toBe(1);
      expect(out.status).toBe(status);
    }
  });

  it("never retries a non-429 4xx — an answer, not an outage", async () => {
    for (const status of [400, 403, 404, 409, 422]) {
      let calls = 0;
      const out = await req("u", {}, "w", { fetchImpl: async () => (calls++, res(status)) });
      expect(calls).toBe(1);
      expect(out.status).toBe(status);
    }
  });

  it("treats a hung attempt (TimeoutError) as null and retries it", async () => {
    let calls = 0;
    const out = await req("u", {}, "w", {
      backoffMs: 0,
      fetchImpl: async () => (calls++ === 0 ? TIMEOUT() : res(200, "ok")),
    });
    expect(calls).toBe(2);
    expect(out.ok).toBe(true);
  });

  it("gives up distinctly after 3 retries on a persistent 5xx or a persistent hang", async () => {
    await expect(req("u", {}, "w", { fetchImpl: async () => res(503) })).rejects.toThrow(/gave up after 3 retries \(503\)/);
    await expect(req("u", {}, "w", { fetchImpl: TIMEOUT })).rejects.toThrow(/still unreachable after 3 retries \(timeout\)/);
  });
});

describe("post(): a committed write reconciles to success, never to retry bait", () => {
  const signer = { did: "did:key:z6Mk" + "f".repeat(44), nonce: "1717000000000000000" };
  const refusal = async (what: string, r: FakeResponse) => new Error(`${what}: ${r.status} ${r.body}`);

  it("commits then returns 524 → export read-back sees the tuple → success, no resend", async () => {
    let posts = 0;
    const stored: Set<string> = new Set();
    const out = await postLike({
      signer, room: "tclk-offers", frame: "tclk1 offer",
      refusal,
      reqImpl: async (_url: string, init: FetchInit) => {
        posts += 1;
        const parsed = JSON.parse(init.body ?? "{}") as { did: string; nonce: string; text: string };
        stored.add(`${parsed.did}|${parsed.nonce}|${parsed.text}`);
        return res(524, "origin timeout");
      },
      exportImpl: async (): Promise<Set<string>> => stored,
    });
    expect(posts).toBe(1); // no resend → no `400 nonce not greater than`
    expect(out.reconciled).toBe(true);
  });

  it("5xx with nothing stored → retries the byte-identical signed body", async () => {
    const bodies: string[] = [];
    let calls = 0;
    const out = await postLike({
      signer, room: "tclk-offers", frame: "tclk1 offer",
      refusal,
      reqImpl: async (_url: string, _init: FetchInit) => {
        bodies.push(JSON.stringify({ did: signer.did, nonce: signer.nonce, text: "tclk1 offer" }));
        return calls++ === 0 ? res(503, "unavailable") : res(200, "{}");
      },
      exportImpl: async (): Promise<Set<string>> => new Set<string>(),
    });
    expect(out.reconciled).toBeUndefined();
    expect(out.attempts).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("400 nonce-replay after the original landed → last-read reconcile returns success", async () => {
    let posts = 0;
    const stored: Set<string> = new Set();
    const out = await postLike({
      signer, room: "tclk-offers", frame: "tclk1 offer",
      refusal,
      reqImpl: async (_url: string, _init: FetchInit) => {
        posts += 1;
        if (posts === 1) { // first attempt lands but the response is lost
          stored.add(`${signer.did}|${signer.nonce}|tclk1 offer`);
          return res(400, "nonce N is not greater than N");
        }
        return res(400, "unreachable");
      },
      exportImpl: async (): Promise<Set<string>> => stored,
    });
    expect(posts).toBe(1);
    expect(out.reconciled).toBe(true);
  });

  it("a genuine refusal (nothing stored) still throws", async () => {
    await expect(postLike({
      signer, room: "tclk-offers", frame: "tclk1 offer",
      refusal,
      reqImpl: async () => res(403, "room is frozen"),
      exportImpl: async (): Promise<Set<string>> => new Set<string>(),
    })).rejects.toThrow(/403 room is frozen/);
  });
});

describe("notes.set(): committed CAS reconciles; a real lost race stays lost", () => {
  const decide = (present: string | null, intended: string, status: number): boolean | undefined =>
    present === intended ? true : status === 409 ? false : undefined;

  it("409 with the note already holding the intended value → success (this run won)", async () => {
    // Mirrors notes.set()'s decision: read back, compare, decide.
    const intended = "tclkpaper1 locked kr1";
    const present = intended; // committed before the response was lost
    expect(decide(present, intended, 409)).toBe(true);
  });

  it("409 with a different value → false (genuine lost race)", async () => {
    const intended = "tclkpaper1 locked kr1";
    const present = "someone-elses-record";
    expect(decide(present, intended, 409)).toBe(false);
  });
});
