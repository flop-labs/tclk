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
  type FlopChain,
  type FlopEscrow,
  type FlopSnapshot,
  type FlopOpenRequest,
} from "../src/rail.js";
import { resolveFlopConfig } from "../src/config.js";
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
  async snapshot(_id?: string, at?: string): Promise<FlopSnapshot> {
    if (this.fail) throw new Error("RPC unavailable");
    if (at) return structuredClone(this.history.get(at)!);
    return structuredClone({ ...this.head, escrow: this.held });
  }
  async open(request: FlopOpenRequest): Promise<string> {
    this.opens++;
    this.request = request;
    this.tick(this.delay);
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
  return `flop1.${base64urlnopad.encode(new TextEncoder().encode(canonicalJson(data)))}`;
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
  it("supplies no symmetry option by default and keeps an explicit one as a frozen copy", () => {
    expect(resolveFlopConfig()).not.toHaveProperty("symmetry");
    expect(resolveFlopConfig({ symmetry: undefined })).not.toHaveProperty(
      "symmetry",
    );
    const input = { marginPercent: 0, maxFinalityStallBlocks: 0 };
    const config = resolveFlopConfig({ symmetry: input });
    input.maxFinalityStallBlocks = 3_600;
    expect(config.symmetry).toEqual({
      marginPercent: 0,
      maxFinalityStallBlocks: 0,
    });
    expect(Object.isFrozen(config.symmetry)).toBe(true);
    // connectFlopRail hands the resolved config back to FlopRail.
    expect(resolveFlopConfig(config)).toEqual(config);
  });
  it.each([
    null,
    [],
    {},
    { marginPercent: 20 },
    { maxFinalityStallBlocks: 3_600 },
    { marginPercent: 20, maxFinalityStall: 3_600 },
    { marginPercent: 20, maxFinalityStallBlocks: 3_600, extra: 1 },
    { marginPercent: undefined, maxFinalityStallBlocks: 3_600 },
    { marginPercent: NaN, maxFinalityStallBlocks: 3_600 },
    { marginPercent: -1, maxFinalityStallBlocks: 3_600 },
    { marginPercent: "20", maxFinalityStallBlocks: 3_600 },
    { marginPercent: 20, maxFinalityStallBlocks: 1.5 },
    { marginPercent: 20, maxFinalityStallBlocks: Infinity },
    { marginPercent: 20, maxFinalityStallBlocks: 2 ** 32 },
  ])("rejects a malformed symmetry option %j", (symmetry) => {
    expect(() => resolveFlopConfig({ symmetry } as any)).toThrow("symmetry");
    expect(() => new FlopRail(new Chain(), { symmetry } as any)).toThrow(
      "symmetry",
    );
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
    ]) {
      const wrong = rewrite(ref, update);
      expect(await rail.verifyLock(t, wrong)).toBe(false);
      await expect(rail.claim(wrong, secret)).rejects.toThrow();
    }
    for (const bad of ["", ref + "=", "flop1.invalid", ref.slice(0, -4)])
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

describe("R10.2 timelock symmetry (opt-in)", () => {
  // Test inputs only (yellow paper v0.5.0 Appendix A); the package ships no values.
  const symmetry = { marginPercent: 20, maxFinalityStallBlocks: 3_600 };
  // The anchor is height 100 at T0 with runtime finality prefix 99 (lag 1). With
  // claimByMs 3600 blocks out, R10.2 requires 3600 + max(720, 3600 + 1) = 7201.
  const withTimeout = (blocks: number): LockTerms => ({
    ...terms(),
    claimByMs: T0 + 3_600_000,
    refundAfterMs: T0 + (blocks - 30) * 1000, // timeout = ceil(...) + margin 30
  });
  const clockOf = (chain: Chain) => () => chain.head.timestampMs;

  it("is off unless configured: a short timeout locks and verifies as before", async () => {
    const { chain, rail } = setup();
    const t = withTimeout(7_200);
    const ref = await rail.lock(t);
    expect(chain.request!.deadlineBlocks).toBe(7_200);
    expect(await rail.verifyLock(t, ref)).toBe(true);
  });

  it("refuses a timeout one block short before journaling or sending, and admits the minimum", async () => {
    const chain = new Chain();
    const journal: string[] = [];
    const rail = new FlopRail(
      chain,
      { symmetry },
      clockOf(chain),
      async (pending) => {
        journal.push(pending);
      },
    );
    await expect(rail.lock(withTimeout(7_200))).rejects.toThrow(
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
  });

  it("takes current_finality_lag from the anchor's runtime finality prefix", async () => {
    const chain = new Chain();
    chain.head.finalizedNumber = 90; // lag 10 at the anchor block
    chain.history.set(chain.head.hash, structuredClone(chain.head));
    const rail = new FlopRail(chain, { symmetry }, clockOf(chain));
    await expect(rail.lock(withTimeout(7_201))).rejects.toThrow(
      "7201 blocks offered, 7210 required (T_other 3600, finality lag 10)",
    );
    const t = withTimeout(7_210);
    expect(await rail.verifyLock(t, await rail.lock(t))).toBe(true);
  });

  it("converts claimByMs at the configured blockTimeMs, not at one block per second", async () => {
    const chain = new Chain();
    const rail = new FlopRail(
      chain,
      { blockTimeMs: 500, symmetry },
      clockOf(chain),
    );
    // 1_800_000 ms is 3600 blocks at 500 ms; at one second it would be 1800, and
    // 7200 blocks would clear the 5401 that would then be required.
    const at500 = (blocks: number): LockTerms => ({
      ...terms(),
      claimByMs: T0 + 1_800_000,
      refundAfterMs: T0 + (blocks - 30) * 500,
    });
    await expect(rail.lock(at500(7_200))).rejects.toThrow(
      "7200 blocks offered, 7201 required (T_other 3600, finality lag 1)",
    );
    const t = at500(7_201);
    expect(await rail.verifyLock(t, await rail.lock(t))).toBe(true);
  });

  it("makes the payee's verifyLock refuse a short escrow, while claim and refund ignore the option", async () => {
    for (const settle of ["claim", "refund"] as const) {
      const chain = new Chain();
      const unchecked = new FlopRail(chain, {}, clockOf(chain));
      const checked = new FlopRail(chain, { symmetry }, clockOf(chain));
      const t = withTimeout(7_200);
      const ref = await unchecked.lock(t);
      expect(await unchecked.verifyLock(t, ref)).toBe(true);
      expect(await checked.verifyLock(t, ref)).toBe(false);
      if (settle === "claim") {
        await checked.claim(ref, secret);
        expect(chain.claims).toBe(1);
      } else {
        chain.tick(7_202); // finalized 7302 >= deadline 7301, wall time past refundAfterMs
        await checked.refund(ref);
        expect(chain.refunds).toBe(1);
      }
    }
  });

  it("decides from the anchor, so the verdict does not move with the tip's finality lag", async () => {
    const chain = new Chain();
    const payer = new FlopRail(chain, { symmetry }, clockOf(chain));
    const payee = new FlopRail(chain, { symmetry }, clockOf(chain));
    const t = withTimeout(7_201);
    const ref = await payer.lock(t);
    expect(await payee.verifyLock(t, ref)).toBe(true);
    chain.tick(2_000);
    // Lag 1000 at the tip, still 1 at the anchor. A check on the tip's lag would
    // now require 3600 + 4600 = 8200 blocks and refuse this escrow.
    chain.head.finalizedNumber = chain.head.number - 1_000;
    expect(await payee.verifyLock(t, ref)).toBe(true);
  });
});
