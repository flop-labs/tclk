// SPDX-License-Identifier: Apache-2.0
//
// B3V4 fast-path helper — MODE 3: EXECUTE-FAST-PATH (gated writes).
//
// The live execution path. Requires an explicit one-shot authorization.
// Sequence: validate auth → consume auth → re-read → re-verify gates →
// room heartbeat → paper lock → verify rail → lock frame → verify lock →
// mailbox wake → stop writes.
//
// FORBIDDEN: new offer, second lock, second heartbeat, reveal, refund,
// cancel, receipt, job-spec mutation, GitHub write, real-value action.

import {
  dealRoom,
  encodeFrame,
  lockTerms,
  makeHeartbeat,
  PaperRail,
  paperNote,
  tryDecodeFrame,
  type LockFrame,
  type OfferFrame,
} from "@flop-labs/tclk";

import { allGatesPass, runPreLockGates } from "./gates.js";
import type {
  Authorization,
  AuthorizationStore,
  DryRunPlan,
  ExecuteResult,
  ExecuteStep,
  PartialState,
  SelectedAccept,
  VenueIO,
  VenueSigner,
} from "./types.js";

import { TimingRecorder } from "./timing.js";
import { VenueNoteStore } from "./venue-note-store.js";

/**
 * Execute the B3V4 fast path.
 *
 * This is the critical path: valid accept → lock frame + mailbox wake
 * in under 60 seconds.
 *
 * @param venue - The venue IO for reads and writes
 * @param signer - The signing identity (holds no secrets)
 * @param selected - The selected accept from inspect
 * @param plan - The dry-run plan to execute
 * @param timing - Timing recorder for measurements
 * @param authorization - One-shot authorization artifact
 * @param authStore - Local authorization store for one-shot consumption
 * @param nowMs - Current time
 */
