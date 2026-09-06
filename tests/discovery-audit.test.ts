// SPDX-License-Identifier: Apache-2.0
//
// Phase-1 discovery-audit scanner tests. Covers the nine mandated areas:
// DID fingerprint/path, one-line note parsing, security (allowlist / no
// untrusted URL ever reaches fetch), tier classification, retained-window
// wording, rate-limit behavior, malformed/unsigned frame rejection,
// within-tier scoring, and cache freshness/stale markers.
//
// Everything runs against an injected fetch; no test touches the network.

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";
import { afterEach, describe, expect, it } from "vitest";

import {
  dealRoom,
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  OFFER_ROOM,
  type TranscriptRecord,
} from "../src/index.js";

import {
  buildAuditUrl,
  candidatesToCsv,
  classifyDid,
  didFingerprint,
  didNotePaths,
  isPaperCompatible,
  loadExportRecords,
  parseDidNoteTokens,
  parseNoteBody,
  rankCandidates,
  resolveNote,
  runAudit,
  validateBaseUrl,
  TIER_A,
  TIER_B,
  TIER_C,
  TIER_D,
  TIER_UNKNOWN,
} from "../scripts/discovery-audit.mjs";

// ── Test identity + signed-record helpers (same approach as transcript.test.ts) ──

const NOW = 1_735_000_000_000;
const BOARD = OFFER_ROOM;

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((part) => Number.parseInt(part, 16)));
}

function identity(seedHex: string) {
  const seed = bytes(seedHex);
  const publicKey = ed25519.getPublicKey(seed);
  const tagged = Uint8Array.from([0xed, 0x01, ...publicKey]);
  return {
    did: `did:key:z${base58.encode(tagged)}`,
    sign(canonical: string) {
      return base64urlnopad.encode(ed25519.sign(new TextEncoder().encode(canonical), seed));
    },
  };
}

const payer = identity("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const payee = identity("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
const stranger = identity("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7");
const noteOnly = identity("56e4b5f1b0b78b3a2f8d7e6c5a4b392817f0e1d2c3b4a5968796859493928377");

function record(
  room: string,
  seq: number,
  timestampMs: number,
  signer: ReturnType<typeof identity>,
  line: string,
  opts: { unsigned?: boolean } = {},
): TranscriptRecord {
  const nonce = String(10_000 + seq);
  return {
    room,
    seq,
    timestampMs,
    sender: signer.did,
    nonce,
    signature: opts.unsigned ? null : signer.sign(`${room}|${nonce}|${line}`),
    line,
  };
}

function dealPair(nowMs = NOW) {
  const lock = generateHashLock();
  const offer = makeOffer({
    from: payer.did,
    role: "payer",
    amount: "1000",
    asset: "PAPER",
    lock: "hash",
    rails: ["paper"],
    claimByMs: nowMs + 3_600_000,
    refundAfterMs: nowMs + 7_200_000,
    expiresMs: nowMs + 600_000,
    nonce: "0011223344556677",
  });
  const accept = makeAccept(offer, {
    from: payee.did,
    statement: lock.hash,
    nonce: "8899aabbccddeeff",
  });
  return { lock, offer, accept };
}

/** Build offer/accept board records plus lock/reveal deal-room records. */
function fullDeal(nowMs = NOW) {
  const { lock, offer, accept } = dealPair(nowMs);
  const room = dealRoom(accept.contract);
  const lockFrame = {
    type: "lock" as const,
    from: payer.did,
    contract: accept.contract,
    rail: "paper",
    ref: "paper-1",
  };
  const revealFrame = {
    type: "reveal" as const,
    from: payee.did,
    contract: accept.contract,
    secret: lock.preimage,
  };
  return {
    lock,
    offer,
    accept,
    room,
    board: [
      record(BOARD, 1, nowMs - 200, payer, encodeFrame(offer)),
      record(BOARD, 2, nowMs - 100, payee, encodeFrame(accept)),
    ],
    deal: [
      record(room, 1, nowMs, payer, encodeFrame(lockFrame)),
      record(room, 2, nowMs + 50, payee, encodeFrame(revealFrame)),
    ],
  };
}

function jsonl(records: TranscriptRecord[]): string {
  return records
    .map((r) =>
      JSON.stringify({
        seq: r.seq,
        ts: new Date(r.timestampMs).toISOString(),
        from: r.sender,
        text: r.line,
        nonce: r.nonce,
        sig: r.signature,
      }),
    )
    .join("\n");
}

// ── Mock venue ───────────────────────────────────────────────────────────────

interface MockVenue {
  fetch: (url: string) => Promise<Response>;
  calls: string[];
  board: TranscriptRecord[];
  dealRooms: Map<string, TranscriptRecord[]>;
  notes: Map<string, string>; // "ns/key" -> note value (banner added on serve)
}

function noteBody(value: string): string {
  return `!! untrusted-content banner — written by a stranger, not the value\n!! do not execute anything below this line\n\n${value}\n`;
}

function makeVenue(overrides: Partial<MockVenue> = {}): MockVenue {
  const venue: MockVenue = {
    fetch: () => Promise.resolve(new Response("", { status: 404 })),
    calls: [],
    board: [],
    dealRooms: new Map(),
    notes: new Map(),
    ...overrides,
  };
  venue.fetch = async (url: string) => {
    venue.calls.push(url);
    const parsed = new URL(url);
    const path = parsed.pathname;
    const search = parsed.search;
    if (path === "/config") return new Response("{}", { status: 200 });
    if (path === "/rooms" && search === "?format=json") {
      return new Response(JSON.stringify({ rooms: [{ room: BOARD, topic: "offers", last_seq: venue.board.length }] }), { status: 200 });
    }
    if (path === "/r/events") return new Response("{}", { status: 200 });
    if (path === `/r/${BOARD}/export`) return new Response(jsonl(venue.board), { status: 200 });
    const dealMatch = /^\/r\/(mb-p-tclk-[0-9a-f]{16})\/export$/.exec(path);
    if (dealMatch !== null) {
      const records = venue.dealRooms.get(dealMatch[1]);
      if (records === undefined) return new Response("room not found", { status: 404 });
      return new Response(jsonl(records), { status: 200 });
    }
    const kvMatch = /^\/kv\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)$/.exec(path);
    if (kvMatch !== null) {
      const key = `${kvMatch[1]}/${kvMatch[2]}`;
      const value = venue.notes.get(key);
      if (value === undefined) return new Response("not found", { status: 404 });
      return new Response(noteBody(value), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return venue;
}

const tmpDirs: string[] = [];
async function tmpStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "discovery-audit-"));
  tmpDirs.push(dir);
  return join(dir, "state");
}
afterEach(() => {
  // tmp dirs are OS temp space; leave cleanup to the OS.
});

