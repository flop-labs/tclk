// SPDX-License-Identifier: Apache-2.0
//
// The `flop-htlc` rail: tclk/1 `SettlementRail` bound to the FLOP network's HTLC
// (yellow paper v0.5.0 §10, has-station `create_htlc` / `redeem_htlc` / `refund_htlc`).
//
// What this file decides, and where each decision comes from
// (long form: examples/flop-htlc-rail-design.md):
//
// - Statement = `H = SHA256(s)`, 32-byte `s` (§10 R10.1) — exactly tclk's hash lock, so the
//   accept frame's statement is the escrow's hash byte-for-byte. Point locks: §10 defines no
//   point predicate, so this rail refuses them rather than guess (SPEC §5 says the escrow has
//   one; that disagreement is flagged in the PR, not papered over here).
// - Deadlines: tclk speaks unix ms, the chain speaks block height with 1 s blocks (§1, §2).
//   `T_lock = best.number + ceil((refundAfterMs - best.timestampMs) / 1000)`, computed from
//   the tip the moment the escrow is created (admission). After that, both fund-releasing
//   actions read the *finalized* head, never the tip (R2.2: every fund-releasing action reads
//   `FinalizedPrefix`; §1.2 / §13 F1: a finality stall freezes economic deadlines; R10.3 for
//   refund): redeem is admitted while `finalized.number < T_lock`, refund once
//   `finalized.number >= T_lock` — the same `<` / `>=` pair `MemoryRail` uses on
//   `refundAfterMs`. One clock decides both, so at any finalized height exactly one of them
//   is admissible (R10.1's "at most one", with no height at which neither is).
// - Admission (R10.2 timelock symmetry): with `T_other` = blocks until `claimByMs`, the
//   escrow's timelock must satisfy
//   `T_FLOP >= T_other + max(ceil(T_other * p / 100), max_finality_stall + current_finality_lag)`.
//   The rail refuses to lock, and `verifyLock` refuses to vouch, when it does not. This is
//   the "rail knows its own T_lock" check issue #132 asked for a home for.
// - Fail closed on every operand: malformed deadlines, heads, params, hashes and amounts
//   throw (or, in `verifyLock`, return false). No default chain parameters: the caller picks
//   `FLOP_HTLC_PARAMS_V050` or reads the runtime constants.
// - No keys, no signing, no network here. `FlopChainClient` is the seam; `MockFlopChain`
//   fills it for tests, `FlopRpcChainClient` names what a live one must do and throws.
//
// ⚠️ Testnet only. Not audited. Has not touched a chain.

import { verifySecret } from "./locks.js";
import type { LockTerms, SettlementRail } from "./rail.js";
import {
  isValidHead,
  isValidParams,
  type FlopChainClient,
  type FlopChainHead,
  type FlopHtlcParams,
  type FlopHtlcRecord,
  type FlopHtlcStatus,
} from "./flop-chain.js";

const HASH32 = /^0x[0-9a-f]{64}$/;
const AMOUNT = /^[1-9][0-9]*$/;

/** Blocks from `head` until wall time `atMs` at one block per second; may be <= 0. */
export function blocksUntil(head: FlopChainHead, atMs: number): number {
  if (!isValidHead(head)) throw new Error("tclk: chain head is not a usable block reference");
  if (!Number.isSafeInteger(atMs) || atMs <= 0) {
    throw new Error("tclk: deadline must be a positive unix-ms integer");
  }
  return Math.ceil((atMs - head.timestampMs) / 1000);
}

/**
 * Yellow paper §10 R10.2, solved for the smallest admissible FLOP timelock:
 * `T_other + max(ceil(T_other * p / 100), max_finality_stall + current_finality_lag)`.
 */
export function timelockSymmetryMinimum(
  tOtherBlocks: number,
  params: FlopHtlcParams,
  currentFinalityLag: number,
): number {
  if (!Number.isSafeInteger(tOtherBlocks) || tOtherBlocks < 0) {
    throw new Error("tclk: T_other must be a non-negative block count");
  }
  if (!isValidParams(params)) throw new Error("tclk: chain params are malformed");
  if (!Number.isSafeInteger(currentFinalityLag) || currentFinalityLag < 0) {
    throw new Error("tclk: finality lag must be a non-negative block count");
  }
  const percentMargin = Math.ceil((tOtherBlocks * params.marginPercent) / 100);
  const finalityMargin = params.maxFinalityStallBlocks + currentFinalityLag;
  return tOtherBlocks + Math.max(percentMargin, finalityMargin);
}