export async function executeFastPath(
  venue: VenueIO,
  signer: VenueSigner,
  selected: SelectedAccept,
  plan: DryRunPlan,
  timing: TimingRecorder,
  authorization: Authorization,
  authStore: AuthorizationStore,
  nowMs: number = Date.now(),
): Promise<ExecuteResult> {
  const steps: ExecuteStep[] = [];
  const partialState: PartialState = {
    railLocked: false,
    lockFramePosted: false,
    mailboxWoken: false,
  };

  function addStep(name: string, ok: boolean, detail?: string, error?: string): void {
    steps.push({ name, ok, timestampMs: Date.now(), detail, error });
  }

  try {
    // ── Authorization validation ──────────────────────────────────────────
    if (authorization.version !== 1) {
      addStep("authorization", false, undefined, "wrong version");
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        error: "GOVERNANCE FAILURE: authorization version must be 1",
      };
    }

    if (authorization.mode !== "execute-fast-path") {
      addStep("authorization", false, undefined, "wrong mode");
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        error: "GOVERNANCE FAILURE: wrong authorization mode",
      };
    }

    if (authorization.offerId !== selected.offer.id) {
      addStep("authorization", false, undefined, "offerId mismatch");
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        error: "GOVERNANCE FAILURE: authorization offerId does not match selected offer",
      };
    }

    if (authorization.contract !== selected.contract) {
      addStep("authorization", false, undefined, "contract mismatch");
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        error: "GOVERNANCE FAILURE: authorization contract does not match selected contract",
      };
    }

    if (authorization.payerDid !== signer.did) {
      addStep("authorization", false, undefined, "payerDid mismatch");
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        error: "GOVERNANCE FAILURE: authorization payerDid does not match signer DID",
      };
    }

    if (nowMs < authorization.issuedAtMs || nowMs > authorization.expiresAtMs) {
      addStep("authorization", false, undefined, "expired or not yet valid");
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        error: "GOVERNANCE FAILURE: authorization is expired or not yet valid",
      };
    }

    if (!authorization.authorizationId || authorization.authorizationId.length < 16) {
      addStep("authorization", false, undefined, "authorizationId too short");
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        error: "GOVERNANCE FAILURE: authorizationId must be at least 16 characters",
      };
    }

    // ── Atomically consume authorization BEFORE any network writes ────────
    const consumed = await authStore.consume(authorization.authorizationId);
    if (!consumed) {
      addStep("authorization", false, undefined, "authorization already consumed");
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        error: "GOVERNANCE FAILURE: authorization has already been consumed",
      };
    }

    addStep("authorization", true, `auth ${authorization.authorizationId.slice(0, 16)}... consumed`);

    // ── A. Fresh re-read ──────────────────────────────────────────────────
    timing.record("execute-start");

    const room = dealRoom(selected.contract);
    const pn = paperNote(selected.contract);

    // Re-read the board to verify nothing changed
    const boardRecords = await venue.exportRoom("tclk-offers");
    const currentOffer = boardRecords
      .map((r) => tryDecodeFrame(r.line))
      .find((f) => f?.type === "offer" && f.id === selected.offer.id);

    if (currentOffer === null || currentOffer === undefined) {
      addStep("fresh-read", false, undefined, "offer no longer on board");
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        partialState,
        error: "LIVENESS FAILURE: offer no longer on board",
      };
    }

    addStep("fresh-read", true, `offer still present: ${selected.offer.id.slice(0, 18)}...`);

    // ── B. Re-run minimum gates ───────────────────────────────────────────
    const gates = runPreLockGates(
      selected.offer,
      selected.accept,
      selected.acceptRecord,
      signer.did,
      nowMs,
      selected.state,
    );

    if (!allGatesPass(gates)) {
      const failure = gates.find((g) => !g.pass);
      addStep("re-verify-gates", false, undefined, failure?.reason);
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        partialState,
        error: `PROTOCOL FAILURE: gate ${failure?.gate} failed: ${failure?.reason}`,
      };
    }

    addStep("re-verify-gates", true, `${gates.length} gates passed`);

    // ── C. Confirm/create deal room with max ONE heartbeat ────────────────
    let heartbeatNeeded = false;

    try {
      const roomRecords = await venue.readRoom(room);
      heartbeatNeeded = roomRecords.length === 0;
    } catch {
      heartbeatNeeded = true;
    }

    if (heartbeatNeeded) {
      const heartbeat = makeHeartbeat({
        from: signer.did,
        contract: selected.contract,
        note: "b3v4 fast-path room creation",
      });
      const heartbeatLine = encodeFrame(heartbeat);

      try {
        await venue.postSigned(room, signer, heartbeatLine);
        addStep("heartbeat", true, `posted to ${room}`);
        timing.record("heartbeat");
      } catch (error) {
        addStep("heartbeat", false, undefined, error instanceof Error ? error.message : "unknown");
        return {
          ok: false,
          mode: "execute-fast-path",
          selected,
          timings: timing.toMeasurements(),
          steps,
          partialState,
          error: `TRANSPORT FAILURE: heartbeat post failed: ${error instanceof Error ? error.message : "unknown"}`,
        };
      }
    } else {
      addStep("heartbeat", true, "room already exists, skipped");
    }

    // ── D. Create exactly ONE PAPER lock ──────────────────────────────────
    const noteStore = new VenueNoteStore(venue);
    const paperRail = new PaperRail(noteStore, () => nowMs);

    // Check if lock already exists via venue
    const existingRecord = await venue.noteGet(pn.ns, pn.key);
    if (existingRecord !== null) {
      addStep("paper-lock", false, undefined, "paper rail already has a record");
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        partialState,
        error: "RAIL FAILURE: paper rail already has a record",
      };
    }

    const terms = lockTerms(selected.state);

    try {
      await paperRail.lock(terms);
      partialState.railLocked = true;
      addStep("paper-lock", true, `locked contract ${selected.contract.slice(0, 18)}...`);
      timing.record("paper-lock");
    } catch (error) {
      addStep("paper-lock", false, undefined, error instanceof Error ? error.message : "unknown");
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        partialState,
        error: `RAIL FAILURE: paper lock failed: ${error instanceof Error ? error.message : "unknown"}`,
      };
    }

    // ── E. Verify PaperRail lock ──────────────────────────────────────────
    const lockVerified = await paperRail.verifyLock(terms, selected.contract);

    if (!lockVerified) {
      addStep("verify-rail-lock", false, undefined, "verifyLock returned false");
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        partialState,
        error: "RAIL FAILURE: verifyLock returned false after lock",
      };
    }

    addStep("verify-rail-lock", true, "verifyLock returned true");

    // ── F. Post exactly ONE signed lock frame ─────────────────────────────
    const lockFrame: LockFrame = {
      type: "lock",
      from: signer.did,
      contract: selected.contract,
      rail: "paper",
      ref: selected.contract,
    };
    const lockFrameLine = encodeFrame(lockFrame);

    try {
      await venue.postSigned(room, signer, lockFrameLine);
      partialState.lockFramePosted = true;
      addStep("lock-frame", true, `posted to ${room}`);
      timing.record("lock-frame");
    } catch (error) {
      addStep("lock-frame", false, undefined, error instanceof Error ? error.message : "unknown");
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        partialState,
        error: `TRANSPORT FAILURE: lock frame post failed: ${error instanceof Error ? error.message : "unknown"}`,
      };
    }

    // ── G. Verify signed lock record ──────────────────────────────────────
    try {
      const roomRecords = await venue.readRoom(room);
      const lockRecord = roomRecords.find((r) => {
        const frame = tryDecodeFrame(r.line);
        return frame?.type === "lock" && frame.contract === selected.contract;
      });

      if (lockRecord === undefined) {
        addStep("verify-lock-record", false, undefined, "lock frame not found in room");
        return {
          ok: false,
          mode: "execute-fast-path",
          selected,
          timings: timing.toMeasurements(),
          steps,
          partialState,
          error: "PROTOCOL FAILURE: lock frame not found in room after post",
        };
      }

      addStep("verify-lock-record", true, `lock frame found at seq ${lockRecord.seq}`);
    } catch (error) {
      addStep("verify-lock-record", false, undefined, error instanceof Error ? error.message : "unknown");
      return {
        ok: false,
        mode: "execute-fast-path",
        selected,
        timings: timing.toMeasurements(),
        steps,
        partialState,
        error: `TRANSPORT FAILURE: could not verify lock record: ${error instanceof Error ? error.message : "unknown"}`,
      };
    }

    // ── H. Send exactly ONE mailbox wake ──────────────────────────────────
    // Mailbox is discovered from the payee's DID note, NOT derived from deal room
    let mailboxRoom: string | null = null;

    try {
      // Read the payee's DID note to discover their mailbox
      const payeeDidNote = await venue.noteGet("did", selected.acceptDID);
      if (payeeDidNote !== null) {
        // Parse for mailbox:mb-p-<hex> pattern
        const mailboxMatch = payeeDidNote.match(/mailbox:(mb-p-[a-z0-9]{16,})/);
        if (mailboxMatch !== null) {
          mailboxRoom = mailboxMatch[1];
        }
      }
    } catch {
      // DID note read failed — mailbox unavailable
    }

    if (mailboxRoom !== null) {
      const wakeMessage = `TCLK LOCKED ${selected.contract} ${room}`;
      try {
        await venue.postSigned(mailboxRoom, signer, wakeMessage);
        partialState.mailboxWoken = true;
        addStep("mailbox-wake", true, `wake sent to ${mailboxRoom}`);
        timing.record("mailbox-wake");
      } catch (error) {
        // Mailbox wake is optional — do NOT fail the lock
        addStep("mailbox-wake", false, undefined, error instanceof Error ? error.message : "unknown");
      }
    } else {
      addStep("mailbox-wake", true, "no mailbox advertised — skipped");
    }

    // ── I. Stop public writes ─────────────────────────────────────────────
    timing.record("end");
    addStep("stop-writes", true, "no further writes will be attempted");

    return {
      ok: true,
      mode: "execute-fast-path",
      selected,
      timings: timing.toMeasurements(),
      steps,
      partialState,
    };
  } catch (error) {
    addStep("unexpected-error", false, undefined, error instanceof Error ? error.message : "unknown");
    return {
      ok: false,
      mode: "execute-fast-path",
      selected,
      timings: timing.toMeasurements(),
      steps,
      partialState,
      error: `INCONCLUSIVE: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }
}
