// SPDX-License-Identifier: Apache-2.0
//
// B3V4 fast-path helper — Accept watcher with cursor-based polling.
//
// ROOT CAUSE FIX: The original watcher used /r/tclk-offers?format=json
// which returns only the last ~50 messages. On a busy board, the offer
// scrolls out of this window within minutes, and the watcher never sees
// accepts referencing it.
//
// This module maintains a cursor (last processed seq) and uses
// /r/tclk-offers?format=json&since=<cursor> to guarantee no gaps.
//
// CRITICAL INVARIANTS:
// 1. Cursor never advances past an unprocessed record.
// 2. EVERY record's seq is checked: seq must equal cursor + 1.
// 3. Generation is tracked; changes fail closed.
// 4. ALL records through the expiry boundary are consumed before
//    declaring EXPIRED_UNANSWERED. Wall-clock expiry is not sufficient.
// 5. Empty response only establishes continuity if generation unchanged.

import {
  dealRoom,
  encodeFrame,
  lockTerms,
  makeHeartbeat,
  PaperRail,
  paperNote,
  tryDecodeFrame,
  verifyTranscriptRecord,
  contractId,
  type AcceptFrame,
  type OfferFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { VenueNoteStore } from "./venue-note-store.js";
import type { VenueIO, VenueSigner } from "./types.js";

export interface WatcherState {
  /** Last seq we processed. Start at offer seq - 1. */
  cursor: number;
  /** Whether we found the offer in any read. */
  offerFound: boolean;
  /** Whether we found a valid accept. */
  acceptFound: boolean;
  /** The valid accept, if found. */
  acceptRecord: TranscriptRecord | null;
  acceptFrame: AcceptFrame | null;
  /** All candidate accepts seen (for debugging). */
  candidatesSeen: number;
  /** Records processed total. */
  recordsProcessed: number;
  /** Number of drain cycles (multi-page reads) in last poll. */
  drainCycles: number;
  /** Whether a seq gap was detected. */
  gapDetected: boolean;
  /** The gap range if detected (e.g., "184201..184249"). */
  gapRange: string | null;
  /** Whether continuity through expiry has been established. */
  continuityEstablished: boolean;
  /** Whether room generation changed. */
  generationChanged: boolean;
  /** Initial generation at watcher start. */
  initialGeneration: number | null;
  /** Current generation from last read. */
  currentGeneration: number | null;
}

export interface WatcherConfig {
  venue: VenueIO;
  offerId: string;
  payerDid: string;
  offerPublishSeq: number;
  offerExpiresMs: number;
  /** Initial generation from the room at offer publication time. */
  initialGeneration?: number | null;
  /** Max polls before giving up. Default: 60 */
  maxPolls?: number;
  /** Ms between polls. Default: 2000 */
  pollIntervalMs?: number;
  /** Callback on each poll for logging. */
  onPoll?: (state: WatcherState, pollCount: number) => void;
}

function parseFrame(text: string): ReturnType<typeof tryDecodeFrame> {
  return tryDecodeFrame(text);
}

function observeGeneration(state: WatcherState, generation: number | null): void {
  if (generation === null) {
    if (state.currentGeneration !== null) {
      state.generationChanged = true;
    }
    return;
  }

  if (state.currentGeneration === null) {
    state.currentGeneration = generation;
    if (state.initialGeneration === null) {
      state.initialGeneration = generation;
    }
    return;
  }

  if (generation !== state.currentGeneration) {
    state.generationChanged = true;
    state.currentGeneration = generation;
  }
}

/**
 * Process a single record against the watcher's criteria.
 * Returns true if the record was a valid accept.
 *
 * INVARIANT: record.seq MUST equal cursor + 1. This is checked BEFORE calling.
 */
function processRecord(
  record: TranscriptRecord,
  state: WatcherState,
  offerId: string,
  payerDid: string,
  offerExpiresMs: number,
  offerRecordRef: { current: TranscriptRecord | null },
): boolean {
  // Verify transport signature
  const sigResult = verifyTranscriptRecord(record);
  if (!sigResult.ok) {
    state.recordsProcessed++;
    state.cursor = record.seq;
    return false;
  }

  // Decode frame
  const frame = parseFrame(record.line);
  if (frame === null || frame.from !== record.sender) {
    state.recordsProcessed++;
    state.cursor = record.seq;
    return false;
  }

  // Advance cursor — record is fully validated
  state.recordsProcessed++;
  state.cursor = record.seq;

  // Check for our offer
  if (frame.type === "offer" && frame.id === offerId) {
    state.offerFound = true;
    offerRecordRef.current = record;
    return false;
  }

  // Check for accepts referencing our offer
  if (frame.type === "accept" && frame.ref === offerId) {
    state.candidatesSeen++;

    // Validate: accept.from != payer
    if (frame.from === payerDid) return false;

    // Validate: contract ID recomputation
    if (offerRecordRef.current === null) return false;

    const offerFrame = parseFrame(offerRecordRef.current.line);
    if (offerFrame === null || offerFrame.type !== "offer") return false;

    const core = {
      from: frame.from,
      ref: frame.ref,
      statement: frame.statement,
      paymentKey: frame.paymentKey,
      nonce: frame.nonce,
    };

    try {
      const expectedContract = contractId(offerFrame, core);
      if (frame.contract !== expectedContract) return false;
    } catch {
      return false;
    }

    // Validate: timestamp before expiry
    if (record.timestampMs >= offerExpiresMs) return false;

    // Valid accept found!
    state.acceptFound = true;
    state.acceptRecord = record;
    state.acceptFrame = frame;
    return true;
  }

  return false;
}

/**
 * Watch for a valid accept on a published offer using cursor-based polling.
 *
 * INVARIANTS:
 * 1. Cursor never advances past an unprocessed record.
 * 2. EVERY record's seq is checked: seq must equal cursor + 1.
 * 3. Generation is tracked; changes fail closed.
 * 4. ALL records through expiry boundary are consumed before EXPIRED_UNANSWERED.
 * 5. Empty response only establishes continuity if generation unchanged.
 */
export async function watchForAccept(
  config: WatcherConfig,
): Promise<WatcherState> {
  const {
    venue,
    offerId,
    payerDid,
    offerPublishSeq,
    offerExpiresMs,
    initialGeneration = null,
    maxPolls = 60,
    pollIntervalMs = 2000,
    onPoll,
  } = config;

  const state: WatcherState = {
    cursor: offerPublishSeq - 1,
    offerFound: false,
    acceptFound: false,
    acceptRecord: null,
    acceptFrame: null,
    candidatesSeen: 0,
    recordsProcessed: 0,
    drainCycles: 0,
    gapDetected: false,
    gapRange: null,
    continuityEstablished: false,
    generationChanged: false,
    initialGeneration,
    currentGeneration: initialGeneration,
  };

  const offerRecordRef: { current: TranscriptRecord | null } = { current: null };

  for (let poll = 0; poll < maxPolls; poll++) {
    try {
      // Drain loop: keep reading until continuity is established
      let recordsInBatch: number;

      do {
        recordsInBatch = 0;

        const result = await venue.readRoom("tclk-offers", state.cursor);

        // Check generation before touching any records.
        observeGeneration(state, result.generation);
        if (state.generationChanged) break;

        if (result.records.length === 0) {
          // Empty tail can only close continuity when the venue exposes a stable
          // generation and an unchanged-generation `since=<cursor>` read is known
          // to be exhaustive for that generation. In that case, zero results mean
          // there are no seq > cursor records left to consume.
          if (
            state.currentGeneration !== null &&
            !state.generationChanged &&
            !state.gapDetected &&
            state.recordsProcessed > 0
          ) {
            state.continuityEstablished = true;
          }
          break;
        }

        // Process records with strict seq checking
        let advancedCursorThisBatch = false;
        for (const record of result.records) {
          // INVARIANT: record.seq must equal cursor + 1
          const expectedSeq = state.cursor + 1;

          if (record.seq < expectedSeq) {
            // Old/duplicate record — skip
            continue;
          }

          if (record.seq > expectedSeq) {
            // GAP DETECTED
            state.gapDetected = true;
            state.gapRange = `${expectedSeq}..${record.seq - 1}`;
            // Do NOT process this record
            // Do NOT advance cursor
            break;
          }

          // record.seq === expectedSeq — process it
          advancedCursorThisBatch = true;
          if (processRecord(record, state, offerId, payerDid, offerExpiresMs, offerRecordRef)) {
            // Valid accept found — stop immediately
            return state;
          }
          recordsInBatch++;
        }

        if (state.gapDetected) break;

        state.drainCycles++;

        // If this page contained only stale duplicates, keep polling. They do not
        // prove continuity, and they do not let us conclude expiry.
        if (!advancedCursorThisBatch) {
          break;
        }

        // We only treat expiry as closed when we have actually consumed records
        // through the expiry boundary in this generation.
        const lastRecord = result.records[result.records.length - 1];
        if (lastRecord && lastRecord.timestampMs >= offerExpiresMs) {
          state.continuityEstablished = true;
          break;
        }

      } while (recordsInBatch > 0 && !state.acceptFound && !state.gapDetected);

      if (state.acceptFound) break;
      if (state.gapDetected) break;
      if (state.generationChanged) break;

      // If continuity is established and no accept found, we're done
      if (state.continuityEstablished) {
        break;
      }

      if (onPoll) onPoll(state, poll);

      // Wait before next poll
      if (poll < maxPolls - 1) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    } catch {
      // Transport error — retry after interval, cursor preserved
      if (poll < maxPolls - 1) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    }
  }

  return state;
}

/**
 * Watch with the fast-path execution integrated.
 * If a valid accept is found, immediately executes the B3V4 fast path.
 */
export async function watchAndExecute(
  config: WatcherConfig & {
    signer: VenueSigner;
  },
): Promise<{
  watcherState: WatcherState;
  executeResult?: {
    ok: boolean;
    contract?: string;
    dealRoom?: string;
    paperRef?: string;
    lockFrameSeq?: number;
    error?: string;
  };
}> {
  const watcherState = await watchForAccept(config);

  if (!watcherState.acceptFound || !watcherState.acceptFrame || !watcherState.acceptRecord) {
    return { watcherState };
  }

  // Find the offer record — re-read from cursor to get it
  const offerResult = await config.venue.readRoom("tclk-offers", 0);
  let offerFrame: OfferFrame | null = null;

  for (const record of offerResult.records) {
    const frame = parseFrame(record.line);
    if (frame && frame.type === "offer" && frame.id === config.offerId) {
      offerFrame = frame;
      break;
    }
  }

  if (!offerFrame) {
    return {
      watcherState,
      executeResult: { ok: false, error: "offer not found for execution" },
    };
  }

  // Execute fast path
  const room = dealRoom(watcherState.acceptFrame.contract);
  const terms = lockTerms({
    status: "accepted",
    offer: offerFrame,
    contract: watcherState.acceptFrame.contract,
    statement: watcherState.acceptFrame.statement,
    payerDid: config.payerDid,
    payeeDid: watcherState.acceptFrame.from,
  });

  // 1. Heartbeat if needed
  try {
    const roomResult = await config.venue.readRoom(room);
    if (roomResult.records.length === 0) {
      const heartbeat = makeHeartbeat({
        from: config.signer.did,
        contract: watcherState.acceptFrame.contract,
        note: "b3v4 fast-path",
      });
      const heartbeatLine = encodeFrame(heartbeat);
      await config.venue.postSigned(room, config.signer, heartbeatLine);
    }
  } catch {
    // Continue — heartbeat is best-effort
  }

  // 2. PaperRail lock
  const noteStore = new VenueNoteStore(config.venue);
  const rail = new PaperRail(noteStore, () => Date.now());

  try {
    await rail.lock(terms);
  } catch (error) {
    return {
      watcherState,
      executeResult: {
        ok: false,
        error: `PaperRail lock failed: ${error instanceof Error ? error.message : "unknown"}`,
      },
    };
  }

  // 3. Verify lock
  const lockVerified = await rail.verifyLock(terms, watcherState.acceptFrame.contract);
  if (!lockVerified) {
    return {
      watcherState,
      executeResult: { ok: false, error: "PaperRail verifyLock returned false" },
    };
  }

  // 4. Lock frame
  const lockFrame = {
    type: "lock" as const,
    from: config.signer.did,
    contract: watcherState.acceptFrame.contract,
    rail: "paper",
    ref: watcherState.acceptFrame.contract,
  };
  const lockFrameLine = encodeFrame(lockFrame);

  try {
    await config.venue.postSigned(room, config.signer, lockFrameLine);
  } catch (error) {
    return {
      watcherState,
      executeResult: {
        ok: false,
        paperRef: watcherState.acceptFrame.contract,
        error: `Lock frame post failed: ${error instanceof Error ? error.message : "unknown"}`,
      },
    };
  }

  // 5. Mailbox wake (best-effort)
  try {
    const didNote = await config.venue.noteGet("did", watcherState.acceptFrame.from);
    if (didNote) {
      const mailboxMatch = didNote.match(/mailbox:(mb-p-[a-z0-9]+)/);
      if (mailboxMatch) {
        const wakeMsg = `TCLK LOCKED ${watcherState.acceptFrame.contract} ${room}`;
        await config.venue.postSigned(mailboxMatch[1], config.signer, wakeMsg);
      }
    }
  } catch {
    // Mailbox wake is optional
  }

  return {
    watcherState,
    executeResult: {
      ok: true,
      contract: watcherState.acceptFrame.contract,
      dealRoom: room,
      paperRef: watcherState.acceptFrame.contract,
    },
  };
}