/** The rail's projection of a contract's ms deadlines onto chain heights, with the verdict. */
export interface FlopHtlcTimelock {
  /** Blocks from the tip until `claimByMs` — the counter-leg duration in R10.2's terms. */
  tOther: number;
  /** Blocks from the tip until `refundAfterMs` — the escrow's duration. */
  tFlop: number;
  /** Smallest `tFlop` R10.2 admits, given the params and the observed finality lag. */
  required: number;
  /** `best.number - finalized.number`. */
  finalityLag: number;
  /** Absolute `T_lock` the escrow would be created with. */
  timelockBlock: number;
  /** True iff `tOther >= 1 && tFlop >= required`. */
  ok: boolean;
}

/**
 * Project `terms` onto the chain as seen from `best` / `finalized`. Pure; throws on any
 * operand that is not a time (so a NaN deadline cannot pass as "no constraint").
 */
export function flopHtlcTimelock(
  terms: Pick<LockTerms, "claimByMs" | "refundAfterMs">,
  best: FlopChainHead,
  finalized: FlopChainHead,
  params: FlopHtlcParams,
): FlopHtlcTimelock {
  if (!isValidHead(best) || !isValidHead(finalized)) {
    throw new Error("tclk: chain head is not a usable block reference");
  }
  if (finalized.number > best.number) {
    throw new Error("tclk: finalized head is ahead of the tip");
  }
  if (
    !Number.isSafeInteger(terms.claimByMs) || terms.claimByMs <= 0 ||
    !Number.isSafeInteger(terms.refundAfterMs) || terms.refundAfterMs <= 0
  ) {
    throw new Error("tclk: deadlines must be positive unix-ms integers");
  }
  if (terms.claimByMs >= terms.refundAfterMs) {
    throw new Error("tclk: claimByMs must be strictly before refundAfterMs");
  }
  const finalityLag = best.number - finalized.number;
  const tOther = blocksUntil(best, terms.claimByMs);
  const tFlop = blocksUntil(best, terms.refundAfterMs);
  const required = timelockSymmetryMinimum(Math.max(tOther, 0), params, finalityLag);
  return {
    tOther, tFlop, required, finalityLag,
    timelockBlock: best.number + tFlop,
    ok: tOther >= 1 && tFlop >= required,
  };
}

export interface FlopHtlcRailOptions {
  /** The only asset this escrow holds. Terms naming another asset are refused. */
  asset?: string;
  /** DID → chain account. Default: the DID string itself (fine for the mock, wrong for a chain). */
  resolveAccount?: (did: string) => string | Promise<string>;
}

/**
 * `SettlementRail` for `flop-htlc`. One escrow per `lock`; the returned ref is the chain's
 * escrow id, and goes into the tclk `lock` frame's `ref`.
 */
export class FlopHtlcRail implements SettlementRail {
  readonly id = "flop-htlc";
  private readonly chain: FlopChainClient;
  private readonly asset: string;
  private readonly resolveAccount: (did: string) => string | Promise<string>;

  constructor(chain: FlopChainClient, options: FlopHtlcRailOptions = {}) {
    if (typeof chain !== "object" || chain === null) throw new Error("tclk: FlopHtlcRail needs a chain client");
    const { asset = "FLOP", resolveAccount = (did: string) => did } = options;
    if (typeof asset !== "string" || asset === "") throw new Error("tclk: rail asset must be a non-empty string");
    this.chain = chain;
    this.asset = asset;
    this.resolveAccount = resolveAccount;
  }

  async lock(terms: LockTerms): Promise<string> {
    this.requireHashTerms(terms);
    const [best, finalized, params] = await this.observe();
    const window = flopHtlcTimelock(terms, best, finalized, params);
    if (window.tOther < 1) throw new Error("tclk: claimByMs is not in the future on this chain");
    if (!window.ok) {
      throw new Error(
        `tclk: refund window too short for the FLOP leg (R10.2): ${window.tFlop} blocks ` +
          `offered, ${window.required} required (T_other ${window.tOther}, lag ${window.finalityLag})`,
      );
    }
    const [payer, payee] = await Promise.all([
      this.resolveAccount(terms.payer), this.resolveAccount(terms.payee),
    ]);
    return this.chain.createHtlc({
      payer, payee, amount: terms.amount, asset: terms.asset,
      hash: terms.statement, timelockBlock: window.timelockBlock,
    });
  }