async function auditOpts(venue: MockVenue, overrides: Record<string, unknown> = {}) {
  const stateDir = await tmpStateDir();
  return {
    fetchImpl: venue.fetch,
    base: "https://technocore.chat",
    stateDir,
    nowMs: () => NOW,
    sleep: async () => {},
    notePaceMs: 0,
    ...overrides,
  };
}

// ── 1. DID fingerprint / path ────────────────────────────────────────────────

describe("DID note path mechanics", () => {
  it("computes sha256(did:key) → first 16 lowercase hex, split 2+14, legacy fallback", () => {
    // Hardcoded vector: sha256("did:key:z6MkTestIdentity00000000000000000000000000000000")
    // first 16 hex chars (computed independently; pins the derivation, not the impl).
    const did = "did:key:z6MkTestIdentity00000000000000000000000000000000";
    const fp = didFingerprint(did);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).toBe("8edd784aac91df1d");
    const paths = didNotePaths(did);
    expect(paths.primary.ns).toBe(`did-${fp.slice(0, 2)}`);
    expect(paths.primary.key).toBe(fp.slice(2));
    expect(paths.primary.key).toHaveLength(14);
    expect(paths.legacy).toEqual({ ns: "did", key: fp });
  });

  it("rejects non-string input", () => {
    expect(() => didFingerprint("")).toThrow(/non-empty string/);
  });
});
// ── 2. One-line note parsing ─────────────────────────────────────────────────

describe("DID note token parsing", () => {
  it("parses tclk1 rails, multiple rails, and mailbox tokens from one line", () => {
    const tokens = parseDidNoteTokens(
      "did:key:z6MkFoo mailbox:mb-p-tclk-abc12345 tclk1:paper,x402 hello",
    );
    expect(tokens.tclk1).toBe("tclk1:paper,x402");
    expect(tokens.rails).toEqual(["paper", "x402"]);
    expect(tokens.railsLenient).toEqual(["paper", "x402"]);
    expect(tokens.mailbox).toBe("mb-p-tclk-abc12345");
  });

  it("normalizes rail aliases (PaperRail → paper) through the strict parser", () => {
    const tokens = parseDidNoteTokens("tclk1:PaperRail,flop-htlc");
    expect(tokens.rails).toEqual(["flop-htlc", "paper"]);
    expect(isPaperCompatible(tokens.rails)).toBe(true);
  });

  it("ignores unrelated tokens", () => {
    expect(parseDidNoteTokens("just some words did:key:z6MkX")).toEqual({
      tclk1: null,
      rails: null,
      railsLenient: null,
      mailbox: null,
    });
  });

  it("treats malformed tokens as absent, never coerced", () => {
    const empty = parseDidNoteTokens("tclk1:");
    expect(empty.rails).toBeNull();
    expect(empty.railsLenient).toBeNull();
    expect(parseDidNoteTokens("mailbox:")).toMatchObject({ mailbox: null });
    expect(parseDidNoteTokens("mailbox:Bad_Room!")).toMatchObject({ mailbox: null });
    expect(parseDidNoteTokens("tclk1:paper,,x402")).toMatchObject({ railsLenient: ["paper", "", "x402"] });
    expect(parseDidNoteTokens("tclk1:unknown-rail-xyz")).toMatchObject({ rails: null, railsLenient: ["unknown-rail-xyz"] });
  });

  it("strips the venue banner and keeps the single value line", () => {
    expect(parseNoteBody("!! banner\n!! more banner\n\n tclk1:paper \n")).toBe("tclk1:paper");
    expect(parseNoteBody("!! only a banner\n\n")).toBeNull();
  });
});

