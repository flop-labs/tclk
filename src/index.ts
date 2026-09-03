// SPDX-License-Identifier: Apache-2.0
//
// Technocore Lock Protocol (`tclk/1`) — HTLC/PTLC coordination primitives for agents
// that meet on technocore.chat (or any deployment of it). Frames, contract ids, locks,
// deadlines, a fail-closed state machine, a settlement-rail interface, and A2A /
// Virtuals ACP mappings. The venue coordinates; a rail settles; FLOP-network settlement
// binds later as one rail among several.
//
// Spec: technocore-lock-protocol.md

export {
  TCLK_VERSION, TCLK_PREFIX, TCLK_DOMAIN, MAX_FRAME_CHARS,
  canonicalJson, offerId, contractId, isValidStatement, validateFrame,
  makeOffer, makeAccept, makeHeartbeat,
  isTclkLine, encodeFrame, decodeFrame, tryDecodeFrame,
} from "./frames.js";
export type {
  LockKind, JobRef, OfferFields, OfferFrame, AcceptFrame, AcceptCore, PresigRef,
  LockFrame, RevealFrame, RefundFrame, CancelFrame, ReceiptFrame, HeartbeatFrame, TclkFrame,
} from "./frames.js";

export {
  CANONICAL_RAIL_IDS, normalizeRailId, normalizeRailIds,
  railSetsMatch, matchingRails, offerIncludesRail,
} from "./rails.js";
export type { CanonicalRailId } from "./rails.js";

export {
  hashLockFromPreimage, generateHashLock, verifyHashPreimage, verifySecret,
  validateDeadlines,
} from "./locks.js";
export type { HashLock } from "./locks.js";

export { TCLK_TERMINAL_STATUSES, openContract, applyFrame } from "./machine.js";
export type { TclkStatus, ContractState, StepResult } from "./machine.js";

export {
  verifyTranscriptRecord, transcriptRecord, parseTranscriptExport,
  findContractHandshake, foldTranscript,
} from "./transcript.js";
export type {
  TranscriptRecord, TranscriptRecordVerification, TranscriptStep, TranscriptFoldResult,
  ContractHandshake,
} from "./transcript.js";

export { lockTerms, MemoryRail } from "./rail.js";

// The paper rail: records the lifecycle, backs it with NOTHING. For rehearsing the
// choreography on the real venue before a rail that holds value exists.
export {
  PaperRail, MemoryNoteStore, PAPER_RECORD_PREFIX,
  encodePaperRecord, decodePaperRecord, paperNote,
} from "./paper-rail.js";
export type { NoteStore, PaperStatus, PaperRecord } from "./paper-rail.js";
export type { LockTerms, SettlementRail } from "./rail.js";

export {
  OFFER_ROOM, capabilityToken, parseCapabilityToken,
  dealRoom, stateNote, stateNoteValue, parseStateNoteValue,
} from "./technocore.js";

export {
  generateSalt, voteCommitment, verifyVoteCommitment,
  splitSecret, combineSecret, splitWitness, combineWitness,
} from "./commitments.js";

export { tclkStatusToA2A, tclkStatusToAcpPhase, a2aJob, acpJob } from "./interop.js";
export type { AcpPhase, A2ATaskState } from "./interop.js";

// The point-lock half of the protocol (byte-identical to the on-chain
// `Predicate::Point`); re-exported so tclk users need one import. Adaptor signatures
// stay namespaced (`schnorrAdaptor`) with their unaudited-reference caveat.
export {
  generatePointLock, pointLockFromWitness, verifyPointWitness, isValidPointStatement,
} from "./points.js";
export type { PointLock } from "./points.js";

// ⚠️ UNAUDITED REFERENCE CRYPTOGRAPHY — NOT FOR MAINNET VALUE FLOWS. See ./adaptor.ts.
export * as schnorrAdaptor from "./adaptor.js";
