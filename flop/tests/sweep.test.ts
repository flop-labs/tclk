// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { base58 } from "@scure/base";
import { hashLockFromPreimage, type LockTerms } from "@flop-labs/tclk";
import {
  FlopRail,
  FlopLockError,
  FlopSubmissionError,
  flopAccountFromDid,
  recoverFlopReference,
  type FlopChain,
  type FlopEscrow,
  type FlopSnapshot,
  type FlopOpenRequest,
} from "../src/rail.js";
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const did = (n: number) =>
  `did:key:z${base58.encode(Uint8Array.from([0xed, 1, ...new Array(32).fill(n)]))}`;
const secret = h(42);
const T0 = 1_790_000_000_000;
function terms(contract: number, refundAfterMs = T0 + 150_000): LockTerms {
  return {
    contract: h(contract),
    lock: "hash",
    statement: hashLockFromPreimage(secret).hash,
    amount: "1000",
    asset: "FLOP",
    payer: did(1),
    payee: did(2),
    claimByMs: T0 + 120_000,
    refundAfterMs,
  };
}
/** Holds many escrows at once, as a wallet's chain account does. */
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
  escrows = new Map<string, FlopEscrow>();
  delay = 1;
  refunds = 0;
  refundFails = false;
  async snapshot(id?: string, at?: string): Promise<FlopSnapshot> {
    if (at) return structuredClone(this.history.get(at)!);
    return structuredClone({
      ...this.head,
      escrow: id ? this.escrows.get(id) : undefined,
    });
  }
  async open(request: FlopOpenRequest): Promise<string> {
    const id = h(900 + this.escrows.size);
    this.tick(this.delay);
    const createdBlock = this.head.number;
    this.escrows.set(id, {
      id,
      funder: this.account,
      payee: request.payee,
      amount: request.amount,
      policy: request.policy,
      deadline: createdBlock + request.deadlineBlocks,
      createdBlock,
      status: "Open",
    });
    return id;
  }
  async satisfy(id: string): Promise<void> {
    this.escrows.get(id)!.status = "Released";
  }
  async refund(id: string): Promise<void> {
    this.refunds++;
    if (this.refundFails) throw new Error("RPC dropped the refund");
    this.escrows.get(id)!.status = "Refunded";
  }
  tick(n: number) {
    this.head.number += n;
    this.head.finalizedNumber = this.head.number - 1;
    this.head.timestampMs += n * 1000;
    this.head.hash = h(this.head.number);
    this.history.set(this.head.hash, structuredClone(this.head));
  }
}
const railFor = (chain: Chain) =>
  new FlopRail(chain, {}, () => chain.head.timestampMs);

describe("sweep", () => {
  it("refunds only due escrows and reports every other reference in order", async () => {
    const chain = new Chain();
    const rail = railFor(chain);
    const due = await rail.lock(terms(3));
    const claimed = await rail.lock(terms(4));
    await rail.claim(claimed, secret);
    const later = await rail.lock(terms(5, T0 + 600_000));
    chain.tick(200);
    const results = await rail.sweep([due, claimed, later, "not-a-reference"]);
    expect(results.map(({ status, refunded }) => [status, refunded])).toEqual([
      ["Refunded", true],
      ["Released", false],
      ["Open", false],
      ["failed", false],
    ]);
    expect(results[3].error).toBe("flop: malformed reference");
    expect(chain.refunds).toBe(1);
  });
  it("reports a pending journal entry without touching the chain", async () => {
    const chain = new Chain();
    let journal = "";
    const open = chain.open.bind(chain);
    chain.open = async (request) => {
      await open(request);
      throw new Error("receipt lost");
    };
    const rail = new FlopRail(
      chain,
      {},
      () => chain.head.timestampMs,
      async (ref) => {
        journal = ref;
      },
    );
    await expect(rail.lock(terms(3))).rejects.toBeInstanceOf(
      FlopSubmissionError,
    );
    chain.tick(200);
    expect(await rail.sweep([journal])).toEqual([
      { ref: journal, status: "pending", refunded: false },
    ]);
    expect(chain.refunds).toBe(0);
    const [id] = chain.escrows.keys();
    const [entry] = await rail.sweep([recoverFlopReference(journal, id)]);
    expect(entry).toMatchObject({ status: "Refunded", refunded: true });
  });
  it("lets a restarted wallet refund the escrow a failed lock left Open", async () => {
    const chain = new Chain();
    chain.delay = 31;
    const error = await railFor(chain)
      .lock(terms(3))
      .catch((e) => e);
    expect(error).toBeInstanceOf(FlopLockError);
    chain.tick(200);
    const [entry] = await railFor(chain).sweep([error.ref]);
    expect(entry).toMatchObject({ status: "Refunded", refunded: true });
    expect(chain.refunds).toBe(1);
  });
  it("does not refund an escrow that a different account funded", async () => {
    const chain = new Chain();
    const ref = await railFor(chain).lock(terms(3));
    chain.tick(200);
    chain.account = flopAccountFromDid(did(2));
    const [entry] = await railFor(chain).sweep([ref]);
    expect(entry).toMatchObject({ status: "Open", refunded: false });
    expect(chain.refunds).toBe(0);
  });
  it("reports a failed refund once, without retrying, and keeps going", async () => {
    const chain = new Chain();
    const rail = railFor(chain);
    const first = await rail.lock(terms(3));
    const second = await rail.lock(terms(4));
    chain.tick(200);
    chain.refundFails = true;
    const results = await rail.sweep([first, first, second]);
    expect(results.map((r) => [r.ref, r.status, r.error])).toEqual([
      [first, "failed", "RPC dropped the refund"],
      [second, "failed", "RPC dropped the refund"],
    ]);
    expect(chain.refunds).toBe(2);
    chain.refundFails = false;
    const next = await rail.sweep([first, second, first]);
    expect(next.map((r) => r.refunded)).toEqual([true, true]);
    expect(chain.refunds).toBe(4);
    expect((await rail.sweep([first]))[0]).toMatchObject({
      status: "Refunded",
      refunded: false,
    });
    expect(chain.refunds).toBe(4);
  });
  it("refuses a reference from another timing profile without writing", async () => {
    const chain = new Chain();
    const ref = await railFor(chain).lock(terms(3));
    chain.tick(200);
    const other = new FlopRail(chain, { refundMarginBlocks: 31 }, () =>
      chain.head.timestampMs,
    );
    const [entry] = await other.sweep([ref]);
    expect(entry.status).toBe("failed");
    expect(entry.error).toContain("different network or timing profile");
    expect(chain.refunds).toBe(0);
  });
  it("refuses a pending journal entry from another timing profile", async () => {
    const chain = new Chain();
    let journal = "";
    const open = chain.open.bind(chain);
    chain.open = async (request) => {
      await open(request);
      throw new Error("receipt lost");
    };
    const rail = new FlopRail(
      chain,
      {},
      () => chain.head.timestampMs,
      async (ref) => {
        journal = ref;
      },
    );
    await expect(rail.lock(terms(3))).rejects.toBeInstanceOf(
      FlopSubmissionError,
    );
    const other = new FlopRail(chain, { refundMarginBlocks: 31 }, () =>
      chain.head.timestampMs,
    );
    const [entry] = await other.sweep([journal]);
    expect(entry).toMatchObject({ status: "failed", refunded: false });
    expect(entry.error).toContain("different network or timing profile");
    expect(chain.refunds).toBe(0);
  });
});
