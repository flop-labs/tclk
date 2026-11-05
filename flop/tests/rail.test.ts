// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { base58, base64urlnopad } from "@scure/base";
import {
  hashLockFromPreimage,
  canonicalJson,
  type LockTerms,
} from "@flop-labs/tclk";
import {
  FlopRail,
  FlopLockError,
  flopAccountFromDid,
  type FlopAdmissionBlock,
  type FlopChain,
  type FlopEscrow,
  type FlopSnapshot,
  type FlopOpenRequest,
} from "../src/rail.js";
import { resolveFlopConfig } from "../src/config.js";
import {
  FlopAdmissionError,
  type FlopSymmetryParams,
} from "../src/symmetry.js";
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const did = (n: number) =>
  `did:key:z${base58.encode(Uint8Array.from([0xed, 1, ...new Array(32).fill(n)]))}`;
const secret = h(42);
const T0 = 1_790_000_000_000;
function terms(): LockTerms {
  return {
    contract: h(3),
    lock: "hash",
    statement: hashLockFromPreimage(secret).hash,
    amount: "900719925474099312345",
    asset: "FLOP",
    payer: did(1),
    payee: did(2),
    claimByMs: T0 + 30_000,
    refundAfterMs: T0 + 60_000,
  };
}
// The mock runtime's R10.2 constants: small, so the short deadlines above pass. The R10.2
// cases below use the yellow paper's values, which devnet runtime 1014003 also reports.
const TEST_RUNTIME: FlopSymmetryParams = {
  marginPercent: 20,
  maxFinalityStallBlocks: 30,
  finalityFreezeThresholdBlocks: 10,
};
const YP: FlopSymmetryParams = {
  marginPercent: 20,
  maxFinalityStallBlocks: 3_600,
  finalityFreezeThresholdBlocks: 120,
};
class Chain implements FlopChain {
  account = flopAccountFromDid(did(1));
  head: FlopSnapshot = {
    genesis: h(1),
    hash: h(100),
    number: 100,
    timestampMs: T0,
    finalizedNumber: 99,
  };
  history = new Map([[this.head.hash, structuredClone(this.head)]]);
  held?: FlopEscrow;
  request?: FlopOpenRequest;
  witnesses?: readonly string[];
  opens = 0;
  claims = 0;
  refunds = 0;
  delay = 1;
  fail = false;
  /** The runtime's R10.2 constants, as every block reports them. */
  params: FlopSymmetryParams = { ...TEST_RUNTIME };
  /** The best block, when it runs ahead of the finalized head (a finality stall). */
  best?: { number: number; finalizedNumber: number };
  /** The runtime finality lag recorded in the block that includes an open. */
  inclusionLag = 1;
  async snapshot(_id?: string, at?: string): Promise<FlopSnapshot> {
    if (this.fail) throw new Error("RPC unavailable");
    if (at) return structuredClone(this.history.get(at)!);
    return structuredClone({ ...this.head, escrow: this.held });
  }
  async admissionBlock(height?: number): Promise<FlopAdmissionBlock> {
    if (this.fail) throw new Error("RPC unavailable");
    const block =
      height === undefined
        ? { ...this.head, ...this.best }
        : this.history.get(h(height));
    if (!block) throw new Error("no such block");
    return structuredClone({
      genesis: block.genesis,
      hash: h(block.number),
      number: block.number,
      finalizedNumber: block.finalizedNumber,
      params: this.params,
    });
  }
  async open(request: FlopOpenRequest): Promise<string> {
    this.opens++;
    this.request = request;
    this.tick(this.delay);
    // The including block records its own runtime finality prefix.
    this.head.finalizedNumber = this.head.number - this.inclusionLag;
    this.history.set(this.head.hash, structuredClone(this.head));
    this.held = {
      id: h(99),
      funder: this.account,
      payee: request.payee,
      amount: request.amount,
      policy: request.policy,
      deadline: this.head.number + request.deadlineBlocks,
      createdBlock: this.head.number,
      status: "Open",
    };
    return this.held.id;
  }
  async satisfy(_id: string, preimages: readonly string[]): Promise<void> {
    this.claims++;
    this.witnesses = preimages;
    this.held!.status = "Released";
  }
  async refund(): Promise<void> {
    this.refunds++;
    this.held!.status = "Refunded";
  }
  tick(n: number) {
    this.head.number += n;
    this.head.finalizedNumber = this.head.number - 1;
    this.head.timestampMs += n * 1000;
    this.head.hash = h(this.head.number);
    this.history.set(this.head.hash, structuredClone(this.head));
  }
}
function setup() {
  const chain = new Chain();
  const rail = new FlopRail(chain, {}, () => chain.head.timestampMs);
  return { chain, rail, t: terms() };
}
function rewrite(ref: string, update: (r: any) => void): string {
  const data = JSON.parse(
    new TextDecoder().decode(base64urlnopad.decode(ref.slice(6))),
  );
  update(data);
  return `${ref.slice(0, 6)}${base64urlnopad.encode(new TextEncoder().encode(canonicalJson(data)))}`;
}
describe("configuration", () => {
  it("defaults to devnet and exposes explicit timing assumptions", () => {
    expect(resolveFlopConfig()).toMatchObject({
      network: "devnet",
      rpcUrl: "wss://rpc.devnet.flop.network",
      blockTimeMs: 1000,
      refundMarginBlocks: 30,
    });
  });
  it.each(["testnet", "mainnet"] as const)(
    "requires explicit %s identity",
    (network) => {
      expect(() => resolveFlopConfig({ network })).toThrow("require");
      expect(
        resolveFlopConfig({
          network,
          rpcUrl: "wss://operator.example",
          expectedGenesisHash: h(2),
        }).network,
      ).toBe(network);
    },
  );
  it.each([
    { network: "invalid" },
    { rpcUrl: "https://example.com" },
    { rpcUrl: "ws://user:password@example.com" },
    { expectedGenesisHash: "0x00" },
    { blockTimeMs: NaN },
    { blockTimeMs: 0 },
    { refundMarginBlocks: -1 },
    { refundMarginBlocks: 0.5 },
  ])("rejects malformed config %j", (config) => {
    expect(() => resolveFlopConfig(config as any)).toThrow();
  });
  it("has no R10.2 option: the parameters come from the chain, never the caller", async () => {
    expect(resolveFlopConfig()).not.toHaveProperty("symmetry");
    const lax = {
      marginPercent: 0,
      maxFinalityStallBlocks: 0,
      finalityFreezeThresholdBlocks: 0xffffffff,
    };
    expect(resolveFlopConfig({ symmetry: lax } as any)).not.toHaveProperty(
      "symmetry",
    );
    const chain = new Chain();
    chain.params = { ...YP };
    const rail = new FlopRail(
      chain,
      { symmetry: lax } as any,
      () => chain.head.timestampMs,
    );
    await expect(rail.lock(terms())).rejects.toBeInstanceOf(
      FlopAdmissionError,
    );
    expect(chain.opens).toBe(0);
  });
});
describe("FlopRail", () => {
  it("locks integer base units with exactly two hash leaves and a conservative block deadline", async () => {
    const { chain, rail, t } = setup();
    const ref = await rail.lock(t);
    expect(rail.id).toBe("flop-htlc");
    expect(chain.request).toMatchObject({
      amount: t.amount,
      payee: flopAccountFromDid(t.payee),
      deadlineBlocks: 90,
      policy: { combinator: "And" },
    });
    expect(chain.request!.policy.clauses).toHaveLength(2);
    expect(chain.request!.policy.clauses[0]).toEqual({ Hash: t.statement });
    expect(await rail.verifyLock(t, ref)).toBe(true);
    // Another process can verify and claim without the payer's in-memory state.
    const payee = new FlopRail(chain, {}, () => chain.head.timestampMs);
    await payee.claim(ref, secret);
    expect(chain.claims).toBe(1);
    expect(chain.witnesses?.[0]).toBe(secret);
    expect(chain.witnesses).toHaveLength(2);
    expect(await rail.verifyLock(t, ref)).toBe(false);
    await expect(payee.claim(ref, secret)).rejects.toThrow("closed");
  });
  it("refunds only when both wall time and the runtime's finalized height permit it", async () => {
    const { chain, rail, t } = setup();
    const ref = await rail.lock(t);
    await expect(rail.refund(ref)).rejects.toThrow("not open");
    chain.tick(89); // block 190, finalized 189, deadline 191
    await expect(rail.refund(ref)).rejects.toThrow("not open");
    chain.tick(2);
    await rail.refund(ref);
    expect(chain.refunds).toBe(1);
    await expect(rail.refund(ref)).rejects.toThrow();
  });
  it("gates claim, refund and verifyLock on the runtime finality prefix, not the snapshot height", async () => {
    // The #171 review case in FlopRail's terms: the height reaches the deadline while
    // the runtime prefix lags 10 behind. A lagging prefix freezes the block deadline
    // for both fund-releasing paths (yellow paper R2.2).
    const { chain, rail, t } = setup();
    const ref = await rail.lock(t); // deadline 191
    const at = (number: number, prefix: number, timestampMs: number) => {
      Object.assign(chain.head, {
        number,
        finalizedNumber: prefix,
        timestampMs,
        hash: h(number),
      });
      chain.history.set(chain.head.hash, structuredClone(chain.head));
    };
    // Blocks ran faster than nominal: height 191 before claimByMs, prefix 181.
    at(191, 181, T0 + 20_000);
    expect(await rail.verifyLock(t, ref)).toBe(true);
    await expect(rail.claim(ref, h(7))).rejects.toThrow("secret"); // still open
    // Past refundAfterMs and 109 blocks past the deadline, prefix still 190.
    at(300, 190, T0 + 120_000);
    await expect(rail.refund(ref)).rejects.toThrow("not open");
    at(301, 191, T0 + 121_000);
    await rail.refund(ref);
    expect(chain.refunds).toBe(1);
    expect(chain.claims).toBe(0);
  });
  it("rejects a third-party refund but permits a relayed claim to the fixed payee", async () => {
    const { chain, rail, t } = setup();
    const ref = await rail.lock(t);
    chain.account = flopAccountFromDid(did(7));
    chain.tick(91);
    await expect(rail.refund(ref)).rejects.toThrow("not the payer");
    expect(chain.refunds).toBe(0);
  });
  it.each([
    "contract",
    "statement",
    "amount",
    "asset",
    "payer",
    "payee",
    "claimByMs",
    "refundAfterMs",
    "lock",
  ] as const)(
    "rejects substituted %s even if the reference is rewritten",
    async (field) => {
      const { chain, rail, t } = setup();
      const ref = await rail.lock(t);
      const replacement: Record<string, unknown> = {
        contract: h(44),
        statement: h(55),
        amount: "1",
        asset: "USDC",
        payer: did(9),
        payee: did(8),
        claimByMs: T0 + 31_000,
        refundAfterMs: T0 + 61_000,
        lock: "point",
      };
      const changed = { ...t, [field]: replacement[field] };
      expect(await rail.verifyLock(changed as LockTerms, ref)).toBe(false);
      expect(
        await rail.verifyLock(
          changed as LockTerms,
          rewrite(ref, (r) => {
            r.terms = changed;
          }),
        ),
      ).toBe(false);
      expect(chain.claims).toBe(0);
    },
  );
  it.each([
    "funder",
    "payee",
    "amount",
    "deadline",
    "status",
    "policy",
    "id",
    "createdBlock",
  ] as const)("checks chain field %s", async (field) => {
    const { chain, rail, t } = setup();
    const ref = await rail.lock(t);
    const values = {
      funder: h(88),
      payee: h(88),
      amount: "7",
      deadline: 900,
      status: "Released",
      policy: { combinator: "Or", clauses: chain.held!.policy.clauses },
      id: h(88),
      createdBlock: 102,
    };
    (chain.held as any)[field] = values[field];
    expect(await rail.verifyLock(t, ref)).toBe(false);
  });
  it("checks network, genesis, timing profile, anchor and canonical reference encoding", async () => {
    const { rail, chain, t } = setup();
    const ref = await rail.lock(t);
    for (const update of [
      (r: any) => (r.network = "testnet"),
      (r: any) => (r.genesis = h(2)),
      (r: any) => (r.anchor = h(98)),
      (r: any) => (r.blockTimeMs = 500),
      (r: any) => (r.refundMarginBlocks = 1),
      (r: any) => (r.extra = true),
      (r: any) => (r.v = 1),
      (r: any) => delete r.symmetry,
    ]) {
      const wrong = rewrite(ref, update);
      expect(await rail.verifyLock(t, wrong)).toBe(false);
      await expect(rail.claim(wrong, secret)).rejects.toThrow();
    }
    for (const bad of ["", ref + "=", "flop2.invalid", ref.slice(0, -4)])
      expect(await rail.verifyLock(t, bad)).toBe(false);
    chain.head.genesis = h(9);
    expect(await rail.verifyLock(t, ref)).toBe(false);
  });
  it("fails closed on unavailable/malformed chain data and stale claim windows", async () => {
    const { rail, chain, t } = setup();
    const ref = await rail.lock(t);
    chain.fail = true;
    expect(await rail.verifyLock(t, ref)).toBe(false);
    chain.fail = false;
    chain.head.finalizedNumber = NaN;
    expect(await rail.verifyLock(t, ref)).toBe(false);
    chain.head.finalizedNumber = 101;
    chain.tick(30);
    expect(await rail.verifyLock(t, ref)).toBe(false);
  });
  it("does not submit an incorrect or expired secret", async () => {
    const { rail, chain, t } = setup();
    const ref = await rail.lock(t);
    await expect(rail.claim(ref, h(7))).rejects.toThrow("secret");
    expect(chain.claims).toBe(0);
    chain.tick(59);
    await expect(rail.claim(ref, secret)).rejects.toThrow("closed");
    expect(chain.claims).toBe(0);
  });
  it("retains a recovery reference when inclusion exceeds the timing margin", async () => {
    const { rail, chain, t } = setup();
    chain.delay = 31;
    await expect(rail.lock(t)).rejects.toBeInstanceOf(FlopLockError);
    expect(chain.opens).toBe(1);
  });
  it("refuses a signer/party mismatch before sending", async () => {
    const { rail, chain, t } = setup();
    chain.account = flopAccountFromDid(t.payee);
    await expect(rail.lock(t)).rejects.toThrow("not the payer");
    expect(chain.opens).toBe(0);
  });
  it.each([
    { amount: "0" },
    { amount: "1.1" },
    { amount: "01" },
    { amount: String(2n ** 128n) },
    { lock: "point" },
    { asset: "BTC" },
    { payer: "did:key:bad" },
    { refundAfterMs: T0 + 1 },
    { claimByMs: Infinity },
    { statement: "0x1" },
    { contract: "bad" },
    { unknown: "extra" },
  ])("rejects malformed terms %j before sending", async (change) => {
    const { rail, chain, t } = setup();
    await expect(rail.lock({ ...t, ...change } as LockTerms)).rejects.toThrow();
    expect(chain.opens).toBe(0);
  });
});