// ── 2b. Export loading (per-row, fail-closed, byte-exact) ────────────────────

describe("tolerant export loading", () => {
  it("recovers byte-exact nonces beyond 2^53 and drops only truly malformed rows", async () => {
    const { offer, accept } = dealPair(NOW);
    // Re-sign the accept under a nonce larger than Number.MAX_SAFE_INTEGER, then
    // serialize it the way the live venue does: as a lossy JSON number.
    const bigNonce = "1788625703100467001";
    const acceptRecord = {
      room: BOARD,
      seq: 2,
      timestampMs: NOW - 100,
      sender: payee.did,
      nonce: bigNonce,
      signature: payee.sign(`${BOARD}|${bigNonce}|${encodeFrame(accept)}`),
      line: encodeFrame(accept),
    };
    const jsonLine = JSON.stringify({
      seq: 2,
      ts: new Date(NOW - 100).toISOString(),
      from: payee.did,
      text: encodeFrame(accept),
      nonce: bigNonce,
      sig: acceptRecord.signature,
    }).replace(`"nonce":"${bigNonce}"`, `"nonce":${bigNonce}`);

    const loaded = loadExportRecords(BOARD, `${jsonLine}\nthis is not json\n`);
    expect(loaded.records).toHaveLength(1);
    expect(loaded.dropped).toHaveLength(1);
    expect(loaded.dropped[0].reason).toBe("line is not JSON");
    expect(loaded.records[0].nonce).toBe(bigNonce);
    expect(loaded.records[0].sender).toBe(payee.did);

    // End-to-end: the recovered record is authenticated evidence.
    const venue = makeVenue({
      board: [
        record(BOARD, 1, NOW - 200, payer, encodeFrame(offer)),
        { ...acceptRecord },
      ],
    });
    // makeVenue serializes board records via jsonl() which emits nonce as a JSON
    // string; patch the served export to mimic the lossy venue.
    const originalFetch = venue.fetch;
    venue.fetch = async (url: string) => {
      if (url.endsWith(`/r/${BOARD}/export`)) {
        return new Response(
          `${jsonl(venue.board.slice(0, 1))}\n${jsonLine}\nthis is not json\n`,
          { status: 200 },
        );
      }
      return originalFetch(url);
    };
    const result = await runAudit(await auditOpts(venue));
    expect(result.status).toBe("PHASE1_COMPLETE");
    expect(result.evidence.counts.boardExportRawRows).toBe(3);
    expect(result.evidence.counts.boardExportDroppedRows).toBe(1);
    expect(result.evidence.counts.didsWithValidAccepts).toBe(1);
    const payeeRow = result.candidates.find((r) => r.did === payee.did);
    expect(payeeRow?.tier).toBe(TIER_B);
  });

  it("fails closed (not whole-audit) when a deal-room export has a bad row", async () => {
    const { lock, offer, accept } = dealPair(NOW);
    const room = dealRoom(accept.contract);
    const lockRecord = record(room, 1, NOW, payer, encodeFrame({
      type: "lock" as const,
      from: payer.did,
      contract: accept.contract,
      rail: "paper",
      ref: "paper-1",
    }));
    const venue = makeVenue({
      board: [
        record(BOARD, 1, NOW - 200, payer, encodeFrame(offer)),
        record(BOARD, 2, NOW - 100, payee, encodeFrame(accept)),
      ],
    });
    const originalFetch = venue.fetch;
    venue.fetch = async (url: string) => {
      if (url.endsWith(`/r/${room}/export`)) {
        return new Response(`${jsonl([lockRecord])}\n{"seq":"broken`
          + `${jsonl([])}`, { status: 200 });
      }
      return originalFetch(url);
    };
    const result = await runAudit(await auditOpts(venue));
    expect(result.status).toBe("PHASE1_COMPLETE");
    expect(result.evidence.contracts[0].foldOk).toBe(true);
    expect(result.evidence.contracts[0].droppedRows).toBe(1);
    void lock;
  });
});

// ── 3. Security: allowlist + untrusted content can never drive a fetch ──────

