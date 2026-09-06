#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Phase-1 discovery audit — a forensic-grade, READ-ONLY scanner for live
// tclk/1 activity on a technocore venue.
//
//   node scripts/discovery-audit.mjs [--base https://technocore.chat]
//
// It reads the venue's public surface (config, room list, the tclk-offers board
// export, derived deal-room exports, and DID notes) and never writes a single
// byte to the venue: there is no POST, no note set, no room creation anywhere in
// this module. It produces evidence artifacts under `.discovery/` (gitignored).
//
// SECURITY MODEL
//   * All network access funnels through venueGet(), which builds URLs only from
//     grammar-validated components against a fixed allowlist of route templates.
//   * Nothing read from a room, a note, or a job.context ever reaches fetch().
//     A frame names a contract id; the contract id passes a strict
//     /^0x[0-9a-f]{64}$/ check before dealRoom() derives a room name, and that
//     name is re-validated against the venue room grammar before use. DID note
//     paths are computed mechanically from the DID string. No slash, no dotdot,
//     no query injection is possible: room/ns/key grammar is
//     ^[a-z0-9][a-z0-9_-]{0,47}$ / ^[a-z0-9][a-z0-9_-]{0,63}$.
//   * Untrusted content (message text, note values) is parsed as data only.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  OFFER_ROOM,
  contractId,
  dealRoom,
  foldTranscript,
  normalizeRailIds,
  parseCapabilityToken,
  transcriptRecord,
  tryDecodeFrame,
  verifyTranscriptRecord,
} from "../dist/index.js";

// ── Grammar / allowlist ──────────────────────────────────────────────────────

export const DEFAULT_BASE = "https://technocore.chat";
export const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const NS_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const CONTRACT_RE = /^0x[0-9a-f]{64}$/;
export const DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{47}$/;
export const MAILBOX_TOKEN_RE = /^mailbox:([a-z0-9][a-z0-9_-]{0,47})$/;
export const TCLK1_TOKEN_RE = /^tclk1:[!-~]+(?:,[!-~]+)*$/;

const BASE_URL_RE = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/** Validate a base URL: https everywhere except localhost, no path, no userinfo. */
export function validateBaseUrl(base) {
  if (typeof base !== "string" || !BASE_URL_RE.test(base)) {
    throw new Error(`discovery-audit: unsafe base URL ${JSON.stringify(base)}`);
  }
  if (!base.startsWith("https://") && !LOCALHOST_RE.test(base)) {
    throw new Error("discovery-audit: non-https base URL is only allowed for localhost");
  }
  return base.replace(/\/+$/, "");
}

/**
 * Build a venue URL from grammar-validated path segments and a fixed query
 * string. `segments` is an allowlist tag (route template), never free input:
 *   ["rooms"], ["r","events"], ["r",room], ["r",room,"export"],
 *   ["kv",ns,key], ["config"], ["llms.txt"], ["patterns.md"],
 *   ["interop.md"], [".well-known","agent.json"]
 * Every dynamic segment is validated against its grammar before it is joined,
 * so nothing from untrusted content can alter the path shape.
 */
export function buildAuditUrl(base, segments, query) {
  const cleanBase = validateBaseUrl(base);
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("discovery-audit: buildAuditUrl needs a non-empty segment list");
  }
  const q = query === undefined || query === null ? "" : `?${query}`;
  const [head, ...rest] = segments;
  if (head === "r") {
    if (rest.length === 1 && rest[0] === "events") return `${cleanBase}/r/events${q}`;
    const [room, tail] = rest;
    if (rest.length === 1) {
      if (!ROOM_RE.test(room)) throw new Error(`discovery-audit: bad room name ${JSON.stringify(room)}`);
      return `${cleanBase}/r/${room}${q}`;
    }
    if (rest.length === 2 && tail === "export") {
      if (!ROOM_RE.test(room)) throw new Error(`discovery-audit: bad room name ${JSON.stringify(room)}`);
      return `${cleanBase}/r/${room}/export`;
    }
    throw new Error("discovery-audit: unrecognized /r route shape");
  }
  if (head === "kv") {
    const [ns, key] = rest;
    if (rest.length !== 2 || !NS_RE.test(ns ?? "") || !KEY_RE.test(key ?? "")) {
      throw new Error("discovery-audit: bad kv namespace/key");
    }
    return `${cleanBase}/kv/${ns}/${key}`;
  }
  if (head === ".well-known") {
    if (rest.length !== 1 || rest[0] !== "agent.json") {
      throw new Error("discovery-audit: only /.well-known/agent.json is allowlisted");
    }
    return `${cleanBase}/.well-known/agent.json`;
  }
  const STATIC = new Set(["rooms", "config", "llms.txt", "patterns.md", "interop.md"]);
  if (rest.length !== 0 || !STATIC.has(head)) {
    throw new Error(`discovery-audit: route ${JSON.stringify(segments)} is not allowlisted`);
  }
  return `${cleanBase}/${head}${q}`;
}

// ── Venue refusal / telemetry ────────────────────────────────────────────────

export class VenueError extends Error {
  constructor(what, status, body) {
    super(`${what}: ${status} ${body}`);
    this.name = "VenueError";
    this.status = status;
    this.body = body;
  }
}

async function firstBodyLine(res) {
  const body = await res.text().catch(() => "");
  return body.split("\n").filter((line) => line.trim())[0] ?? "";
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The ONLY network entry point. GET-only, allowlisted routes, bounded retry on
 * 429 (honours Retry-After and reports the venue's own body line) and 503.
 * Any other non-OK status throws a VenueError; callers fail closed per record.
 */
export async function venueGet(fetchImpl, base, segments, what, ctx, query) {
  const url = buildAuditUrl(base, segments, query ?? null);
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(url);
    } catch (error) {
      throw new Error(`discovery-audit: ${what} network failure: ${error.message}`);
    }
    // Global read pacing: keep every GET inside the venue's advertised
    // `rate_read` budget (600/min default) with a safety margin.
    if (ctx.readPaceMs > 0) {
      const realNow = Date.now();
      const wait = (ctx.lastReadAt ?? 0) + ctx.readPaceMs - realNow;
      if (wait > 0) await (ctx.sleep ?? defaultSleep)(wait);
      ctx.lastReadAt = Date.now();
    }
    ctx.requests += 1;
    if (res.status === 429) {
      ctx.rateLimited429 += 1;
      ctx.last429Body = await firstBodyLine(res);
      if (attempt >= (ctx.max429Retries ?? 3)) {
        throw new VenueError(what, 429, ctx.last429Body);
      }
      const stated = Number(res.headers.get("retry-after"));
      const waitMs = (Number.isFinite(stated) && stated > 0 ? stated : 5) * 1000;
      ctx.rateLimitWaitsMs += waitMs;
      ctx.log(`rate limited on ${what} — waiting ${waitMs / 1000}s, as the venue asked`);
      await (ctx.sleep ?? defaultSleep)(waitMs);
      continue;
    }
    if (res.status === 503) {
      ctx.rateLimited503 += 1;
      if (attempt >= (ctx.max503Retries ?? 2)) {
        const body = await firstBodyLine(res);
        throw new VenueError(what, 503, body);
      }
      const waitMs = (attempt + 1) * 2000;
      ctx.rateLimitWaitsMs += waitMs;
      ctx.log(`venue busy (503) on ${what} — retrying in ${waitMs / 1000}s`);
      await (ctx.sleep ?? defaultSleep)(waitMs);
      continue;
    }
    return res;
  }
}