  /**
   * True iff `ref` is a live escrow that matches `terms` and still leaves the R10.2 room
   * a payee needs, measured from the tip *now*. Never throws: any failure is `false`.
   */
  async verifyLock(terms: LockTerms, ref: string): Promise<boolean> {
    try {
      this.requireHashTerms(terms);
      if (typeof ref !== "string" || ref === "") return false;
      const record = await this.chain.getHtlc(ref);
      if (record === null || record.status !== "created") return false;
      const [payer, payee] = await Promise.all([
        this.resolveAccount(terms.payer), this.resolveAccount(terms.payee),
      ]);
      if (
        record.hash !== terms.statement ||
        record.payer !== payer ||
        record.payee !== payee ||
        record.amount !== terms.amount ||
        record.asset !== terms.asset ||
        !Number.isSafeInteger(record.timelockBlock)
      ) {
        return false;
      }
      const [best, finalized, params] = await this.observe();
      const window = flopHtlcTimelock(terms, best, finalized, params);
      if (window.tOther < 1) return false;
      return record.timelockBlock - best.number >= window.required;
    } catch {
      return false;
    }
  }

  async claim(ref: string, secret: string): Promise<void> {
    const record = await this.requireCreated(ref, "claim");
    // R2.2: a redeem releases funds, so it reads the finalized head like refund does, never
    // the tip. A finality stall then freezes the claim deadline instead of letting the tip
    // run it out while the refund is still frozen (§1.2, §13 F1).
    const finalized = await this.chain.finalizedHead();
    if (!isValidHead(finalized)) throw new Error("tclk: chain head is not a usable block reference");
    if (finalized.number >= record.timelockBlock) {
      throw new Error(
        `tclk: claim at/after T_lock on the finalized head ` +
          `(finalized ${finalized.number}, T_lock ${record.timelockBlock})`,
      );
    }
    if (!verifySecret("hash", record.hash, secret)) {
      throw new Error("tclk: secret does not open the statement");
    }
    await this.chain.redeemHtlc(ref, secret);
  }

  async refund(ref: string): Promise<void> {
    const record = await this.requireCreated(ref, "refund");
    const finalized = await this.chain.finalizedHead();
    if (!isValidHead(finalized)) throw new Error("tclk: chain head is not a usable block reference");
    if (finalized.number < record.timelockBlock) {
      throw new Error("tclk: refund before T_lock is finalized");
    }
    await this.chain.refundHtlc(ref);
  }

  /** Inspection helper: the chain's status for one escrow, or undefined when unknown. */
  async status(ref: string): Promise<FlopHtlcStatus | undefined> {
    const record = await this.chain.getHtlc(ref);
    return record?.status;
  }

  private requireHashTerms(terms: LockTerms): void {
    if (terms.lock !== "hash") {
      throw new Error(`tclk: flop-htlc binds hash locks only (yellow paper §10); got ${String(terms.lock)}`);
    }
    if (typeof terms.statement !== "string" || !HASH32.test(terms.statement)) {
      throw new Error("tclk: statement must be a 32-byte 0x-hex sha256 digest");
    }
    if (typeof terms.amount !== "string" || !AMOUNT.test(terms.amount)) {
      throw new Error("tclk: amount must be a positive decimal string");
    }
    if (terms.asset !== this.asset) {
      throw new Error(`tclk: this rail settles ${this.asset}, terms name ${String(terms.asset)}`);
    }
    if (typeof terms.payer !== "string" || terms.payer === "" || typeof terms.payee !== "string" || terms.payee === "") {
      throw new Error("tclk: terms must name payer and payee");
    }
    if (terms.payer === terms.payee) throw new Error("tclk: payer and payee must differ");
  }

  private async observe(): Promise<[FlopChainHead, FlopChainHead, FlopHtlcParams]> {
    const [best, finalized, params] = await Promise.all([
      this.chain.bestHead(), this.chain.finalizedHead(), this.chain.params(),
    ]);
    if (!isValidHead(best) || !isValidHead(finalized)) {
      throw new Error("tclk: chain head is not a usable block reference");
    }
    if (!isValidParams(params)) throw new Error("tclk: chain params are malformed");
    return [best, finalized, params];
  }

  private async requireCreated(ref: string, op: string): Promise<FlopHtlcRecord> {
    if (typeof ref !== "string" || ref === "") throw new Error(`tclk: ${op} needs an escrow id`);
    const record = await this.chain.getHtlc(ref);
    if (record === null) throw new Error(`tclk: ${op} on an unknown escrow`);
    if (record.status !== "created") throw new Error(`tclk: ${op} on a ${record.status} escrow`);
    if (!Number.isSafeInteger(record.timelockBlock)) throw new Error(`tclk: ${op} on an escrow with a malformed timelock`);
    return record;
  }
}
