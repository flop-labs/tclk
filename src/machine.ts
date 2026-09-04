// SPDX-License-Identifier: Apache-2.0
//
// tclk/1 contract state machine. Pure and fail-closed: `applyFrame` never throws on
// a bad frame and never mutates its input — an invalid transition returns the same
// state with `ok: false` and a reason, so a polling loop can feed it every line of a
// world-writable room (replays, duplicates, hostile frames) and money-state only
// advances on frames that verify. The machine tracks what the signed transcript
// establishes; the settlement rail enforces the same predicates independently.
//
// proposed ─accept→ accepted ─lock→ locked ─reveal(ref)→ claimed | ─refund(ref)→ refunded
// proposed|accepted ─cancel→ cancelled; accepted|locked ─heartbeat→ unchanged

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
import { normalizeRailId } from "./rails.js";

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

function tclk1OfferIncludesRail(offered: readonly string[], selected: string): boolean {
  if (offered.includes(selected)) return true;
  let target: string;
  try {
    target = normalizeRailId(selected);
  } catch {
    return false;
  }
  return offered.some((rail) => {
    try {
      return normalizeRailId(rail) === target;
    } catch {
      return false;
    }
  });
}

/**
 * Apply one frame at wall-clock `nowMs`. Clock and structural validation run first
 * (bad input is rejected, not thrown on); then the transition guards.
 */
export function applyFrame(state: ContractState, frame: TclkFrame, nowMs: number): StepResult {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    return reject(state, "tclk: nowMs must be a finite non-negative number");
  }

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
      if (nowMs >= state.offer.refundAfterMs) return reject(state, "refund window is already open");
      // Registered ids compare canonically. Historical custom ids retain the exact
      // membership rule they had before the registry, without poisoning known matches
      // when a legacy offer contains both kinds.
      if (!tclk1OfferIncludesRail(state.offer.rails, frame.rail)) {
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
      if (frame.ref !== undefined && frame.ref !== state.railRef) {
        return reject(state, "reveal names a different rail ref");
      }
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
      if (frame.ref !== undefined && frame.ref !== state.railRef) {
        return reject(state, "refund names a different rail ref");
      }
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
      if (frame.rail !== undefined && state.rail !== undefined && frame.rail !== state.rail) {
        return reject(state, `receipt rail ${frame.rail} does not match contract rail ${state.rail}`);
      }
      if (frame.ref !== undefined && state.railRef !== undefined && frame.ref !== state.railRef) {
        return reject(state, "receipt ref does not match contract railRef");
      }
      if (state.status === "cancelled" && (frame.rail !== undefined || frame.ref !== undefined)) {
        return reject(state, "receipt on cancelled contract cannot name a settlement rail");
      }
      return { ok: true, state };
    }

    case "heartbeat": {
      if (state.status !== "accepted" && state.status !== "locked") {
        return reject(state, `heartbeat in status ${state.status}`);
      }
      if (frame.contract !== state.contract) {
        return reject(state, "heartbeat names a different contract");
      }
      if (!isParty(state, frame.from)) return reject(state, "heartbeat from a non-party");
      return { ok: true, state };
    }
  }
}

// ── Derived funding actionability ─────────────────────────────────────────────

/**
 * Why funding is or is not still actionable. One bucket per distinguishable outcome, so a funnel
 * can separate "locked", "explicitly cancelled", "the window shut and nothing arrived" and "still
 * open, merely unobserved" — the four an accepted-but-unlocked contract gets confused between.
 */
export type FundingOutlookCode =
  | "awaiting-accept"
  | "offer-expired"
  | "open"
  | "lapsed"
  | "funded"
  | "settled"
  | "cancelled"
  | "unreadable-clock";

export interface FundingOutlook {
  /** True only while a `lock` frame would still be accepted at `nowMs`. */
  actionable: boolean;
  code: FundingOutlookCode;
  /** Milliseconds until funding stops being actionable, 0 once it has. */
  msRemaining: number;
  reason: string;
}

/**
 * Whether the signed transcript plus a clock still leave room to fund this contract.
 *
 * Derived, never signed and never stored. An accepted contract's *status* can sit at `accepted`
 * forever, which is what makes an abandonment look like a party being briefly offline, but
 * funding itself already has a deterministic upper bound: `applyFrame` refuses a `lock` once
 * `nowMs >= offer.refundAfterMs`, and `refundAfterMs` is in the offer and committed by
 * `contractId` before either party signs anything. So the deadline exists, is agreed, and needs
 * no new field or frame — it was simply never exposed, so nothing could report it (#41).
 *
 * The boundary here is read off the same comparison the transition guard uses; a test pins the
 * two together over a sweep of clocks so they cannot drift apart.
 *
 * No safety margin is applied. A margin is rail-specific — how long a rail takes to accept a
 * lock, and how much slack a payee wants before `claimByMs` — so it belongs to the caller, which
 * is why `msRemaining` is reported rather than a bare boolean. `claimByMs` is deliberately not a
 * boundary: no transition guard reads it, and SPEC §3.1 calls it the payee's *safe* claim
 * deadline, a margin rather than a cliff.
 */
export function fundingOutlook(state: ContractState, nowMs: number): FundingOutlook {
  // Fail closed on a clock the machine itself would refuse, rather than answering from NaN —
  // every comparison below would be false in both directions.
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    return {
      actionable: false,
      code: "unreadable-clock",
      msRemaining: 0,
      reason: "tclk: nowMs must be a finite non-negative number",
    };
  }

  const { expiresMs, refundAfterMs } = state.offer;
  const closed = (code: FundingOutlookCode, reason: string): FundingOutlook => ({
    actionable: false,
    code,
    msRemaining: 0,
    reason,
  });

  switch (state.status) {
    case "cancelled":
      return closed("cancelled", "contract was cancelled");
    case "claimed":
    case "refunded":
      return closed("settled", `contract is ${state.status}`);
    case "locked":
      return closed("funded", "contract is already funded");

    case "proposed": {
      // Two barriers in the order the machine hits them: accept is refused at `expiresMs`, and a
      // lock is refused at `refundAfterMs` however the accept went. An offer may order those two
      // either way — nothing requires `expiresMs < refundAfterMs` — so both are checked.
      if (nowMs >= expiresMs) return closed("offer-expired", "offer expired unaccepted");
      if (nowMs >= refundAfterMs) {
        return closed("lapsed", "refund window opened before the offer was accepted");
      }
      return {
        actionable: true,
        code: "awaiting-accept",
        msRemaining: Math.min(expiresMs, refundAfterMs) - nowMs,
        reason: "offer is open and a lock would still be accepted",
      };
    }

    case "accepted": {
      if (nowMs >= refundAfterMs) {
        return closed("lapsed", "refund window opened with no lock on the contract");
      }
      return {
        actionable: true,
        code: "open",
        msRemaining: refundAfterMs - nowMs,
        reason: "accepted and a lock would still be accepted",
      };
    }
  }
}
