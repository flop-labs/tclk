// SPDX-License-Identifier: Apache-2.0
import {
  canonicalJson,
  verifyHashPreimage,
  type LockTerms,
  type SettlementRail,
} from "@flop-labs/tclk";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58, base64urlnopad } from "@scure/base";
import {
  HEX32,
  resolveFlopConfig,
  type FlopRailConfig,
  type ResolvedFlopConfig,
  type FlopNetwork,
} from "./config.js";

export interface FlopEscrow {
  id: string;
  funder: string;
  payee: string;
  amount: string;
  policy: { combinator: string; clauses: unknown[] };
  deadline: number;
  createdBlock: number;
  status: string;
}
export interface FlopSnapshot {
  genesis: string;
  hash: string;
  number: number;
  timestampMs: number;
  /** Runtime's AlephFinalizedPrefix, read at this same finalized block. */
  finalizedNumber: number;
  escrow?: FlopEscrow;
}
export interface FlopOpenRequest {
  payee: string;
  amount: string;
  policy: { combinator: "And"; clauses: { Hash: string }[] };
  deadlineBlocks: number;
}
/** Injectable chain boundary. Writes resolve only after finalized dispatch success. */
export interface FlopChain {
  readonly account?: string;
  snapshot(escrowId?: string, at?: string): Promise<FlopSnapshot>;
  open(request: FlopOpenRequest): Promise<string>;
  satisfy(escrowId: string, preimages: readonly string[]): Promise<void>;
  refund(escrowId: string): Promise<void>;
}
interface Reference {
  v: 1;
  network: FlopNetwork;
  genesis: string;
  escrow: string;
  anchor: string;
  blockTimeMs: number;
  refundMarginBlocks: number;
  terms: LockTerms;
}
const encoder = new TextEncoder();
const digest = (bytes: Uint8Array) => `0x${bytesToHex(sha256(bytes))}`;
const bytes = (hex: string) => hexToBytes(hex.slice(2));

