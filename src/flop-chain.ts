// SPDX-License-Identifier: Apache-2.0
//
// The chain surface the `flop-htlc` rail is written against.
//
// The FLOP network's HTLC lives in the `has-station` pallet (yellow paper v0.5.0 §10,
// Appendix G.3: `create_htlc` / `redeem_htlc` / `refund_htlc`). This file names the
// smallest slice of it the rail needs — as an interface, so the library stays free of
// network code, signing code and key material, the same way `PaperRail` takes a
// `NoteStore`. Two implementations ship:
//
// - `MockFlopChain` — in-memory, deterministic, block-stepped. It enforces the §10 state
//   machine (CREATED → SETTLED | REFUNDED, at most one of redeem/refund, hash check,
//   height timelock, redeem and refund both gated on the *finalized* head — R2.2, R10.3)
//   so the rail and its tests can be driven end to end with no network. It holds no value.
// - `FlopRpcChainClient` — a stub that documents the method surface and throws. There is
//   no public FLOP RPC to bind to as of this writing; wiring it is a follow-up that will
//   also have to decide where signing happens (not here: this interface carries no keys).
//
// ⚠️ Nothing in this file has touched a chain. Testnet only; not audited.

import { isHex } from "./hex.js";
import { verifyHashPreimage } from "./locks.js";

/** A block reference: height plus the block's own timestamp (unix ms). 1-second blocks. */
export interface FlopChainHead {
  /** Block height. */
  number: number;
  /** The block's timestamp (pallet_timestamp), unix ms. */
  timestampMs: number;
}

/**
 * Chain parameters the rail's admission check reads (yellow paper Appendix A, §13.0).
 * `currentFinalityLag` is not here on purpose: it is derived from the two heads, never
 * trusted as a separate reading.
 */
export interface FlopHtlcParams {
  /** `htlc_timelock_symmetry_safety_margin_percent` — 20 in v0.5.0. */
  marginPercent: number;
  /** `max_finality_stall`, in blocks — 3_600 in v0.5.0. */
  maxFinalityStallBlocks: number;
}

/**
 * The v0.5.0 (2026-09-05) values of record from yellow paper Appendix A. Named so a caller
 * chooses them explicitly; the rail supplies no default of its own, consistent with
 * `validateDeadlines` ("there is no safe universal default").
 */
export const FLOP_HTLC_PARAMS_V050: Readonly<FlopHtlcParams> = Object.freeze({
  marginPercent: 20,
  maxFinalityStallBlocks: 3_600,
});

export type FlopHtlcStatus = "created" | "settled" | "refunded";

/** One FLOP-leg HTLC as the chain reports it (§10 state machine). */
export interface FlopHtlcRecord {
  id: string;
  payer: string;
  payee: string;
  amount: string;
  asset: string;
  /** `H = SHA256(s)`, 0x-hex, 32 bytes. */
  hash: string;
  /**
   * `T_lock`: redeem is admitted while the *finalized* head is strictly below this height,
   * refund once the finalized head is at/after it (R2.2, R10.3). The tip decides neither.
   */
  timelockBlock: number;
  /** Height at which the escrow was created. */
  createdBlock: number;
  status: FlopHtlcStatus;
  /** Present once settled — public by then, it was the redeem. */
  preimage?: string;
}

export interface FlopCreateHtlc {
  payer: string;
  payee: string;
  amount: string;
  asset: string;
  hash: string;
  timelockBlock: number;
}

/**
 * What the rail needs from a FLOP node. Every method may throw; the rail treats a throw as
 * "not done" and never advances its own view on one.
 */
export interface FlopChainClient {
  /**
   * The best (tip) block. Read only for admission (the R10.2 projection in `lock` /
   * `verifyLock`), never to release funds (R2.2).
   */
  bestHead(): Promise<FlopChainHead>;
  /**
   * The AlephBFT-finalized head. R2.2 / R10.3: redeem and refund are both gated on this,
   * never on the tip, so a finality stall freezes both deadlines (§1.2, §13 F1).
   */
  finalizedHead(): Promise<FlopChainHead>;
  /** Chain parameters for the R10.2 admission check. */
  params(): Promise<FlopHtlcParams>;
  /** `create_htlc` as `payer`. Returns the escrow id. */
  createHtlc(params: FlopCreateHtlc): Promise<string>;
  /** Read one escrow; null when unknown. */
  getHtlc(id: string): Promise<FlopHtlcRecord | null>;
  /** `redeem_htlc(id, s)` as `payee`. */
  redeemHtlc(id: string, preimage: string): Promise<void>;
  /** `refund_htlc(id)` as `payer`. */
  refundHtlc(id: string): Promise<void>;
}

const HASH32 = /^0x[0-9a-f]{64}$/;
const AMOUNT = /^[1-9][0-9]*$/;

