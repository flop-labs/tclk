// SPDX-License-Identifier: Apache-2.0
//
// B3V4 fast-path helper — minimum fail-closed pre-lock verification gates.
//
// These 16 checks run before any write is attempted. If any gate fails,
// the helper stops with no write and reports the exact reason.

import {
  contractId,
  decodeFrame,
  dealRoom,
  encodeFrame,
  isValidStatement,
  offerId,
  verifyTranscriptRecord,
  type AcceptFrame,
  type ContractState,
  type OfferFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import type { GateResult, GateResultSet } from "./types.js";

const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

// ── Individual gates ─────────────────────────────────────────────────────────

/**
 * Gate 1: Offer parses as valid tclk/1.
 */
export function gateOfferParses(offer: OfferFrame): GateResult {
  try {
    decodeFrame(encodeFrame(offer));
    return { pass: true, gate: "offer-parses" };
  } catch (error) {
    return {
      pass: false,
      gate: "offer-parses",
      reason: error instanceof Error ? error.message : "offer failed round-trip decode",
    };
  }
}

/**
 * Gate 2: Offer ID recomputes correctly.
 */
export function gateOfferIdRecomputes(offer: OfferFrame): GateResult {
  try {
    const { id: _id, ...fields } = offer;
    const expected = offerId(fields as unknown as OfferFrame);
    if (offer.id !== expected) {
      return { pass: false, gate: "offer-id-recomputes", reason: `expected ${expected}, got ${offer.id}` };
    }
    return { pass: true, gate: "offer-id-recomputes" };
  } catch (error) {
    return { pass: false, gate: "offer-id-recomputes", reason: error instanceof Error ? error.message : "unknown" };
  }
}

/**
 * Gate 3: offer.from == our payer DID.
 */
export function gateOfferFromIsOurs(offer: OfferFrame, ourDID: string): GateResult {
  if (offer.from !== ourDID) {
    return { pass: false, gate: "offer-from-is-ours", reason: `offer.from=${offer.from} ≠ our=${ourDID}` };
  }
  return { pass: true, gate: "offer-from-is-ours" };
}

/**
 * Gate 4: offer.role == payer.
 */
export function gateOfferRoleIsPayer(offer: OfferFrame): GateResult {
  if (offer.role !== "payer") {
    return { pass: false, gate: "offer-role-is-payer", reason: `role=${offer.role}` };
  }
  return { pass: true, gate: "offer-role-is-payer" };
}

/**
 * Gate 5: offer.rails contains canonical "paper".
 */
export function gateOfferHasPaper(offer: OfferFrame): GateResult {
  if (!offer.rails.includes("paper")) {
    return { pass: false, gate: "offer-has-paper", reason: `rails=${JSON.stringify(offer.rails)}` };
  }
  return { pass: true, gate: "offer-has-paper" };
}

/**
 * Gate 6: offer has not expired at accept timestamp.
 */
export function gateOfferNotExpired(offer: OfferFrame, acceptTimestampMs: number): GateResult {
  if (acceptTimestampMs >= offer.expiresMs) {
    return {
      pass: false,
      gate: "offer-not-expired",
      reason: `accept at ${acceptTimestampMs} ≥ expiresMs ${offer.expiresMs}`,
    };
  }
  return { pass: true, gate: "offer-not-expired" };
}

/**
 * Gate 7: Accept transport signature is valid.
 */
export function gateAcceptSignatureValid(acceptRecord: TranscriptRecord): GateResult {
  const result = verifyTranscriptRecord(acceptRecord);
  if (!result.ok) {
    return { pass: false, gate: "accept-signature-valid", reason: result.reason };
  }
  return { pass: true, gate: "accept-signature-valid" };
}

/**
 * Gate 8: accept.from != our DID.
 */
export function gateAcceptFromNotOurs(accept: AcceptFrame, ourDID: string): GateResult {
  if (accept.from === ourDID) {
    return { pass: false, gate: "accept-from-not-ours", reason: "self-accept" };
  }
  return { pass: true, gate: "accept-from-not-ours" };
}

/**
 * Gate 9: accept.ref == frozen offer ID.
 */
export function gateAcceptRefMatchesOffer(accept: AcceptFrame, offer: OfferFrame): GateResult {
  if (accept.ref !== offer.id) {
    return { pass: false, gate: "accept-ref-matches-offer", reason: `ref=${accept.ref} ≠ offer.id=${offer.id}` };
  }
  return { pass: true, gate: "accept-ref-matches-offer" };
}

/**
 * Gate 10: accept contractId recomputes correctly.
 */
export function gateContractIdRecomputes(accept: AcceptFrame, offer: OfferFrame): GateResult {
  const core = {
    from: accept.from,
    ref: accept.ref,
    statement: accept.statement,
    paymentKey: accept.paymentKey,
    nonce: accept.nonce,
  };
  const expected = contractId(offer, core);
  if (accept.contract !== expected) {
    return { pass: false, gate: "contract-id-recomputes", reason: `expected ${expected}, got ${accept.contract}` };
  }
  return { pass: true, gate: "contract-id-recomputes" };
}

/**
 * Gate 11: Accepted statement fits offer lock kind.
 */
export function gateStatementFitsLock(accept: AcceptFrame, offer: OfferFrame): GateResult {
  if (!isValidStatement(offer.lock, accept.statement)) {
    return {
      pass: false,
      gate: "statement-fits-lock",
      reason: `statement does not fit a ${offer.lock} lock`,
    };
  }
  return { pass: true, gate: "statement-fits-lock" };
}

/**
 * Gate 12: Candidate accept is an independent DID (not ours).
 * Same as gate 8, included for completeness per the spec.
 */
export function gateAcceptIsIndependent(accept: AcceptFrame, ourDID: string): GateResult {
  if (accept.from === ourDID) {
    return { pass: false, gate: "accept-is-independent", reason: "acceptor is our DID" };
  }
  if (!DID_RE.test(accept.from)) {
    return { pass: false, gate: "accept-is-independent", reason: `malformed DID: ${accept.from}` };
  }
  return { pass: true, gate: "accept-is-independent" };
}

/**
 * Gate 13: No existing valid lock for another selected accept.
 * This checks the state machine — if we already have a locked state,
 * we cannot lock again.
 */
export function gateNoExistingLock(state: ContractState): GateResult {
  if (state.status === "locked" || state.status === "claimed" || state.status === "refunded") {
    return {
      pass: false,
      gate: "no-existing-lock",
      reason: `contract already in status ${state.status}`,
    };
  }
  return { pass: true, gate: "no-existing-lock" };
}

/**
 * Gate 14: current time < refundAfterMs.
 */
export function gateRefundWindowNotOpen(offer: OfferFrame, nowMs: number): GateResult {
  if (nowMs >= offer.refundAfterMs) {
    return {
      pass: false,
      gate: "refund-window-not-open",
      reason: `now=${nowMs} ≥ refundAfterMs=${offer.refundAfterMs}`,
    };
  }
  return { pass: true, gate: "refund-window-not-open" };
}

/**
 * Gate 15: Deal room derives exactly from contract ID.
 */
export function gateDealRoomDerivation(contract: string): GateResult {
  try {
    const room = dealRoom(contract);
    if (!room.startsWith("mb-p-tclk-") || room.length !== 26) {
      return { pass: false, gate: "deal-room-derivation", reason: `unexpected room shape: ${room}` };
    }
    return { pass: true, gate: "deal-room-derivation" };
  } catch (error) {
    return { pass: false, gate: "deal-room-derivation", reason: error instanceof Error ? error.message : "unknown" };
  }
}

/**
 * Gate 16: No reveal/refund/cancel/terminal conflict already exists.
 */
export function gateNoTerminalConflict(state: ContractState): GateResult {
  if (state.status === "claimed" || state.status === "refunded" || state.status === "cancelled") {
    return {
      pass: false,
      gate: "no-terminal-conflict",
      reason: `contract in terminal status ${state.status}`,
    };
  }
  return { pass: true, gate: "no-terminal-conflict" };
}

// ── Gate runner ──────────────────────────────────────────────────────────────

/**
 * Run all 16 pre-lock gates against a candidate accept.
 * Returns the full gate result set. If any gate fails, the pipeline stops.
 */
export function runPreLockGates(
  offer: OfferFrame,
  accept: AcceptFrame,
  acceptRecord: TranscriptRecord,
  ourDID: string,
  nowMs: number,
  state: ContractState,
): GateResultSet {
  return [
    gateOfferParses(offer),
    gateOfferIdRecomputes(offer),
    gateOfferFromIsOurs(offer, ourDID),
    gateOfferRoleIsPayer(offer),
    gateOfferHasPaper(offer),
    gateOfferNotExpired(offer, acceptRecord.timestampMs),
    gateAcceptSignatureValid(acceptRecord),
    gateAcceptFromNotOurs(accept, ourDID),
    gateAcceptRefMatchesOffer(accept, offer),
    gateContractIdRecomputes(accept, offer),
    gateStatementFitsLock(accept, offer),
    gateAcceptIsIndependent(accept, ourDID),
    gateNoExistingLock(state),
    gateRefundWindowNotOpen(offer, nowMs),
    gateDealRoomDerivation(accept.contract),
    gateNoTerminalConflict(state),
  ];
}

/**
 * Check if all gates pass.
 */
export function allGatesPass(results: GateResultSet): boolean {
  return results.every((r) => r.pass);
}

/**
 * Get the failing gate, if any.
 */
export function firstFailure(results: GateResultSet): GateResult | undefined {
  return results.find((r) => !r.pass);
}