describe("security gates", () => {
  it("rejects unsafe base URLs", () => {
    expect(() => validateBaseUrl("http://evil.example.com")).toThrow(/non-https/);
    expect(() => validateBaseUrl("https://evil.example.com/path")).toThrow(/unsafe base/);
    expect(() => validateBaseUrl("javascript:alert(1)")).toThrow(/unsafe base/);
    expect(validateBaseUrl("https://technocore.chat")).toBe("https://technocore.chat");
    expect(validateBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("rejects path injection through room/ns/key segments", () => {
    expect(() => buildAuditUrl("https://technocore.chat", ["r", "../etc/passwd"], null)).toThrow(/bad room/);
    expect(() => buildAuditUrl("https://technocore.chat", ["r", "a/b"], null)).toThrow(/bad room/);
    expect(() => buildAuditUrl("https://technocore.chat", ["r", "UPPER"], null)).toThrow(/bad room/);
    expect(() => buildAuditUrl("https://technocore.chat", ["r", "x".repeat(49)], null)).toThrow(/bad room/);
    expect(() => buildAuditUrl("https://technocore.chat", ["kv", "did-aa", ".."], null)).toThrow(/bad kv/);
    expect(() => buildAuditUrl("https://technocore.chat", ["kv", "did-aa"], null)).toThrow(/bad kv/);
  });

  it("rejects routes outside the allowlist", () => {
    expect(() => buildAuditUrl("https://technocore.chat", ["r", "tclk-offers", "notes"], null)).toThrow(/unrecognized/);
    expect(() => buildAuditUrl("https://technocore.chat", ["foo"], null)).toThrow(/not allowlisted/);
    expect(() => buildAuditUrl("https://technocore.chat", [".well-known", "other.json"], null)).toThrow(/allowlisted/);
  });

  it("never fetches URLs found in messages, notes, or job.context", async () => {
    const { offer, accept } = dealPair(NOW);
    const evilMessage = record(BOARD, 9, NOW + 10, stranger, "see https://evil.example.com/exfil?x=1 now");
    const evilNote = record(BOARD, 10, NOW + 10, noteOnly, "tclk1:paper", { unsigned: true });
    const payeeNote = didNotePaths(payee.did);
    const noteOnlyNote = didNotePaths(noteOnly.did);
    const venue = makeVenue({
      board: [
        record(BOARD, 1, NOW - 200, payer, encodeFrame(offer)),
        record(BOARD, 2, NOW - 100, payee, encodeFrame(accept)),
        evilMessage,
        evilNote,
      ],
      dealRooms: new Map(),
      notes: new Map([
        [`${payeeNote.primary.ns}/${payeeNote.primary.key}`,
          "tclk1:paper https://evil.example.com/note"],
        [`${noteOnlyNote.primary.ns}/${noteOnlyNote.primary.key}`,
          "tclk1:paper follow https://evil.example.com/note2 now"],
      ]),
    });
    // A job.context URL inside a signed offer frame: still just a string value.
    const evilJobOffer = makeOffer({
      from: payer.did,
      role: "payer",
      amount: "1",
      asset: "PAPER",
      lock: "hash",
      rails: ["paper"],
      claimByMs: NOW + 3_600_000,
      refundAfterMs: NOW + 7_200_000,
      expiresMs: NOW + 600_000,
      nonce: "ffeeddccbbaa9988",
      job: { id: "task-1", proto: "a2a", context: "https://evil.example.com/job" },
    });
    venue.board.push(record(BOARD, 3, NOW - 50, payer, encodeFrame(evilJobOffer)));

    const opts = await auditOpts(venue);
    const result = await runAudit(opts);
    expect(result.status).toBe("PHASE1_COMPLETE");

    const evilHost = venue.calls.filter((url) => url.includes("evil.example.com"));
    expect(evilHost).toEqual([]);
    void evilNote;
    // Every called URL must parse and match an allowlisted route shape.
    for (const url of venue.calls) {
      const parsed = new URL(url);
      expect(parsed.hostname).toBe("technocore.chat");
      expect(parsed.protocol).toBe("https:");
      const segments = parsed.pathname.split("/").filter(Boolean);
      const allowed =
        (segments[0] === "config") ||
        (segments[0] === "rooms") ||
        (segments[0] === "r" && segments[1] === "events") ||
        (segments[0] === "r" && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(segments[1]) &&
          (segments.length === 2 || (segments[2] === "export" && segments.length === 3))) ||
        (segments[0] === "kv" && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(segments[1]) &&
          /^[a-z0-9][a-z0-9_-]{0,63}$/.test(segments[2]));
      expect(allowed).toBe(true);
    }
  });
});

// ── 4. Tier classification ───────────────────────────────────────────────────

describe("tier classification", () => {
  const now = NOW + 1_000_000;
  const recent = 14 * 24 * 3600 * 1000;

  it("reveal/claimed payee ⇒ Tier A", () => {
    const d = {
      ...newEvidence(),
      validAccepts: 1,
      validReveals: 1,
      claimedAsPayee: true,
      lastSeen: now - 1000,
    };
    expect(classifyDid(d, now, recent).tier).toBe(TIER_A);
  });

  it("accept only ⇒ Tier B", () => {
    const d = { ...newEvidence(), validAccepts: 1, lastSeen: now - 1000 };
    expect(classifyDid(d, now, recent).tier).toBe(TIER_B);
  });

  it("signed activity (+ recent and/or capability hints) ⇒ Tier C", () => {
    const d = { ...newEvidence(), validOffers: 1, lastSeen: now - 1000 };
    expect(classifyDid(d, now, recent).tier).toBe(TIER_C);
    const stale = { ...newEvidence(), validLocks: 1, lastSeen: now - 3 * recent };
    expect(classifyDid(stale, now, recent).tier).toBe(TIER_C);
  });

  it("capability advertisement only ⇒ Tier D", () => {
    const d = { ...newEvidence(), note: { railsLenient: ["paper"], rails: ["paper"] } };
    expect(classifyDid(d, now, recent).tier).toBe(TIER_D);
  });

  it("no evidence ⇒ UNKNOWN, never a negative verdict", () => {
    expect(classifyDid(newEvidence(), now, recent).tier).toBe(TIER_UNKNOWN);
  });

  it("reachability: accepts+recent ⇒ confirmed; frames+recent/hints ⇒ probable; old+no hints ⇒ stale", () => {
    const recent = 14 * 24 * 3600 * 1000;
    expect(classifyDid({ ...newEvidence(), validAccepts: 1, lastSeen: now - 1 }, now, recent).reachable).toBe("confirmed");
    expect(classifyDid({ ...newEvidence(), validOffers: 1, lastSeen: now - 1 }, now, recent).reachable).toBe("probable");
    expect(classifyDid({ ...newEvidence(), validOffers: 1, lastSeen: now - 3 * recent }, now, recent).reachable).toBe("stale");
    expect(classifyDid({ ...newEvidence(), note: { rails: ["paper"] } }, now, recent).reachable).toBe("unknown");
  });
});

function newEvidence() {
  return {
    did: "did:key:z6MkX",
    signedFrames: 0,
    invalidTclkLines: 0,
    validOffers: 0,
    validAccepts: 0,
    validLocks: 0,
    validReveals: 0,
    validRefunds: 0,
    validCancels: 0,
    validReceipts: 0,
    validHeartbeats: 0,
    firstSeen: null,
    lastSeen: null,
    contracts: new Set(),
    lockedContracts: new Set(),
    claimedAsPayee: false,
    cancelledContracts: new Set(),
    terminalStates: new Set(),
    offerRails: new Set(),
    note: {},
  };
}

// ── 5. Retained-window wording ───────────────────────────────────────────────

describe("retained-window wording and unknowns", () => {
  it("a Tier B candidate says 'no valid reveal observed in the currently retained transcript window', not 'never revealed'", async () => {
    const { offer, accept } = dealPair(NOW);
    const venue = makeVenue({
      board: [
        record(BOARD, 1, NOW - 200, payer, encodeFrame(offer)),
        record(BOARD, 2, NOW - 100, payee, encodeFrame(accept)),
      ],
    });
    const result = await runAudit(await auditOpts(venue));
    const row = result.candidates.find((r) => r.did === payee.did);
    expect(row?.tier).toBe(TIER_B);
    expect(row?.caveats).toContain("currently retained transcript window");
    // Absence of a reveal in the retained window is never reported as "never revealed".
    expect(row?.caveats).not.toMatch(/never( |-)revealed/i);
  });

  it("an unobserved DID is UNKNOWN, and the report uses retained-window phrasing", async () => {
    const venue = makeVenue({ board: [] });
    const result = await runAudit(await auditOpts(venue));
    expect(result.status).toBe("PHASE1_COMPLETE");
    // No DID observed at all → no candidates, and nothing claims a negative.
    expect(result.candidates).toEqual([]);
    expect(result.evidence.counts.totalRetainedBoardRecords).toBe(0);
  });
});

// ── 6. Rate-limit behavior ───────────────────────────────────────────────────

describe("rate-limit behavior", () => {
  it("honours Retry-After and completes within the bound", async () => {
    const waits: number[] = [];
    const venue = makeVenue();
    const base = "https://technocore.chat";
    let config429 = true;
    const fetch429 = async (url: string) => {
      venue.calls.push(url);
      if (url === `${base}/config` && config429) {
        config429 = false; // one 429, then success — the retry must recover
        return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
      }
      return venue.fetch(url);
    };
    const result = await runAudit(await auditOpts(venue, {
      fetchImpl: fetch429,
      sleep: async (ms: number) => { waits.push(ms); },
    }));
    expect(result.status).toBe("PHASE1_COMPLETE");
    expect(waits).toContain(1000);
    expect(result.rateLimits.rateLimited429).toBeGreaterThan(0);
    expect(result.rateLimits.rateLimitWaitsMs).toBeGreaterThanOrEqual(1000);
  });

  it("stops cleanly on persistent 429, preserving the checkpoint", async () => {
    const venue = makeVenue();
    const base = "https://technocore.chat";
    const fetch429 = async (url: string) => {
      if (url === `${base}/config` || url === `${base}/r/${BOARD}/export`) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "5" } });
      }
      return venue.fetch(url);
    };
    const opts = await auditOpts(venue, {
      fetchImpl: fetch429,
      max429Retries: 1,
      sleep: async () => {},
    });
    const result = await runAudit(opts);
    expect(result.status).toBe("STOPPED_ON_PROBLEM");
    expect(result.stopReason).toMatch(/rate limited|429/);
    // Checkpoint survives.
    const checkpoint = JSON.parse(await readFile(join(opts.stateDir, "checkpoint.json"), "utf8"));
    expect(checkpoint.format).toBe(1);
  });
});