// ── DID note path mechanics ──────────────────────────────────────────────────

/**
 * fingerprint = SHA256(full did:key UTF-8 string), lowercase hex, first 16 chars,
 * sharded like the venue's DID-note convention: ns `did-<first2>`, key `<next14>`.
 * Legacy fallback path: /kv/did/<fingerprint>.
 */
export function didFingerprint(did) {
  if (typeof did !== "string" || did.length === 0) {
    throw new Error("discovery-audit: didFingerprint needs a non-empty string");
  }
  return createHash("sha256").update(did, "utf8").digest("hex").slice(0, 16);
}

export function didNotePaths(did) {
  const fp = didFingerprint(did);
  return {
    primary: { ns: `did-${fp.slice(0, 2)}`, key: fp.slice(2) },
    legacy: { ns: "did", key: fp },
  };
}

/**
 * Strip the venue's untrusted-content banner from a note read. The venue
 * prefixes every note with prose lines (`!!…`) and a blank line; the value
 * itself is the single surviving line (notes are single-line after the venue
 * sweep). Null when nothing survives — i.e. no usable value.
 */
export function parseNoteBody(body) {
  const value = body
    .split("\n")
    .filter((line) => !line.startsWith("!!") && line.trim() !== "")
    .join("\n")
    .trim();
  return value === "" ? null : value;
}

/**
 * Parse routing tokens out of a one-line DID note. Returns only syntactically
 * valid tokens; nothing here is trusted as proof. `rails` are the strictly
 * registered rails (library-normalized, null on unknown/malformed ids);
 * `railsLenient` is any well-formed tclk1: token (historical/free-form ids).
 */
export function parseDidNoteTokens(note) {
  if (typeof note !== "string" || note === "") {
    return { tclk1: null, rails: null, railsLenient: null, mailbox: null };
  }
  const parts = note.split(/\s+/);
  let tclk1Token = null;
  let mailbox = null;
  for (const part of parts) {
    if (part.startsWith("tclk1:") && tclk1Token === null) tclk1Token = part;
    const mb = MAILBOX_TOKEN_RE.exec(part);
    if (mb !== null && mailbox === null) mailbox = mb[1];
  }
  let rails = null;
  let railsLenient = null;
  if (tclk1Token !== null) {
    if (TCLK1_TOKEN_RE.test(tclk1Token)) railsLenient = tclk1Token.slice(6).split(",");
    rails = parseCapabilityToken(note); // strict: registered rails only, null otherwise
  }
  return { tclk1: tclk1Token, rails, railsLenient, mailbox };
}

/** True when the (strictly parsed) rails include the paper rail after normalization. */
export function isPaperCompatible(rails) {
  if (rails === null || rails === undefined) return false;
  try {
    return normalizeRailIds(rails).includes("paper");
  } catch {
    return false;
  }
}

// ── Export loading (per-row, fail-closed, byte-exact) ───────────────────────

/**
 * Load a JSONL export one row at a time, keeping every row the official
 * `transcriptRecord` validator accepts and dropping the rest with a reason.
 *
 * Why not the library's all-or-nothing `parseTranscriptExport`? The live venue
 * serializes some senders' nonces as JSON numbers beyond 2^53 (a sender bug,
 * e.g. `Date.now() * 1e6`). `JSON.parse` silently rounds those, so the strict
 * parser refuses the whole export. The exact decimal digits are still present
 * in the raw line, so this loader recovers them and re-runs the OFFICIAL
 * validator — verification then uses the exact nonce bytes, never a guess. A
 * row that still fails is dropped (fail closed on that record) and counted,
 * so the audit never fabricates evidence and never dies on one junk row.
 */
export function loadExportRecords(room, text) {
  const records = [];
  const dropped = [];
  const lines = String(text).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      dropped.push({ line: index + 1, reason: "line is not JSON" });
      continue;
    }
    if (
      value !== null && typeof value === "object" &&
      typeof value.nonce === "number" && !Number.isSafeInteger(value.nonce)
    ) {
      const exact = /"nonce":(\d+)/.exec(line);
      if (exact !== null) value = { ...value, nonce: exact[1] };
    }
    try {
      records.push(transcriptRecord(room, value));
    } catch (error) {
      dropped.push({
        line: index + 1,
        reason: error instanceof Error ? error.message.replace(/^tclk: /, "") : "invalid record",
      });
    }
  }
  return { records, dropped };
}

// ── Board forensics ──────────────────────────────────────────────────────────

/** Verify + decode one record; `authed` means transport-verified AND frame.from matches. */
function assessRecord(record) {
  const verified = verifyTranscriptRecord(record);
  if (!verified.ok) return { record, verified: false, reason: verified.reason };
  const frame = tryDecodeFrame(record.line);
  if (frame === null) return { record, verified: true, frame: null, reason: "not a tclk frame" };
  if (frame.from !== record.sender) {
    return { record, verified: true, frame, forged: true, reason: "frame.from != record sender" };
  }
  return { record, verified: true, frame };
}

function newDidAccumulator(did) {
  return {
    did,
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
  };
}

/**
 * Analyze the full retained board export. Tolerant pairing: an accept whose
 * offer is outside the retained window is kept as evidence (orphaned), never
 * thrown on; an accept whose recomputed contract id disagrees is invalid.
 */
export function analyzeBoard(records, nowMs) {
  const dids = new Map();
  const offers = new Map(); // offer id -> {record, frame}
  const pairs = []; // {offer, accept, contract}
  const orphanedAccepts = [];
  const invalidAccepts = [];
  const frameTypeCounts = {};

  const touch = (sender, ts) => {
    let entry = dids.get(sender);
    if (entry === undefined) {
      entry = newDidAccumulator(sender);
      dids.set(sender, entry);
    }
    if (entry.firstSeen === null || ts < entry.firstSeen) entry.firstSeen = ts;
    if (entry.lastSeen === null || ts > entry.lastSeen) entry.lastSeen = ts;
    return entry;
  };

  for (const record of records) {
    const assessed = assessRecord(record);
    if (typeof record.sender !== "string" || !assessed.verified) continue;
    const d = touch(record.sender, record.timestampMs);
    d.signedFrames += 1;
    if (assessed.frame === null || assessed.forged) {
      d.invalidTclkLines += 1;
      continue;
    }
    const frame = assessed.frame;
    frameTypeCounts[frame.type] = (frameTypeCounts[frame.type] ?? 0) + 1;
    if (frame.type === "offer") {
      d.validOffers += 1;
      for (const rail of frame.rails ?? []) d.offerRails.add(rail);
      if (!offers.has(frame.id)) offers.set(frame.id, { record, frame });
      continue;
    }
    if (frame.type === "accept") {
      if (!CONTRACT_RE.test(frame.contract)) {
        invalidAccepts.push({ record, frame, reason: "malformed contract id" });
        continue;
      }
      const offer = offers.get(frame.ref);
      if (offer === undefined) {
        orphanedAccepts.push({ record, frame });
        d.validAccepts += 1; // authenticated accept; offer outside the retained window
        d.contracts.add(frame.contract);
        continue;
      }
      let computed;
      try {
        computed = contractId(offer.frame, {
          from: frame.from,
          ref: frame.ref,
          statement: frame.statement,
          paymentKey: frame.paymentKey,
          nonce: frame.nonce,
        });
      } catch {
        invalidAccepts.push({ record, frame, reason: "contractId threw" });
        continue;
      }
      if (computed !== frame.contract) {
        invalidAccepts.push({ record, frame, reason: "contract id mismatch" });
        continue;
      }
      d.validAccepts += 1;
      d.contracts.add(frame.contract);
      pairs.push({ offer, accept: record, contract: frame.contract });
    }
  }

  return { dids, offers, pairs, orphanedAccepts, invalidAccepts, frameTypeCounts, totalRecords: records.length };
}

