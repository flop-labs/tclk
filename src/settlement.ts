// SPDX-License-Identifier: Apache-2.0
//
// tclk/1 settlement view: what a consumer may read as MONEY state.
//
// `TclkStatus` is coordination state. A payer-signed `lock` moves a contract to `locked`, a
// `reveal` moves it to `claimed`, a `refund` to `refunded`, and no rail is consulted on the
// way. That is right for the machine, which tracks what the signed transcript establishes.
// It is the wrong answer to "did money move", because a signed assertion is not rail
// evidence: a room can carry a reveal and a receipt for a contract nobody ever funded, and
// a deal room can be filled with well-formed frames by someone who is not a party.
//
// The view is local and derived. It is not a wire object: it adds no frame and no field,
// and it changes the fold of no transcript. It combines a folded `ContractState` with what
// a rail reports for that contract's own `rail` and `railRef`, and it asserts `funded`,
// `claimed` or `refunded` only with that report attached. The rail is the source of truth
// for value (SPEC §1), so where room and rail disagree the rail wins, and the view says
// that they disagreed instead of picking silently.

import type { ContractState, TclkStatus } from "./machine.js";
import {
  type RailObservation,
  type RailObserver,
  type SettlementRail,
  lockTerms,
} from "./rail.js";
import { normalizeRailId } from "./rails.js";

/** One reading of one rail, supplied by whoever asked it. */
export interface RailEvidence {
  /** Id of the rail that was asked. Counts only if it names the contract's own rail. */
  rail: string;
  /** The ref that was read. Counts only if it equals the contract's `railRef`. */
  ref: string;
  observation: RailObservation;
}

/**
 * - `none`: no lock has been announced, so there is no money state to speak of.
 * - `unverified`: the room asserts a lock, a claim or a refund, and no rail has confirmed or
 *   denied it (nobody asked, the wrong rail was asked, or the rail could not say).
 * - `unfunded`: the rail was asked and holds nothing under these terms at the announced ref.
 * - `funded` | `claimed` | `refunded`: the rail holds a lock under exactly these terms, in
 *   that state. These three are the only values that carry rail evidence.
 */
export type MoneyState = "none" | "unverified" | "unfunded" | "funded" | "claimed" | "refunded";

export interface SettlementView {
  /** What the signed transcript establishes. Coordination state, never money state. */
  coordination: TclkStatus;
  /** What the rail establishes. See `MoneyState`. */
  money: MoneyState;
  /**
   * False when the contract's rail is a registered rehearsal rail (`paper`, `memory`): the
   * lifecycle is real, the value is not. An id the registry does not know counts as
   * value-bearing, so that an unknown rail is held to the evidence standard, not excused.
   * False as well while no rail has been chosen.
   */
  valueBacked: boolean;
  /**
   * The room carries a secret that opens the statement. That the payee accepted payment,
   * not that a rail paid: the witness can be public while the claim is still unmined, or
   * while the payer's refund has already won.
   */
  witnessKnown: boolean;
  /**
   * Room and rail contradict each other: the room says `claimed` and the rail refunded (or
   * the reverse), or the room announces a lock the rail does not hold. `money` follows the
   * rail either way. A room that is merely behind the rail, or ahead of it, is not divergence.
   */
  diverged: boolean;
  /** One short sentence on why `money` is what it is, for logs and audits. */
  reason: string;
}

const REHEARSAL_RAILS: ReadonlySet<string> = new Set(["memory", "paper"]);

function canonicalOrNull(rail: string): string | null {
  try {
    return normalizeRailId(rail);
  } catch {
    return null;
  }
}

/** Same rule the machine applies at `lock`: exact spelling, or the same registered id. */
function sameRail(left: string, right: string): boolean {
  if (left === right) return true;
  const canonical = canonicalOrNull(left);
  return canonical !== null && canonical === canonicalOrNull(right);
}

function movesValue(rail: string): boolean {
  const canonical = canonicalOrNull(rail);
  return canonical === null || !REHEARSAL_RAILS.has(canonical);
}

/**
 * Derive the settlement view of a contract. Pure and total: never throws, and with no
 * evidence, or evidence it cannot bind to this contract, it reports `unverified` rather
 * than guessing in either direction.
 */
export function settlementView(state: ContractState, evidence?: RailEvidence): SettlementView {
  const coordination = state.status;
  const witnessKnown = state.secret !== undefined;

  if (state.rail === undefined || state.railRef === undefined) {
    return {
      coordination,
      money: "none",
      valueBacked: false,
      witnessKnown,
      diverged: false,
      reason: "no lock has been announced",
    };
  }

  const valueBacked = movesValue(state.rail);
  const view = (money: MoneyState, diverged: boolean, reason: string): SettlementView => ({
    coordination,
    money,
    valueBacked,
    witnessKnown,
    diverged,
    reason,
  });

  if (evidence === undefined) return view("unverified", false, "the rail was not consulted");
  if (!sameRail(evidence.rail, state.rail) || evidence.ref !== state.railRef) {
    return view("unverified", false, "the evidence names a different rail or ref");
  }

  switch (evidence.observation) {
    case "locked":
      return view("funded", false, "the rail holds a live lock under these terms");
    case "claimed":
      return view(
        "claimed",
        coordination === "refunded",
        coordination === "refunded"
          ? "the rail paid the payee although the room says refunded"
          : "the rail paid the payee",
      );
    case "refunded":
      return view(
        "refunded",
        coordination === "claimed",
        coordination === "claimed"
          ? "the rail returned the funds although the room says claimed"
          : "the rail returned the funds",
      );
    case "absent":
      return view("unfunded", true, "the rail holds nothing at the announced ref");
    case "mismatch":
      return view("unfunded", true, "the rail holds something at the ref, under other terms");
    default:
      // "unknown", and anything a hand-written rail returns that is not an observation.
      return view("unverified", false, "the rail could not say");
  }
}

/**
 * Ask a rail and derive the view in one step. A rail that implements `RailObserver` is
 * asked for the full observation. A rail that only has `verifyLock` can confirm a live
 * lock and nothing else: `false` there also means claimed, refunded or never funded, so it
 * maps to `unknown`, not to `absent`. A rail that throws establishes nothing.
 *
 * The rail is only asked when it is the contract's own rail. Asking another one would
 * produce an observation that means nothing for this contract.
 *
 * A `"locked"` from `observe` is checked against `verifyLock` before it counts. The two are
 * required to agree (see `RailObserver`); a rail where they do not has contradicted itself
 * about these terms, and a contradiction establishes nothing, so the view stays `unverified`
 * instead of reading `funded` out of the weaker of two answers.
 */
export async function observeSettlement(
  state: ContractState,
  rail: SettlementRail & Partial<RailObserver>,
): Promise<SettlementView> {
  if (state.rail === undefined || state.railRef === undefined) return settlementView(state);
  const ref = state.railRef;
  if (!sameRail(rail.id, state.rail)) {
    return settlementView(state, { rail: rail.id, ref, observation: "unknown" });
  }

  let observation: RailObservation;
  try {
    const terms = lockTerms(state);
    if (typeof rail.observe === "function") {
      observation = await rail.observe(terms, ref);
      if (observation === "locked" && !(await rail.verifyLock(terms, ref))) {
        observation = "unknown";
      }
    } else {
      observation = (await rail.verifyLock(terms, ref)) ? "locked" : "unknown";
    }
  } catch {
    observation = "unknown";
  }
  return settlementView(state, { rail: rail.id, ref, observation });
}
