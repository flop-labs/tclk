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
import { randomU8a, stringToU8a, u8aToHex } from "./hex.js";
import { isValidPointStatement } from "./points.js";

export const TCLK_VERSION = "tclk/1" as const;
export const TCLK_PREFIX = "tclk1 " as const;
export const TCLK_DOMAIN = "FLOP::tclk::v1" as const;
/** Technocore's message cap: a frame must fit one single-line room message. */
export const MAX_FRAME_CHARS = 4096;

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
  /** The 32-byte preimage (hash lock) or scalar witness (point lock), 0x-hex. */
  secret: string;
}

export interface RefundFrame {
  type: "refund";
  from: string;
  contract: string;
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

export type TclkFrame =
  | OfferFrame
  | AcceptFrame
  | LockFrame
  | RevealFrame
  | RefundFrame
  | CancelFrame
  | ReceiptFrame;

// ── Field shapes ─────────────────────────────────────────────────────────────

const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX33 = /^0x[0-9a-f]{66}$/;
// Ed25519 did:key as the technocore signed lane verifies it (56 chars, z6Mk…).
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const AMOUNT = /^[1-9][0-9]*$/;
const ASSET = /^[A-Za-z0-9_-]{1,32}$/;
const RAIL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
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

function requireKeys(record: Record<string, unknown>, allowed: Set<string>, required: string[]): void {
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

const KEYS: Record<TclkFrame["type"], { allowed: string[]; required: string[] }> = {
  offer: {
    allowed: ["type", "from", "role", "amount", "asset", "lock", "rails", "claimByMs",
      "refundAfterMs", "expiresMs", "paymentKey", "job", "nonce", "id"],
    required: ["from", "role", "amount", "asset", "lock", "rails", "claimByMs",
      "refundAfterMs", "expiresMs", "nonce", "id"],
  },
  accept: {
    allowed: ["type", "from", "ref", "statement", "contract", "paymentKey", "nonce"],
    required: ["from", "ref", "statement", "contract", "nonce"],
  },
  lock: {
    allowed: ["type", "from", "contract", "rail", "ref", "presig"],
    required: ["from", "contract", "rail", "ref"],
  },
  reveal: {
    allowed: ["type", "from", "contract", "secret"],
    required: ["from", "contract", "secret"],
  },
  refund: {
    allowed: ["type", "from", "contract", "reason"],
    required: ["from", "contract"],
  },
  cancel: {
    allowed: ["type", "from", "contract", "reason"],
    required: ["from", "contract"],
  },
  receipt: {
    allowed: ["type", "from", "contract", "outcome", "rail", "ref"],
    required: ["from", "contract", "outcome"],
  },
};

/** Validate a hash/point statement for the given lock kind (fail-closed boolean). */
export function isValidStatement(lock: LockKind, statement: string): boolean {
  if (lock === "hash") return HEX32.test(statement);
  return HEX33.test(statement) && isValidPointStatement(statement);
}

/** Validate one frame structurally. Throws with a reason on the first violation. */
export function validateFrame(value: unknown): TclkFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("frame must be an object");
  const frame = value as Record<string, unknown>;
  const type = frame.type as TclkFrame["type"];
  const keys = KEYS[type];
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
      for (const rail of frame.rails) requireString(rail, "rail", RAIL);
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
      requireString(frame.rail, "rail", RAIL);
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
      requireString(frame.secret, "secret", HEX32);
      break;
    }
    case "refund":
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
      if (frame.rail !== undefined) requireString(frame.rail, "rail", RAIL);
      if (frame.ref !== undefined) requireString(frame.ref, "ref");
      break;
    }
  }
  return value as TclkFrame;
}

// ── Builders ─────────────────────────────────────────────────────────────────

/** Build a validated offer; mints a nonce if none given, computes the id. */
export function makeOffer(fields: Omit<OfferFields, "type" | "nonce"> & { nonce?: string }): OfferFrame {
  const body: OfferFields = {
    ...fields,
    type: "offer",
    nonce: fields.nonce ?? u8aToHex(randomU8a(8)).slice(2),
  };
  return validateFrame({ ...body, id: offerId(body) }) as OfferFrame;
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
  const line = TCLK_PREFIX + toAscii(canonicalJson(validateFrame(frame)));
  if (line.length > MAX_FRAME_CHARS) {
    fail(`frame exceeds the ${MAX_FRAME_CHARS}-char room-message cap (${line.length})`);
  }
  // Sweep guard: technocore replaces controls/format chars with spaces before storing,
  // which would silently change the bytes a reader re-verifies. Refuse to emit them.
  if (!/^[\x20-\x7e]*$/.test(line)) fail("frame line contains non-printable-ASCII characters");
  return line;
}

/** Decode a room-message line. Throws on a malformed tclk line or a non-tclk line. */
export function decodeFrame(text: string): TclkFrame {
  if (!isTclkLine(text)) fail("not a tclk/1 line");
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