// ── Contract reconstruction ──────────────────────────────────────────────────

/**
 * Read one derived deal room and fold it with the library. A missing room
 * (404) means accept-only evidence; a malformed export fails closed for that
 * contract but never for the audit as a whole.
 */
export async function reconstructContract({ offer, accept, contract }, ctx) {
  const room = dealRoom(contract); // validates the contract id; derived, not chosen
  const res = await venueGet(ctx.fetchImpl, ctx.base, ["r", room, "export"], `export ${room}`, ctx);
  if (res.status === 404) {
    return { contract, room, ok: true, roomExists: false, folded: null, state: null, dealRecords: [] };
  }
  if (!res.ok) {
    const body = await firstBodyLine(res);
    throw new VenueError(`export ${room}`, res.status, body);
  }
  const text = await res.text();
  const { records: dealRecords, dropped } = loadExportRecords(room, text);
  if (dealRecords.length === 0 && dropped.length > 0) {
    // Nothing usable at all in a non-empty export: that room's evidence is unsafe.
    return {
      contract,
      room,
      ok: false,
      reason: `export yielded no usable records (${dropped.length} dropped)`,
      folded: null,
      state: null,
      dealRecords: [],
      dropped,
    };
  }
  const folded = foldTranscript([offer.record, accept, ...dealRecords]);
  return { contract, room, ok: true, roomExists: true, folded, state: folded.state, dealRecords, dropped };
}

/**
 * Fold post-accept steps back into per-DID counters. The fold input was
 * [offer, accept, ...dealRecords], so step index i maps to dealRecords[i-2].
 * Returns a compact attribution record (sender, frame type, final status,
 * parties) so a resumed run can replay the same evidence without re-reading
 * the deal room.
 */
export function applyDealEvidence(contractResult, board) {
  const { contract, ok, folded, dealRecords } = contractResult;
  const attribution = { steps: [], status: null, payeeDid: null, payerDid: null };
  if (!ok || folded === null || folded.state === null) return attribution;
  const status = folded.state.status;
  attribution.status = status;
  attribution.payeeDid = folded.state.payeeDid ?? null;
  attribution.payerDid = folded.state.payerDid ?? null;

  folded.steps.forEach((step, index) => {
    if (!step.ok || step.type === undefined) return;
    const source = index >= 2 ? dealRecords[index - 2] : null;
    if (source === null || typeof source.sender !== "string") return;
    const d = board.dids.get(source.sender);
    if (d !== undefined) {
      switch (step.type) {
        case "lock": d.validLocks += 1; d.lockedContracts.add(contract); break;
        case "reveal": d.validReveals += 1; break;
        case "refund": d.validRefunds += 1; break;
        case "cancel": d.validCancels += 1; d.cancelledContracts.add(contract); break;
        case "receipt": d.validReceipts += 1; break;
        case "heartbeat": d.validHeartbeats += 1; break;
        default: break;
      }
    }
    attribution.steps.push({ did: source.sender, type: step.type });
  });

  for (const did of [folded.state.payeeDid, folded.state.payerDid]) {
    if (typeof did !== "string") continue;
    const d = board.dids.get(did);
    if (d === undefined) continue;
    d.terminalStates.add(status);
    if (status === "claimed" && did === folded.state.payeeDid) d.claimedAsPayee = true;
  }
  return attribution;
}

/**
 * Replay a cached contract's attribution into the current evidence board — the
 * resume path for contracts folded by an earlier run, so their evidence is not
 * silently dropped and their deal rooms are not re-read.
 */
export function replayContractEvidence(cached, board) {
  if (cached === undefined || typeof cached !== "object") return;
  const entry = (did) => {
    let d = board.dids.get(did);
    if (d === undefined) {
      d = newDidAccumulator(did);
      board.dids.set(did, d);
    }
    return d;
  };
  // `attribution` is persisted as a plain [{did, type}, …] array.
  const steps = Array.isArray(cached.attribution)
    ? cached.attribution
    : cached.attribution?.steps ?? [];
  for (const step of steps) {
    if (typeof step?.did !== "string" || typeof step?.type !== "string") continue;
    const d = entry(step.did);
    switch (step.type) {
      case "lock": d.validLocks += 1; d.lockedContracts.add(cached.contract); break;
      case "reveal": d.validReveals += 1; break;
      case "refund": d.validRefunds += 1; break;
      case "cancel": d.validCancels += 1; d.cancelledContracts.add(cached.contract); break;
      case "receipt": d.validReceipts += 1; break;
      case "heartbeat": d.validHeartbeats += 1; break;
      default: break;
    }
  }
  const status = cached.finalStatus;
  if (status !== null && status !== undefined) {
    for (const did of [cached.payeeDid, cached.payerDid]) {
      if (typeof did !== "string") continue;
      entry(did).terminalStates.add(status);
      if (status === "claimed" && did === cached.payeeDid) entry(did).claimedAsPayee = true;
    }
  }
}

// ── Note resolution (paced, cached, fail-closed) ─────────────────────────────

/**
 * Resolve one DID's note: primary path once, legacy fallback once on 404.
 * Uses the checkpoint cache when fresh (TTL-based); a stale cached note is
 * revalidated and marked. Pacing applies between network lookups only.
 */
