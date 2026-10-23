// SPDX-License-Identifier: Apache-2.0
//
// Technocore Lock Protocol (`tclk/1`) — wire frames.
//
// One frame per technocore room message: the prefix `tclk1 ` followed by one canonical,
// ASCII-only JSON object on a single line. Canonical = sorted keys, compact separators,
// undefined keys dropped, non-ASCII `\uXXXX`-escaped — so the stored bytes equal the bytes
// the transport `did:key` signature covered (technocore sweeps controls/format chars and
// never normalizes; ASCII sidesteps both). Decoding is fail-closed: unknown keys, missing
// fields, and malformed values reject — nothing is coerced.
//
// Spec: technocore-lock-protocol.md

import { sha256 } from "@noble/hashes/sha2.js";
import { FRAME_FIELDS, TCLK1_RAIL_PATTERN } from "./frame-fields.generated.js";
import { randomU8a, stringToU8a, u8aToHex } from "./hex.js";
import { isValidPointStatement } from "./points.js";
import {
  normalizeRailId,
  normalizeRailIds,
} from "./rails.js";

export const TCLK_VERSION = "tclk/1" as const;
export const TCLK_PREFIX = "tclk1 " as const;
export const TCLK_DOMAIN = "FLOP::tclk::v1" as const;
/** Technocore's message cap: a frame must fit one single-line room message. */
export const MAX_FRAME_CHARS = 4096;
/**
 * The other half of SPEC §2's frame sentence: single line, ASCII-only. One definition, used
 * by both halves of the codec — the encoder must not emit a line the venue would sweep, and
 * the decoder must not accept one, because such a line was never the line a sender signed.
 */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export type LockKind = "hash" | "point";

/** Binding to an external job the contract pays for (A2A task, Virtuals ACP job, …). */
export interface JobRef {
  proto: string;
  id: string;
  context?: string;
}

export interface OfferFields {
  type: "offer";
  /** Sender's transport identity — must match the signed-lane `from` of the record. */
  from: string;
  /** Which side the sender takes. */
  role: "payer" | "payee";
  /** Decimal integer string, rail-native minimal units. */
  amount: string;
  asset: string;
  lock: LockKind;
  /** Settlement rails the sender accepts (e.g. "flop-htlc", "x402"). */
  rails: string[];
  /** Payee's safe claim deadline (unix ms). */
  claimByMs: number;
  /** Payer may refund from here (unix ms). Strictly after claimByMs. */
  refundAfterMs: number;
  /** Offer dies unanswered at this time (unix ms). */
  expiresMs: number;
  /** Sender's secp256k1 key (33-byte SEC1 hex). Required for point locks. */
  paymentKey?: string;
  job?: JobRef;
  /** Random hex; makes the id unique and defeats the venue's duplicate-text filter. */
  nonce: string;
}

export interface OfferFrame extends OfferFields {
  /** sha256 over the domain-tagged canonical offer fields (see offerId). */
  id: string;
}

export interface AcceptFrame {
  type: "accept";
  from: string;
  /** The offer id being accepted. */
  ref: string;
  /** Hash lock: sha256(preimage). Point lock: SEC1-compressed Y = y·G. Payee-minted. */
  statement: string;
  /** sha256 over the domain-tagged canonical {offer, accept-core} (see contractId). */
  contract: string;
  paymentKey?: string;
  nonce: string;
}

/** Schnorr adaptor pre-signature (see ../adaptor.ts — unaudited reference crypto). */
export interface PresigRef {
  nonce: string;
  s: string;
}

export interface LockFrame {
  type: "lock";
  from: string;
  contract: string;
  /** Which rail holds the funds — must be one the offer listed. */
  rail: string;
  /** Rail-specific reference (escrow id, txid, payment id). */
  ref: string;
  /** PTLC: payer's adaptor pre-signature under the statement over the rail's claim message. */
  presig?: PresigRef;
}

export interface RevealFrame {
  type: "reveal";
  from: string;
  contract: string;
  /** Rail-specific reference; new senders include it and it must equal lock.ref. */
  ref?: string;
  /** The 32-byte preimage (hash lock) or scalar witness (point lock), 0x-hex. */
  secret: string;
}

export interface RefundFrame {
  type: "refund";
  from: string;
  contract: string;
  /** Rail-specific reference; new senders include it and it must equal lock.ref. */
  ref?: string;
  reason?: string;
}

export interface CancelFrame {
  type: "cancel";
  from: string;
  contract: string;
  reason?: string;
}

export interface ReceiptFrame {
  type: "receipt";
  from: string;
  contract: string;
  outcome: "claimed" | "refunded" | "cancelled";
  rail?: string;
  ref?: string;
}

