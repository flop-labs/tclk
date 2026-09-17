// SPDX-License-Identifier: Apache-2.0
//
// tclk_read_verified_transcript: fetches OFFER_ROOM, locates the authenticated
// handshake for a contract via findContractHandshake, fetches the derived deal room,
// and folds everything together in one call. The regression this file exists to pin
// down is #158's actual attack surface: a genuine cross-room contract (offer+accept in
// OFFER_ROOM, a genuine lock in the deal room) with a forged terminal frame -- `from`
// claiming a real party, actually signed by an unrelated identity -- sitting in the
// deal room itself. A single-room read cannot see this; this tool must.

import { describe, expect, it } from "vitest";

import { OFFER_ROOM, dealRoom } from "@flop-labs/tclk";
import { canonicalMessage, signerFromSeed } from "../src/signing.js";
import { createHandlers } from "../src/tools.js";
import {
  ATTACKER_SEED,
  HASH_OFFER,
  NOW,
  PAYEE_DID,
  PAYEE_SEED,
  PAYER_DID,
  PAYER_SEED,
  fakeFetch,
  hexToBytes,
} from "./fixtures.js";

const payer = signerFromSeed(hexToBytes(PAYER_SEED));
const payee = signerFromSeed(hexToBytes(PAYEE_SEED));
const attacker = signerFromSeed(hexToBytes(ATTACKER_SEED));

function envelope(seq: number, signer: typeof payer, room: string, nonce: number, line: string) {
  return {
    seq,
    ts: new Date(NOW + seq).toISOString(),
    from: signer.did,
    nonce: String(nonce),
    sig: signer.sign(canonicalMessage(room, nonce, line)),
    text: line,
  };
}

/** Queues one fetch response per room tclk_read_verified_transcript will read, in the
 * order it reads them: OFFER_ROOM first, then the deal room. */
function queueRooms(offerMessages: unknown[], dealMessages: unknown[], deal: string) {
  return fakeFetch([
    {
      body: "",
      json: { room: OFFER_ROOM, count: offerMessages.length, last_seq: offerMessages.length - 1, messages: offerMessages },
    },
    {
      body: "",
      json: { room: deal, count: dealMessages.length, last_seq: Math.max(dealMessages.length - 1, 0), messages: dealMessages },
    },
  ]);
}

describe("tclk_read_verified_transcript", () => {
  it("folds a genuine cross-room contract the same way tclk_apply_transcript would", async () => {
    const h = createHandlers({ env: {} });
    const offer = h.tclk_make_offer(HASH_OFFER);
    const accept = h.tclk_accept_offer({ offer: offer.line, from: PAYEE_DID });
    const lock = h.tclk_make_lock({
      from: PAYER_DID,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-158happy",
    });
    const deal = dealRoom(accept.contract);

    const { fetchLike } = queueRooms(
      [envelope(0, payer, OFFER_ROOM, 100, offer.line), envelope(1, payee, OFFER_ROOM, 101, accept.line)],
      [envelope(0, payer, deal, 102, lock.line)],
      deal,
    );
    const handlers = createHandlers({ env: {}, fetch: fetchLike });

    const result = await handlers.tclk_read_verified_transcript({ contract: accept.contract });

    expect(result.contract).toBe(accept.contract);
    expect(result.dealRoom).toBe(deal);
    expect(result.handshakeFound).toBe(true);
    expect(result.steps.map((s) => s.ok)).toEqual([true, true, true]);
    expect(result.state).not.toBeNull();
    expect(result.state!.status).toBe("locked");
    expect(result.state!.contract).toBe(accept.contract);
    expect(result.state!.rail).toBe("flop-htlc");
    expect(result.rejectedCount).toBe(0);
  });

  it("#158 regression: a forged terminal frame in the deal room never advances state, even with a genuine cross-room handshake behind it", async () => {
    const h = createHandlers({ env: {} });
    const offer = h.tclk_make_offer(HASH_OFFER);
    const accept = h.tclk_accept_offer({ offer: offer.line, from: PAYEE_DID });
    const lock = h.tclk_make_lock({
      from: PAYER_DID,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-158",
    });
    const deal = dealRoom(accept.contract);
    // The forged frame: format-valid, `from` claims the real payee, secret is even
    // correct -- but it is signed and posted by an unrelated attacker identity, sitting
    // in the deal room itself. Exactly #158's reported shape: a fake reveal/receipt/
    // refund from a third DID, on top of an otherwise-real, otherwise-active contract.
    const forgedReveal = h.tclk_make_reveal({
      from: PAYEE_DID,
      contract: accept.contract,
      ref: "escrow-158",
      secret: accept.secret,
    });

    const { fetchLike } = queueRooms(
      [envelope(0, payer, OFFER_ROOM, 200, offer.line), envelope(1, payee, OFFER_ROOM, 201, accept.line)],
      [
        envelope(0, payer, deal, 202, lock.line),
        // Real technocore sender is the attacker; the frame text's own `from` field
        // still says payee. This is the exact mismatch foldTranscript exists to catch,
        // and it is sitting in the room #158 says was poisoned -- not the offer board.
        envelope(1, attacker, deal, 203, forgedReveal.line),
      ],
      deal,
    );
    const handlers = createHandlers({ env: {}, fetch: fetchLike });

    const result = await handlers.tclk_read_verified_transcript({ contract: accept.contract });

    expect(result.handshakeFound).toBe(true);
    expect(result.state).not.toBeNull();
    // The genuine handshake and lock land; the contract stops at "locked" because the
    // only reveal in the deal room's transcript is rejected, not applied.
    expect(result.state!.status).toBe("locked");
    expect(result.state!.secretRevealed).toBe(false);

    expect(result.steps).toHaveLength(4);
    expect(result.steps.slice(0, 3).map((s) => s.ok)).toEqual([true, true, true]);
    expect(result.steps[3]).toMatchObject({
      ok: false,
      type: "reveal",
      reason: "reveal.from does not match the record sender",
    });
    expect(result.rejectedCount).toBe(1);
    expect(attacker.did).not.toBe(PAYEE_DID);
  });

  it("reports state: null, not a throw, when no handshake for this contract is found", async () => {
    const h = createHandlers({ env: {} });
    const offer = h.tclk_make_offer(HASH_OFFER);
    const accept = h.tclk_accept_offer({ offer: offer.line, from: PAYEE_DID });
    const deal = dealRoom(accept.contract);

    // OFFER_ROOM is read but contains nothing for this contract -- e.g. it has already
    // rotated out of the window, or the id is simply wrong.
    const { fetchLike } = queueRooms([], [], deal);
    const h2 = createHandlers({ env: {}, fetch: fetchLike });

    const result = await h2.tclk_read_verified_transcript({ contract: accept.contract });
    expect(result.handshakeFound).toBe(false);
    expect(result.state).toBeNull();
  });
});
