/**
 * The frames in examples/htlc-walkthrough.md are real, not illustrative: every
 * `FRAME='tclk1 …'` line decodes, the ids are the ones the library computes, and the
 * transcript folds to `claimed` on the reveal path and `refunded` on the alternative.
 * Pinning that here keeps the walkthrough from drifting from the code it demonstrates.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import {
  applyFrame,
  decodeFrame,
  hashLockFromPreimage,
  openContract,
  type AcceptFrame,
  type OfferFrame,
  type RevealFrame,
} from "../src/index.js";

const WALKTHROUGH = new URL("../examples/htlc-walkthrough.md", import.meta.url);
const lines = [...readFileSync(WALKTHROUGH, "utf8").matchAll(/^FRAME='(tclk1 [^']*)'$/gm)].map(
  (m) => m[1],
);

describe("examples/htlc-walkthrough.md", () => {
  it("carries five frames that all decode, in walkthrough order", () => {
    expect(lines.map((line) => decodeFrame(line).type)).toEqual([
      "offer", "accept", "lock", "reveal", "refund",
    ]);
  });

  it("folds to claimed on the reveal path and to refunded on the refund path", () => {
    const [offerLine, acceptLine, lockLine, revealLine, refundLine] = lines;
    const offer = decodeFrame(offerLine) as OfferFrame;

    const accepted = applyFrame(openContract(offer), decodeFrame(acceptLine), offer.expiresMs - 1);
    expect(accepted.ok).toBe(true);
    const locked = applyFrame(accepted.state, decodeFrame(lockLine), offer.expiresMs);
    expect(locked.ok).toBe(true);
    expect(locked.state.status).toBe("locked");

    const claimed = applyFrame(locked.state, decodeFrame(revealLine), offer.refundAfterMs - 1);
    expect(claimed.ok).toBe(true);
    expect(claimed.state.status).toBe("claimed");

    const refunded = applyFrame(locked.state, decodeFrame(refundLine), offer.refundAfterMs);
    expect(refunded.ok).toBe(true);
    expect(refunded.state.status).toBe("refunded");
  });

  it("reveals the stand-in preimage the prose describes, and it opens the statement", () => {
    const accept = decodeFrame(lines[1]) as AcceptFrame;
    const reveal = decodeFrame(lines[3]) as RevealFrame;
    // "correct horse battery staple" is 28 ASCII bytes; zero-padded to the 32 a hash lock needs.
    const padded = new Uint8Array(32);
    padded.set(new TextEncoder().encode("correct horse battery staple"));
    const lock = hashLockFromPreimage(padded);
    expect(reveal.secret).toBe(lock.preimage);
    expect(accept.statement).toBe(lock.hash);
  });
});