/** True iff `head` is a usable block reference. Fail-closed: anything else is not a time. */
export function isValidHead(head: unknown): head is FlopChainHead {
  if (typeof head !== "object" || head === null) return false;
  const { number, timestampMs } = head as { number?: unknown; timestampMs?: unknown };
  return (
    typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number >= 0 &&
    typeof timestampMs === "number" &&
    Number.isSafeInteger(timestampMs) &&
    timestampMs > 0
  );
}

/** True iff `params` are usable for the R10.2 arithmetic. */
export function isValidParams(params: unknown): params is FlopHtlcParams {
  if (typeof params !== "object" || params === null) return false;
  const { marginPercent, maxFinalityStallBlocks } = params as {
    marginPercent?: unknown;
    maxFinalityStallBlocks?: unknown;
  };
  return (
    typeof marginPercent === "number" &&
    Number.isSafeInteger(marginPercent) &&
    marginPercent >= 0 &&
    typeof maxFinalityStallBlocks === "number" &&
    Number.isSafeInteger(maxFinalityStallBlocks) &&
    maxFinalityStallBlocks >= 0
  );
}

/**
 * Deterministic in-memory FLOP chain: one escrow map and two heads. Blocks are 1 s apart
 * (yellow paper §1, §2). `mine(n)` advances the tip; finality follows unless `holdFinality`
 * is set, which is how a finality stall is simulated for the finalized-head gates.
 *
 * It enforces what the pallet enforces (§10 R10.1): create only with a well-formed hash,
 * a positive amount and a timelock in the future; redeem only from `created`, only with
 * `SHA256(s) == H`, only while the finalized head is strictly below `T_lock`; refund only
 * from `created`, only once the finalized head reaches `T_lock`. Both releases read the
 * finalized head, never the tip (R2.2, R10.3), so a finality stall freezes the redeem
 * deadline together with the refund (§1.2, §13 F1). Every violation throws.
 */
export class MockFlopChain implements FlopChainClient {
  private best: number;
  private finalized: number;
  private readonly genesisMs: number;
  private readonly chainParams: FlopHtlcParams;
  private readonly escrows = new Map<string, FlopHtlcRecord>();
  private nextId = 1;
  /** When true, `mine` moves the tip but not the finalized head. */
  holdFinality = false;

  constructor(
    options: { genesisMs?: number; height?: number; params?: FlopHtlcParams } = {},
  ) {
    const { genesisMs = 1_756_700_000_000, height = 0, params = FLOP_HTLC_PARAMS_V050 } =
      options;
    if (!Number.isSafeInteger(genesisMs) || genesisMs <= 0) {
      throw new Error("tclk: mock chain genesis must be a positive unix-ms integer");
    }
    if (!Number.isSafeInteger(height) || height < 0) {
      throw new Error("tclk: mock chain height must be a non-negative integer");
    }
    if (!isValidParams(params)) throw new Error("tclk: mock chain params are malformed");
    this.genesisMs = genesisMs;
    this.best = height;
    this.finalized = height;
    this.chainParams = { ...params };
  }

