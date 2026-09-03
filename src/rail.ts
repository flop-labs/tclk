// SPDX-License-Identifier: Apache-2.0
//
// tclk/1 settlement-rail interface: anything that can hold `amount` of `asset` under
// the contract's statement and deadlines. The rail is the source of truth for value;
// tclk frames only coordinate. `MemoryRail` is the reference implementation — the
// executable spec of the predicates a real rail (has-station escrow, x402, EVM/NEAR
// HTLC contracts) must enforce, and what the end-to-end tests drive.

import type { ContractState } from "./machine.js";
import type { LockKind } from "./frames.js";
import { canonicalJson } from "./frames.js";
import { verifySecret } from "./locks.js";
import type { CanonicalRailId } from "./rails.js";

/** The rail-facing projection of an accepted contract. */
export interface LockTerms {
  contract: string;
  lock: LockKind;
  statement: string;
  amount: string;
  asset: string;
  payer: string;
  payee: string;
  claimByMs: number;
  refundAfterMs: number;
}

/** Project an accepted (or later) contract state onto its rail terms. Throws before accept. */
export function lockTerms(state: ContractState): LockTerms {
  if (!state.contract || !state.statement || !state.payerDid || !state.payeeDid) {
    throw new Error(`tclk: contract is not accepted yet (status ${state.status})`);
  }
  return {
    contract: state.contract,
    lock: state.offer.lock,
    statement: state.statement,
    amount: state.offer.amount,
    asset: state.offer.asset,
    payer: state.payerDid,
    payee: state.payeeDid,
    claimByMs: state.offer.claimByMs,
    refundAfterMs: state.offer.refundAfterMs,
  };
}

export interface SettlementRail {
  /** Rail id as advertised in `offer.rails` (e.g. "flop-htlc", "x402"). */
  readonly id: CanonicalRailId;
  /** Escrow the funds under the terms; returns the rail-specific reference. */
  lock(terms: LockTerms): Promise<string>;
  /** True iff `ref` holds a live lock matching `terms` exactly. Fail-closed. */
  verifyLock(terms: LockTerms, ref: string): Promise<boolean>;
  /** Release to the payee — only with the secret that opens the statement. */
  claim(ref: string, secret: string): Promise<void>;
  /** Return to the payer — only at/after refundAfterMs. */
  refund(ref: string): Promise<void>;
}

type MemoryLockStatus = "locked" | "claimed" | "refunded";

interface MemoryLock {
  terms: LockTerms;
  status: MemoryLockStatus;
  secret?: string;
}

/**
 * In-process reference rail. Enforces exactly the predicates every real rail must:
 * one lock per contract, claim only with a verifying secret strictly before
 * refundAfterMs, refund only at/after it, and both only from the "locked" state.
 * All violations throw (fail closed).
 */
export class MemoryRail implements SettlementRail {
  readonly id: CanonicalRailId;
  private readonly locks = new Map<string, MemoryLock>();
  private readonly clock: () => number;

  constructor(id: CanonicalRailId = "memory", clock: () => number = Date.now) {
    this.id = id;
    this.clock = clock;
  }

  async lock(terms: LockTerms): Promise<string> {
    if (this.locks.has(terms.contract)) {
      throw new Error(`tclk: rail already holds a lock for ${terms.contract}`);
    }
    if (this.clock() >= terms.refundAfterMs) {
      throw new Error("tclk: refusing to lock into an already-open refund window");
    }
    this.locks.set(terms.contract, { terms, status: "locked" });
    return terms.contract;
  }

  async verifyLock(terms: LockTerms, ref: string): Promise<boolean> {
    const held = this.locks.get(ref);
    return (
      held !== undefined &&
      held.status === "locked" &&
      canonicalJson(held.terms) === canonicalJson(terms)
    );
  }

  async claim(ref: string, secret: string): Promise<void> {
    const held = this.requireLocked(ref, "claim");
    if (this.clock() >= held.terms.refundAfterMs) {
      throw new Error("tclk: claim after refundAfterMs");
    }
    if (!verifySecret(held.terms.lock, held.terms.statement, secret)) {
      throw new Error("tclk: secret does not open the statement");
    }
    this.locks.set(ref, { ...held, status: "claimed", secret });
  }

  async refund(ref: string): Promise<void> {
    const held = this.requireLocked(ref, "refund");
    if (this.clock() < held.terms.refundAfterMs) {
      throw new Error("tclk: refund before refundAfterMs");
    }
    this.locks.set(ref, { ...held, status: "refunded" });
  }

  /** Test/inspection helper: the rail's view of one lock. */
  status(ref: string): MemoryLockStatus | undefined {
    return this.locks.get(ref)?.status;
  }

  private requireLocked(ref: string, op: string): MemoryLock {
    const held = this.locks.get(ref);
    if (!held) throw new Error(`tclk: ${op} on an unknown lock ${ref}`);
    if (held.status !== "locked") throw new Error(`tclk: ${op} on a ${held.status} lock`);
    return held;
  }
}
