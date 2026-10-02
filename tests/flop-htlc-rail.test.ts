/**
 * Tests for the flop-htlc rail against the deterministic mock chain.
 *
 * Nothing here touches a network or a key. What is worth testing is that the rail enforces
 * the yellow paper §10 predicates in the chain's own time domain (block height, finalized
 * head for redeem and refund), maps tclk's ms deadlines onto it without a fail-open hole,
 * and refuses to vouch for an escrow that does not leave the payee the R10.2 room.
 */

import { describe, it, expect } from "vitest";

import {
  FlopHtlcRail,
  FlopRpcChainClient,
  FLOP_HTLC_PARAMS_V050,
  MockFlopChain,
  blocksUntil,
  flopHtlcTimelock,
  timelockSymmetryMinimum,
  applyFrame,
  generateHashLock,
  generatePointLock,
  lockTerms,
  makeAccept,
  makeOffer,
  openContract,
  type FlopChainClient,
  type FlopChainHead,
  type FlopHtlcRecord,
  type LockTerms,
} from "../src/index.js";

const PAYER_DID = "did:key:z6Mk" + "f".repeat(44);
const PAYEE_DID = "did:key:z6Mk" + "g".repeat(44);
/** Genesis wall time; block n has timestamp T0 + n * 1000. */
const T0 = 1_756_700_000_000;
const CLAIM_BY = T0 + 3_600_000; // 3600 blocks out
const REFUND_AFTER = T0 + 7_200_000; // 7200 blocks out — exactly the R10.2 minimum at lag 0

function terms(
  overrides: Partial<{ claimByMs: number; refundAfterMs: number; lock: "hash" | "point" }> = {},
) {
  const lock = overrides.lock ?? "hash";
  const secret = lock === "hash" ? generateHashLock() : generatePointLock();
  const statement = "hash" in secret ? secret.hash : secret.statement;
  const key = "0x02" + "7".repeat(64);
  const offer = makeOffer({
    from: PAYER_DID,
    role: "payer",
    lock,
    amount: "1000000",
    asset: "FLOP",
    rails: ["flop-htlc"],
    claimByMs: overrides.claimByMs ?? CLAIM_BY,
    refundAfterMs: overrides.refundAfterMs ?? REFUND_AFTER,
    expiresMs: T0 + 600_000,
    nonce: "9f2c81d04c9e1f7a",
    ...(lock === "point" ? { paymentKey: key } : {}),
  } as Parameters<typeof makeOffer>[0]);
  const accept = makeAccept(offer, {
    from: PAYEE_DID,
    statement,
    ...(lock === "point" ? { paymentKey: key } : {}),
  });
  const state = applyFrame(openContract(offer), accept, T0).state;
  return {
    state,
    terms: lockTerms(state),
    secret: "preimage" in secret ? secret.preimage : secret.witness,
  };
}

function setup(chainOptions: ConstructorParameters<typeof MockFlopChain>[0] = {}) {
  const chain = new MockFlopChain({ genesisMs: T0, ...chainOptions });
  return { chain, rail: new FlopHtlcRail(chain) };
}

/**
 * An injected, read-only chain client: fixed heads, and fixed escrows served under whatever
 * ids the test hands it. It mints nothing and parses nothing — the string that reaches
 * `getHtlc` is looked up as-is and recorded in `asked`. Writes throw; nothing here needs them.
 */
function readOnlyChain(escrows: ReadonlyMap<string, FlopHtlcRecord>, head: FlopChainHead) {
  const asked: string[] = [];
  const write = async (): Promise<never> => {
    throw new Error("read-only test client");
  };
  const client: FlopChainClient = {
    bestHead: async () => ({ ...head }),
    finalizedHead: async () => ({ ...head }),
    params: async () => ({ ...FLOP_HTLC_PARAMS_V050 }),
    getHtlc: async (id) => {
      asked.push(id);
      const held = escrows.get(id);
      return held === undefined ? null : { ...held };
    },
    createHtlc: write,
    redeemHtlc: write,
    refundHtlc: write,
  };
  return { client, asked };
}

type LockedDeal = ReturnType<typeof terms> & { ref: string };