  /** Advance the tip by `n` blocks; finality follows unless held. */
  mine(n = 1): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("tclk: mine expects a non-negative integer");
    this.best += n;
    if (!this.holdFinality) this.finalized = this.best;
  }

  /** Finalize up to the tip (or to `upTo`, which may not exceed the tip nor go backwards). */
  finalize(upTo: number = this.best): void {
    if (!Number.isSafeInteger(upTo) || upTo < this.finalized || upTo > this.best) {
      throw new Error("tclk: finalize target must lie in [finalized, best]");
    }
    this.finalized = upTo;
  }

  private headAt(number: number): FlopChainHead {
    return { number, timestampMs: this.genesisMs + number * 1000 };
  }

  async bestHead(): Promise<FlopChainHead> {
    return this.headAt(this.best);
  }

  async finalizedHead(): Promise<FlopChainHead> {
    return this.headAt(this.finalized);
  }

  async params(): Promise<FlopHtlcParams> {
    return { ...this.chainParams };
  }

  async createHtlc(params: FlopCreateHtlc): Promise<string> {
    const { payer, payee, amount, asset, hash, timelockBlock } = params;
    if (typeof payer !== "string" || payer === "" || typeof payee !== "string" || payee === "") {
      throw new Error("tclk: create_htlc needs payer and payee accounts");
    }
    if (typeof asset !== "string" || asset === "") throw new Error("tclk: create_htlc needs an asset");
    if (typeof amount !== "string" || !AMOUNT.test(amount)) {
      throw new Error("tclk: create_htlc amount must be a positive decimal string");
    }
    if (typeof hash !== "string" || !HASH32.test(hash)) {
      throw new Error("tclk: create_htlc hash must be a 32-byte 0x-hex sha256 digest");
    }
    if (!Number.isSafeInteger(timelockBlock) || timelockBlock <= this.best) {
      throw new Error("tclk: create_htlc timelock must be a future block height");
    }
    const id = `flop-htlc-mock-${this.nextId++}`;
    this.escrows.set(id, {
      id, payer, payee, amount, asset, hash, timelockBlock,
      createdBlock: this.best, status: "created",
    });
    return id;
  }

  async getHtlc(id: string): Promise<FlopHtlcRecord | null> {
    const held = this.escrows.get(id);
    return held === undefined ? null : { ...held };
  }

  async redeemHtlc(id: string, preimage: string): Promise<void> {
    const held = this.requireCreated(id, "redeem_htlc");
    // R2.2: a fund-releasing action reads the finalized head, never the tip. While finality
    // stalls the tip may pass T_lock; the redeem deadline stays frozen with the refund's.
    if (this.finalized >= held.timelockBlock) {
      throw new Error("tclk: redeem_htlc at/after T_lock on the finalized head");
    }
    if (!isHex(preimage) || preimage.length !== 66) {
      throw new Error("tclk: redeem_htlc preimage must be 32 bytes of 0x-hex");
    }
    if (!verifyHashPreimage(held.hash, preimage)) {
      throw new Error("tclk: redeem_htlc preimage does not hash to H");
    }
    this.escrows.set(id, { ...held, status: "settled", preimage: preimage.toLowerCase() });
  }

  async refundHtlc(id: string): Promise<void> {
    const held = this.requireCreated(id, "refund_htlc");
    // R10.3: the finalized head, never the tip.
    if (this.finalized < held.timelockBlock) {
      throw new Error("tclk: refund_htlc before T_lock is finalized");
    }
    this.escrows.set(id, { ...held, status: "refunded" });
  }

  private requireCreated(id: string, op: string): FlopHtlcRecord {
    const held = this.escrows.get(id);
    if (!held) throw new Error(`tclk: ${op} on an unknown escrow`);
    if (held.status !== "created") throw new Error(`tclk: ${op} on a ${held.status} escrow`);
    return held;
  }
}

/**
 * The shape of a real client, with nothing behind it. Every method throws until a public
 * FLOP RPC exists to bind; see examples/flop-htlc-rail-design.md for what each one will
 * have to do. It takes an endpoint and no key material: signing `create_htlc` /
 * `redeem_htlc` / `refund_htlc` belongs to whatever wallet owns the account, outside this
 * library, the same rule the MCP server follows.
 */
export class FlopRpcChainClient implements FlopChainClient {
  readonly endpoint: string;

  constructor(endpoint: string) {
    if (typeof endpoint !== "string" || endpoint === "") {
      throw new Error("tclk: FlopRpcChainClient needs an endpoint URL");
    }
    this.endpoint = endpoint;
  }

  private unwired(method: string): never {
    throw new Error(
      `tclk: FlopRpcChainClient.${method} is not wired — no public FLOP HTLC RPC yet ` +
        "(yellow paper Appendix G.3 has-station create/redeem/refund_htlc)",
    );
  }

  // TODO(testnet RPC): chain_getHeader(best) + timestamp.now → { number, timestampMs }.
  async bestHead(): Promise<FlopChainHead> {
    return this.unwired("bestHead");
  }
  // TODO(testnet RPC): chain_getFinalizedHead → header → { number, timestampMs }.
  async finalizedHead(): Promise<FlopChainHead> {
    return this.unwired("finalizedHead");
  }
  // TODO(testnet RPC): read htlc_timelock_symmetry_safety_margin_percent and
  // max_finality_stall from runtime constants; refuse to fall back to a hard-coded value.
  async params(): Promise<FlopHtlcParams> {
    return this.unwired("params");
  }
  // TODO(testnet RPC): submit has-station.create_htlc signed by the payer's wallet; return
  // the escrow id from the emitted event. Signing happens outside this class.
  async createHtlc(_params: FlopCreateHtlc): Promise<string> {
    return this.unwired("createHtlc");
  }
  // TODO(testnet RPC): storage read of the escrow by id, mapped onto FlopHtlcRecord.
  async getHtlc(_id: string): Promise<FlopHtlcRecord | null> {
    return this.unwired("getHtlc");
  }
  // TODO(testnet RPC): submit has-station.redeem_htlc(id, s) signed by the payee's wallet,
  // only while finalizedHead().number < T_lock (R2.2).
  async redeemHtlc(_id: string, _preimage: string): Promise<void> {
    return this.unwired("redeemHtlc");
  }
  // TODO(testnet RPC): submit has-station.refund_htlc(id) signed by the payer's wallet,
  // only after finalizedHead().number >= T_lock (R10.3).
  async refundHtlc(_id: string): Promise<void> {
    return this.unwired("refundHtlc");
  }
}