/** v1 uses the DID's Ed25519 public key directly as FLOP AccountId32. */
export function flopAccountFromDid(did: string): string {
  if (typeof did !== "string" || !did.startsWith("did:key:z"))
    throw new Error("flop: invalid party DID");
  const key = base58.decode(did.slice(9));
  if (
    key.length !== 34 ||
    key[0] !== 0xed ||
    key[1] !== 1 ||
    base58.encode(key) !== did.slice(9)
  ) {
    throw new Error("flop: party must be an Ed25519 did:key");
  }
  return `0x${bytesToHex(key.slice(2))}`;
}
function validateTerms(terms: LockTerms): void {
  if (
    !terms ||
    canonicalJson(Object.keys(terms).sort()) !==
      canonicalJson([
        "amount",
        "asset",
        "claimByMs",
        "contract",
        "lock",
        "payee",
        "payer",
        "refundAfterMs",
        "statement",
      ])
  )
    throw new Error("flop: invalid LockTerms fields");
  if (terms.lock !== "hash")
    throw new Error("flop: FlopRail supports HTLC hash locks only");
  if (!HEX32.test(terms.contract) || !HEX32.test(terms.statement))
    throw new Error("flop: malformed contract or statement");
  if (terms.asset !== "FLOP")
    throw new Error("flop: asset must be native FLOP");
  if (
    typeof terms.amount !== "string" ||
    !/^[1-9][0-9]{0,38}$/.test(terms.amount) ||
    BigInt(terms.amount) >= 2n ** 128n
  ) {
    throw new Error("flop: amount must be positive u128 base units");
  }
  flopAccountFromDid(terms.payer);
  flopAccountFromDid(terms.payee);
  if (terms.payer === terms.payee)
    throw new Error("flop: payer and payee must differ");
  if (
    !Number.isSafeInteger(terms.claimByMs) ||
    terms.claimByMs <= 0 ||
    !Number.isSafeInteger(terms.refundAfterMs) ||
    terms.refundAfterMs <= terms.claimByMs
  ) {
    throw new Error("flop: invalid deadlines");
  }
}
function encodeRef(ref: Reference): string {
  return `flop1.${base64urlnopad.encode(encoder.encode(canonicalJson(ref)))}`;
}
function parseRef(value: string): Reference {
  if (
    typeof value !== "string" ||
    !value.startsWith("flop1.") ||
    value.length > 3500
  )
    throw new Error("flop: malformed reference");
  const ref: Reference = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      base64urlnopad.decode(value.slice(6)),
    ),
  );
  if (
    !ref ||
    ref.v !== 1 ||
    canonicalJson(Object.keys(ref).sort()) !==
      canonicalJson([
        "anchor",
        "blockTimeMs",
        "escrow",
        "genesis",
        "network",
        "refundMarginBlocks",
        "terms",
        "v",
      ]) ||
    !HEX32.test(ref.genesis) ||
    !HEX32.test(ref.escrow) ||
    !HEX32.test(ref.anchor) ||
    encodeRef(ref) !== value
  ) {
    throw new Error("flop: malformed reference");
  }
  validateTerms(ref.terms);
  return ref;
}
/** Public 32-byte witness binds ALL terms and chain/time configuration into the policy. */
function binding(ref: Reference): string {
  const { escrow: _escrow, ...rest } = ref;
  return digest(
    encoder.encode(canonicalJson({ domain: "tclk/flop-htlc/1", ...rest })),
  );
}
function policy(ref: Reference): FlopOpenRequest["policy"] {
  return {
    combinator: "And",
    clauses: [
      { Hash: ref.terms.statement },
      { Hash: digest(bytes(binding(ref))) },
    ],
  };
}
function duration(ref: Reference, anchor: FlopSnapshot): number {
  const blocks =
    Math.ceil(
      (ref.terms.refundAfterMs - anchor.timestampMs) / ref.blockTimeMs,
    ) + ref.refundMarginBlocks;
  if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > 0xffffffff)
    throw new Error("flop: deadline exceeds block range");
  return blocks;
}
function checkSnapshot(s: FlopSnapshot): void {
  if (
    !HEX32.test(s.genesis) ||
    !HEX32.test(s.hash) ||
    !Number.isSafeInteger(s.number) ||
    s.number < 0 ||
    s.number > 0xffffffff ||
    !Number.isSafeInteger(s.finalizedNumber) ||
    s.finalizedNumber < 0 ||
    s.finalizedNumber > s.number ||
    !Number.isSafeInteger(s.timestampMs) ||
    s.timestampMs <= 0
  )
    throw new Error("flop: malformed finalized snapshot");
}
/** A submitted lock may exist even when subsequent verification fails. Keep this ref for recovery. */
export class FlopLockError extends Error {
  constructor(readonly ref: string) {
    super(
      "flop: escrow finalized but could not be verified; retain ref and inspect/refund it",
    );
  }
}

/** A public pre-submission journal entry; contains no signing key or claim preimage. */
export type FlopPendingWriter = (pendingRef: string) => Promise<void>;
export class FlopSubmissionError extends Error {
  readonly txHash?: string;
  constructor(
    readonly pendingRef: string,
    error: unknown,
  ) {
    super(
      "flop: lock submission failed or outcome unknown; inspect txHash before retrying",
    );
    const hash = (error as { txHash?: unknown } | null)?.txHash;
    if (typeof hash === "string" && HEX32.test(hash)) this.txHash = hash;
  }
}
/** Complete a journaled reference using ONLY the escrow ID from the finalized open event. */
export function recoverFlopReference(
  pendingRef: string,
  escrowId: string,
): string {
  const ref = parseRef(pendingRef);
  if (ref.escrow !== `0x${"0".repeat(64)}` || !HEX32.test(escrowId))
    throw new Error("flop: malformed pending reference or escrow id");
  return encodeRef({ ...ref, escrow: escrowId });
}