describe("wallet recovery and duplicate submissions", () => {
  it("submits a contract at most once even when calls race", async () => {
    const { rail, chain, t } = setup();
    const results = await Promise.allSettled([rail.lock(t), rail.lock(t)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(chain.opens).toBe(1);
    await expect(rail.lock(t)).rejects.toThrow("already submitted");
  });
  it("persists public recovery data before sending and recovers a lost receipt", async () => {
    const { FlopSubmissionError, recoverFlopReference } = await import(
      "../src/rail.js"
    );
    const chain = new Chain();
    let pending = "";
    const open = chain.open.bind(chain);
    chain.open = async (request) => {
      await open(request);
      throw { txHash: h(44) };
    };
    const rail = new FlopRail(
      chain,
      {},
      () => chain.head.timestampMs,
      async (ref) => {
        expect(chain.opens).toBe(0);
        pending = ref;
      },
    );
    const error = await rail.lock(terms()).catch((e) => e);
    expect(error).toBeInstanceOf(FlopSubmissionError);
    expect(error.pendingRef).toBe(pending);
    expect(error.txHash).toBe(h(44));
    expect(pending).not.toContain(secret);
    const ref = recoverFlopReference(pending, chain.held!.id);
    expect(await rail.verifyLock(terms(), ref)).toBe(true);
    chain.tick(92);
    await rail.refund(ref);
    expect(chain.refunds).toBe(1);
    await expect(rail.lock(terms())).rejects.toThrow("already submitted");
  });
  it("does not send when the journal fails, and allows a safe retry", async () => {
    const chain = new Chain();
    let fail = true;
    const rail = new FlopRail(
      chain,
      {},
      () => chain.head.timestampMs,
      async () => {
        if (fail) throw new Error("disk full");
      },
    );
    await expect(rail.lock(terms())).rejects.toThrow("disk full");
    expect(chain.opens).toBe(0);
    fail = false;
    await rail.lock(terms());
    expect(chain.opens).toBe(1);
  });
  it("can refund an escrow whose late inclusion made verification refuse it", async () => {
    const { rail, chain, t } = setup();
    chain.delay = 31;
    const error = await rail.lock(t).catch((e) => e);
    expect(error).toBeInstanceOf(FlopLockError);
    chain.tick(92);
    await rail.refund(error.ref);
    expect(chain.refunds).toBe(1);
  });
});

describe("post-journal admission", () => {
  it("refuses to send when the local clock reaches claimByMs during journaling", async () => {
    const chain = new Chain();
    let now = T0;
    const t = terms();
    const rail = new FlopRail(
      chain,
      {},
      () => now,
      async () => {
        now = t.claimByMs;
      },
    );
    await expect(rail.lock(t)).rejects.toThrow("claim window has closed");
    expect(chain.opens).toBe(0);
    expect(chain.held).toBeUndefined();
  });

  it("also checks the chain clock after journaling", async () => {
    const chain = new Chain();
    const rail = new FlopRail(
      chain,
      {},
      () => T0,
      async () => {
        chain.tick(30);
      },
    );
    await expect(rail.lock(terms())).rejects.toThrow("claim window has closed");
    expect(chain.opens).toBe(0);
  });

  it("rejects an exhausted inclusion allowance and permits a freshly anchored retry", async () => {
    const chain = new Chain();
    const t = {
      ...terms(),
      claimByMs: T0 + 60_000,
      refundAfterMs: T0 + 90_000,
    };
    let delay = true;
    const rail = new FlopRail(
      chain,
      {},
      () => chain.head.timestampMs,
      async () => {
        if (delay) chain.tick(30);
        delay = false;
      },
    );
    await expect(rail.lock(t)).rejects.toThrow("anchor became stale");
    expect(chain.opens).toBe(0);
    const ref = await rail.lock(t);
    expect(chain.opens).toBe(1);
    expect(await rail.verifyLock(t, ref)).toBe(true);
  });

  it("accepts inclusion on the last permitted block", async () => {
    const chain = new Chain();
    const t = {
      ...terms(),
      claimByMs: T0 + 60_000,
      refundAfterMs: T0 + 90_000,
    };
    const rail = new FlopRail(
      chain,
      {},
      () => chain.head.timestampMs,
      async () => {
        chain.tick(29);
      },
    );
    const ref = await rail.lock(t);
    expect(chain.opens).toBe(1);
    expect(await rail.verifyLock(t, ref)).toBe(true);
  });

  it("aborts without sending on a chain reset during journaling", async () => {
    const chain = new Chain();
    const rail = new FlopRail(
      chain,
      {},
      () => T0,
      async () => {
        chain.head.genesis = h(7);
      },
    );
    await expect(rail.lock(terms())).rejects.toThrow("anchor became stale");
    expect(chain.opens).toBe(0);
  });

  it("aborts on an unavailable post-journal snapshot and permits a safe retry", async () => {
    const chain = new Chain();
    let fail = true;
    const rail = new FlopRail(
      chain,
      {},
      () => T0,
      async () => {
        chain.fail = fail;
      },
    );
    await expect(rail.lock(terms())).rejects.toThrow("RPC unavailable");
    expect(chain.opens).toBe(0);
    fail = false;
    chain.fail = false;
    await rail.lock(terms());
    expect(chain.opens).toBe(1);
  });
});

describe("pending reference validation", () => {
  it("rejects a completed reference and malformed escrow IDs during recovery", async () => {
    const { recoverFlopReference } = await import("../src/rail.js");
    const chain = new Chain();
    let pending = "";
    const rail = new FlopRail(
      chain,
      {},
      () => T0,
      async (ref) => {
        pending = ref;
      },
    );
    const completed = await rail.lock(terms());
    expect(() => recoverFlopReference(completed, h(77))).toThrow(
      "pending reference",
    );
    for (const id of ["", "0x12", "not-a-hash"])
      expect(() => recoverFlopReference(pending, id)).toThrow("escrow id");
  });

  it("never submits a claim against a zero-escrow pending reference", async () => {
    const chain = new Chain();
    let pending = "";
    const rail = new FlopRail(
      chain,
      {},
      () => T0,
      async (ref) => {
        pending = ref;
      },
    );
    await rail.lock(terms());
    await expect(rail.claim(pending, secret)).rejects.toThrow("agreed terms");
    expect(chain.claims).toBe(0);
  });
});

describe("R10.2 admission (always on, parameters from the chain)", () => {
  // The yellow paper's parameters on a chain anchored at height 1000, time T0, with runtime
  // finality prefix 999 (lag 1). claimByMs is 3600 one-second blocks out, so R10.2 requires
  // 3600 + max(720, 3600 + lag) = 7200 + lag in the admitting block.
  const withTimeout = (blocks: number): LockTerms => ({
    ...terms(),
    claimByMs: T0 + 3_600_000,
    refundAfterMs: T0 + (blocks - 30) * 1000, // timeout = ceil(...) + margin 30
  });
  function ypChain(): Chain {
    const chain = new Chain();
    chain.params = { ...YP };
    Object.assign(chain.head, {
      number: 1_000,
      finalizedNumber: 999,
      hash: h(1_000),
    });
    chain.history.set(chain.head.hash, structuredClone(chain.head));
    return chain;
  }
  const railOn = (chain: Chain, journal?: (pending: string) => Promise<void>) =>
    new FlopRail(chain, {}, () => chain.head.timestampMs, journal);
  const carried = (ref: string) =>
    JSON.parse(new TextDecoder().decode(base64urlnopad.decode(ref.slice(6))))
      .symmetry;

  it("applies the runtime's parameters without any option, refusing one block short before journaling or sending", async () => {
    const chain = ypChain();
    const journal: string[] = [];
    const rail = railOn(chain, async (pending) => {
      journal.push(pending);
    });
    const error = await rail.lock(withTimeout(7_200)).catch((e) => e);
    expect(error).toBeInstanceOf(FlopAdmissionError);
    expect(error.reason).toBe("timelock-symmetry");
    expect(error.message).toContain(
      "7200 blocks offered, 7201 required (T_other 3600, finality lag 1)",
    );
    expect(journal).toHaveLength(0);
    expect(chain.opens).toBe(0);
    // The refusal took neither the duplicate guard nor a journal entry.
    const t = withTimeout(7_201);
    const ref = await rail.lock(t);
    expect(journal).toHaveLength(1);
    expect(chain.request!.deadlineBlocks).toBe(7_201);
    expect(await rail.verifyLock(t, ref)).toBe(true);
    expect(ref.startsWith("flop2.")).toBe(true);
    expect(carried(ref)).toEqual(YP);
  });

  it("applies the finality-open gate first: refused at finality_freeze_threshold, admitted below it", async () => {
    const chain = ypChain();
    const journal: string[] = [];
    const rail = railOn(chain, async (pending) => {
      journal.push(pending);
    });
    // A stall at the tip: the best block leads the runtime prefix by 120 while the
    // finalized anchor still shows lag 1.
    chain.best = { number: 1_119, finalizedNumber: 999 };
    // Long enough for any lag, so only the gate can refuse it.
    const error = await rail.lock(withTimeout(20_000)).catch((e) => e);
    expect(error).toBeInstanceOf(FlopAdmissionError);
    expect(error.reason).toBe("finality-freeze");
    expect(error.message).toContain(
      "finality lag 120 is at or above the R10.2 freeze threshold 120",
    );
    // Refused before the journal, on the best block rather than the anchor.
    expect(journal).toHaveLength(0);
    expect(chain.opens).toBe(0);
    chain.best = { number: 1_118, finalizedNumber: 999 }; // lag 119
    await expect(rail.lock(withTimeout(7_318))).rejects.toThrow(
      "7318 blocks offered, 7319 required (T_other 3600, finality lag 119)",
    );
    expect(journal).toHaveLength(0);
    expect(chain.opens).toBe(0);
    const t = withTimeout(7_319);
    expect(await rail.verifyLock(t, await rail.lock(t))).toBe(true);
  });

  it("reads current_finality_lag in the block the open builds on, not at the finalized anchor", async () => {
    const chain = ypChain();
    const journal: string[] = [];
    const rail = railOn(chain, async (pending) => {
      journal.push(pending);
    });
    chain.best = { number: 1_049, finalizedNumber: 999 }; // lag 50; the anchor shows 1
    await expect(rail.lock(withTimeout(7_201))).rejects.toThrow(
      "7201 blocks offered, 7250 required (T_other 3600, finality lag 50)",
    );
    expect(journal).toHaveLength(0); // the check before the journal read the best block
    const t = withTimeout(7_250);
    expect(await rail.verifyLock(t, await rail.lock(t))).toBe(true);
  });

  it("verifies in the escrow's createdBlock, so the payer's lock and the payee's verifyLock agree", async () => {
    // The best block showed lag 1 when the payer checked; the block that included the
    // open recorded lag 10, so R10.2 there requires 7210.
    for (const [blocks, admitted] of [
      [7_201, false],
      [7_209, false],
      [7_210, true],
    ] as const) {
      const chain = ypChain();
      chain.inclusionLag = 10;
      const payer = railOn(chain);
      const payee = railOn(chain);
      const t = withTimeout(blocks);
      let ref: string;
      if (admitted) ref = await payer.lock(t);
      else {
        const error = await payer.lock(t).catch((e) => e);
        expect(error).toBeInstanceOf(FlopLockError); // opened: keep the ref to refund
        ref = error.ref;
      }
      expect(chain.opens).toBe(1);
      expect(await payer.verifyLock(t, ref)).toBe(admitted);
      expect(await payee.verifyLock(t, ref)).toBe(admitted);
    }
  });

  it("refuses at verification when the block that included the open had reached the freeze threshold", async () => {
    for (const [lag, admitted] of [
      [120, false],
      [119, true],
    ] as const) {
      const chain = ypChain();
      chain.inclusionLag = lag;
      // Long enough for either lag, so only the gate can refuse it.
      const t = withTimeout(20_000);
      const ref = await railOn(chain)
        .lock(t)
        .catch((e) => {
          expect(e).toBeInstanceOf(FlopLockError);
          return e.ref as string;
        });
      expect(await railOn(chain).verifyLock(t, ref)).toBe(admitted);
    }
  });

  it("keeps the verdict fixed after inclusion, however far the tip's finality falls behind", async () => {
    const chain = ypChain();
    const payer = railOn(chain);
    const payee = railOn(chain);
    const t = withTimeout(7_201);
    const ref = await payer.lock(t);
    expect(await payee.verifyLock(t, ref)).toBe(true);
    chain.tick(2_000);
    // Finality stalls after inclusion: lag 1000 in the finalized head, more at the tip.
    chain.head.finalizedNumber = chain.head.number - 1_000;
    chain.best = {
      number: chain.head.number + 500,
      finalizedNumber: chain.head.finalizedNumber,
    };
    expect(await payee.verifyLock(t, ref)).toBe(true);
  });

  it("converts claimByMs to one-second blocks, whatever blockTimeMs is", async () => {
    const chain = ypChain();
    const rail = new FlopRail(
      chain,
      { blockTimeMs: 500 },
      () => chain.head.timestampMs,
    );
    // 1_800_000 ms is 1800 one-second blocks (3600 at the configured 500 ms). T_FLOP is
    // the pallet timeout, still counted at 500 ms: R10.2 requires 1800 + max(360, 3601).
    const at500 = (blocks: number, claimMs = 1_800_000): LockTerms => ({
      ...terms(),
      claimByMs: T0 + claimMs,
      refundAfterMs: T0 + (blocks - 30) * 500,
    });
    await expect(rail.lock(at500(5_400))).rejects.toThrow(
      "5400 blocks offered, 5401 required (T_other 1800, finality lag 1)",
    );
    // A part of a second rounds up: 1_800_001 ms is 1801 blocks.
    await expect(rail.lock(at500(5_401, 1_800_001))).rejects.toThrow(
      "5401 blocks offered, 5402 required (T_other 1801, finality lag 1)",
    );
    const t = at500(5_401);
    expect(await rail.verifyLock(t, await rail.lock(t))).toBe(true);
  });

  it("binds the parameters into the reference and requires them to be the admitting block's constants", async () => {
    const chain = ypChain();
    const rail = railOn(chain);
    const t = withTimeout(7_201);
    const ref = await rail.lock(t);
    // Laxer parameters written into the reference break the policy binding.
    const lax = rewrite(ref, (r) => {
      r.symmetry = { ...YP, maxFinalityStallBlocks: 0 };
    });
    expect(await rail.verifyLock(t, lax)).toBe(false);
    await expect(rail.claim(lax, secret)).rejects.toThrow("agreed terms");
    // The admitting block's runtime reports other constants than the reference carries.
    chain.params = { ...YP, marginPercent: 25 };
    expect(await rail.verifyLock(t, ref)).toBe(false);
    chain.params = { ...YP };
    expect(await rail.verifyLock(t, ref)).toBe(true);
  });

  it("evaluates again after journaling and sends nothing if finality fell behind meanwhile", async () => {
    const chain = ypChain();
    let stall = true;
    const rail = railOn(chain, async () => {
      if (stall) chain.best = { number: 1_120, finalizedNumber: 1_000 }; // lag 120
    });
    const error = await rail.lock(withTimeout(7_300)).catch((e) => e);
    expect(error).toBeInstanceOf(FlopAdmissionError);
    expect(error.reason).toBe("finality-freeze");
    expect(chain.opens).toBe(0);
    // The refusal released the duplicate guard: once finality catches up, a retry locks.
    stall = false;
    chain.best = undefined;
    const t = withTimeout(7_300);
    expect(await rail.verifyLock(t, await rail.lock(t))).toBe(true);
  });

  it("sends nothing if the runtime's constants change while the journal runs", async () => {
    const chain = ypChain();
    let upgrade = true;
    const rail = railOn(chain, async () => {
      if (upgrade) chain.params = { ...YP, maxFinalityStallBlocks: 3_000 };
      upgrade = false;
    });
    await expect(rail.lock(withTimeout(7_201))).rejects.toThrow(
      "differ from the admitting block's runtime constants",
    );
    expect(chain.opens).toBe(0);
    // A fresh attempt reads, carries and is verified under the new constants.
    const t = withTimeout(7_201);
    const ref = await rail.lock(t);
    expect(carried(ref)).toEqual({ ...YP, maxFinalityStallBlocks: 3_000 });
    expect(await rail.verifyLock(t, ref)).toBe(true);
  });

  it("never applies R10.2 to claim or refund, so an escrow it refused stays settleable", async () => {
    for (const settle of ["claim", "refund"] as const) {
      const chain = ypChain();
      chain.inclusionLag = 120;
      const t = withTimeout(20_000);
      const error = await railOn(chain).lock(t).catch((e) => e);
      expect(error).toBeInstanceOf(FlopLockError);
      const rail = railOn(chain);
      expect(await rail.verifyLock(t, error.ref)).toBe(false);
      if (settle === "claim") {
        await rail.claim(error.ref, secret);
        expect(chain.claims).toBe(1);
      } else {
        chain.tick(20_001); // finalized 21_001 >= deadline 21_001, wall time past refundAfterMs
        await rail.refund(error.ref);
        expect(chain.refunds).toBe(1);
      }
    }
  });

  it("fails closed on a malformed or mismatched admission block", async () => {
    const corruptions: ((block: any) => void)[] = [
      (b) => (b.finalizedNumber = b.number + 1),
      (b) => (b.finalizedNumber = NaN),
      (b) => (b.number = 2 ** 32),
      (b) => (b.number -= 1),
      (b) => (b.genesis = h(9)),
      (b) => (b.hash = "0x12"),
      (b) => delete b.params.finalityFreezeThresholdBlocks,
      (b) => (b.params.extra = 1),
      (b) => (b.params.marginPercent = "20"),
      (b) => (b.params.maxFinalityStallBlocks = -1),
    ];
    const corrupt = (chain: Chain, change: (block: any) => void) => {
      const read = chain.admissionBlock.bind(chain);
      chain.admissionBlock = async (height) => {
        const block = await read(height);
        change(block);
        return block;
      };
    };
    for (const change of corruptions) {
      const before = ypChain();
      corrupt(before, change);
      await expect(railOn(before).lock(withTimeout(7_201))).rejects.toThrow();
      expect(before.opens).toBe(0);
      const after = ypChain();
      const t = withTimeout(7_201);
      const ref = await railOn(after).lock(t);
      corrupt(after, change);
      expect(await railOn(after).verifyLock(t, ref)).toBe(false);
    }
  });

  it("refuses a flop1 reference, which carries no R10.2 parameters", async () => {
    const chain = ypChain();
    const rail = railOn(chain);
    const t = withTimeout(7_201);
    const ref = await rail.lock(t);
    const v1 = `flop1.${rewrite(ref, (r) => {
      r.v = 1;
      delete r.symmetry;
    }).slice(6)}`;
    expect(await rail.verifyLock(t, v1)).toBe(false);
    await expect(rail.claim(v1, secret)).rejects.toThrow("malformed reference");
    await expect(rail.refund(v1)).rejects.toThrow("malformed reference");
  });
});