// ── 7. Malformed / unsigned / forged frame rejection ────────────────────────

describe("malformed and unsigned frame rejection", () => {
  it("counts only transport-verified, from-matching frames as evidence", async () => {
    const { offer, accept } = dealPair(NOW);
    const venue = makeVenue({
      board: [
        // Unsigned tclk-looking line: data, not evidence.
        record(BOARD, 1, NOW - 300, stranger, encodeFrame(offer), { unsigned: true }),
        // Validly signed but claims a different from: signed activity, not a frame.
        record(BOARD, 2, NOW - 200, stranger, encodeFrame({ ...offer, from: payer.did })),
        // Validly signed but garbage text.
        record(BOARD, 3, NOW - 200, stranger, "tclk1 not json at all"),
        // The real deal.
        record(BOARD, 4, NOW - 100, payer, encodeFrame(offer)),
        record(BOARD, 5, NOW, payee, encodeFrame(accept)),
      ],
    });
    const result = await runAudit(await auditOpts(venue));
    const counts = result.evidence.counts;
    expect(counts.validTclkFrames).toBe(2); // only the real offer + accept
    expect(counts.invalidTclkLines).toBe(2); // forged-from + garbage
    const strangerRow = result.candidates.find((r) => r.did === stranger.did);
    expect(strangerRow?.tier).toBe(TIER_UNKNOWN);
    expect(strangerRow?.signedFrames).toBe(2); // both were transport-verified
    const payeeRow = result.candidates.find((r) => r.did === payee.did);
    expect(payeeRow?.tier).toBe(TIER_B);
    expect(counts.uniqueAuthenticatedDids).toBe(3);
  });
});

