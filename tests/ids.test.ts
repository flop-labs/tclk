/**
 * `offerId` and `contractId` hash exactly the fields their contracts document, whatever
 * else the object passed in happens to carry. A decoded frame is the common caller: an
 * auditor re-deriving ids from the wire must get the ids the sender posted.
 */

import { describe, it, expect } from "vitest";

import { contractId, makeAccept, makeOffer, offerId } from "../src/index.js";

const PAYER_DID = "did:key:z6Mk" + "f".repeat(44);
const PAYEE_DID = "did:key:z6Mk" + "g".repeat(44);

const offer = makeOffer({
  from: PAYER_DID,
  role: "payer",
  amount: "1000000",
  asset: "FLOP",
  lock: "hash",
  rails: ["paper"],
  claimByMs: 1756703600000,
  refundAfterMs: 1756707200000,
  expiresMs: 1756700600000,
  nonce: "0f1e2d3c4b5a6978",
});
const accept = makeAccept(offer, { from: PAYEE_DID, statement: "0x" + "ab".repeat(32) });

describe("offerId", () => {
  it("is idempotent over a full offer frame (the id it carries is not hashed)", () => {
    expect(offerId(offer)).toBe(offer.id);
  });

  it("ignores keys outside the documented offer fields", () => {
    const withExtra = { ...offer, extra: "z", contract: "0x" + "cd".repeat(32), nested: { a: 1 } } as typeof offer;
    expect(offerId(withExtra)).toBe(offer.id);
  });

  it("still binds the optional job and paymentKey when present", () => {
    const withJob = makeOffer({
      from: PAYER_DID, role: "payer", amount: "1", asset: "FLOP", lock: "hash", rails: ["paper"],
      claimByMs: 1756703600000, refundAfterMs: 1756707200000, expiresMs: 1756700600000,
      nonce: "0f1e2d3c4b5a6978", job: { proto: "a2a", id: "task-1" },
    });
    expect(withJob.id).not.toBe(offer.id);
    expect(offerId(withJob)).toBe(withJob.id);
  });
});

describe("contractId", () => {
  it("derives the posted contract id from the full accept frame", () => {
    expect(contractId(offer, accept)).toBe(accept.contract);
  });

  it("ignores keys outside the acceptance core", () => {
    const core = { from: accept.from, ref: accept.ref, statement: accept.statement, nonce: accept.nonce };
    const withExtra = { ...core, extra: "z" } as typeof core & { extra: string };
    expect(contractId(offer, withExtra)).toBe(contractId(offer, core));
  });

  it("still binds paymentKey when the acceptance names one", () => {
    const core = { from: accept.from, ref: accept.ref, statement: accept.statement, nonce: accept.nonce };
    const keyed = { ...core, paymentKey: "02" + "11".repeat(32) };
    expect(contractId(offer, keyed)).not.toBe(contractId(offer, core));
  });
});
