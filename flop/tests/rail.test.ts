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
// These fixtures keep 30-60 s windows so the block arithmetic stays small; the
// claim-window floor (default 90 s) has its own tests below.
const TIGHT = { minClaimWindowMs: 0 };
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
  const rail = new FlopRail(chain, TIGHT, () => chain.head.timestampMs);
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
    { minClaimWindowMs: -1 },
    { minClaimWindowMs: 0.5 },
    { minClaimWindowMs: NaN },
  ])("rejects malformed config %j", (config) => {
    expect(() => resolveFlopConfig(config as any)).toThrow();
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
    const payee = new FlopRail(chain, TIGHT, () => chain.head.timestampMs);
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
      TIGHT,
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
      TIGHT,
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
      TIGHT,
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
      TIGHT,
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
      TIGHT,
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
      TIGHT,
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
      TIGHT,
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
      TIGHT,
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

describe("claim-window floor", () => {
  const window = (claimMs: number): LockTerms => ({
    ...terms(),
    claimByMs: T0 + claimMs,
    refundAfterMs: T0 + claimMs + 30_000,
  });
  it("defaults to 90 s and refuses a shorter window before journaling or signing", async () => {
    const chain = new Chain();
    let journaled = 0;
    const rail = new FlopRail(
      chain,
      {},
      () => T0,
      async () => {
        journaled++;
      },
    );
    expect(rail.config.minClaimWindowMs).toBe(90_000);
    await expect(rail.lock(window(89_999))).rejects.toThrow("too short");
    expect(journaled).toBe(0);
    expect(chain.opens).toBe(0);
    await rail.lock(window(90_000));
    expect(chain.opens).toBe(1);
  });
  it("measures the window from the later of the local and chain clocks", async () => {
    const chain = new Chain();
    let now = T0 - 60_000;
    const rail = new FlopRail(chain, {}, () => now);
    await expect(rail.lock(window(89_999))).rejects.toThrow("too short");
    now = T0;
    chain.head.timestampMs = T0 - 60_000;
    await expect(rail.lock(window(89_999))).rejects.toThrow("too short");
    expect(chain.opens).toBe(0);
  });
  it("rechecks the floor after journaling and releases the duplicate guard", async () => {
    const chain = new Chain();
    let now = T0;
    const rail = new FlopRail(
      chain,
      {},
      () => now,
      async () => {
        now += 1;
      },
    );
    await expect(rail.lock(window(90_000))).rejects.toThrow("too short");
    expect(chain.opens).toBe(0);
    now = T0;
    await rail.lock(window(90_001));
    expect(chain.opens).toBe(1);
  });
  it("keeps the closed-window error distinct, and 0 disables the floor", async () => {
    const chain = new Chain();
    const rail = new FlopRail(chain, TIGHT, () => T0);
    await expect(rail.lock(window(0))).rejects.toThrow("has closed");
    await rail.lock(window(5_000));
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
      TIGHT,
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
      TIGHT,
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
