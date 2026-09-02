/**
 * Tests for the request-level reconcile-before-retry logic in examples/live-deal.mjs.
 *
 * The dangerous branch is a transport that COMMITS the write and then returns a 5xx:
 * a blind retry then fails on replay (400 nonce for signed frames; 409 for CAS notes),
 * turning a successful write into an apparent failure. These tests pin the contract
 * that committed-but-unacknowledged writes are reconciled to success.
 *
 * The example is a plain .mjs, so these tests exercise the same logic via a small
 * in-file reimplementation of req()/post()/notes.set() identical to the example's
 * (kept in sync by review); a future refactor should hoist the shared logic into a
 * testable module and import it from both places.
 */

import { describe, it, expect } from "vitest";

/** Mirror of examples/live-deal.mjs req() — see that file for the contract. */
async function reqWithReconcile(url, init, what, { fetchImpl, reconcile }) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchImpl(url, init);
    if (res.status !== 429 && res.status < 500) return res;
    if (res.status >= 500) {
      // Operation-layer reconciliation: a 5xx does not prove the write failed.
      const committed = await reconcile?.(url, init);
      if (committed) return res; // treat as success; caller checks res.ok per-shape
    }
    if (attempt >= 3) throw new Error(`${what}: gave up after ${attempt} retries (${res.status})`);
    const stated = Number(res.headers.get?.("retry-after"));
    const waitMs = res.status === 429
      ? (Number.isFinite(stated) && stated > 0 ? stated : 5) * 1000
      : Math.min(2 ** attempt, 10) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

function res(status, body = "", headers = {}) {
  return { status, body, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, ok: status >= 200 && status < 300 };
}

describe("reconcile-before-retry: committed writes are success, not retry bait", () => {
  it("signed frame: transport commits the POST then returns 524 → reconciled as success", async () => {
    const stored = [];
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      if (calls === 1) {
        // Commit the frame, then die before answering.
        stored.push(JSON.parse(init.body));
        return res(524, "origin timeout");
      }
      return res(500, "should not be retried");
    };
    const reconcile = async (url, init) => {
      const { did, nonce, text } = JSON.parse(init.body);
      return stored.some((m) => m.did === did && m.nonce === nonce && m.text === text);
    };
    const out = await reqWithReconcile("https://venue/r/room", { method: "POST", body: JSON.stringify({ did: "d1", nonce: "1", text: "tclk1 offer" }) }, "post", { fetchImpl, reconcile });
    expect(calls).toBe(1); // NO retry — the write is already committed
    expect(stored).toHaveLength(1); // exactly one stored frame
    expect(out.status).toBe(524);
  });

  it("signed frame: 5xx with nothing stored → retry reuses the same signed body", async () => {
    const stored = [];
    const bodies = [];
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      bodies.push(JSON.parse(init.body));
      if (calls === 1) return res(503, "unavailable");
      return res(200, "{}");
    };
    const reconcile = async () => stored.length > 0; // nothing stored yet
    await reqWithReconcile("https://venue/r/room", { method: "POST", body: JSON.stringify({ did: "d1", nonce: "1", text: "tclk1 offer" }) }, "post", { fetchImpl, reconcile });
    expect(calls).toBe(2);
    expect(bodies[0]).toEqual(bodies[1]); // byte-identical replay of the signed body
  });

  it("note CAS: commit then 524 on ?if_absent=1 → read-back shows the value → success, not 409-bait", async () => {
    let calls = 0;
    let note = null;
    const intended = "tclkpaper1 locked kr1";
    const fetchImpl = async (url) => {
      calls += 1;
      if (calls === 1) {
        note = intended; // commit, then die before answering
        return res(524, "origin timeout");
      }
      return res(500, "no retry should happen");
    };
    const reconcile = async (url) => {
      // mirror of the example's read-back: ?if_absent writes land only if absent
      if (note === intended) return "committed";
      if (note === null) return "absent";
      return "conflict";
    };
    const out = await reqWithReconcile("https://venue/kv/ns/key/set/" + encodeURIComponent(intended) + "?if_absent=1", {}, "kv set", { fetchImpl, reconcile });
    expect(calls).toBe(1); // no second write → no 409 already exists
    expect(out.status).toBe(524); // caller reconciles on the returned shape
  });

  it("note CAS: commit then 524 on ?if=old → read-back shows the new value → success", async () => {
    let calls = 0;
    let note = "old";
    const next = "new";
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        note = next; // commit
        return res(503, "unavailable");
      }
      return res(500, "no retry");
    };
    const reconcile = async () => (note === next ? "committed" : note === "old" ? "old" : "conflict");
    await reqWithReconcile("https://venue/kv/ns/key/set/" + encodeURIComponent(next) + "?if=old", {}, "kv set", { fetchImpl, reconcile });
    expect(calls).toBe(1);
    expect(note).toBe(next);
  });

  it("note 409 on a lost race still returns lost-race (no false success)", async () => {
    let calls = 0;
    const note = "someone-elses-value";
    const fetchImpl = async () => {
      calls += 1;
      return res(409, note);
    };
    const reconcile = async () => (note === "intended" ? "committed" : "conflict");
    const out = await reqWithReconcile("https://venue/kv/ns/key/set/intended?if_absent=1", {}, "kv set", { fetchImpl, reconcile });
    expect(calls).toBe(1);
    expect(out.status).toBe(409); // caller maps to lost-race, not success
    expect(out.status).not.toBe(200);
  });
});
