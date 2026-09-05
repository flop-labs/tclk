// SPDX-License-Identifier: Apache-2.0
//
// B3V4 fast-path helper — shared types.

import type {
  AcceptFrame,
  ContractState,
  HeartbeatFrame,
  LockFrame,
  OfferFrame,
  TranscriptRecord,
} from "@flop-labs/tclk";

// ── Gate results ─────────────────────────────────────────────────────────────

export interface GateResult {
  pass: boolean;
  gate: string;
  reason?: string;
}

export type GateResultSet = GateResult[];

// ── Selected accept ──────────────────────────────────────────────────────────

export interface SelectedAccept {
  accept: AcceptFrame;
  offer: OfferFrame;
  contract: string;
  acceptRecord: TranscriptRecord;
  offerRecord: TranscriptRecord;
  state: ContractState;
  acceptDID: string;
  acceptTimestampMs: number;
}

// ── Pre-lock inspection report ───────────────────────────────────────────────

export interface InspectReport {
  offerId: string;
  offerValid: boolean;
  accepts: AcceptCandidate[];
  selectedAccept: SelectedAccept | null;
  dealRoom: string;
  paperNote: { ns: string; key: string };
  existingLock: boolean;
  roomExists: boolean;
  gateResults: GateResultSet;
  error?: string;
}

export interface AcceptCandidate {
  accept: AcceptFrame;
  contract: string;
  acceptDID: string;
  acceptTimestampMs: number;
  acceptRecord: TranscriptRecord;
  gates: GateResultSet;
  allPass: boolean;
}

// ── Dry-run plan ─────────────────────────────────────────────────────────────

export interface DryRunPlan {
  selected: SelectedAccept;
  heartbeat?: HeartbeatFrame;
  heartbeatLine?: string;
  paperLockTerms: LockTermsLocal;
  paperLockRecord: string;
  lockFrame: LockFrame;
  lockFrameLine: string;
  mailboxWake: string | null;
  mailboxRoom: string | null;
  signingPayloads: SigningPayload[];
  stateTransitions: string[];
}

export interface SigningPayload {
  room: string;
  nonce: string | number;
  text: string;
  canonical: string;
}

// ── Execute result ───────────────────────────────────────────────────────────

export interface ExecuteResult {
  ok: boolean;
  mode: "execute-fast-path";
  selected: SelectedAccept;
  timings: TimingMeasurements;
  steps: ExecuteStep[];
  partialState?: PartialState;
  error?: string;
}

export interface ExecuteStep {
  name: string;
  ok: boolean;
  timestampMs: number;
  detail?: string;
  error?: string;
}

export interface PartialState {
  railLocked: boolean;
  lockFramePosted: boolean;
  mailboxWoken: boolean;
}

// ── Timing ───────────────────────────────────────────────────────────────────

export interface TimingMeasurements {
  offerPublishToAcceptMs?: number;
  acceptToRoomReadyMs?: number;
  acceptToPaperLockMs?: number;
  acceptToLockFrameMs?: number;
  acceptToMailboxWakeMs?: number;
  totalMs?: number;
}

// ── Venue IO interface ───────────────────────────────────────────────────────

export interface VenueSigner {
  readonly did: string;
  sign(canonical: string): string;
  /** Must return a decimal string to avoid float precision loss for >2^53 nonces. */
  nextNonce(): string;
}

export interface VenueIO {
  readRoom(room: string, since?: number): Promise<TranscriptRecord[]>;
  exportRoom(room: string): Promise<TranscriptRecord[]>;
  postSigned(room: string, signer: VenueSigner, line: string): Promise<string>;
  noteGet(ns: string, key: string): Promise<string | null>;
  noteSet(
    ns: string,
    key: string,
    value: string,
    condition?: { ifAbsent: true } | { if: string },
  ): Promise<boolean>;
}

// ── Authorization ────────────────────────────────────────────────────────────

export interface Authorization {
  version: 1;
  mode: "execute-fast-path";
  offerId: string;
  contract: string;
  payerDid: string;
  issuedAtMs: number;
  expiresAtMs: number;
  /** Unique 16+ character random identifier for one-shot consumption. */
  authorizationId: string;
}

export interface AuthorizationStore {
  /**
   * Atomically consume an authorization ID.
   * Returns true if successfully consumed (first use).
   * Returns false if already consumed.
   */
  consume(authorizationId: string): Promise<boolean>;

  /**
   * Check if an authorization ID has been consumed (read-only).
   */
  isConsumed(authorizationId: string): Promise<boolean>;
}

// ── Evidence ─────────────────────────────────────────────────────────────────

export interface EvidenceCollector {
  add(filename: string, data: unknown): void;
  addText(filename: string, data: string): void;
  flush(): Promise<void>;
  dir(): string;
}

// ── Error classification ─────────────────────────────────────────────────────

export type ErrorClass =
  | "TRANSPORT FAILURE"
  | "CRYPTOGRAPHIC FAILURE"
  | "PROTOCOL FAILURE"
  | "RAIL FAILURE"
  | "LIVENESS FAILURE"
  | "JOB-SPEC FAILURE"
  | "SEMANTIC-QUALITY FAILURE"
  | "GOVERNANCE FAILURE"
  | "EXPERIMENT-DESIGN FAILURE"
  | "COUNTERPARTY FAILURE"
  | "INCONCLUSIVE";

// ── LockTerms (local copy to avoid circular dependency) ──────────────────────

export interface LockTermsLocal {
  contract: string;
  lock: "hash" | "point";
  statement: string;
  amount: string;
  asset: string;
  payer: string;
  payee: string;
  claimByMs: number;
  refundAfterMs: number;
}