export class FlopRail implements SettlementRail {
  readonly id = "flop-htlc" as const;
  readonly config: Readonly<ResolvedFlopConfig>;
  private readonly submitted = new Set<string>();
  constructor(
    private readonly chain: FlopChain,
    config: FlopRailConfig = {},
    private readonly clock: () => number = Date.now,
    private readonly persistPending?: FlopPendingWriter,
  ) {
    this.config = resolveFlopConfig(config);
  }
  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now <= 0)
      throw new Error("flop: invalid clock");
    return now;
  }
  private async snapshot(id?: string, at?: string): Promise<FlopSnapshot> {
    const s = await this.chain.snapshot(id, at);
    checkSnapshot(s);
    if (at && s.hash !== at) throw new Error("flop: anchor hash mismatch");
    if (
      this.config.expectedGenesisHash &&
      s.genesis !== this.config.expectedGenesisHash
    )
      throw new Error("flop: genesis mismatch");
    return s;
  }
  /** Before signing only: a window that runs out after the open strands funds until refund. */
  private checkClaimWindow(claimByMs: number, chainMs: number): void {
    const remaining = claimByMs - Math.max(this.now(), chainMs);
    if (remaining <= 0) throw new Error("flop: claim window has closed");
    if (remaining < this.config.minClaimWindowMs)
      throw new Error("flop: claim window is too short to lock safely");
  }
  private checkRef(ref: Reference): void {
    if (
      ref.network !== this.config.network ||
      ref.blockTimeMs !== this.config.blockTimeMs ||
      ref.refundMarginBlocks !== this.config.refundMarginBlocks ||
      (this.config.expectedGenesisHash &&
        ref.genesis !== this.config.expectedGenesisHash)
    ) {
      throw new Error(
        "flop: reference belongs to a different network or timing profile",
      );
    }
  }
  async lock(terms: LockTerms): Promise<string> {
    // Copy before awaiting so caller mutation cannot change the signed payment.
    terms = { ...terms };
    validateTerms(terms);
    if (this.chain.account !== flopAccountFromDid(terms.payer))
      throw new Error("flop: signer is not the payer");
    if (this.submitted.has(terms.contract))
      throw new Error(
        "flop: contract already submitted by this wallet instance",
      );
    const anchor = await this.snapshot();
    this.checkClaimWindow(terms.claimByMs, anchor.timestampMs);
    const ref: Reference = {
      v: 1,
      network: this.config.network,
      genesis: anchor.genesis,
      escrow: `0x${"0".repeat(64)}`,
      anchor: anchor.hash,
      blockTimeMs: this.config.blockTimeMs,
      refundMarginBlocks: this.config.refundMarginBlocks,
      terms,
    };
    const deadlineBlocks = duration(ref, anchor);
    if (anchor.number + deadlineBlocks + ref.refundMarginBlocks > 0xffffffff)
      throw new Error("flop: deadline overflows chain height");
    // Check again after asynchronous preflight; preserve the guard on uncertain submission.
    if (this.submitted.has(terms.contract))
      throw new Error(
        "flop: contract already submitted by this wallet instance",
      );
    this.submitted.add(terms.contract);
    const pendingRef = encodeRef(ref);
    try {
      await this.persistPending?.(pendingRef);
      // Journaling can outlive both the coordination window and the anchor's
      // inclusion allowance. Nothing has been signed yet, so reject safely here.
      const current = await this.snapshot();
      this.checkClaimWindow(terms.claimByMs, current.timestampMs);
      if (
        current.genesis !== anchor.genesis ||
        current.number < anchor.number ||
        current.number - anchor.number >= ref.refundMarginBlocks
      )
        throw new Error("flop: anchor became stale before submission");
    } catch (error) {
      this.submitted.delete(terms.contract);
      throw error;
    }
    try {
      ref.escrow = await this.chain.open({
        payee: flopAccountFromDid(terms.payee),
        amount: terms.amount,
        policy: policy(ref),
        deadlineBlocks,
      });
    } catch (error) {
      throw new FlopSubmissionError(pendingRef, error);
    }
    if (!HEX32.test(ref.escrow))
      throw new Error("flop: chain returned an invalid escrow id");
    const encoded = encodeRef(ref);
    if (!(await this.verifyLock(terms, encoded)))
      throw new FlopLockError(encoded);
    return encoded;
  }
  private async inspect(
    ref: Reference,
    requireTimely = true,
  ): Promise<{ snapshot: FlopSnapshot; escrow: FlopEscrow }> {
    this.checkRef(ref);
    const snapshot = await this.snapshot(ref.escrow);
    const anchor = await this.snapshot(undefined, ref.anchor);
    const escrow = snapshot.escrow;
    if (
      snapshot.genesis !== ref.genesis ||
      anchor.genesis !== ref.genesis ||
      anchor.number > snapshot.number ||
      anchor.timestampMs >= ref.terms.claimByMs ||
      !escrow ||
      escrow.id !== ref.escrow ||
      escrow.funder !== flopAccountFromDid(ref.terms.payer) ||
      escrow.payee !== flopAccountFromDid(ref.terms.payee) ||
      escrow.amount !== ref.terms.amount ||
      canonicalJson(escrow.policy) !== canonicalJson(policy(ref)) ||
      !Number.isSafeInteger(escrow.createdBlock) ||
      escrow.createdBlock < anchor.number ||
      escrow.createdBlock > snapshot.number ||
      (requireTimely &&
        escrow.createdBlock - anchor.number > ref.refundMarginBlocks) ||
      escrow.deadline !== escrow.createdBlock + duration(ref, anchor) ||
      escrow.deadline > 0xffffffff
    ) {
      throw new Error("flop: escrow does not match the agreed terms");
    }
    return { snapshot, escrow };
  }
  async verifyLock(terms: LockTerms, value: string): Promise<boolean> {
    try {
      validateTerms(terms);
      const ref = parseRef(value);
      if (canonicalJson(ref.terms) !== canonicalJson(terms)) return false;
      const { snapshot, escrow } = await this.inspect(ref);
      return (
        escrow.status === "Open" &&
        snapshot.finalizedNumber < escrow.deadline &&
        Math.max(this.now(), snapshot.timestampMs) < terms.claimByMs
      );
    } catch {
      return false;
    }
  }
  async claim(value: string, secret: string): Promise<void> {
    const ref = parseRef(value);
    const { snapshot, escrow } = await this.inspect(ref, false);
    if (
      escrow.status !== "Open" ||
      snapshot.finalizedNumber >= escrow.deadline ||
      Math.max(this.now(), snapshot.timestampMs) >= ref.terms.refundAfterMs
    )
      throw new Error("flop: claim window has closed");
    if (!HEX32.test(secret) || !verifyHashPreimage(ref.terms.statement, secret))
      throw new Error("flop: secret does not open the statement");
    await this.chain.satisfy(ref.escrow, [secret, binding(ref)]);
    const after = await this.snapshot(ref.escrow);
    if (after.genesis !== ref.genesis || after.escrow?.status !== "Released")
      throw new Error("flop: claim not observed in finalized state");
  }
  async refund(value: string): Promise<void> {
    const ref = parseRef(value);
    const { snapshot, escrow } = await this.inspect(ref, false);
    if (this.chain.account !== escrow.funder)
      throw new Error("flop: signer is not the payer");
    if (
      escrow.status !== "Open" ||
      snapshot.finalizedNumber < escrow.deadline ||
      this.now() < ref.terms.refundAfterMs ||
      snapshot.timestampMs < ref.terms.refundAfterMs
    )
      throw new Error("flop: refund window is not open");
    await this.chain.refund(ref.escrow);
    const after = await this.snapshot(ref.escrow);
    if (after.genesis !== ref.genesis || after.escrow?.status !== "Refunded")
      throw new Error("flop: refund not observed in finalized state");
  }
}
