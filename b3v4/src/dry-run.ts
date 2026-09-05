// SPDX-License-Identifier: Apache-2.0
//
// B3V4 fast-path helper — MODE 2: DRY-RUN (local-only).
//
// Builds but does NOT publish: heartbeat frame, PaperRail locked record,
// lock frame, mailbox wake message, all signing payloads.
// Validates all generated objects locally. No network write methods allowed.

import {
  dealRoom,
  encodeFrame,
  makeHeartbeat,
  paperNote,
  lockTerms,
  type HeartbeatFrame,
  type LockFrame,
  type OfferFrame,
} from "@flop-labs/tclk";

import type {
  DryRunPlan,
  LockTermsLocal,
  SelectedAccept,
  SigningPayload,
  VenueIO,
} from "./types.js";

/**
 * Build a dry-run plan for the selected accept.
 *
 * Generates all objects that would be published during execute-fast-path,
 * but does NOT publish anything. Validates everything locally.
 *
 * @param selected - The selected accept from inspect
 * @param venue - The venue IO (only used to check room existence)
 * @param frameNonce - Nonce for heartbeat frame (optional, mints if not provided)
 */
export async function buildDryRunPlan(
  selected: SelectedAccept,
  venue: VenueIO,
  frameNonce?: string,
): Promise<DryRunPlan> {
  const { offer, accept, contract } = selected;
  const room = dealRoom(contract);
  const pn = paperNote(contract);

  // 1. Check if room exists — if not, plan a heartbeat
  let heartbeat: HeartbeatFrame | undefined;
  let heartbeatLine: string | undefined;

  try {
    const roomRecords = await venue.readRoom(room);
    if (roomRecords.length === 0) {
      // Room is empty or doesn't exist — need a heartbeat to create it
      heartbeat = makeHeartbeat({
        from: offer.from,
        contract,
        nonce: frameNonce,
        note: "b3v4 fast-path room creation",
      });
      heartbeatLine = encodeFrame(heartbeat);
    }
  } catch {
    // Room doesn't exist — need heartbeat
    heartbeat = makeHeartbeat({
      from: offer.from,
      contract,
      nonce: frameNonce,
      note: "b3v4 fast-path room creation",
    });
    heartbeatLine = encodeFrame(heartbeat);
  }

  // 2. Build paper lock record
  const terms = lockTerms(selected.state);
  const paperRecord = `tclkpaper1 locked ${terms.lock} ${terms.statement} ${terms.refundAfterMs}`;

  // 3. Build lock frame
  const lockFrame: LockFrame = {
    type: "lock",
    from: offer.from,
    contract,
    rail: "paper",
    ref: contract, // Paper rail uses contract as ref
  };
  const lockFrameLine = encodeFrame(lockFrame);

  // 4. Build mailbox wake message
  const mailboxRoom = room; // Deal room IS the mailbox
  const mailboxWake = `TCLK LOCKED ${contract} ${room}`;

  // 5. Build signing payloads (canonical strings for later signing)
  const signingPayloads: SigningPayload[] = [];

  if (heartbeat !== undefined && heartbeatLine !== undefined) {
    signingPayloads.push({
      room,
      nonce: "PLACEHOLDER_NONCE",
      text: heartbeatLine,
      canonical: `${room}|PLACEHOLDER_NONCE|${heartbeatLine}`,
    });
  }

  signingPayloads.push({
    room,
    nonce: "PLACEHOLDER_NONCE",
    text: lockFrameLine,
    canonical: `${room}|PLACEHOLDER_NONCE|${lockFrameLine}`,
  });

  // 6. State transitions
  const stateTransitions: string[] = [];

  if (heartbeat !== undefined) {
    stateTransitions.push("proposed → accepted (heartbeat establishes room)");
  }

  stateTransitions.push("accepted → locked (paper rail CAS write)");
  stateTransitions.push("locked → locked (lock frame posted to deal room)");
  stateTransitions.push("mailbox wake sent to payee DID note");

  return {
    selected,
    heartbeat,
    heartbeatLine,
    paperLockTerms: terms,
    paperLockRecord: paperRecord,
    lockFrame,
    lockFrameLine,
    mailboxWake,
    mailboxRoom,
    signingPayloads,
    stateTransitions,
  };
}

/**
 * Validate a dry-run plan without any side effects.
 * Returns errors if the plan is invalid.
 */
export function validateDryRunPlan(plan: DryRunPlan): string[] {
  const errors: string[] = [];

  // Validate heartbeat frame
  if (plan.heartbeat !== undefined) {
    try {
      const line = encodeFrame(plan.heartbeat);
      if (line !== plan.heartbeatLine) {
        errors.push("heartbeat frame line mismatch");
      }
    } catch (error) {
      errors.push(`heartbeat frame invalid: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  // Validate lock frame
  try {
    const line = encodeFrame(plan.lockFrame);
    if (line !== plan.lockFrameLine) {
      errors.push("lock frame line mismatch");
    }
  } catch (error) {
    errors.push(`lock frame invalid: ${error instanceof Error ? error.message : "unknown"}`);
  }

  // Validate paper record format
  if (!plan.paperLockRecord.startsWith("tclkpaper1 locked ")) {
    errors.push("paper record does not start with expected prefix");
  }

  // Validate deal room derivation
  const expectedRoom = dealRoom(plan.selected.contract);
  if (plan.mailboxRoom !== expectedRoom) {
    errors.push(`mailbox room mismatch: expected ${expectedRoom}, got ${plan.mailboxRoom}`);
  }

  // Validate state transitions are sequential
  if (plan.stateTransitions.length < 3) {
    errors.push("expected at least 3 state transitions");
  }

  return errors;
}