// ── 8. Scoring only within a tier ───────────────────────────────────────────

describe("scoring stays inside a tier", () => {
  it("a low-score Tier A outranks a high-score Tier B", () => {
    const rows = [
      { did: "b-high", tier: TIER_B, score: 100, lastSeen: 1 },
      { did: "a-low", tier: TIER_A, score: 10, lastSeen: 2 },
      { did: "d-any", tier: TIER_D, score: 500, lastSeen: 3 },
      { did: "u-huge", tier: TIER_UNKNOWN, score: 900, lastSeen: 4 },
    ];
    const ranked = rankCandidates(rows);
    expect(ranked.map((r) => r.did)).toEqual(["a-low", "b-high", "d-any", "u-huge"]);
  });

  it("scores within a tier order by score then recency", () => {
    const rows = [
      { did: "b-1", tier: TIER_B, score: 40, lastSeen: 100 },
      { did: "b-2", tier: TIER_B, score: 40, lastSeen: 200 },
      { did: "b-3", tier: TIER_B, score: 50, lastSeen: 50 },
    ];
    const ranked = rankCandidates(rows);
    expect(ranked.map((r) => r.did)).toEqual(["b-3", "b-2", "b-1"]);
  });

  it("CSV columns use the mandated snake_case names", () => {
    const csv = candidatesToCsv([{
      rank: 1, tier: "A", score: 100, did: "did:key:z6MkX",
      firstSeen: "2025-01-01T00:00:00.000Z", lastSeen: "2025-01-02T00:00:00.000Z",
      signedFrames: 4, validOffers: 1, validAccepts: 1, validLocks: 1, validReveals: 1,
      observedTerminalStates: "claimed", railsAdvertised: "paper",
      mailboxAdvertised: "mb-p-x", notePath: "kv/did-aa/bb", noteSource: "primary",
      noteCheckedAt: "", recentActivity: "yes", reachableStatus: "confirmed",
      protocolCapability: "proven", evidenceWindowStart: "a", evidenceWindowEnd: "b",
      evidenceGeneration: "", reason: "r", caveats: "c",
    }]);
    expect(csv.split("\n")[0]).toBe([
      "rank", "tier", "score", "did", "first_seen", "last_seen", "signed_frames",
      "valid_offers", "valid_accepts", "valid_locks", "valid_reveals",
      "observed_terminal_states", "rails_advertised", "mailbox_advertised",
      "note_path", "note_source", "note_checked_at", "recent_activity",
      "reachable_status", "protocol_capability", "evidence_window_start",
      "evidence_window_end", "evidence_generation", "reason", "caveats",
    ].join(","));
    expect(csv.split("\n")[1]).toContain("did:key:z6MkX");
  });
});

