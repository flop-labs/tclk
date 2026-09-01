// SPDX-License-Identifier: Apache-2.0
//
// tclk/1 contract state machine. Pure and fail-closed: `applyFrame` never throws on
// a bad frame and never mutates its input — an invalid transition returns the same
// state with `ok: false` and a reason, so a polling loop can feed it every line of a
// world-writable room (replays, duplicates, hostile frames) and money-state only
// advances on frames that verify. The machine tracks what the signed transcript
// establishes; the settlement rail enforces the same predicates independently.
//
// proposed ─accept→ accepted ─lock→ locked ─reveal→ claimed | ─refund→ refunded
// proposed|accepted ─cancel→ cancelled

import {
  type AcceptFrame,
  type OfferFrame,
  type PresigRef,
  type TclkFrame,
  contractId,
  isValidStatement,
  validateFrame,
} from "./frames.js";
import { verifySecret } from "./locks.js";

export type TclkStatus = "proposed" | "accepted" | "locked" | "claimed" | "refunded" | "cancelled";

export const TCLK_TERMINAL_STATUSES: ReadonlySet<TclkStatus> = new Set([
  "claimed",
  "refunded",
  "cancelled",
]);

export interface ContractState {
  status: TclkStatus;
  offer: OfferFrame;
  /** Known from the offer when role is payer, else filled at accept. */
  payerDid?: string;
  payeeDid?: string;
  payerKey?: string;
  payeeKey?: string;
  /** Set at accept. */
  contract?: string;
  statement?: string;
  /** Set at lock. */
  rail?: string;
  railRef?: string;
  presig?: PresigRef;
  /** Set at claim (the revealed preimage/witness). */
  secret?: string;
}

export interface StepResult {
  state: ContractState;
  ok: boolean;
  reason?: string;
}

/** Open the local view of a contract from a validated offer. Throws on a bad offer. */
export function openContract(offer: OfferFrame): ContractState {
  validateFrame(offer);
  return {
    status: "proposed",
    offer,
    payerDid: offer.role === "payer" ? offer.from : undefined,
    payeeDid: offer.role === "payee" ? offer.from : undefined,
    payerKey: offer.role === "payer" ? offer.paymentKey : undefined,
    payeeKey: offer.role === "payee" ? offer.paymentKey : undefined,
  };
}

function reject(state: ContractState, reason: string): StepResult {
  return { state, ok: false, reason };
}

function isParty(state: ContractState, did: string): boolean {
  return did === state.offer.from || did === state.payerDid || did === state.payeeDid;
}

/**
 * Apply one frame at wall-clock `nowMs`. Structural validation runs first (a frame
 * that fails it is rejected, not thrown on); then the transition guards.
 */
export function applyFrame(state: ContractState, frame: TclkFrame, nowMs: number): StepResult {
  try {
    validateFrame(frame);
  } catch (error) {
    return reject(state, error instanceof Error ? error.message : "invalid frame");
  }

  switch (frame.type) {
    case "offer":
      return reject(state, "contract is already open");

    case "accept": {
      const accept = frame as AcceptFrame;
      if (state.status !== "proposed") return reject(state, `accept in status ${state.status}`);
      if (accept.ref !== state.offer.id) return reject(state, "accept.ref names a different offer");
      if (accept.from === state.offer.from) return reject(state, "cannot accept own offer");
      if (nowMs >= state.offer.expiresMs) return reject(state, "offer has expired");
      const expected = contractId(state.offer, {
        from: accept.from,
        ref: accept.ref,
        statement: accept.statement,
        paymentKey: accept.paymentKey,
        nonce: accept.nonce,
      });
      if (accept.contract !== expected) return reject(state, "contract id mismatch");
      if (state.offer.lock === "point" && accept.paymentKey === undefined) {
        return reject(state, "point locks require the acceptor's paymentKey");
      }
      // Statement/lock-kind fit is enforced by makeAccept on the sender; re-check here
      // so a hand-built accept cannot slip a 32-byte "point" through.
      if (!isValidStatement(state.offer.lock, accept.statement)) {
        return reject(state, `statement does not fit a ${state.offer.lock} lock`);
      }
      const acceptorIsPayer = state.offer.role === "payee";
      return {
        ok: true,
        state: {
          ...state,
          status: "accepted",
          contract: accept.contract,
          statement: accept.statement,
          payerDid: acceptorIsPayer ? accept.from : state.payerDid,
          payeeDid: acceptorIsPayer ? state.payeeDid : accept.from,
          payerKey: acceptorIsPayer ? accept.paymentKey : state.payerKey,
          payeeKey: acceptorIsPayer ? state.payeeKey : accept.paymentKey,
        },
      };
    }

    case "lock": {
      if (state.status !== "accepted") return reject(state, `lock in status ${state.status}`);
      if (frame.contract !== state.contract) return reject(state, "lock names a different contract");
      if (frame.from !== state.payerDid) return reject(state, "only the payer locks");
      if (!state.offer.rails.includes(frame.rail)) {
        return reject(state, `rail ${frame.rail} was not offered`);
      }
      return {
        ok: true,
        state: { ...state, status: "locked", rail: frame.rail, railRef: frame.ref, presig: frame.presig },
      };
    }

    case "reveal": {
      if (state.status !== "locked") return reject(state, `reveal in status ${state.status}`);
      if (frame.contract !== state.contract) return reject(state, "reveal names a different contract");
      if (frame.from !== state.payeeDid) return reject(state, "only the payee reveals");
      if (nowMs >= state.offer.refundAfterMs) return reject(state, "refund window is open");
      if (!verifySecret(state.offer.lock, state.statement!, frame.secret)) {
        return reject(state, "secret does not open the statement");
      }
      return { ok: true, state: { ...state, status: "claimed", secret: frame.secret } };
    }

    case "refund": {
      if (state.status !== "locked") return reject(state, `refund in status ${state.status}`);
      if (frame.contract !== state.contract) return reject(state, "refund names a different contract");
      if (frame.from !== state.payerDid) return reject(state, "only the payer refunds");
      if (nowMs < state.offer.refundAfterMs) return reject(state, "refund window not open yet");
      return { ok: true, state: { ...state, status: "refunded" } };
    }

    case "cancel": {
      if (state.status !== "proposed" && state.status !== "accepted") {
        return reject(state, `cancel in status ${state.status}`);
      }
      if (state.status === "accepted" && frame.contract !== state.contract) {
        return reject(state, "cancel names a different contract");
      }
      if (!isParty(state, frame.from)) return reject(state, "cancel from a non-party");
      return { ok: true, state: { ...state, status: "cancelled" } };
    }

    case "receipt": {
      // Post-terminal acknowledgment; never a transition.
      if (!TCLK_TERMINAL_STATUSES.has(state.status)) {
        return reject(state, "receipt before a terminal status");
      }
      if (frame.contract !== state.contract) return reject(state, "receipt names a different contract");
      if (!isParty(state, frame.from)) return reject(state, "receipt from a non-party");
      if (frame.outcome !== state.status) {
        return reject(state, `receipt outcome ${frame.outcome} does not match ${state.status}`);
      }
      return { ok: true, state };
    }
  }
}
