// SPDX-License-Identifier: Apache-2.0
//
// A transcript is not an array of frame strings. The transport record beside each line
// supplies the identity and time that make the state-machine guards meaningful. Keep the
// fields together so attribution and timestamps cannot become short, shifted parallel
// arrays, and verify the signed record before its frame is allowed to move money-state.

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";

import { decodeFrame, tryDecodeFrame } from "./frames.js";
import { applyFrame, openContract, type ContractState } from "./machine.js";
import { dealRoom, OFFER_ROOM } from "./technocore.js";

const ROOM_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const NONCE = /^(?:0|[1-9][0-9]*)$/;
const SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const TIMESTAMP = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const DID_PREFIX = "did:key:z";

/**
 * One normalized technocore record. `line` is the exact stored text; `sender`, `nonce`
 * and `signature` authenticate it for `room`. `timestampMs` and `seq` are venue metadata,
 * not fields covered by the sender's signature; an offline auditor must trust the export
 * file for those two values. Missing signature fields represent an unsigned-lane record
 * and are rejected by a fold.
 */
export interface TranscriptRecord {
  room: string;
  seq: number;
  timestampMs: number;
  sender: string;
  nonce: string | null;
  signature: string | null;
  line: string;
}

export interface TranscriptRecordVerification {
  ok: boolean;
  reason?: string;
}

export interface TranscriptStep {
  index: number;
  room: string;
  seq: number;
  type?: string;
  ok: boolean;
  reason?: string;
}

export interface TranscriptFoldResult {
  state: ContractState | null;
  steps: TranscriptStep[];
}

/**
 * Which single room a fold reads post-accept frames from. Exactly one, in either mode —
 * admitting both rooms would leave the result depending on how the caller interleaved two
 * independent streams (per-room `seq`, millisecond timestamps that can tie), so signed
 * evidence would no longer determine one state.
 *
 * - `"strict"` — SPEC §2 as first written: post-accept frames only in the contract's derived
 *   deal room. The default.
 * - `"offer-room"` — post-accept frames only in `tclk-offers`; a frame in the derived room is
 *   rejected like any other wrong-room frame. For deals whose payer could not open the derived
 *   room — a venue can refuse a new room outright (service-wide cap, `400`) or per client
 *   (`rate_rooms_per_day`, `429`) — and so announced the lock on the board instead.
 *
 * Neither mode relaxes anything but the room: the frame still has to be signed by a party,
 * name this contract, and pass the state guards. Neither consults a settlement rail — a fold
 * says what the signed transcript establishes, not that anything was funded. And the board
 * is a ~10 MiB ring: a deal kept there stops being verifiable from the venue within hours,
 * so `"offer-room"` restores visibility, not durability.
 */
export type RoomBinding = "strict" | "offer-room";

export interface FoldOptions {
  roomBinding?: RoomBinding;
}

export interface ContractHandshake {
  offer: TranscriptRecord;
  accept: TranscriptRecord;
}

function invalid(reason: string): TranscriptRecordVerification {
  return { ok: false, reason };
}

function publicKeyFromDid(did: string): Uint8Array | null {
  if (!did.startsWith(DID_PREFIX)) return null;
  try {
    const tagged = base58.decode(did.slice(DID_PREFIX.length));
    if (tagged.length !== 34 || tagged[0] !== 0xed || tagged[1] !== 0x01) return null;
    return tagged.slice(2);
  } catch {
    return null;
  }
}