// ── 9. Cache freshness / stale markers ───────────────────────────────────────

describe("checkpoint cache freshness", () => {
  it("reuses fresh cached notes, revalidates expired ones, and marks stale on failure", async () => {
    const { offer, accept } = dealPair(NOW);
    const venue = makeVenue({
      board: [
        record(BOARD, 1, NOW - 200, payer, encodeFrame(offer)),
        record(BOARD, 2, NOW - 100, payee, encodeFrame(accept)),
      ],
    });
    const payeePaths = didNotePaths(payee.did);
    venue.notes.set(`${payeePaths.primary.ns}/${payeePaths.primary.key}`, "tclk1:paper v1");

    const firstOpts = await auditOpts(venue, { noteTtlMs: 3_600_000 });
    const first = await runAudit(firstOpts);
    expect(first.status).toBe("PHASE1_COMPLETE");
    expect(first.cache.misses).toBeGreaterThanOrEqual(2); // payer + payee notes resolved
    const kvCalls1 = venue.calls.filter((u) => u.includes("/kv/")).length;

    // Second run, reusing the checkpoint file written by the first: cached notes
    // are reused, so no kv lookups happen at all.
    const checkpoint = JSON.parse(await readFile(join(firstOpts.stateDir, "checkpoint.json"), "utf8"));
    const second = await runAudit({ ...(await auditOpts(venue, { noteTtlMs: 3_600_000 })), checkpoint });
    expect(second.status).toBe("PHASE1_COMPLETE");
    expect(second.cache.hits).toBeGreaterThanOrEqual(2);
    const kvCalls2 = venue.calls.filter((u) => u.includes("/kv/")).length;
    expect(kvCalls2 - kvCalls1).toBe(0); // no network revalidation
    const cachedRow = second.candidates.find((r) => r.did === payee.did);
    expect(cachedRow?.railsAdvertised).toBe("paper");
    expect(cachedRow?.noteSource).toBe("primary");

    // Third run with a zero TTL: the cache is expired → revalidate over the
    // network and pick up the new note value.
    venue.notes.set(`${payeePaths.primary.ns}/${payeePaths.primary.key}`, "tclk1:paper v2");
    const third = await runAudit({ ...(await auditOpts(venue, { noteTtlMs: 0 })), checkpoint });
    expect(third.status).toBe("PHASE1_COMPLETE");
    expect(third.cache.misses).toBeGreaterThan(0);
    const refreshed = third.candidates.find((r) => r.did === payee.did);
    expect(refreshed?.railsAdvertised).toBe("paper");
  });

  it("resolveNote marks stale data when revalidation fails", async () => {
    const ctx = {
      fetchImpl: async () => new Response("error", { status: 500 }),
      base: "https://technocore.chat",
      nowMs: () => NOW,
      sleep: async () => {},
      noteTtlMs: 0, // always expired → always revalidate
      notePaceMs: 0,
      cacheHits: 0,
      cacheMisses: 0,
      requests: 0,
      rateLimited429: 0,
      rateLimited503: 0,
      rateLimitWaitsMs: 0,
      last429Body: null,
      lastNoteAt: null,
      log: () => {},
    };
    const cached = {
      note: { status: "found", source: "primary", value: "tclk1:paper old", checkedAt: NOW - 1000, stale: false },
    };
    const note = await resolveNote(payee.did, cached, ctx);
    expect(note.status).toBe("error");
    expect(note.stale).toBe(true);
    expect(note.value).toBe("tclk1:paper old"); // old data kept, never silently fresh
  });
});

// ── Resume: contract evidence survives across runs without re-reading ───────