/** Lock `n` fresh deals on `rail` at the chain's current height, each with its escrow ref. */
async function lockDeals(rail: FlopHtlcRail, n: number): Promise<LockedDeal[]> {
  const deals: LockedDeal[] = [];
  for (let i = 0; i < n; i++) {
    const deal = terms();
    deals.push({ ...deal, ref: await rail.lock(deal.terms) });
  }
  return deals;
}

/** "ok" when `op` resolves, otherwise the message it rejected with. */
async function outcome(op: () => Promise<unknown>): Promise<string> {
  try {
    await op();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("flop-htlc rail — lifecycle on the mock chain", () => {
  it("locks, verifies, and claims with the preimage; the chain records the redeem", async () => {
    const { chain, rail } = setup();
    const deal = terms();

    const ref = await rail.lock(deal.terms);
    expect(ref).toMatch(/^flop-htlc-mock-/);
    expect(await rail.verifyLock(deal.terms, ref)).toBe(true);

    const record = await chain.getHtlc(ref);
    expect(record).toMatchObject({
      status: "created", hash: deal.terms.statement, amount: "1000000", asset: "FLOP",
      payer: PAYER_DID, payee: PAYEE_DID, createdBlock: 0, timelockBlock: 7200,
    });

    chain.mine(100);
    await rail.claim(ref, deal.secret);
    expect(await rail.status(ref)).toBe("settled");
    expect((await chain.getHtlc(ref))?.preimage).toBe(deal.secret);
    // A claimed escrow is no longer a live lock.
    expect(await rail.verifyLock(deal.terms, ref)).toBe(false);
  });

  it("carries the ref through the tclk frames: lock → reveal folds to claimed", async () => {
    const { rail } = setup();
    const deal = terms();
    const ref = await rail.lock(deal.terms);

    let state = deal.state;
    const locked = applyFrame(
      state,
      { type: "lock", from: PAYER_DID, contract: state.contract!, rail: "flop-htlc", ref },
      T0 + 1_000,
    );
    expect(locked.ok).toBe(true);
    state = locked.state;
    await rail.claim(ref, deal.secret);
    const revealed = applyFrame(
      state,
      { type: "reveal", from: PAYEE_DID, contract: state.contract!, secret: deal.secret, ref },
      T0 + 2_000,
    );
    expect(revealed.ok).toBe(true);
    expect(revealed.state.status).toBe("claimed");
  });

  it("refunds once T_lock is finalized, and not before it is", async () => {
    const { chain, rail } = setup();
    const deal = terms();
    const ref = await rail.lock(deal.terms);

    chain.mine(7199);
    await expect(rail.refund(ref)).rejects.toThrow(/refund before T_lock is finalized/);
    expect(await rail.status(ref)).toBe("created");

    chain.mine(1); // finalized == best == 7200 == T_lock
    await rail.refund(ref);
    expect(await rail.status(ref)).toBe("refunded");
    await expect(rail.claim(ref, deal.secret)).rejects.toThrow(/claim on a refunded escrow/);
  });

  it("R10.3: a refund is gated on the finalized head, never on the tip", async () => {
    const { chain, rail } = setup();
    const deal = terms();
    const ref = await rail.lock(deal.terms);

    chain.holdFinality = true;
    chain.mine(7300); // tip well past T_lock, finality stuck at 0
    expect((await chain.finalizedHead()).number).toBe(0);
    await expect(rail.refund(ref)).rejects.toThrow(/before T_lock is finalized/);

    chain.finalize(7199);
    await expect(rail.refund(ref)).rejects.toThrow(/before T_lock is finalized/);
    chain.finalize(7200);
    await rail.refund(ref);
    expect(await rail.status(ref)).toBe("refunded");
  });

  it("rejects a wrong preimage and leaves the escrow claimable", async () => {
    const { chain, rail } = setup();
    const deal = terms();
    const ref = await rail.lock(deal.terms);

    const wrong = generateHashLock().preimage;
    await expect(rail.claim(ref, wrong)).rejects.toThrow(/secret does not open the statement/);
    await expect(rail.claim(ref, "0x" + "0".repeat(62))).rejects.toThrow(/secret does not open/);
    await expect(rail.claim(ref, "not-hex")).rejects.toThrow(/secret does not open/);
    expect(await rail.status(ref)).toBe("created");

    // The mock chain checks the hash itself too — the rail is not the only gate.
    await expect(chain.redeemHtlc(ref, wrong)).rejects.toThrow(/does not hash to H/);
    expect(await rail.status(ref)).toBe("created");

    await rail.claim(ref, deal.secret);
    expect(await rail.status(ref)).toBe("settled");
  });

  it("R10.1: at most one of redeem/refund — a replayed claim or a later refund fails", async () => {
    const { chain, rail } = setup();
    const deal = terms();
    const ref = await rail.lock(deal.terms);

    await rail.claim(ref, deal.secret);
    await expect(rail.claim(ref, deal.secret)).rejects.toThrow(/claim on a settled escrow/);
    chain.mine(8000);
    await expect(rail.refund(ref)).rejects.toThrow(/refund on a settled escrow/);
    await expect(chain.refundHtlc(ref)).rejects.toThrow(/refund_htlc on a settled escrow/);
    expect(await rail.status(ref)).toBe("settled");
  });

  it("holds the claim / refund boundary at T_lock on the finalized head: claim < T_lock, refund >= T_lock", async () => {
    // Two escrows so each side of the boundary is exercised from the same height. Finality
    // follows the tip here; the stalled-finality cases are in the R2.2 block below.
    const { chain, rail } = setup();
    const a = terms();
    const b = terms();
    const refA = await rail.lock(a.terms);
    const refB = await rail.lock(b.terms);

    chain.mine(7199); // finalized == best == T_lock - 1
    expect((await chain.finalizedHead()).number).toBe(7199);
    await expect(rail.refund(refA)).rejects.toThrow(/before T_lock/);
    await rail.claim(refA, a.secret);
    expect(await rail.status(refA)).toBe("settled");

    chain.mine(1); // finalized == best == T_lock
    expect((await chain.finalizedHead()).number).toBe(7200);
    await expect(rail.claim(refB, b.secret)).rejects.toThrow(/claim at\/after T_lock on the finalized head/);
    await rail.refund(refB);
    expect(await rail.status(refB)).toBe("refunded");
  });

  it("unknown escrow ids are rejected on every path", async () => {
    const { rail } = setup();
    const deal = terms();
    await expect(rail.claim("flop-htlc-mock-999", deal.secret)).rejects.toThrow(/unknown escrow/);
    await expect(rail.refund("flop-htlc-mock-999")).rejects.toThrow(/unknown escrow/);
    await expect(rail.claim("", deal.secret)).rejects.toThrow(/needs an escrow id/);
    expect(await rail.verifyLock(deal.terms, "flop-htlc-mock-999")).toBe(false);
    expect(await rail.verifyLock(deal.terms, "")).toBe(false);
    expect(await rail.status("flop-htlc-mock-999")).toBeUndefined();
  });
});

describe("flop-htlc rail — a finality stall freezes the claim deadline too (R2.2, §1.2 / §13 F1)", () => {
  it("the #171 review case: T_lock 7200, best 7200, finalized 7190 — claim stays open until T_lock is finalized", async () => {
    // Redeem releases funds, so like refund it reads the finalized prefix, never the tip
    // (R2.2), and a finality stall freezes its deadline with the refund's (§1.2, §13 F1).
    // A tip-clocked claim is refused here while the refund is refused too.
    const { chain, rail } = setup();
    const [a, b, c, d, e, f, g] = await lockDeals(rail, 7);
    for (const deal of [a, b, c, d, e, f, g]) {
      expect((await chain.getHtlc(deal.ref))?.timelockBlock).toBe(7200); // T_lock
    }
    // One claim through the rail, one redeem straight on the mock chain: both must admit it.
    const claimOnBoth = async (viaRail: LockedDeal, viaChain: LockedDeal) => {
      await rail.claim(viaRail.ref, viaRail.secret);
      await chain.redeemHtlc(viaChain.ref, viaChain.secret);
      expect([await rail.status(viaRail.ref), await rail.status(viaChain.ref)]).toEqual(["settled", "settled"]);
    };

    chain.mine(7190); // finality follows the tip up to 7190 ...
    chain.holdFinality = true;
    chain.mine(10); // ... then stalls while the tip reaches T_lock
    expect((await chain.bestHead()).number).toBe(7200);
    expect((await chain.finalizedHead()).number).toBe(7190);
    await expect(rail.refund(a.ref)).rejects.toThrow(/refund before T_lock is finalized/);
    await claimOnBoth(a, b);

    chain.mine(1800); // the tip runs on, 1800 blocks past T_lock; finality still at 7190
    expect((await chain.bestHead()).number).toBe(9000);
    await expect(rail.refund(c.ref)).rejects.toThrow(/refund before T_lock is finalized/);
    await claimOnBoth(c, d);

    chain.finalize(7199); // finalized == T_lock - 1: still the claim side
    await expect(rail.refund(e.ref)).rejects.toThrow(/refund before T_lock is finalized/);
    await claimOnBoth(e, f);

    chain.finalize(7200); // finalized == T_lock: the claim side closes, the refund side opens
    await expect(rail.claim(g.ref, g.secret)).rejects.toThrow(
      /claim at\/after T_lock on the finalized head \(finalized 7200, T_lock 7200\)/,
    );
    await expect(chain.redeemHtlc(g.ref, g.secret)).rejects.toThrow(/redeem_htlc at\/after T_lock on the finalized head/);
    expect(await rail.status(g.ref)).toBe("created");
    await rail.refund(g.ref);
    expect(await rail.status(g.ref)).toBe("refunded");

    // Never both (R10.1): the settled escrows do not refund, the refunded one does not settle.
    for (const deal of [a, b, c, d, e, f]) {
      await expect(rail.refund(deal.ref)).rejects.toThrow(/refund on a settled escrow/);
    }
    await expect(rail.claim(g.ref, g.secret)).rejects.toThrow(/claim on a refunded escrow/);
  });

  it("R10.1 under R2.2: at every finalized height exactly one of redeem/refund is admissible, wherever the tip is", async () => {
    const { chain, rail } = setup();
    // [best, finalized], in chain order. Every escrow is locked at block 0, so T_lock = 7200.
    const steps: Array<[number, number]> = [
      [7190, 7190], [7200, 7190], [7201, 7190], [9000, 7190], [9000, 7199], [9000, 7200], [9000, 9000],
    ];
    // Four fresh escrows per step, one per gate, so no attempt consumes another's escrow.
    const deals = await lockDeals(rail, steps.length * 4);
    chain.holdFinality = true;
    for (const [i, [best, finalized]] of steps.entries()) {
      chain.mine(best - (await chain.bestHead()).number);
      chain.finalize(finalized);
      const [toClaim, toRedeem, toRefund, toChainRefund] = deals.slice(i * 4, i * 4 + 4);
      const got = {
        railClaim: await outcome(() => rail.claim(toClaim.ref, toClaim.secret)),
        chainRedeem: await outcome(() => chain.redeemHtlc(toRedeem.ref, toRedeem.secret)),
        railRefund: await outcome(() => rail.refund(toRefund.ref)),
        chainRefund: await outcome(() => chain.refundHtlc(toChainRefund.ref)),
      };
      const at = `best ${best}, finalized ${finalized}`;
      if (finalized < 7200) {
        expect(got, at).toEqual({
          railClaim: "ok",
          chainRedeem: "ok",
          railRefund: expect.stringMatching(/refund before T_lock is finalized/),
          chainRefund: expect.stringMatching(/refund_htlc before T_lock is finalized/),
        });
      } else {
        expect(got, at).toEqual({
          railClaim: expect.stringMatching(/claim at\/after T_lock on the finalized head/),
          chainRedeem: expect.stringMatching(/redeem_htlc at\/after T_lock on the finalized head/),
          railRefund: "ok",
          chainRefund: "ok",
        });
      }
    }
  });
});

describe("flop-htlc rail — verifyLock is the payee's gate", () => {
  it("is false when any term differs: parties, statement, amount, asset", async () => {
    const { rail } = setup();
    const deal = terms();
    const ref = await rail.lock(deal.terms);
    expect(await rail.verifyLock(deal.terms, ref)).toBe(true);

    const swap = (patch: Partial<LockTerms>) => rail.verifyLock({ ...deal.terms, ...patch }, ref);
    expect(await swap({ payer: PAYEE_DID, payee: PAYER_DID })).toBe(false);
    expect(await swap({ payee: "did:key:z6Mk" + "h".repeat(44) })).toBe(false);
    expect(await swap({ statement: terms().terms.statement })).toBe(false);
    expect(await swap({ amount: "1000001" })).toBe(false);
    expect(await swap({ asset: "PAPER" })).toBe(false);
    expect(await swap({ lock: "point" })).toBe(false);
  });

  it("is false for an escrow whose timelock leaves less than the R10.2 room", async () => {
    const { chain, rail } = setup();
    const deal = terms();
    // Same terms, but the escrow was created on the chain with a short timelock.
    const short = await chain.createHtlc({
      payer: PAYER_DID, payee: PAYEE_DID, amount: "1000000", asset: "FLOP",
      hash: deal.terms.statement, timelockBlock: 7199,
    });
    expect(await rail.verifyLock(deal.terms, short)).toBe(false);
    const exact = await chain.createHtlc({
      payer: PAYER_DID, payee: PAYEE_DID, amount: "1000000", asset: "FLOP",
      hash: deal.terms.statement, timelockBlock: 7200,
    });
    expect(await rail.verifyLock(deal.terms, exact)).toBe(true);
  });

  it("stops vouching once the tip moves so far that claimByMs is behind it", async () => {
    const { chain, rail } = setup();
    const deal = terms();
    const ref = await rail.lock(deal.terms);
    chain.mine(3599);
    expect(await rail.verifyLock(deal.terms, ref)).toBe(true);
    chain.mine(1); // tip == claimBy block, T_other == 0
    expect(await rail.verifyLock(deal.terms, ref)).toBe(false);
  });

  it("is false, never a throw, when the chain misbehaves", async () => {
    const { chain, rail } = setup();
    const deal = terms();
    const ref = await rail.lock(deal.terms);
    chain.getHtlc = async () => { throw new Error("rpc down"); };
    expect(await rail.verifyLock(deal.terms, ref)).toBe(false);
  });

  it("reads ref as an opaque id: a flop-rail-tx-… ref and a full 0x ref get identical verdicts", async () => {
    // Live lock frames carry both shapes (reported on #171). SPEC §3.3 leaves the lock `ref`
    // rail-specific and validateFrame requires only a non-empty string, so neither the rail nor
    // a later RPC adapter behind getHtlc(id) may read a prefix or a length into it.
    const deal = terms();
    const txRef = "flop-rail-tx-5f1d0c8a2b7e4396"; // suffix illustrative; only the shape matters
    const contractRef = deal.terms.contract; // the exact full 0x<contract> id
    expect(contractRef).toMatch(/^0x[0-9a-f]{64}$/);

    const tip = { number: 100, timestampMs: T0 + 100_000 };
    // The escrow `lock` creates for these terms at block 0 (T_lock 7200), which at block 100
    // still leaves exactly the R10.2 room.
    const live: Omit<FlopHtlcRecord, "id"> = {
      payer: PAYER_DID, payee: PAYEE_DID, amount: "1000000", asset: "FLOP",
      hash: deal.terms.statement, timelockBlock: 7200, createdBlock: 0, status: "created",
    };
    const cases: Array<[string, Omit<FlopHtlcRecord, "id">, boolean]> = [
      ["matching escrow", live, true],
      ["wrong amount", { ...live, amount: "999999" }, false],
      ["wrong hashlock", { ...live, hash: generateHashLock().hash }, false],
      ["expired: T_lock already reached at the tip", { ...live, timelockBlock: tip.number }, false],
    ];
    for (const [name, body, expected] of cases) {
      // One client, the same escrow under both ids; only `id` differs.
      const { client, asked } = readOnlyChain(
        new Map<string, FlopHtlcRecord>([
          [txRef, { ...body, id: txRef }],
          [contractRef, { ...body, id: contractRef }],
        ]),
        tip,
      );
      const rail = new FlopHtlcRail(client);
      const verdicts = [
        await rail.verifyLock(deal.terms, txRef),
        await rail.verifyLock(deal.terms, contractRef),
      ];
      expect(verdicts, name).toEqual([expected, expected]);
      // The client was asked for these two strings and nothing else: no prefix stripped,
      // nothing re-cased, cut, or derived from the ref.
      expect(new Set(asked), name).toEqual(new Set([txRef, contractRef]));
    }
  });
});

describe("flop-htlc rail — fail closed on every operand", () => {
  it("refuses deadlines that are not positive unix-ms integers", async () => {
    const { chain, rail } = setup();
    const deal = terms();
    const bad = [Number.NaN, undefined, Number.POSITIVE_INFINITY, -1, 0, 1.5, "1"] as unknown[];
    for (const value of bad) {
      await expect(rail.lock({ ...deal.terms, claimByMs: value as number })).rejects.toThrow(
        /deadlines must be positive unix-ms integers/,
      );
      await expect(rail.lock({ ...deal.terms, refundAfterMs: value as number })).rejects.toThrow(
        /deadlines must be positive unix-ms integers/,
      );
    }
    // Ordering is enforced here too, not only in validateFrame.
    await expect(
      rail.lock({ ...deal.terms, claimByMs: REFUND_AFTER, refundAfterMs: CLAIM_BY }),
    ).rejects.toThrow(/strictly before/);
    await expect(rail.lock({ ...deal.terms, refundAfterMs: CLAIM_BY })).rejects.toThrow(/strictly before/);
    // Nothing was created on the chain by any of those.
    expect(await chain.getHtlc("flop-htlc-mock-1")).toBeNull();
  });

  it("refuses to lock when claimByMs is not in the chain's future", async () => {
    const { chain, rail } = setup();
    const deal = terms();
    chain.mine(3600);
    await expect(rail.lock(deal.terms)).rejects.toThrow(/claimByMs is not in the future/);
  });

  it("R10.2: refuses a refund window that does not clear the symmetry margin", async () => {
    const { rail } = setup();
    // claimBy 3600 blocks out → required 3600 + max(720, 3600 + 0) = 7200. One block short:
    const short = terms({ refundAfterMs: REFUND_AFTER - 1_000 });
    await expect(rail.lock(short.terms)).rejects.toThrow(/R10\.2.*7199 blocks offered, 7200 required/);
    // Exactly at the minimum is admitted (>=, matching the paper's "MUST satisfy").
    await rail.lock(terms().terms);
  });

  it("R10.2: an observed finality lag raises the required window", async () => {
    const { chain, rail } = setup();
    chain.holdFinality = true;
    chain.mine(0);
    // Advance the tip 10 blocks with finality stuck: lag 10. Deadlines are wall-clock, so
    // recompute them from the new tip so T_other stays 3600 and T_FLOP stays 7200.
    chain.mine(10);
    const best = await chain.bestHead();
    const deal = terms({ claimByMs: best.timestampMs + 3_600_000, refundAfterMs: best.timestampMs + 7_200_000 });
    await expect(rail.lock(deal.terms)).rejects.toThrow(/7200 blocks offered, 7210 required.*lag 10/);
    chain.finalize();
    await rail.lock(deal.terms);
  });

  it("refuses point locks: yellow paper §10 defines only H = SHA256(s)", async () => {
    const { rail } = setup();
    const deal = terms({ lock: "point" });
    await expect(rail.lock(deal.terms)).rejects.toThrow(/hash locks only/);
    expect(await rail.verifyLock(deal.terms, "flop-htlc-mock-1")).toBe(false);
  });

  it("refuses terms that name another asset, a malformed amount, or the same party twice", async () => {
    const { rail } = setup();
    const deal = terms();
    await expect(rail.lock({ ...deal.terms, asset: "PAPER" })).rejects.toThrow(/settles FLOP, terms name PAPER/);
    await expect(rail.lock({ ...deal.terms, amount: "0" })).rejects.toThrow(/positive decimal string/);
    await expect(rail.lock({ ...deal.terms, amount: "1e6" })).rejects.toThrow(/positive decimal string/);
    await expect(rail.lock({ ...deal.terms, payee: PAYER_DID })).rejects.toThrow(/must differ/);
    await expect(rail.lock({ ...deal.terms, statement: "0xabc" })).rejects.toThrow(/32-byte 0x-hex/);
    const other = new FlopHtlcRail(new MockFlopChain({ genesisMs: T0 }), { asset: "PAPER" });
    await expect(other.lock(deal.terms)).rejects.toThrow(/settles PAPER, terms name FLOP/);
  });

  it("refuses a chain head that is not a time, on lock, claim and refund", async () => {
    const { chain, rail } = setup();
    const deal = terms();
    const ref = await rail.lock(deal.terms);
    const badHead = /not a usable block reference/;

    const bads: FlopChainHead[] = [
      { number: Number.NaN, timestampMs: T0 },
      { number: 10, timestampMs: Number.NaN },
      { number: -1, timestampMs: T0 },
      { number: 10, timestampMs: 0 },
      { number: 1.5, timestampMs: T0 },
      { number: Number.POSITIVE_INFINITY, timestampMs: T0 },
    ];
    for (const bad of bads) {
      chain.bestHead = async () => bad;
      chain.finalizedHead = async () => bad;
      await expect(rail.lock(terms().terms)).rejects.toThrow(badHead);
      await expect(rail.claim(ref, deal.secret)).rejects.toThrow(badHead);
      await expect(rail.refund(ref)).rejects.toThrow(badHead);
      expect(await rail.verifyLock(deal.terms, ref)).toBe(false);
    }
    expect(await rail.status(ref)).toBe("created");
  });

  it("refuses malformed chain params rather than defaulting them", async () => {
    const { chain, rail } = setup();
    const deal = terms();
    for (const params of [
      { marginPercent: Number.NaN, maxFinalityStallBlocks: 3600 },
      { marginPercent: 20, maxFinalityStallBlocks: -1 },
      { marginPercent: 20 },
      null,
    ]) {
      chain.params = async () => params as never;
      await expect(rail.lock(deal.terms)).rejects.toThrow(/chain params are malformed/);
    }
  });
});

describe("flop-htlc timelock arithmetic (yellow paper §10 R10.2)", () => {
  it("timelockSymmetryMinimum takes the larger of the percent and finality margins", () => {
    const p = FLOP_HTLC_PARAMS_V050;
    expect(p).toEqual({ marginPercent: 20, maxFinalityStallBlocks: 3600 });
    expect(timelockSymmetryMinimum(3600, p, 0)).toBe(7200); // finality margin wins
    expect(timelockSymmetryMinimum(3600, p, 100)).toBe(7300);
    expect(timelockSymmetryMinimum(100_000, p, 0)).toBe(120_000); // percent margin wins
    expect(timelockSymmetryMinimum(1, p, 0)).toBe(3601);
    expect(timelockSymmetryMinimum(0, p, 0)).toBe(3600);
    expect(timelockSymmetryMinimum(7, { marginPercent: 15, maxFinalityStallBlocks: 0 }, 0)).toBe(9); // ceil(1.05)
  });

  it("timelockSymmetryMinimum refuses operands that are not counts", () => {
    const p = FLOP_HTLC_PARAMS_V050;
    expect(() => timelockSymmetryMinimum(Number.NaN, p, 0)).toThrow(/T_other/);
    expect(() => timelockSymmetryMinimum(-1, p, 0)).toThrow(/T_other/);
    expect(() => timelockSymmetryMinimum(1, p, Number.NaN)).toThrow(/finality lag/);
    expect(() => timelockSymmetryMinimum(1, p, -1)).toThrow(/finality lag/);
    expect(() => timelockSymmetryMinimum(1, { marginPercent: 20, maxFinalityStallBlocks: Number.NaN }, 0)).toThrow(/params/);
  });

  it("blocksUntil rounds up at one block per second and can be non-positive", () => {
    const head = { number: 100, timestampMs: T0 };
    expect(blocksUntil(head, T0 + 1)).toBe(1);
    expect(blocksUntil(head, T0 + 1000)).toBe(1);
    expect(blocksUntil(head, T0 + 1001)).toBe(2);
    expect(blocksUntil(head, T0)).toBe(0);
    expect(blocksUntil(head, T0 - 5000)).toBe(-5);
    expect(() => blocksUntil(head, Number.NaN)).toThrow(/positive unix-ms/);
    expect(() => blocksUntil({ number: Number.NaN, timestampMs: T0 }, T0)).toThrow(/block reference/);
  });

  it("flopHtlcTimelock projects terms from the tip and reports the verdict", () => {
    const best = { number: 50, timestampMs: T0 + 50_000 };
    const finalized = { number: 45, timestampMs: T0 + 45_000 };
    const window = flopHtlcTimelock({ claimByMs: CLAIM_BY, refundAfterMs: REFUND_AFTER }, best, finalized, FLOP_HTLC_PARAMS_V050);
    expect(window).toEqual({
      tOther: 3550, tFlop: 7150, required: 3550 + 3605, finalityLag: 5, timelockBlock: 7200, ok: false,
    });
    expect(() => flopHtlcTimelock({ claimByMs: CLAIM_BY, refundAfterMs: REFUND_AFTER }, finalized, best, FLOP_HTLC_PARAMS_V050))
      .toThrow(/finalized head is ahead/);
    expect(() => flopHtlcTimelock({ claimByMs: Number.NaN, refundAfterMs: REFUND_AFTER }, best, finalized, FLOP_HTLC_PARAMS_V050))
      .toThrow(/positive unix-ms/);
  });
});

describe("mock chain and RPC stub", () => {
  it("the mock refuses a malformed create_htlc and a timelock that is not in the future", async () => {
    const chain = new MockFlopChain({ genesisMs: T0, height: 10 });
    const base = { payer: "a", payee: "b", amount: "1", asset: "FLOP", hash: "0x" + "a".repeat(64), timelockBlock: 11 };
    await expect(chain.createHtlc({ ...base, timelockBlock: 10 })).rejects.toThrow(/future block height/);
    await expect(chain.createHtlc({ ...base, timelockBlock: Number.NaN })).rejects.toThrow(/future block height/);
    await expect(chain.createHtlc({ ...base, hash: "0x" + "A".repeat(64) })).rejects.toThrow(/sha256 digest/);
    await expect(chain.createHtlc({ ...base, amount: "-1" })).rejects.toThrow(/positive decimal/);
    await expect(chain.createHtlc({ ...base, payer: "" })).rejects.toThrow(/payer and payee/);
    expect(await chain.createHtlc(base)).toBe("flop-htlc-mock-1");
    expect(() => chain.finalize(12)).toThrow(/\[finalized, best\]/);
    expect(() => chain.mine(-1)).toThrow(/non-negative/);
    expect(() => new MockFlopChain({ genesisMs: 0 })).toThrow(/genesis/);
  });

  it("the mock's heads are one second apart and getHtlc returns copies", async () => {
    const chain = new MockFlopChain({ genesisMs: T0 });
    chain.mine(3);
    expect(await chain.bestHead()).toEqual({ number: 3, timestampMs: T0 + 3000 });
    const id = await chain.createHtlc({ payer: "a", payee: "b", amount: "1", asset: "FLOP", hash: "0x" + "a".repeat(64), timelockBlock: 9 });
    const copy = (await chain.getHtlc(id))!;
    copy.status = "settled";
    expect((await chain.getHtlc(id))!.status).toBe("created");
  });

  it("the RPC stub names its endpoint, holds no keys, and throws on every call", async () => {
    expect(() => new FlopRpcChainClient("")).toThrow(/endpoint/);
    const rpc = new FlopRpcChainClient("wss://example.invalid");
    expect(Object.keys(rpc)).toEqual(["endpoint"]);
    const unwired = /not wired/;
    await expect(rpc.bestHead()).rejects.toThrow(unwired);
    await expect(rpc.finalizedHead()).rejects.toThrow(unwired);
    await expect(rpc.params()).rejects.toThrow(unwired);
    await expect(rpc.getHtlc("x")).rejects.toThrow(unwired);
    await expect(rpc.createHtlc({ payer: "a", payee: "b", amount: "1", asset: "FLOP", hash: "0x" + "a".repeat(64), timelockBlock: 1 })).rejects.toThrow(unwired);
    await expect(rpc.redeemHtlc("x", "0x" + "0".repeat(64))).rejects.toThrow(unwired);
    await expect(rpc.refundHtlc("x")).rejects.toThrow(unwired);
    // And the rail on top of it fails closed rather than pretending.
    const rail = new FlopHtlcRail(rpc);
    await expect(rail.lock(terms().terms)).rejects.toThrow(unwired);
    expect(await rail.verifyLock(terms().terms, "x")).toBe(false);
  });
});