/** Signed liveness signal. It never changes contract or money state. */
export interface HeartbeatFrame {
  type: "heartbeat";
  from: string;
  contract: string;
  /** Defeats the venue's duplicate-text filter without changing protocol state. */
  nonce: string;
  note?: string;
}

export type TclkFrame =
  | OfferFrame
  | AcceptFrame
  | LockFrame
  | RevealFrame
  | RefundFrame
  | CancelFrame
  | ReceiptFrame
  | HeartbeatFrame;

// ── Field shapes ─────────────────────────────────────────────────────────────

const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX33 = /^0x[0-9a-f]{66}$/;
// Ed25519 did:key as the technocore signed lane verifies it (56 chars, z6Mk…).
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const AMOUNT = /^[1-9][0-9]*$/;
const ASSET = /^[A-Za-z0-9_-]{1,32}$/;
// The original tclk/1 wire grammar. Decoding keeps accepting it so old contract ids and
// transcripts remain replayable; encodeFrame separately requires registered canonical ids.
const LEGACY_RAIL = new RegExp(TCLK1_RAIL_PATTERN);
const NONCE = /^[0-9a-f]{8,64}$/;
const SCALAR_HEX = /^0x(?:[0-9a-f]{2}){1,32}$/;

function fail(msg: string): never {
  throw new Error(`tclk: ${msg}`);
}

function requireString(v: unknown, name: string, re?: RegExp): string {
  if (typeof v !== "string" || v.length === 0) fail(`${name} must be a non-empty string`);
  if (re && !re.test(v)) fail(`${name} is malformed: ${v}`);
  return v;
}

function requireMs(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
    fail(`${name} must be a positive unix-ms integer`);
  }
  return v;
}

function requireKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`unknown field on ${String(record.type)}: ${key}`);
  }
  for (const key of required) {
    if (record[key] === undefined) fail(`missing field on ${String(record.type)}: ${key}`);
  }
}

function validateJob(v: unknown): JobRef {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("job must be an object");
  const job = v as Record<string, unknown>;
  requireKeys({ ...job, type: "job" }, new Set(["type", "proto", "id", "context"]), ["proto", "id"]);
  requireString(job.proto, "job.proto", /^[a-z0-9][a-z0-9._-]{0,31}$/);
  requireString(job.id, "job.id");
  if (job.context !== undefined) requireString(job.context, "job.context");
  return v as JobRef;
}

function validatePaymentKey(v: unknown, name: string): string {
  const key = requireString(v, name, HEX33);
  // Length is not enough: the key must be an actual curve point, same fail-closed
  // rule as the on-chain Point statement.
  if (!isValidPointStatement(key)) fail(`${name} is not a valid secp256k1 point`);
  return key;
}

// ── Canonical encoding ───────────────────────────────────────────────────────

