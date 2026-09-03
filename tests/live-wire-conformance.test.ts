// SPDX-License-Identifier: Apache-2.0
//
// Regression cases distilled from 21 hours of live tclk/1 traffic. These pin the wire
// contract at the seams the original unit tests exercised only in isolation.

import { describe, expect, it } from "vitest";

import {
  applyFrame,
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  matchingRails,
  openContract,
  railSetsMatch,
} from "../src/index.js";

const PAYER = "did:key:z6Mk" + "f".repeat(44);
const PAYEE = "did:key:z6Mk" + "g".repeat(44);
const NOW = 1_756_700_000_000;

function offer(rails = ["flop-htlc", "paper", "x402"]) {
  return makeOffer({
    from: PAYER,
    role: "payer",
    amount: "1000",
    asset: "PAPER",
    lock: "hash",
    rails,
    claimByMs: NOW + 3_600_000,
    refundAfterMs: NOW + 7_200_000,
    expiresMs: NOW + 600_000,
    nonce: "0011223344556677",
  });
}

function accepted(rails?: string[]) {
  const proposed = offer(rails);
  const lock = generateHashLock();
  const accept = makeAccept(proposed, {
    from: PAYEE,
    statement: lock.hash,
    nonce: "8899aabbccddeeff",
  });
  const state = applyFrame(openContract(proposed), accept, NOW).state;
  return { lock, state };
}

describe("live-wire conformance gaps", () => {
  it("requires the rail ref on reveal and refund frames", () => {
    const contract = "0x" + "11".repeat(32);
    expect(() => encodeFrame({
      type: "reveal", from: PAYEE, contract, secret: "0x" + "22".repeat(32),
    } as never)).toThrow(/missing field.*ref/);
    expect(() => encodeFrame({
      type: "refund", from: PAYER, contract,
    } as never)).toThrow(/missing field.*ref/);
  });

  it.each(["PaperRail", "paper-rail", "paper"])(
    "normalizes the %s alias to the canonical paper rail id",
    (alias) => {
      expect(offer([alias]).rails).toEqual(["paper"]);
    },
  );

  it("rejects non-canonical rail aliases if they arrive directly on the wire", () => {
    const canonical = offer(["paper"]);
    expect(() => encodeFrame({ ...canonical, rails: ["PaperRail"] } as never)).toThrow(
      /non-canonical rail id.*use paper/,
    );
  });

  it("rejects an unknown rail id loudly", () => {
    expect(() => offer(["combat"])).toThrow(/unknown rail id/);
  });

  it("selects an offered rail independently of list order", () => {
    for (const rails of [
      ["flop-htlc", "paper", "x402"],
      ["flop-htlc", "x402", "paper"],
    ]) {
      const { state } = accepted(rails);
      const step = applyFrame(state, {
        type: "lock",
        from: PAYER,
        contract: state.contract!,
        rail: "paper",
        ref: "paper-lock-1",
      }, NOW);
      expect(step.ok).toBe(true);
      expect(step.state.status).toBe("locked");
    }
  });

  it("matches rail sets and intersections independently of list order", () => {
    expect(railSetsMatch(["paper", "x402"], ["x402", "PaperRail"])).toBe(true);
    expect(matchingRails(["flop-htlc", "paper"], ["paper", "x402"])).toEqual(["paper"]);
  });

  it("accepts a heartbeat from a party without changing contract state", () => {
    const { state } = accepted();
    const heartbeat = applyFrame(state, {
      type: "heartbeat",
      from: PAYER,
      contract: state.contract!,
      nonce: "0123456789abcdef",
    }, NOW);
    expect(heartbeat.ok).toBe(true);
    expect(heartbeat.state).toBe(state);
    expect(applyFrame(state, {
      type: "heartbeat",
      from: "did:key:z6Mk" + "h".repeat(44),
      contract: state.contract!,
      nonce: "fedcba9876543210",
    }, NOW).reason).toMatch(/non-party/);
  });

  it("does not accept heartbeat fields disguised as a terminal receipt", () => {
    const contract = "0x" + "11".repeat(32);
    expect(() => encodeFrame({
      type: "receipt",
      from: PAYER,
      contract,
      outcome: "claimed",
      note: "agentic-commerce heartbeat",
      status: "active",
    } as never)).toThrow(/unknown field on receipt/);
  });
});
