// SPDX-License-Identifier: Apache-2.0
//
// Regression cases distilled from 21 hours of live tclk/1 traffic. These pin the wire
// contract at the seams the original unit tests exercised only in isolation.

import { describe, expect, it } from "vitest";

import {
  applyFrame,
  canonicalJson,
  capabilityToken,
  decodeFrame,
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  matchingRails,
  MAX_FRAME_CHARS,
  offerId,
  openContract,
  parseCapabilityToken,
  railSetsMatch,
  TCLK_PREFIX,
  tryDecodeFrame,
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
  it("keeps historical reveal/refund frames replayable while binding a supplied ref", () => {
    const contract = "0x" + "11".repeat(32);
    expect(() => encodeFrame({
      type: "reveal", from: PAYEE, contract, secret: "0x" + "22".repeat(32),
    })).not.toThrow();
    expect(() => encodeFrame({
      type: "refund", from: PAYER, contract,
    })).not.toThrow();

    const { lock, state } = accepted();
    const locked = applyFrame(state, {
      type: "lock",
      from: PAYER,
      contract: state.contract!,
      rail: "paper",
      ref: "paper-lock-legacy",
    }, NOW).state;
    expect(applyFrame(locked, {
      type: "reveal",
      from: PAYEE,
      contract: state.contract!,
      secret: lock.preimage,
    }, NOW).ok).toBe(true);
    expect(applyFrame(locked, {
      type: "reveal",
      from: PAYEE,
      contract: state.contract!,
      ref: "another-lock",
      secret: lock.preimage,
    }, NOW).reason).toMatch(/different rail ref/);
  });

  it.each(["PaperRail", "paper-rail", "paper"])(
    "normalizes the %s alias to the canonical paper rail id",
    (alias) => {
      expect(offer([alias]).rails).toEqual(["paper"]);
    },
  );

  it("rejects non-canonical rail aliases if they arrive directly on the wire", () => {
    const canonical = offer(["paper"]);
    const { id: _id, ...fields } = canonical;
    const aliased = { ...fields, rails: ["PaperRail"] };
    expect(() => encodeFrame({ ...aliased, id: offerId(aliased) })).toThrow(
      /non-canonical rail id.*use paper/,
    );
  });

  it("rejects an unknown rail id loudly", () => {
    expect(() => offer(["combat"])).toThrow(/unknown rail id/);
    expect(() => matchingRails(["combat"], ["paper"])).toThrow(/unknown rail id/);
    expect(railSetsMatch(["flop-htlc"], ["paper"])).toBe(false);
  });

  it("rejects punctuation instead of silently coercing it", () => {
    expect(() => offer(["flop-htlc."])).toThrow(/malformed rail id/);
    expect(() => capabilityToken(["flop-htlc."])).toThrow(/malformed rail id/);
    expect(parseCapabilityToken("agent tclk1:flop-htlc.")).toBeNull();
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

  it("matches rail sets by non-empty intersection independently of list order", () => {
    expect(railSetsMatch(["paper", "x402"], ["x402", "PaperRail"])).toBe(true);
    expect(railSetsMatch(["flop-htlc", "paper"], ["paper", "x402"])).toBe(true);
    expect(matchingRails(["flop-htlc", "paper"], ["paper", "x402"])).toEqual(["paper"]);
  });

  it("decodes and applies historical tclk/1 custom rail ids without admitting new ones", () => {
    const fields = {
      type: "offer" as const,
      from: PAYER,
      role: "payer" as const,
      amount: "1000",
      asset: "PAPER",
      lock: "hash" as const,
      rails: ["combat", "paper"],
      claimByMs: NOW + 3_600_000,
      refundAfterMs: NOW + 7_200_000,
      expiresMs: NOW + 600_000,
      nonce: "0011223344556677",
    };
    const historical = { ...fields, id: offerId(fields) };
    const decoded = decodeFrame(`${TCLK_PREFIX}${canonicalJson(historical)}`);

    expect(decoded).toEqual(historical);
    expect(() => encodeFrame(decoded)).toThrow(/unknown rail id/);

    const lock = generateHashLock();
    const accept = makeAccept(decoded as ReturnType<typeof offer>, {
      from: PAYEE,
      statement: lock.hash,
      nonce: "8899aabbccddeeff",
    });
    const acceptedState = applyFrame(openContract(decoded as ReturnType<typeof offer>), accept, NOW).state;
    expect(applyFrame(acceptedState, {
      type: "lock",
      from: PAYER,
      contract: accept.contract,
      rail: "combat",
      ref: "legacy-lock",
    }, NOW).ok).toBe(true);
    expect(applyFrame(acceptedState, {
      type: "lock",
      from: PAYER,
      contract: accept.contract,
      rail: "paper",
      ref: "registered-lock",
    }, NOW).ok).toBe(true);
  });

  it("preserves historical duplicate rail arrays while new emission rejects them", () => {
    const fields = {
      type: "offer" as const,
      from: PAYER,
      role: "payer" as const,
      amount: "1000",
      asset: "USDC",
      lock: "hash" as const,
      rails: ["x402", "x402"],
      claimByMs: NOW + 3_600_000,
      refundAfterMs: NOW + 7_200_000,
      expiresMs: NOW + 600_000,
      nonce: "0011223344556677",
    };
    const historical = { ...fields, id: offerId(fields) };
    const decoded = decodeFrame(`${TCLK_PREFIX}${canonicalJson(historical)}`);

    expect(decoded).toEqual(historical);
    expect(() => encodeFrame(decoded)).toThrow(/rails must not contain duplicates/);
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

  it("refuses a line the venue could never have stored, on decode as well as encode", () => {
    const beat = (note: string) => ({
      type: "heartbeat" as const,
      from: PAYER,
      contract: "0x" + "11".repeat(32),
      nonce: "0123456789abcdef",
      note,
    });
    // Grow the note until the line lands exactly on the cap: both halves must still take it.
    const spare = MAX_FRAME_CHARS - encodeFrame(beat("x")).length;
    const atCap = beat("x".repeat(1 + spare));
    expect(encodeFrame(atCap).length).toBe(MAX_FRAME_CHARS);
    expect(decodeFrame(encodeFrame(atCap))).toEqual(atCap);

    // One character more, and neither half takes it.
    const overCap = beat("x".repeat(2 + spare));
    const line = `${TCLK_PREFIX}${canonicalJson(overCap)}`;
    expect(line.length).toBe(MAX_FRAME_CHARS + 1);
    expect(() => encodeFrame(overCap)).toThrow(/room-message cap/);
    expect(() => decodeFrame(line)).toThrow(/room-message cap/);
    expect(tryDecodeFrame(line)).toBeNull();

    // The bound is what keeps one doctored export row from costing a fold a megabyte of parsing.
    const megabyte = `${TCLK_PREFIX}${canonicalJson(beat("x".repeat(1_000_000)))}`;
    expect(tryDecodeFrame(megabyte)).toBeNull();
  });
});