/** Deterministic JSON: sorted keys, compact, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail("frame contains an unsupported value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Escape every non-ASCII char so the stored line equals the signed line. */
function toAscii(json: string): string {
  return json.replace(
    /[\u0080-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The id hash. `payload` is escaped to ASCII first, deliberately: the id must commit to
 * the same bytes the wire carries. Hashing the unescaped form instead would leave two
 * conforming implementations disagreeing on the contract id for any frame carrying a
 * non-ASCII character (a job id, say) — and since every later frame names the contract by
 * that id, the two sides would believe they were on different deals. For ASCII payloads
 * the escape is the identity, so ids of ASCII frames are unaffected.
 */
function domainHash(tag: string, payload: string): string {
  return u8aToHex(sha256(stringToU8a(`${TCLK_DOMAIN}|${tag}|${toAscii(payload)}`)));
}

/** The offer id: sha256 over the domain-tagged canonical offer fields (without `id`). */
export function offerId(fields: OfferFields): string {
  return domainHash("offer", canonicalJson(fields));
}

/** Acceptance core — the accept fields the contract id commits to. */
export interface AcceptCore {
  from: string;
  ref: string;
  statement: string;
  paymentKey?: string;
  nonce: string;
}

/**
 * The contract id: sha256 over the domain-tagged canonical {offer, accept} pair.
 * Binds the full offer (id included) and the acceptance, so either side tampering
 * with any term yields a different contract.
 */
export function contractId(offer: OfferFrame, accept: AcceptCore): string {
  return domainHash("contract", canonicalJson({ offer, accept }));
}

// ── Frame validation (fail-closed) ───────────────────────────────────────────

/** Validate a hash/point statement for the given lock kind (fail-closed boolean). */
export function isValidStatement(lock: LockKind, statement: string): boolean {
  if (lock === "hash") return HEX32.test(statement);
  if (lock === "point") return HEX33.test(statement) && isValidPointStatement(statement);
  return false;
}

/** Validate one frame structurally. Throws with a reason on the first violation. */
export function validateFrame(value: unknown): TclkFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("frame must be an object");
  const frame = value as Record<string, unknown>;
  const type = frame.type as TclkFrame["type"];
  const keys = FRAME_FIELDS[type];
  if (!keys) fail(`unknown frame type: ${String(frame.type)}`);
  requireKeys(frame, new Set(keys.allowed), keys.required);
  requireString(frame.from, "from", DID);

  switch (type) {
    case "offer": {
      if (frame.role !== "payer" && frame.role !== "payee") fail("role must be payer|payee");
      requireString(frame.amount, "amount", AMOUNT);
      requireString(frame.asset, "asset", ASSET);
      if (frame.lock !== "hash" && frame.lock !== "point") fail("lock must be hash|point");
      if (!Array.isArray(frame.rails) || frame.rails.length === 0) fail("rails must be a non-empty array");
      for (const rail of frame.rails) requireString(rail, "rail", LEGACY_RAIL);
      const claimBy = requireMs(frame.claimByMs, "claimByMs");
      const refundAfter = requireMs(frame.refundAfterMs, "refundAfterMs");
      requireMs(frame.expiresMs, "expiresMs");
      if (claimBy >= refundAfter) fail("claimByMs must be strictly before refundAfterMs");
      if (frame.paymentKey !== undefined) validatePaymentKey(frame.paymentKey, "paymentKey");
      if (frame.lock === "point" && frame.paymentKey === undefined) {
        fail("point locks require paymentKey");
      }
      if (frame.job !== undefined) validateJob(frame.job);
      requireString(frame.nonce, "nonce", NONCE);
      const { id: _id, ...fields } = frame as unknown as OfferFrame;
      const expected = offerId(fields);
      if (frame.id !== expected) fail(`offer id mismatch (expected ${expected})`);
      break;
    }
    case "accept": {
      requireString(frame.ref, "ref", HEX32);
      requireString(frame.statement, "statement", /^0x(?:[0-9a-f]{64}|[0-9a-f]{66})$/);
      requireString(frame.contract, "contract", HEX32);
      if (frame.paymentKey !== undefined) validatePaymentKey(frame.paymentKey, "paymentKey");
      requireString(frame.nonce, "nonce", NONCE);
      break;
    }
    case "lock": {
      requireString(frame.contract, "contract", HEX32);
      requireString(frame.rail, "rail", LEGACY_RAIL);
      requireString(frame.ref, "ref");
      if (frame.presig !== undefined) {
        const presig = frame.presig as Record<string, unknown>;
        if (!presig || typeof presig !== "object" || Array.isArray(presig)) fail("presig must be an object");
        requireKeys({ ...presig, type: "presig" }, new Set(["type", "nonce", "s"]), ["nonce", "s"]);
        requireString(presig.nonce, "presig.nonce", HEX33);
        requireString(presig.s, "presig.s", SCALAR_HEX);
      }
      break;
    }
    case "reveal": {
      requireString(frame.contract, "contract", HEX32);
      if (frame.ref !== undefined) requireString(frame.ref, "ref");
      requireString(frame.secret, "secret", HEX32);
      break;
    }
    case "refund": {
      requireString(frame.contract, "contract", HEX32);
      if (frame.ref !== undefined) requireString(frame.ref, "ref");
      if (frame.reason !== undefined) requireString(frame.reason, "reason");
      break;
    }
    case "cancel": {
      requireString(frame.contract, "contract", HEX32);
      if (frame.reason !== undefined) requireString(frame.reason, "reason");
      break;
    }
    case "receipt": {
      requireString(frame.contract, "contract", HEX32);
      if (!["claimed", "refunded", "cancelled"].includes(String(frame.outcome))) {
        fail("outcome must be claimed|refunded|cancelled");
      }
      if (frame.rail !== undefined) {
        requireString(frame.rail, "rail", LEGACY_RAIL);
      }
      if (frame.ref !== undefined) requireString(frame.ref, "ref");
      break;
    }
    case "heartbeat": {
      requireString(frame.contract, "contract", HEX32);
      requireString(frame.nonce, "nonce", NONCE);
      if (frame.note !== undefined) requireString(frame.note, "note");
      break;
    }
  }
  return value as TclkFrame;
}

// ── Builders ─────────────────────────────────────────────────────────────────

/** Build a validated offer; mints a nonce if none given, computes the id. */
export function makeOffer(
  fields: Omit<OfferFields, "type" | "nonce" | "rails"> & {
    rails: readonly string[];
    nonce?: string;
  },
): OfferFrame {
  const body: OfferFields = {
    ...fields,
    type: "offer",
    rails: normalizeRailIds(fields.rails),
    nonce: fields.nonce ?? u8aToHex(randomU8a(8)).slice(2),
  };
  return validateFrame({ ...body, id: offerId(body) }) as OfferFrame;
}

function requireCanonicalRail(value: string): void {
  const canonical = normalizeRailId(value);
  if (value !== canonical) fail(`non-canonical rail id: ${value}; use ${canonical}`);
}

/** New tclk/1 emissions use the closed registry; decoding retains the original grammar. */
function validateEmissionRails(frame: TclkFrame): void {
  if (frame.type === "offer") {
    for (const rail of frame.rails) requireCanonicalRail(rail);
    if (new Set(frame.rails).size !== frame.rails.length) fail("rails must not contain duplicates");
  } else if (frame.type === "lock") {
    requireCanonicalRail(frame.rail);
  } else if (frame.type === "receipt" && frame.rail !== undefined) {
    requireCanonicalRail(frame.rail);
  }
}

/** Build a signed liveness frame; mints a nonce if none is supplied. */
export function makeHeartbeat(
  fields: Omit<HeartbeatFrame, "type" | "nonce"> & { nonce?: string },
): HeartbeatFrame {
  return validateFrame({
    ...fields,
    type: "heartbeat",
    nonce: fields.nonce ?? u8aToHex(randomU8a(8)).slice(2),
  }) as HeartbeatFrame;
}

/**
 * Accept an offer: verifies the offer's own id, checks the statement fits the
 * offered lock kind (a point lock also requires both payment keys), computes the
 * contract id.
 */
export function makeAccept(
  offer: OfferFrame,
  accept: { from: string; statement: string; paymentKey?: string; nonce?: string },
): AcceptFrame {
  validateFrame(offer);
  if (accept.from === offer.from) fail("accept.from must differ from offer.from");
  if (!isValidStatement(offer.lock, accept.statement)) {
    fail(`statement does not fit a ${offer.lock} lock: ${accept.statement}`);
  }
  if (offer.lock === "point" && accept.paymentKey === undefined) {
    fail("point locks require the acceptor's paymentKey");
  }
  const core: AcceptCore = {
    from: accept.from,
    ref: offer.id,
    statement: accept.statement,
    paymentKey: accept.paymentKey,
    nonce: accept.nonce ?? u8aToHex(randomU8a(8)).slice(2),
  };
  return validateFrame({
    type: "accept",
    ...core,
    contract: contractId(offer, core),
  }) as AcceptFrame;
}

// ── Line codec ───────────────────────────────────────────────────────────────

/** True iff a room-message text is a tclk/1 frame line. */
export function isTclkLine(text: string): boolean {
  return text.startsWith(TCLK_PREFIX);
}

/** Encode a frame to its room-message line. Validates, and enforces the venue caps. */
export function encodeFrame(frame: TclkFrame): string {
  const validated = validateFrame(frame);
  validateEmissionRails(validated);
  const line = TCLK_PREFIX + toAscii(canonicalJson(validated));
  if (line.length > MAX_FRAME_CHARS) {
    fail(`frame exceeds the ${MAX_FRAME_CHARS}-char room-message cap (${line.length})`);
  }
  // Sweep guard: technocore replaces controls/format chars with spaces before storing,
  // which would silently change the bytes a reader re-verifies. Refuse to emit them.
  if (!PRINTABLE_ASCII.test(line)) fail("frame line contains non-printable-ASCII characters");
  return line;
}

/** Decode a room-message line. Throws on a malformed tclk line or a non-tclk line. */
export function decodeFrame(text: string): TclkFrame {
  if (!isTclkLine(text)) fail("not a tclk/1 line");
  // The cap is a property of a frame, not just of our emitter: the venue refuses a longer
  // text, so a longer line was never a stored room message. Checked before the parse, so a
  // fold over an untrusted export bounds the work a single row can cost it.
  if (text.length > MAX_FRAME_CHARS) {
    fail(`frame exceeds the ${MAX_FRAME_CHARS}-char room-message cap (${text.length})`);
  }
  // Single-line and ASCII-only are properties of a frame too, from the same §2 sentence as
  // the cap. A line carrying a control or format char is not the line its sender signed —
  // the venue swept it to a space before storing — and a raw non-ASCII char makes the id
  // commit to bytes the line does not carry, since the id hashes the escaped form (§3).
  // Before the parse, for the same reason the cap is.
  if (!PRINTABLE_ASCII.test(text)) fail("frame line contains non-printable-ASCII characters");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(TCLK_PREFIX.length));
  } catch {
    fail("frame is not valid JSON");
  }
  return validateFrame(parsed);
}

/**
 * Decode for polling loops over mixed rooms: null for non-tclk lines AND for
 * malformed tclk lines (message bodies are anonymous input — a hostile line must
 * not break the reader).
 */
export function tryDecodeFrame(text: string): TclkFrame | null {
  try {
    return decodeFrame(text);
  } catch {
    return null;
  }
}