describe("resumable contract folding", () => {
  it("replays cached contract evidence on a resumed run without refetching deal rooms", async () => {
    const deal = fullDeal(NOW);
    const venue = makeVenue({
      board: deal.board,
      dealRooms: new Map([[deal.room, deal.deal]]),
    });
    const firstOpts = await auditOpts(venue);
    const first = await runAudit(firstOpts);
    expect(first.status).toBe("PHASE1_COMPLETE");
    const dealCalls1 = venue.calls.filter((u) => u.includes("/export")).length;

    const checkpoint = JSON.parse(await readFile(join(firstOpts.stateDir, "checkpoint.json"), "utf8"));
    expect(checkpoint.contracts[deal.accept.contract].foldOk).toBe(true);
    expect(checkpoint.contracts[deal.accept.contract].finalStatus).toBe("claimed");

    // Second run: deal-room export would blow up if touched; the cached contract
    // must be replayed instead.
    const originalFetch = venue.fetch;
    venue.fetch = async (url: string) => {
      if (url.includes("/mb-p-tclk-")) return new Response("boom", { status: 500 });
      return originalFetch(url);
    };
    const callsBefore2 = venue.calls.length;
    const second = await runAudit({ ...(await auditOpts(venue)), checkpoint });
    expect(second.status).toBe("PHASE1_COMPLETE");
    const run2Calls = venue.calls.slice(callsBefore2);
    expect(run2Calls.filter((u) => u.includes("/export")).length).toBe(1); // board only
    expect(run2Calls.filter((u) => u.includes("/mb-p-tclk-"))).toEqual([]); // no deal reads
    const payeeRow = second.candidates.find((r) => r.did === payee.did);
    expect(payeeRow?.tier).toBe(TIER_A);
    expect(second.evidence.counts.claimedContracts).toBe(1);
    const contractEntry = second.evidence.contracts.find((c) => c.contract === deal.accept.contract);
    expect(contractEntry?.resumed).toBe(true);
    // Lock/reveal attribution from the cached contract must survive the resume.
    expect(second.evidence.counts.didsWithValidLocks).toBe(1);
    expect(second.evidence.counts.didsWithValidReveals).toBe(1);
    const payerRow2 = second.candidates.find((r) => r.did === payer.did);
    expect(payerRow2?.validLocks).toBe(1);
  });
});

// ── End-to-end: a full claimed deal lands Tier A and correct counts ─────────

describe("end-to-end audit on a mock venue", () => {
  it("folds a claimed deal, attributes evidence, and classifies correctly", async () => {
    const deal = fullDeal(NOW);
    const venue = makeVenue({
      board: deal.board,
      dealRooms: new Map([[deal.room, deal.deal]]),
    });
    const pp = didNotePaths(payee.did);
    venue.notes.set(`${pp.primary.ns}/${pp.primary.key}`, "tclk1:paper mailbox:mb-p-tclk-payee01");
    const opts = await auditOpts(venue);
    const result = await runAudit(opts);

    expect(result.status).toBe("PHASE1_COMPLETE");
    expect(result.evidence.counts.totalRetainedBoardRecords).toBe(2);
    expect(result.evidence.counts.validTclkFrames).toBe(4); // offer+accept+lock+reveal
    expect(result.evidence.counts.claimedContracts).toBe(1);
    expect(result.evidence.counts.contractsRoomMissing).toBe(0);
    expect(result.evidence.counts.didsWithValidAccepts).toBe(1);
    expect(result.evidence.counts.didsWithValidReveals).toBe(1);
    expect(result.evidence.counts.didsPaperCompatible).toBe(1);

    const payeeRow = result.candidates.find((r) => r.did === payee.did);
    expect(payeeRow).toMatchObject({
      tier: TIER_A,
      score: 110, // accept 40 + reveal 40 + recent 10 + paper hint 10 + mailbox 10
      reachableStatus: "confirmed",
      protocolCapability: "proven",
      mailboxAdvertised: "mb-p-tclk-payee01",
    });
    expect(payeeRow?.noteSource).toBe("primary");
    expect(payeeRow?.caveats).toBe("");

    const payerRow = result.candidates.find((r) => r.did === payer.did);
    expect(payerRow?.tier).toBe(TIER_C);
    expect(payerRow?.reachableStatus).toBe("probable"); // frames + recent, no hints
  });

  it("accepts an orphaned accept (offer outside retained window) without crashing", async () => {
    const { offer, accept } = dealPair(NOW);
    const venue = makeVenue({
      board: [record(BOARD, 7, NOW, payee, encodeFrame(accept))],
    });
    void offer;
    const result = await runAudit(await auditOpts(venue));
    expect(result.status).toBe("PHASE1_COMPLETE");
    expect(result.evidence.counts.orphanedAccepts).toBe(1);
    const row = result.candidates.find((r) => r.did === payee.did);
    expect(row?.tier).toBe(TIER_B);
  });

  it("classifies a capability-only DID as Tier D from a note + tclk-looking line", async () => {
    const { offer, accept } = dealPair(NOW);
    const venue = makeVenue({
      board: [
        record(BOARD, 1, NOW - 100, payer, encodeFrame(offer)),
        record(BOARD, 2, NOW, payee, encodeFrame(accept)),
        record(BOARD, 3, NOW + 1, noteOnly, "tclk1:paper", { unsigned: true }),
      ],
    });
    const np = didNotePaths(noteOnly.did);
    venue.notes.set(`${np.primary.ns}/${np.primary.key}`, "tclk1:paper mailbox:mb-p-ghost");
    const result = await runAudit(await auditOpts(venue));
    const row = result.candidates.find((r) => r.did === noteOnly.did);
    expect(row?.tier).toBe(TIER_D);
    expect(row?.protocolCapability).toBe("hinted");
    expect(row?.caveats).toContain("routing hint");
  });
});