export async function resolveNote(did, cached, ctx) {
  const cachedNote = cached?.note;
  if (cachedNote !== undefined && cachedNote.status !== "error") {
    const ageMs = ctx.nowMs() - (cachedNote.checkedAt ?? 0);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ctx.noteTtlMs) {
      ctx.cacheHits += 1;
      return { ...cachedNote, stale: false, checkedAt: cachedNote.checkedAt };
    }
  }
  ctx.cacheMisses += 1;

  if (ctx.notePaceMs > 0 && ctx.lastNoteAt !== null) {
    const elapsed = ctx.nowMs() - ctx.lastNoteAt;
    if (elapsed < ctx.notePaceMs) await (ctx.sleep ?? defaultSleep)(ctx.notePaceMs - elapsed);
  }
  ctx.lastNoteAt = ctx.nowMs();

  const paths = didNotePaths(did);
  const tryRead = async (segments, label) => {
    const res = await venueGet(ctx.fetchImpl, ctx.base, segments, `note ${label}`, ctx);
    if (res.status === 404) return { status: "absent", label };
    if (!res.ok) {
      const body = await firstBodyLine(res);
      throw new VenueError(`note ${label}`, res.status, body);
    }
    const value = parseNoteBody(await res.text());
    if (value === null) return { status: "absent", label };
    return { status: "found", label, value };
  };

  try {
    const primary = await tryRead(["kv", paths.primary.ns, paths.primary.key], "primary");
    if (primary.status === "found") return { did, ...primary, checkedAt: ctx.nowMs() };
    const legacy = await tryRead(["kv", paths.legacy.ns, paths.legacy.key], "legacy");
    return { did, ...legacy, checkedAt: ctx.nowMs() };
  } catch (error) {
    // Revalidation failed: keep the cached value (if any) but mark it stale so it
    // is never silently treated as fresh.
    return {
      did,
      status: "error",
      label: cachedNote?.source ?? "none",
      value: cachedNote?.value ?? null,
      checkedAt: ctx.nowMs(),
      stale: cachedNote !== undefined,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Classification (tier first, score second) ───────────────────────────────

export const TIER_A = "A";
export const TIER_B = "B";
export const TIER_C = "C";
export const TIER_D = "D";
export const TIER_UNKNOWN = "UNKNOWN";

/** Valid authenticated TCLK frames observed for a DID. */
export function validFrameCount(d) {
  return d.validOffers + d.validAccepts + d.validLocks + d.validReveals +
    d.validRefunds + d.validCancels + d.validReceipts + d.validHeartbeats;
}

/**
 * Tier first: reveal/claimed⇒A, accept-only⇒B, signed activity⇒C,
 * capability-only⇒D, else UNKNOWN. Score orders candidates INSIDE a tier only.
 */
export function classifyDid(d, nowMs, recentMs) {
  const frames = validFrameCount(d);
  const recentlyActive = d.lastSeen !== null && nowMs - d.lastSeen <= recentMs;
  const note = d.note ?? {};
  const railsAdvertised = note.rails ?? null;
  const railsLenient = note.railsLenient ?? null;
  const mailbox = note.mailbox ?? null;
  const hinted = railsLenient !== null || railsAdvertised !== null || mailbox !== null;

  let tier;
  if (d.claimedAsPayee) tier = TIER_A;
  else if (d.validAccepts > 0) tier = TIER_B;
  else if (frames > 0) tier = TIER_C;
  else if (railsLenient !== null || railsAdvertised !== null) tier = TIER_D;
  else tier = TIER_UNKNOWN;

  const score =
    (d.validAccepts > 0 ? 40 : 0) +
    (d.validReveals > 0 ? 40 : 0) +
    (d.lockedContracts.size > 0 ? 20 : 0) +
    (recentlyActive ? 10 : 0) +
    (mailbox !== null ? 10 : 0) +
    (isPaperCompatible(railsAdvertised) ? 10 : 0);

  let reachable;
  if (d.validAccepts > 0 && recentlyActive) reachable = "confirmed";
  else if (frames > 0 && (recentlyActive || hinted)) reachable = "probable";
  else if (frames > 0) reachable = "stale";
  else reachable = "unknown";

  const protocolCapable =
    d.validAccepts > 0 || d.lockedContracts.size > 0 || d.claimedAsPayee
      ? "proven"
      : hinted ? "hinted" : "unknown";

  return {
    tier,
    score,
    frames,
    recentlyActive,
    reachable,
    protocolCapable,
    mailboxAdvertised: mailbox !== null,
    willing: "UNKNOWN", // Phase 1 never probes willingness
  };
}

/** Final ranking: tier first (A > B > C > D > UNKNOWN), then score, then lastSeen. */
export function rankCandidates(candidates) {
  const order = { A: 0, B: 1, C: 2, D: 3, UNKNOWN: 4 };
  return [...candidates].sort((a, b) => {
    const ta = order[a.tier] ?? 9;
    const tb = order[b.tier] ?? 9;
    if (ta !== tb) return ta - tb;
    if (b.score !== a.score) return b.score - a.score;
    return (b.lastSeen ?? 0) - (a.lastSeen ?? 0);
  });
}

// ── Checkpoint (local, gitignored, never committed) ─────────────────────────

export function freshCheckpoint() {
  return { format: 1, updatedAt: null, base: null, dids: {}, contracts: {} };
}

export async function loadCheckpoint(stateDir) {
  try {
    const raw = await readFile(join(stateDir, "checkpoint.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.format !== 1 || typeof parsed.dids !== "object") return freshCheckpoint();
    if (typeof parsed.contracts !== "object") parsed.contracts = {};
    return parsed;
  } catch {
    return freshCheckpoint();
  }
}

export async function saveCheckpoint(stateDir, checkpoint, nowIso) {
  await mkdir(stateDir, { recursive: true });
  checkpoint.updatedAt = nowIso;
  const tmp = join(stateDir, `checkpoint.json.tmp-${process.pid}`);
  await writeFile(tmp, JSON.stringify(checkpoint, null, 2));
  await rename(tmp, join(stateDir, "checkpoint.json"));
}

export async function appendEvent(stateDir, event) {
  try {
    await mkdir(stateDir, { recursive: true });
    await appendFile(join(stateDir, "audit-events.jsonl"), `${JSON.stringify(event)}\n`);
  } catch {
    // Event logging is best-effort; it must never break the audit.
  }
}

// ── Artifacts ────────────────────────────────────────────────────────────────

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const CANDIDATE_COLUMNS = [
  "rank", "tier", "score", "did", "first_seen", "last_seen", "signed_frames",
  "valid_offers", "valid_accepts", "valid_locks", "valid_reveals",
  "observed_terminal_states", "rails_advertised", "mailbox_advertised",
  "note_path", "note_source", "note_checked_at", "recent_activity",
  "reachable_status", "protocol_capability", "evidence_window_start",
  "evidence_window_end", "evidence_generation", "reason", "caveats",
];

/** snake_case column names map onto the camelCase candidate rows. */
function camelize(name) {
  return name.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
}

export function candidatesToCsv(rows) {
  const lines = [CANDIDATE_COLUMNS.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(CANDIDATE_COLUMNS.map((col) => csvEscape(row[col] ?? row[camelize(col)])).join(","));
  }
  return lines.join("\n");
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Run one full audit with an injected fetch (tests) or the real one (CLI).
 * Read-only: every network call is a GET built by venueGet().
 */
export async function runAudit(opts) {
  const nowMs = opts.nowMs ?? Date.now;
  const base = validateBaseUrl(opts.base ?? DEFAULT_BASE);
  const ctx = {
    fetchImpl: opts.fetchImpl,
    base,
    nowMs,
    sleep: opts.sleep ?? defaultSleep,
    noteTtlMs: opts.noteTtlMs ?? 3_600_000,
    notePaceMs: opts.notePaceMs ?? 250,
    readPaceMs: opts.readPaceMs ?? 120,
    max429Retries: opts.max429Retries ?? 3,
    max503Retries: opts.max503Retries ?? 2,
    recentMs: opts.recentMs ?? 14 * 24 * 3600 * 1000,
    log: opts.log ?? (() => {}),
    requests: 0,
    rateLimited429: 0,
    rateLimited503: 0,
    rateLimitWaitsMs: 0,
    last429Body: null,
    cacheHits: 0,
    cacheMisses: 0,
    lastNoteAt: null,
    lastReadAt: null,
  };
  const stateDir = opts.stateDir ?? ".discovery/state";
  const startUtc = new Date(nowMs()).toISOString();
  const checkpoint = (opts.checkpoint ?? (await loadCheckpoint(stateDir))) ?? freshCheckpoint();
  checkpoint.base = base;
  const result = {
    format: "discovery-audit-v1",
    status: "PHASE1_INCONCLUSIVE",
    stopReason: null,
    audit: { startUtc, finishUtc: null, baseUrl: base },
    meta: {},
    venue: { config: null, configRaw: null, rooms: null, events: null },
    evidence: { counts: null, contracts: [], dids: {} },
    candidates: [],
    rateLimits: null,
    cache: null,
  };

  try {
    // ── Venue snapshot ──
    const configRes = await venueGet(ctx.fetchImpl, base, ["config"], "config", ctx);
    if (configRes.ok) result.venue.configRaw = await configRes.text();
    try {
      result.venue.config = result.venue.configRaw === null ? null : JSON.parse(result.venue.configRaw);
    } catch {
      result.venue.config = null; // non-JSON config is fine; raw text is retained
    }

    const roomsRes = await venueGet(ctx.fetchImpl, base, ["rooms"], "rooms", ctx, "format=json");
    if (roomsRes.ok) {
      try {
        result.venue.rooms = await roomsRes.json();
      } catch {
        result.venue.rooms = null;
      }
    }
    result.venue.roomsRanked = rankRooms(result.venue.rooms, 20);
    result.venue.retention = retentionEvidence(result.venue.config);

    try {
      const eventsRes = await venueGet(ctx.fetchImpl, base, ["r", "events"], "events", ctx);
      result.venue.events = eventsRes.ok ? await eventsRes.json() : { unavailable: true, status: eventsRes.status };
    } catch (error) {
      result.venue.events = { unavailable: true, error: error.message };
    }

    // ── Board export (full retained window, not the tail) ──
    const boardRes = await venueGet(ctx.fetchImpl, base, ["r", OFFER_ROOM, "export"], `export ${OFFER_ROOM}`, ctx);
    if (!boardRes.ok) {
      const body = await firstBodyLine(boardRes);
      throw new VenueError(`export ${OFFER_ROOM}`, boardRes.status, body);
    }
    const boardText = await boardRes.text();
    const { records: boardRecords, dropped: boardDropped } = loadExportRecords(OFFER_ROOM, boardText);
    if (boardRecords.length === 0 && boardDropped.length > 0) {
      result.stopReason = `board export yielded no usable records (${boardDropped.length} dropped)`;
      result.status = "STOPPED_ON_PROBLEM";
      return result;
    }
    const boardSeqs = boardRecords.map((r) => r.seq).filter((s) => Number.isSafeInteger(s));
    result.evidence.boardExport = {
      rawRows: boardText.split("\n").filter((l) => l.trim() !== "").length,
      droppedRows: boardDropped.length,
      droppedReasons: firstReasons(boardDropped),
      generation: boardRes.headers.get("x-room-generation") ?? null,
      firstSeq: boardSeqs.length > 0 ? Math.min(...boardSeqs) : null,
      lastSeq: boardSeqs.length > 0 ? Math.max(...boardSeqs) : null,
    };

    const board = analyzeBoard(boardRecords, nowMs());
    await saveCheckpoint(stateDir, checkpoint, new Date(nowMs()).toISOString());
    await appendEvent(stateDir, {
      ts: new Date(nowMs()).toISOString(),
      kind: "BOARD_ANALYZED",
      total: board.totalRecords,
      pairs: board.pairs.length,
    });

    // ── Contract reconstruction (derived deal rooms) ──
    for (let pairIndex = 0; pairIndex < board.pairs.length; pairIndex += 1) {
      const pair = board.pairs[pairIndex];
      const cachedContract = checkpoint.contracts?.[pair.contract];
      let contractResult;
      let attribution;
      if (cachedContract !== undefined && cachedContract.foldedAt !== undefined) {
        // Resume: evidence already folded by an earlier run — replay it locally.
        contractResult = {
          contract: pair.contract,
          room: cachedContract.room,
          roomExists: cachedContract.roomExists,
          ok: cachedContract.foldOk,
          reason: cachedContract.reason ?? null,
          state: cachedContract.finalStatus === null ? null : { status: cachedContract.finalStatus },
          folded: null,
          dealRecords: [],
          dropped: [],
        };
        replayContractEvidence(cachedContract, board);
        attribution = cachedContract.attribution ?? { steps: [], status: cachedContract.finalStatus, payeeDid: cachedContract.payeeDid, payerDid: cachedContract.payerDid };
      } else {
        try {
          contractResult = await reconstructContract(pair, ctx);
        } catch (error) {
          result.stopReason = `deal-room read failed for ${pair.contract}: ${error.message}`;
          result.status = "STOPPED_ON_PROBLEM";
          return result;
        }
        attribution = applyDealEvidence(contractResult, board);
        checkpoint.contracts[pair.contract] = {
          foldedAt: new Date(nowMs()).toISOString(),
          contract: pair.contract,
          room: contractResult.room,
          roomExists: contractResult.roomExists,
          foldOk: contractResult.ok,
          reason: contractResult.reason ?? null,
          finalStatus: contractResult.state?.status ?? null,
          payeeDid: attribution.payeeDid,
          payerDid: attribution.payerDid,
          attribution: attribution.steps,
        };
        if (pairIndex % 25 === 0) {
          await saveCheckpoint(stateDir, checkpoint, new Date(nowMs()).toISOString());
        }
      }
      result.evidence.contracts.push({
        contract: pair.contract,
        room: contractResult.room,
        offerSeq: pair.offer.record.seq,
        acceptSeq: pair.accept.seq,
        offerBy: pair.offer.record.sender,
        acceptBy: pair.accept.sender,
        roomExists: contractResult.roomExists,
        foldOk: contractResult.ok,
        reason: contractResult.reason ?? null,
        finalStatus: contractResult.state?.status ?? null,
        droppedRows: contractResult.dropped?.length ?? 0,
        resumed: cachedContract !== undefined && cachedContract.foldedAt !== undefined,
      });
    }

    // ── DID note resolution (paced + cached) ──
    // Subjects: every authenticated DID plus DIDs whose unsigned/malformed lines
    // look like tclk (capability-only tier-D candidates).
    const noteSubjects = new Set(board.dids.keys());
    for (const record of boardRecords) {
      if (typeof record.sender !== "string") continue;
      if (/^tclk1\s/.test(record.line) || record.line.includes("tclk1:")) {
        noteSubjects.add(record.sender);
      }
    }

    for (const did of noteSubjects) {
      let note;
      try {
        note = await resolveNote(did, checkpoint.dids[did], ctx);
      } catch (error) {
        note = {
          status: "error",
          source: "none",
          value: null,
          checkedAt: nowMs(),
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      const tokens = parseDidNoteTokens(note.value ?? "");
      checkpoint.dids[did] = {
        note: {
          status: note.status,
          source: note.source ?? (note.label === "primary" ? "primary" : note.label === "legacy" ? "legacy" : "none"),
          value: note.value ?? null,
          checkedAt: note.checkedAt ?? nowMs(),
          stale: note.stale ?? false,
          rails: tokens.rails,
          railsLenient: tokens.railsLenient,
          mailbox: tokens.mailbox,
          tclk1: tokens.tclk1,
          reason: note.reason ?? null,
        },
      };
      const entry = board.dids.get(did);
      if (entry !== undefined) {
        entry.note = checkpoint.dids[did].note;
      } else {
        // Capability-only DID: no authenticated frames, but a note (or a
        // tclk-looking line) made it a subject. It enters the candidate set
        // with the note as its only evidence — tier D material.
        const synthetic = newDidAccumulator(did);
        synthetic.note = checkpoint.dids[did].note;
        board.dids.set(did, synthetic);
      }
    }
    await saveCheckpoint(stateDir, checkpoint, new Date(nowMs()).toISOString());

    // ── Classify, rank, serialize ──
    const didEntries = [...board.dids.values()];
    const boardRange = boardRangeOf(boardRecords);
    boardRange.generation = result.evidence.boardExport.generation;
    const rows = didEntries.map((d) => rowFor(d, classifyDid(d, nowMs(), ctx.recentMs), nowMs(), ctx.recentMs, boardRange));

    const ranked = rankCandidates(rows);
    result.candidates = ranked;
    result.evidence.dids = Object.fromEntries(didEntries.map((d) => [d.did, serializableDid(d, nowMs(), ctx.recentMs)]));
    result.evidence.counts = countsOf(
      board, rows, didEntries, boardRange, result.evidence.contracts,
      result.evidence.boardExport, nowMs(), ctx.recentMs,
    );
    result.rateLimits = {
      requests: ctx.requests,
      rateLimited429: ctx.rateLimited429,
      rateLimited503: ctx.rateLimited503,
      rateLimitWaitsMs: ctx.rateLimitWaitsMs,
      last429Body: ctx.last429Body,
    };
    result.cache = { hits: ctx.cacheHits, misses: ctx.cacheMisses };
    result.status = "PHASE1_COMPLETE";
  } catch (error) {
    result.stopReason = error instanceof Error ? error.message : String(error);
    result.status = error instanceof VenueError ? "STOPPED_ON_PROBLEM" : "PHASE1_INCONCLUSIVE";
    if (process.env.DISCOVERY_DEBUG === "1") {
      // eslint-disable-next-line no-console
      console.error(error instanceof Error ? error.stack : error);
    }
  } finally {
    result.audit.finishUtc = new Date(nowMs()).toISOString();
    await saveCheckpoint(stateDir, checkpoint, result.audit.finishUtc);
  }
  return result;
}

/**
 * Rank rooms from the /rooms?format=json snapshot for human/agent activity.
 * High activity is NOT assumed to mean tclk capability — this is engagement
 * context only. The venue lists at most a bounded top-N; `p-` rooms (deal
 * rooms) are unlisted by design, and the snapshot's own ordering is kept.
 */
export function rankRooms(snapshot, limit = 20) {
  const list = Array.isArray(snapshot) ? snapshot : (snapshot?.rooms ?? []);
  if (!Array.isArray(list)) return [];
  const ranked = list.map((r, index) => {
    const count = Number(r.count ?? r.messages ?? r.window ?? 0);
    return {
      rank: index + 1,
      room: r.room ?? r.name ?? "",
      topic: r.topic ?? null,
      lastSeq: r.last_seq ?? null,
      idleSeconds: r.idle_seconds ?? null,
      bytes: r.bytes ?? null,
      window: r.window ?? null,
      zeroResponseShare: r.zero_response_share ?? null,
      nickDiversity: r.nick_diversity ?? null,
      count,
    };
  });
  return ranked.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || (a.rank - b.rank)).slice(0, limit);
}

/**
 * Retention/limit evidence: live values from /config where available, the
 * manual's own wording otherwise. Never hard-coded guesses — each item names
 * its source so stale assumptions are distinguishable from current facts.
 */
export function retentionEvidence(config) {
  const s = config?.settings ?? {};
  return {
    source: "live /config + venue manual (/llms.txt)",
    rateReadPerMinPerIp: s.rate_read ?? null,
    rateWritePerMinPerIp: s.rate_write ?? null,
    rateRoomsPerDay: s.rate_rooms_per_day ?? null,
    maxRooms: s.max_rooms ?? null,
    maxNotesPerNs: s.max_notes_per_ns ?? null,
    maxNotesTotal: s.max_notes_total ?? null,
    dupeFilterSeconds: s.dupe_filter_seconds ?? null,
    manualRetention: "rooms are a ring — old messages are dropped past ~10 MiB (manual RETENTION); rooms/notes with no write for 7 days are deleted, a room still on its single message goes after 12 hours (manual CAPACITY)",
  };
}

function rowFor(d, c, nowMs, recentMs, boardRange) {
  const paths = didNotePaths(d.did);
  const note = d.note ?? {};
  const reason = c.tier === TIER_UNKNOWN
    ? "insufficient evidence"
    : reasonForTier(c, d);
  return {
    did: d.did,
    tier: c.tier,
    score: c.score,
    firstSeen: d.firstSeen === null ? "" : new Date(d.firstSeen).toISOString(),
    lastSeen: d.lastSeen === null ? "" : new Date(d.lastSeen).toISOString(),
    signedFrames: d.signedFrames,
    validOffers: d.validOffers,
    validAccepts: d.validAccepts,
    validLocks: d.validLocks,
    validReveals: d.validReveals,
    observedTerminalStates: [...d.terminalStates].join("|"),
    railsAdvertised: (note.railsLenient ?? []).join("|"),
    mailboxAdvertised: note.mailbox ?? "",
    notePath:
      note.status === "found"
        ? (note.source === "primary"
            ? `kv/${paths.primary.ns}/${paths.primary.key}`
            : `kv/${paths.legacy.ns}/${paths.legacy.key}`)
        : "",
    noteSource: note.status === "found" ? note.source : note.status ?? "none",
    noteCheckedAt: note.checkedAt === undefined || note.checkedAt === null
      ? "" : new Date(note.checkedAt).toISOString(),
    recentActivity: c.recentlyActive ? "yes" : d.lastSeen === null ? "unknown" : "no",
    reachableStatus: c.reachable,
    protocolCapability: c.protocolCapable,
    evidenceWindowStart: boardRange.startIso,
    evidenceWindowEnd: boardRange.endIso,
    evidenceGeneration: boardRange.generation ?? "",
    reason,
    caveats: caveatsFor(d, c, nowMs, recentMs),
  };
}

function reasonForTier(c, d) {
  switch (c.tier) {
    case TIER_A:
      return "valid payee in a retained contract that reached a verified reveal/claimed path";
    case TIER_B:
      return "valid authenticated accept observed in retained evidence; no valid reveal observed";
    case TIER_C:
      return "authenticated signed tclk/1 activity in retained evidence";
    case TIER_D:
      return "self-asserted tclk1 capability advertisement only; no authenticated protocol evidence";
    default:
      return "insufficient evidence";
  }
}

function caveatsFor(d, c, nowMs, recentMs) {
  const caveats = [];
  if (c.tier === TIER_B) {
    caveats.push("no valid reveal observed in the currently retained transcript window — absence of a reveal is not proof of non-revelation");
  }
  if (c.tier === TIER_C && d.validReveals === 0) {
    caveats.push("no valid reveal observed in the currently retained transcript window");
  }
  if (d.note?.status === "absent" && d.validAccepts === 0) {
    caveats.push("no DID note found; capability unverified");
  }
  if (d.lastSeen !== null && nowMs - d.lastSeen > recentMs) {
    caveats.push("last authenticated activity is outside the recent window");
  }
  if (c.tier === TIER_D) {
    caveats.push("capability token is a world-writable routing hint and proves nothing on its own");
  }
  return caveats.join("; ");
}

function boardRangeOf(records) {
  const ts = records.map((r) => r.timestampMs).filter((t) => Number.isFinite(t));
  if (ts.length === 0) return { startIso: "", endIso: "", startMs: null, endMs: null, generation: null };
  return {
    startIso: new Date(Math.min(...ts)).toISOString(),
    endIso: new Date(Math.max(...ts)).toISOString(),
    startMs: Math.min(...ts),
    endMs: Math.max(...ts),
    generation: null, // filled by the caller from the board export header
  };
}

/** First few distinct drop reasons, each with its count, for the report. */
function firstReasons(dropped, limit = 5) {
  const counts = new Map();
  for (const d of dropped) {
    counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  }
  return [...counts.entries()].slice(0, limit).map(([reason, count]) => ({ reason, count }));
}

function countsOf(board, rows, didEntries, boardRange, contracts, boardExport, nowMs, recentMs) {
  const bySource = (src) => rows.filter((r) => r.noteSource === src).length;
  return {
    totalRetainedBoardRecords: board.totalRecords,
    boardExportRawRows: boardExport?.rawRows ?? board.totalRecords,
    boardExportDroppedRows: boardExport?.droppedRows ?? 0,
    boardExportDroppedReasons: boardExport?.droppedReasons ?? [],
    boardFirstSeq: boardExport?.firstSeq ?? null,
    boardLastSeq: boardExport?.lastSeq ?? null,
    evidenceGeneration: boardExport?.generation ?? null,
    authenticatedSignedRecords: didEntries.reduce((sum, d) => sum + d.signedFrames, 0),
    invalidTclkLines: didEntries.reduce((sum, d) => sum + d.invalidTclkLines, 0),
    validTclkFrames: didEntries.reduce((sum, d) => sum + validFrameCount(d), 0),
    frameTypeCounts: board.frameTypeCounts,
    uniqueAuthenticatedDids: didEntries.filter((d) => d.signedFrames > 0).length,
    didNotesAttempted: didEntries.length,
    notesFoundPrimary: bySource("primary"),
    notesFoundLegacy: bySource("legacy"),
    notesAbsent: rows.filter((r) => r.noteSource === "none" || r.noteSource === "absent").length,
    notesError: bySource("error"),
    didsAdvertisingTclk1: didEntries.filter((d) => d.note?.tclk1 !== null && d.note?.tclk1 !== undefined).length,
    didsPaperCompatible: didEntries.filter((d) => isPaperCompatible(d.note?.rails)).length,
    didsAdvertisingMailbox: didEntries.filter((d) => d.note?.mailbox !== null && d.note?.mailbox !== undefined).length,
    didsWithValidOffers: didEntries.filter((d) => d.validOffers > 0).length,
    didsWithValidAccepts: didEntries.filter((d) => d.validAccepts > 0).length,
    didsWithValidLocks: didEntries.filter((d) => d.validLocks > 0).length,
    didsWithValidReveals: didEntries.filter((d) => d.validReveals > 0).length,
    orphanedAccepts: board.orphanedAccepts.length,
    invalidAccepts: board.invalidAccepts.length,
    contractsDerived: board.pairs.length,
    contractsRoomMissing: contracts.filter((c) => c.roomExists === false).length,
    contractsFoldFailed: contracts.filter((c) => !c.foldOk).length,
    claimedContracts: contracts.filter((c) => c.finalStatus === "claimed").length,
    refundedContracts: contracts.filter((c) => c.finalStatus === "refunded").length,
    cancelledContracts: contracts.filter((c) => c.finalStatus === "cancelled").length,
    tierA: rows.filter((r) => r.tier === TIER_A).length,
    tierB: rows.filter((r) => r.tier === TIER_B).length,
    tierC: rows.filter((r) => r.tier === TIER_C).length,
    tierD: rows.filter((r) => r.tier === TIER_D).length,
    tierUnknown: rows.filter((r) => r.tier === TIER_UNKNOWN).length,
    recentlyActiveCandidates: didEntries.filter(
      (d) => d.lastSeen !== null && nowMs - d.lastSeen <= recentMs,
    ).length,
    confirmedReachableCandidates: rows.filter((r) => r.reachableStatus === "confirmed").length,
    probableReachableCandidates: rows.filter((r) => r.reachableStatus === "probable").length,
    staleOrUnknownReachable:
      rows.length
      - rows.filter((r) => r.reachableStatus === "confirmed").length
      - rows.filter((r) => r.reachableStatus === "probable").length,
    evidenceWindowStart: boardRange.startIso,
    evidenceWindowEnd: boardRange.endIso,
  };
}

function serializableDid(d, nowMs, recentMs) {
  const c = classifyDid(d, nowMs, recentMs);
  return {
    did: d.did,
    firstSeen: d.firstSeen === null ? null : new Date(d.firstSeen).toISOString(),
    lastSeen: d.lastSeen === null ? null : new Date(d.lastSeen).toISOString(),
    signedFrames: d.signedFrames,
    invalidTclkLines: d.invalidTclkLines,
    validOffers: d.validOffers,
    validAccepts: d.validAccepts,
    validLocks: d.validLocks,
    validReveals: d.validReveals,
    validRefunds: d.validRefunds,
    validCancels: d.validCancels,
    validReceipts: d.validReceipts,
    validHeartbeats: d.validHeartbeats,
    contracts: [...d.contracts],
    lockedContracts: [...d.lockedContracts],
    claimedAsPayee: d.claimedAsPayee,
    terminalStates: [...d.terminalStates],
    offerRails: [...d.offerRails],
    tier: c.tier,
    score: c.score,
    reachable: c.reachable,
    protocolCapable: c.protocolCapable,
    recentlyActive: c.recentlyActive,
    willing: c.willing,
    note: {
      status: d.note?.status ?? null,
      source: d.note?.source ?? null,
      value: d.note?.value ?? null,
      checkedAt: d.note?.checkedAt ?? null,
      rails: d.note?.rails ?? null,
      railsLenient: d.note?.railsLenient ?? null,
      mailbox: d.note?.mailbox ?? null,
      tclk1: d.note?.tclk1 ?? null,
    },
  };
}

// ── Report ───────────────────────────────────────────────────────────────────

export function buildReport(result) {
  const c = result.evidence.counts ?? {};
  const L = [];
  const push = (line = "") => L.push(line);

  push("# PHASE-1 DISCOVERY AUDIT — REPORT");
  push("");
  push(`- status: \`${result.status}\``);
  push(`- stop reason: \`${result.stopReason ?? "none"}\``);
  push(`- start UTC: \`${result.audit.startUtc}\``);
  push(`- finish UTC: \`${result.audit.finishUtc}\``);
  push(`- venue: \`${result.audit.baseUrl}\``);
  push(`- repo: \`${result.meta.repo ?? ""}\` branch \`${result.meta.branch ?? ""}\` head \`${result.meta.head ?? ""}\``);
  push(`- node: \`${result.meta.node ?? ""}\` pnpm: \`${result.meta.pnpm ?? ""}\``);
  push("");
  push("## E. Live audit");
  push("| metric | value |");
  push("|---|---|");
  push(`| export raw rows | ${c.boardExportRawRows ?? 0} |`);
  push(`| export rows dropped (fail-closed per record) | ${c.boardExportDroppedRows ?? 0} |`);
  push(`| drop reasons | ${JSON.stringify(c.boardExportDroppedReasons ?? [])} |`);
  push(`| export generation (X-Room-Generation) | ${c.evidenceGeneration ?? "?"} |`);
  push(`| retained board records | ${c.totalRetainedBoardRecords ?? 0} |`);
  push(`| board seq range | ${c.boardFirstSeq ?? ""} → ${c.boardLastSeq ?? ""} |`);
  push(`| retention (manual + /config) | ${JSON.stringify(result.venue.retention ?? {})} |`);
  push(`| authenticated signed records | ${c.authenticatedSignedRecords ?? 0} |`);
  push(`| valid TCLK frames | ${c.validTclkFrames ?? 0} |`);
  push(`| frame types | ${JSON.stringify(c.frameTypeCounts ?? {})} |`);
  push(`| unique authenticated DIDs | ${c.uniqueAuthenticatedDids ?? 0} |`);
  push(`| evidence window (board) | ${c.evidenceWindowStart ?? ""} → ${c.evidenceWindowEnd ?? ""} |`);
  push("");
  push("> All activity counts are limited to the **currently retained transcript window** served by the venue; they are not \"all historical activity\".");
  push("");
  push("## F. DID resolution");
  push("| metric | value |");
  push("|---|---|");
  push(`| notes attempted | ${c.didNotesAttempted ?? 0} |`);
  push(`| primary notes found | ${c.notesFoundPrimary ?? 0} |`);
  push(`| legacy notes found | ${c.notesFoundLegacy ?? 0} |`);
  push(`| notes absent | ${c.notesAbsent ?? 0} |`);
  push(`| note errors | ${c.notesError ?? 0} |`);
  push(`| tclk1 advertisers | ${c.didsAdvertisingTclk1 ?? 0} |`);
  push(`| paper-compatible (registered rails) | ${c.didsPaperCompatible ?? 0} |`);
  push(`| mailbox advertisers | ${c.didsAdvertisingMailbox ?? 0} |`);
  push("");
  push("## G. Protocol evidence");
  push("| metric | value |");
  push("|---|---|");
  push(`| DIDs with valid offers | ${c.didsWithValidOffers ?? 0} |`);
  push(`| DIDs with valid accepts | ${c.didsWithValidAccepts ?? 0} |`);
  push(`| DIDs with valid locks | ${c.didsWithValidLocks ?? 0} |`);
  push(`| DIDs with valid reveals | ${c.didsWithValidReveals ?? 0} |`);
  push(`| contracts derived | ${c.contractsDerived ?? 0} |`);
  push(`| deal rooms missing (accept-only) | ${c.contractsRoomMissing ?? 0} |`);
  push(`| folds failed (malformed export) | ${c.contractsFoldFailed ?? 0} |`);
  push(`| orphaned accepts (offer outside retained window) | ${c.orphanedAccepts ?? 0} |`);
  push(`| invalid accepts (contract mismatch/malformed) | ${c.invalidAccepts ?? 0} |`);
  push(`| claimed / refunded / cancelled | ${c.claimedContracts ?? 0} / ${c.refundedContracts ?? 0} / ${c.cancelledContracts ?? 0} |`);
  push("");
  push("## H. Candidate summary");
  push("| tier | count |");
  push("|---|---|");
  push(`| A | ${c.tierA ?? 0} |`);
  push(`| B | ${c.tierB ?? 0} |`);
  push(`| C | ${c.tierC ?? 0} |`);
  push(`| D | ${c.tierD ?? 0} |`);
  push(`| UNKNOWN | ${c.tierUnknown ?? 0} |`);
  push(`| recently active | ${c.recentlyActiveCandidates ?? 0} |`);
  push(`| confirmed reachable | ${c.confirmedReachableCandidates ?? 0} |`);
  push(`| probable reachable | ${c.probableReachableCandidates ?? 0} |`);
  push(`| stale / unknown | ${c.staleOrUnknownReachable ?? 0} |`);
  push("");
  push("## I. Top candidates");
  push("| rank | tier | score | did | last seen | rails | mailbox | reachable | capability |");
  push("|---|---|---|---|---|---|---|---|---|");
  for (const row of result.candidates.slice(0, 25)) {
    push(`| ${row.rank ?? "-"} | ${row.tier} | ${row.score} | \`${row.did}\` | ${row.lastSeen || "-"} | ${row.railsAdvertised || "-"} | ${row.mailboxAdvertised || "-"} | ${row.reachableStatus} | ${row.protocolCapability} |`);
  }
  push("");
  push("## J. Rate limit / venue health");
  push(`- HTTP requests: ${result.rateLimits?.requests ?? 0}`);
  push(`- 429 count: ${result.rateLimits?.rateLimited429 ?? 0}`);
  push(`- 503 count: ${result.rateLimits?.rateLimited503 ?? 0}`);
  push(`- total retry wait: ${((result.rateLimits?.rateLimitWaitsMs ?? 0) / 1000).toFixed(1)}s`);
  push(`- last 429 body: \`${result.rateLimits?.last429Body ?? "none"}\``);
  push(`- cache hits / misses: ${result.cache?.hits ?? 0} / ${result.cache?.misses ?? 0}`);
  push("");
  push("## L. Findings");
  push("- discovery status: see JSON artifact for full evidence.");
  push("- no message, note, offer, accept, lock, reveal, refund, cancel, heartbeat, or mailbox write was performed by this audit; every network call was a GET against an allowlisted locally-built route.");
  push("- \"no valid reveal observed\" means exactly that within the retained window, never \"never revealed\".");
  return L.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    base: process.env.TECHNOCORE_URL ?? DEFAULT_BASE,
    stateDir: ".discovery/state",
    verbose: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[i + 1];
    if (arg === "--base") { args.base = next(); i += 1; }
    else if (arg === "--state-dir") { args.stateDir = next(); i += 1; }
    else if (arg === "--recent-ms") { args.recentMs = Number(next()); i += 1; }
    else if (arg === "--note-ttl-ms") { args.noteTtlMs = Number(next()); i += 1; }
    else if (arg === "--note-pace-ms") { args.notePaceMs = Number(next()); i += 1; }
    else if (arg === "--read-pace-ms") { args.readPaceMs = Number(next()); i += 1; }
    else if (arg === "--quiet") args.verbose = false;
    else {
      console.error(`discovery-audit: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

async function gitInfo() {
  const run = async (cmd) => {
    try {
      const { execSync } = await import("node:child_process");
      return execSync(cmd, { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  return {
    repo: (await run("basename $(pwd)")) || "",
    branch: await run("git branch --show-current"),
    head: await run("git rev-parse HEAD"),
    worktree: await run("git status --short | head -20"),
    node: process.version,
    pnpm: (await run("pnpm --version")) || "",
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const artifactsDir = ".discovery/artifacts";
  await mkdir(artifactsDir, { recursive: true });
  const log = args.verbose
    ? (line) => console.log(`${new Date().toISOString()} ${line}`)
    : () => {};

  log(`discovery audit starting — base ${args.base} (READ-ONLY)`);
  const result = await runAudit({
    fetchImpl: (url) => fetch(url),
    base: args.base,
    stateDir: args.stateDir,
    recentMs: args.recentMs,
    noteTtlMs: args.noteTtlMs,
    notePaceMs: args.notePaceMs,
    readPaceMs: args.readPaceMs,
    log,
  });
  result.meta = await gitInfo();

  result.candidates.forEach((row, i) => { row.rank = i + 1; });

  const stamp = result.audit.startUtc.replace(/[:.]/g, "-");
  const jsonPath = join(artifactsDir, `discovery-audit-${stamp}.json`);
  const csvPath = join(artifactsDir, `discovery-candidates-${stamp}.csv`);
  const mdPath = join(artifactsDir, `discovery-report-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(result, null, 2));
  await writeFile(csvPath, candidatesToCsv(result.candidates));
  await writeFile(mdPath, buildReport(result));

  const counts = result.evidence.counts ?? {};
  log(`done — status ${result.status}`);
  log(`  board records      ${counts.totalRetainedBoardRecords ?? 0}`);
  log(`  authenticated DIDs ${counts.uniqueAuthenticatedDids ?? 0}`);
  log(`  tier A/B/C/D       ${counts.tierA ?? 0}/${counts.tierB ?? 0}/${counts.tierC ?? 0}/${counts.tierD ?? 0}`);
  log(`  429/503            ${result.rateLimits?.rateLimited429 ?? 0}/${result.rateLimits?.rateLimited503 ?? 0}`);
  log(`  artifacts          ${jsonPath}, ${csvPath}, ${mdPath}`);

  if (result.status !== "PHASE1_COMPLETE") {
    log(`stop reason: ${result.stopReason}`);
    process.exitCode = 1;
  }
  return result;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}