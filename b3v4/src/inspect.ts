// SPDX-License-Identifier: Apache-2.0
//
// B3V4 fast-path helper — MODE 1: INSPECT (read-only).
//
// Fetches board data, finds offers and accepts, verifies signatures,
// derives contracts and deal rooms, inspects room state.
// NO WRITES.

import {
  applyFrame,
  contractId,
  dealRoom,
  lockTerms,
  OFFER_ROOM,
  openContract,
  paperNote,
  tryDecodeFrame,
  verifyTranscriptRecord,
  type OfferFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import {
  allGatesPass,
  runPreLockGates,
} from "./gates.js";
import type {
  AcceptCandidate,
  InspectReport,
  SelectedAccept,
  VenueIO,
} from "./types.js";

/**
 * Inspect a frozen offer and all its accepts.
 *
 * This mode is strictly read-only: it reads the board room, finds the offer,
 * finds all accepts, verifies signatures, derives contracts, and reports.
 *
 * @param venue - The venue IO (must be read-only; writes will throw)
 * @param offerId - The offer ID to find
 * @param ourDID - Our payer DID
 * @param nowMs - Current time for expiry checks
 */
export async function inspect(
  venue: VenueIO,
  offerId: string,
  ourDID: string,
  nowMs: number = Date.now(),
): Promise<InspectReport> {
  // 1. Read the board
  const boardRecords = await venue.exportRoom(OFFER_ROOM);

  // 2. Find the offer
  let offer: OfferFrame | null = null;
  let offerRecord: TranscriptRecord | null = null;

  for (const record of boardRecords) {
    const frame = tryDecodeFrame(record.line);
    if (frame === null) continue;
    if (frame.type !== "offer") continue;
    const sigResult = verifyTranscriptRecord(record);
    if (!sigResult.ok) continue;
    if (frame.from !== record.sender) continue;

    if (frame.id === offerId) {
      offer = frame;
      offerRecord = record;
      break;
    }
  }

  if (offer === null || offerRecord === null) {
    return {
      offerId,
      offerValid: false,
      accepts: [],
      selectedAccept: null,
      dealRoom: "",
      paperNote: { ns: "", key: "" },
      existingLock: false,
      roomExists: false,
      gateResults: [],
      error: "offer not found on board",
    };
  }

  // 3. Find all accepts for this offer
  const accepts: AcceptCandidate[] = [];

  for (const record of boardRecords) {
    const frame = tryDecodeFrame(record.line);
    if (frame === null) continue;
    if (frame.type !== "accept") continue;
    if (frame.ref !== offer.id) continue;

    const sigResult = verifyTranscriptRecord(record);
    if (!sigResult.ok) continue;
    if (frame.from !== record.sender) continue;

    // Derive contract state from offer + accept
    const acceptCore = {
      from: frame.from,
      ref: frame.ref,
      statement: frame.statement,
      paymentKey: frame.paymentKey,
      nonce: frame.nonce,
    };

    try {
      const computedContract = contractId(offer, acceptCore);
      if (frame.contract !== computedContract) continue;

      const state = applyFrame(openContract(offer), frame, record.timestampMs);

      const gates = runPreLockGates(offer, frame, record, ourDID, nowMs, state.state);

      accepts.push({
        accept: frame,
        contract: frame.contract,
        acceptDID: frame.from,
        acceptTimestampMs: record.timestampMs,
        acceptRecord: record,
        gates,
        allPass: allGatesPass(gates),
      });
    } catch {
      // Skip malformed accepts
    }
  }

  // 4. Select the first valid accept
  let selected: SelectedAccept | null = null;

  for (const candidate of accepts) {
    if (candidate.allPass) {
      // Re-derive the full state
      const state = applyFrame(openContract(offer), candidate.accept, candidate.acceptTimestampMs);
      selected = {
        accept: candidate.accept,
        offer,
        contract: candidate.contract,
        acceptRecord: candidate.acceptRecord,
        offerRecord,
        state: state.state,
        acceptDID: candidate.acceptDID,
        acceptTimestampMs: candidate.acceptTimestampMs,
      };
      break;
    }
  }

  // 5. Derive deal room and paper note
  const contract = selected?.contract ?? accepts[0]?.contract ?? "";
  const dr = contract ? dealRoom(contract) : "";
  const pn = contract ? paperNote(contract) : { ns: "", key: "" };

  // 6. Check existing room state
  let roomExists = false;
  let existingLock = false;

  if (dr) {
    try {
      const roomRecords = await venue.readRoom(dr);
      roomExists = roomRecords.length > 0;

      // Check for existing lock frames
      for (const record of roomRecords) {
        const frame = tryDecodeFrame(record.line);
        if (frame !== null && frame.type === "lock") {
          existingLock = true;
          break;
        }
      }
    } catch {
      // Room doesn't exist or can't be read
    }
  }

  // 7. Check paper rail state
  if (pn.ns) {
    try {
      const paperValue = await venue.noteGet(pn.ns, pn.key);
      if (paperValue !== null) {
        existingLock = true;
      }
    } catch {
      // Note not accessible
    }
  }

  return {
    offerId: offer.id,
    offerValid: true,
    accepts,
    selectedAccept: selected,
    dealRoom: dr,
    paperNote: pn,
    existingLock,
    roomExists,
    gateResults: selected !== null ? runPreLockGates(
      offer,
      selected.accept,
      selected.acceptRecord,
      ourDID,
      nowMs,
      selected.state,
    ) : [],
  };
}