/** Verify all structure and the Ed25519 signature of one normalized record. */
export function verifyTranscriptRecord(record: TranscriptRecord): TranscriptRecordVerification {
  if (!record || typeof record !== "object") return invalid("record is not an object");
  if (typeof record.room !== "string" || !ROOM_NAME.test(record.room)) {
    return invalid("record has an invalid room name");
  }
  if (!Number.isSafeInteger(record.seq) || record.seq < 0) {
    return invalid("record seq must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(record.timestampMs) || record.timestampMs < 0) {
    return invalid("record timestampMs must be a non-negative safe integer");
  }
  if (typeof record.line !== "string") return invalid("record line must be a string");
  if (typeof record.sender !== "string") return invalid("record sender must be a string");
  if (record.nonce === null || record.signature === null) {
    return invalid("record is unsigned");
  }
  if (!NONCE.test(record.nonce)) return invalid("record nonce is not canonical decimal");
  if (!SIGNATURE.test(record.signature)) {
    return invalid("record signature is not canonical base64url");
  }
  const publicKey = publicKeyFromDid(record.sender);
  if (publicKey === null) return invalid("record sender is not an Ed25519 did:key");

  try {
    const signature = base64urlnopad.decode(record.signature);
    const canonical = `${record.room}|${record.nonce}|${record.line}`;
    if (!ed25519.verify(signature, new TextEncoder().encode(canonical), publicKey)) {
      return invalid("record signature does not verify");
    }
  } catch {
    return invalid("record signature does not verify");
  }
  return { ok: true };
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`tclk: ${where} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Normalize one `?format=json` or `/export` message without discarding its exact line. */
export function transcriptRecord(room: string, value: unknown): TranscriptRecord {
  if (!ROOM_NAME.test(room)) throw new Error(`tclk: invalid transcript room ${JSON.stringify(room)}`);
  const message = object(value, "transcript message");
  if (!Number.isSafeInteger(message.seq) || (message.seq as number) < 0) {
    throw new Error("tclk: transcript message seq must be a non-negative safe integer");
  }
  if (typeof message.ts !== "string") throw new Error("tclk: transcript message has no timestamp");
  if (!TIMESTAMP.test(message.ts)) {
    throw new Error("tclk: transcript message timestamp must be timezone-qualified RFC 3339");
  }
  const timestampMs = Date.parse(message.ts);
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new Error("tclk: transcript message timestamp is invalid");
  }
  if (typeof message.from !== "string") throw new Error("tclk: transcript message has no sender");
  if (typeof message.text !== "string") throw new Error("tclk: transcript message has no text");

  let nonce: string | null = null;
  if (typeof message.nonce === "string") nonce = message.nonce;
  else if (typeof message.nonce === "number" && Number.isSafeInteger(message.nonce)) {
    nonce = String(message.nonce);
  } else if (message.nonce !== undefined && message.nonce !== null) {
    throw new Error("tclk: transcript message nonce must be decimal text");
  }

  let signature: string | null = null;
  if (typeof message.sig === "string") signature = message.sig;
  else if (message.sig !== undefined && message.sig !== null) {
    throw new Error("tclk: transcript message signature must be text");
  }

  return {
    room,
    seq: message.seq as number,
    timestampMs,
    sender: message.from,
    nonce,
    signature,
    line: message.text,
  };
}

/** Parse a byte-exact technocore `/export` JSONL response. One malformed row fails all. */
export function parseTranscriptExport(room: string, jsonl: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  jsonl.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`tclk: transcript export line ${index + 1} is not JSON`);
    }
    try {
      records.push(transcriptRecord(room, value));
    } catch (error) {
      const reason = error instanceof Error ? error.message.replace(/^tclk: /, "") : "invalid record";
      throw new Error(`tclk: transcript export line ${index + 1}: ${reason}`);
    }
  });
  return records;
}

function decodeReason(line: string): string {
  try {
    decodeFrame(line);
  } catch (error) {
    return error instanceof Error ? error.message : "invalid tclk frame";
  }
  return "frame did not decode";
}

function authenticatedFrame(record: TranscriptRecord) {
  if (record.room !== OFFER_ROOM || !verifyTranscriptRecord(record).ok) return null;
  const frame = tryDecodeFrame(record.line);
  return frame !== null && frame.from === record.sender ? frame : null;
}

/**
 * Find one contract's authenticated offer/accept pair without rewriting board history.
 * Only an accept that follows its referenced offer in the supplied append order counts.
 */
export function findContractHandshake(
  records: readonly TranscriptRecord[],
  contract: string,
): ContractHandshake | null {
  // Reuse the public derivation's strict contract-id validation.
  dealRoom(contract);
  const offers = new Map<string, TranscriptRecord>();
  let acceptPrecededOffer = false;

  for (const record of records) {
    const frame = authenticatedFrame(record);
    if (frame?.type === "offer") {
      if (!offers.has(frame.id)) offers.set(frame.id, record);
      continue;
    }
    if (frame?.type !== "accept" || frame.contract !== contract) continue;
    const offer = offers.get(frame.ref);
    if (offer !== undefined) return { offer, accept: record };
    acceptPrecededOffer = true;
  }

  if (acceptPrecededOffer) {
    throw new Error(`tclk: accept for ${contract} has no preceding authenticated offer`);
  }
  return null;
}

/**
 * Authenticate and fold records in the supplied order. Every record gets a verdict;
 * invalid signatures, forged `from` fields, wrong rooms, malformed lines and bad
 * transitions are rejected without changing state. Deadline guards use that record's
 * venue timestamp. `options.roomBinding` selects how the room binding is enforced
 * (see RoomBinding); the default is strict.
 */
export function foldTranscript(
  records: readonly TranscriptRecord[],
  options: FoldOptions = {},
): TranscriptFoldResult {
  const roomBinding: RoomBinding = options.roomBinding ?? "strict";
  if (roomBinding !== "strict" && roomBinding !== "offer-room") {
    throw new Error(`tclk: unknown roomBinding ${JSON.stringify(roomBinding)}`);
  }
  const steps: TranscriptStep[] = [];
  let state: ContractState | null = null;

  records.forEach((record, index) => {
    const base = { index, room: record?.room ?? "", seq: record?.seq ?? -1 };
    const verification = verifyTranscriptRecord(record);
    if (!verification.ok) {
      steps.push({ ...base, ok: false, reason: verification.reason });
      return;
    }

    const frame = tryDecodeFrame(record.line);
    if (frame === null) {
      steps.push({ ...base, ok: false, reason: decodeReason(record.line) });
      return;
    }
    if (frame.from !== record.sender) {
      steps.push({
        ...base,
        type: frame.type,
        ok: false,
        reason: `${frame.type}.from does not match the record sender`,
      });
      return;
    }

    if (state === null) {
      if (frame.type !== "offer") {
        steps.push({ ...base, type: frame.type, ok: false, reason: "no contract open yet" });
        return;
      }
      if (record.room !== OFFER_ROOM) {
        steps.push({
          ...base,
          type: frame.type,
          ok: false,
          reason: `offer must be posted in ${OFFER_ROOM}`,
        });
        return;
      }
      try {
        state = openContract(frame);
        steps.push({ ...base, type: frame.type, ok: true });
      } catch (error) {
        steps.push({
          ...base,
          type: frame.type,
          ok: false,
          reason: error instanceof Error ? error.message : "invalid offer",
        });
      }
      return;
    }

    // Offer/accept always belong to the board; post-accept frames belong to exactly one
    // room chosen by the mode. A frame anywhere else is rejected, in either mode.
    const expectedRoom =
      frame.type === "offer" || frame.type === "accept" || state.contract === undefined
        ? OFFER_ROOM
        : roomBinding === "offer-room"
          ? OFFER_ROOM
          : dealRoom(state.contract);
    if (record.room !== expectedRoom) {
      const where = expectedRoom === OFFER_ROOM
        ? OFFER_ROOM
        : `the derived deal room ${expectedRoom}`;
      steps.push({
        ...base,
        type: frame.type,
        ok: false,
        reason: `${frame.type} must be posted in ${where}`,
      });
      return;
    }

    const result = applyFrame(state, frame, record.timestampMs);
    state = result.state;
    steps.push({ ...base, type: frame.type, ok: result.ok, reason: result.reason });
  });

  return { state, steps };
}
