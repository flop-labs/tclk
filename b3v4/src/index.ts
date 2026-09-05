// SPDX-License-Identifier: Apache-2.0
//
// B3V4 fast-path helper — public API.
//
// This is a local, fail-closed B3V4 execution helper for the FLOP/TCLK workflow.
// It provides three modes: INSPECT (read-only), DRY-RUN (local-only), and
// EXECUTE-FAST-PATH (gated writes).
//
// No public writes during implementation/testing.

export { inspect } from "./inspect.js";
export { buildDryRunPlan, validateDryRunPlan } from "./dry-run.js";
export { executeFastPath } from "./execute.js";
export {
  runPreLockGates,
  allGatesPass,
  firstFailure,
  gateOfferParses,
  gateOfferIdRecomputes,
  gateOfferFromIsOurs,
  gateOfferRoleIsPayer,
  gateOfferHasPaper,
  gateOfferNotExpired,
  gateAcceptSignatureValid,
  gateAcceptFromNotOurs,
  gateAcceptRefMatchesOffer,
  gateContractIdRecomputes,
  gateStatementFitsLock,
  gateAcceptIsIndependent,
  gateNoExistingLock,
  gateRefundWindowNotOpen,
  gateDealRoomDerivation,
  gateNoTerminalConflict,
} from "./gates.js";
export { createVenueIO, createMockVenueIO } from "./venue-io.js";
export { VenueNoteStore } from "./venue-note-store.js";
export { createAuthorizationStore } from "./authorization-store.js";
export { createEvidenceCollector } from "./evidence.js";
export { TimingRecorder } from "./timing.js";
export { watchForAccept, watchAndExecute } from "./watcher.js";

export type {
  GateResult,
  GateResultSet,
  SelectedAccept,
  InspectReport,
  AcceptCandidate,
  DryRunPlan,
  SigningPayload,
  ExecuteResult,
  ExecuteStep,
  PartialState,
  TimingMeasurements,
  VenueIO,
  VenueSigner,
  Authorization,
  AuthorizationStore,
  EvidenceCollector,
  ErrorClass,
  LockTermsLocal,
} from "./types.js";
