// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finalizedTransaction,
  PolkadotFlopChain,
  FlopTransactionError,
} from "../src/chain.js";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";
const h = `0x${"12".repeat(32)}`;
const signer = {} as KeyringPair;
const constant = (value: string) => ({ toString: () => value });
/** HasStation's R10.2 constants as devnet runtime 1014003 reports them. */
const r10Constants = () => ({
  hasStation: {
    timelockSymmetrySafetyMargin: constant("20"),
    maxFinalityStall: constant("3600"),
    finalityFreezeThreshold: constant("120"),
  },
});
const event = (section: string, method: string) => ({
  event: { section, method },
});
function transaction(run: (cb: (r: any) => void) => Promise<() => void>) {
  return {
    hash: { toHex: () => h },
    signAndSend: vi.fn((_s, _o, cb) => run(cb)),
  } as unknown as SubmittableExtrinsic<"promise">;
}
afterEach(() => vi.useRealTimers());
describe("finalized transaction lifecycle", () => {
  it("waits for finalized success and cleans a subscription returned after a synchronous callback", async () => {
    const stop = vi.fn();
    const tx = transaction(async (cb) => {
      cb({ status: { isInBlock: true }, events: [] });
      cb({
        status: { isFinalized: true },
        events: [event("system", "ExtrinsicSuccess")],
      });
      return stop;
    });
    await finalizedTransaction(tx, signer, 100);
    expect(stop).toHaveBeenCalledOnce();
    expect(tx.signAndSend).toHaveBeenCalledOnce();
  });
  it.each(["isInvalid", "isDropped", "isUsurped", "isFinalityTimeout"])(
    "rejects %s without retry",
    async (flag) => {
      const stop = vi.fn();
      const tx = transaction(async (cb) => {
        cb({ status: { [flag]: true } });
        return stop;
      });
      await expect(
        finalizedTransaction(tx, signer, 100),
      ).rejects.toBeInstanceOf(FlopTransactionError);
      expect(tx.signAndSend).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
    },
  );
  it.each([
    {
      dispatchError: { isModule: true },
      events: [event("system", "ExtrinsicSuccess")],
    },
    { events: [event("system", "ExtrinsicFailed")] },
    { events: [] },
  ])("rejects failed or unproven finalized execution", async (result) => {
    const tx = transaction(async (cb) => {
      cb({ status: { isFinalized: true }, ...result });
      return vi.fn();
    });
    await expect(finalizedTransaction(tx, signer, 100)).rejects.toThrow(
      "finalized",
    );
  });
  it("redacts provider error text that could contain a secret", async () => {
    const tx = transaction(async () => {
      throw new Error("SECRET_IN_CALLDATA");
    });
    const error = await finalizedTransaction(tx, signer, 100).catch((e) => e);
    expect(error.message).not.toContain("SECRET");
    expect(error.txHash).toBe(h);
  });
  it("times out, reports uncertain outcome, and unsubscribes exactly once", async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const tx = transaction(async () => stop);
    const result = finalizedTransaction(tx, signer, 10).catch((e) => e);
    await vi.advanceTimersByTimeAsync(11);
    expect((await result).message).toContain("inspect txHash");
    expect(stop).toHaveBeenCalledOnce();
    expect(tx.signAndSend).toHaveBeenCalledOnce();
  });
});
describe("metadata transport", () => {
  it("decodes u128 from the codec rather than lossy JSON, and reads a single finalized view", async () => {
    const amount = "340282366920938463463374607431768211455";
    const fields: Record<string, string> = {
      amount,
      deadline: "150",
      createdBlock: "100",
    };
    const raw = {
      id: h,
      funder: h,
      payee: h,
      amount: "0xffffffffffffffffffffffffffffffff",
      policy: {
        combinator: { and: null },
        clauses: [{ hash: h }, { hash: h }],
      },
      status: "Open",
    };
    const view = {
      query: {
        timestamp: {
          now: vi.fn(async () => ({ toString: () => "1790000000000" })),
        },
        aleph: {
          lastFinalized: vi.fn(async () => ({ toJSON: () => [99, h] })),
        },
        hasStation: {
          escrows: vi.fn(async () => ({
            isSome: true,
            unwrap: () => ({
              toJSON: () => raw,
              get: (key: string) => ({ toString: () => fields[key] }),
            }),
          })),
        },
      },
      consts: r10Constants(),
    };
    const api: any = {
      tx: {
        hasStation: {
          openEscrow: vi.fn(),
          satisfyEscrow: vi.fn(),
          refundEscrow: vi.fn(),
        },
      },
      query: {
        hasStation: { escrows: vi.fn() },
        aleph: { lastFinalized: vi.fn() },
      },
      consts: r10Constants(),
      rpc: {
        chain: {
          getFinalizedHead: vi.fn(async () => ({ toHex: () => h })),
          getHeader: vi.fn(async () => ({ number: { toString: () => "100" } })),
          getBlockHash: vi.fn(async () => ({ toHex: () => h })),
        },
      },
      at: vi.fn(async () => view),
      registry: { createType: vi.fn((_type, v) => ({ toHex: () => v })) },
    };
    const chain = new PolkadotFlopChain(api);
    const s = await chain.snapshot(h);
    expect(s.escrow).toMatchObject({
      amount,
      deadline: 150,
      createdBlock: 100,
      policy: { combinator: "And", clauses: [{ Hash: h }, { Hash: h }] },
    });
    expect(api.at).toHaveBeenCalledWith(h);
    expect(view.query.hasStation.escrows).toHaveBeenCalledWith(h);
    api.rpc.chain.getBlockHash = vi.fn(async (n) => ({
      toHex: () => (n === 0 ? h : `0x${"34".repeat(32)}`),
    }));
    await expect(chain.snapshot(h)).rejects.toThrow("canonical finalized");
  });
});
describe("R10.2 admission block", () => {
  const genesis = `0x${"ab".repeat(32)}`;
  const best = `0x${"56".repeat(32)}`;
  const finalized = `0x${"78".repeat(32)}`;
  // Heights from a devnet read: best 2161733 with runtime prefix 2161729 (lag 4).
  function rpc(prefix: unknown = [2_161_729, finalized]) {
    const heights: Record<string, string> = {
      [best]: "2161733",
      [finalized]: "2161729",
    };
    const view = {
      query: { aleph: { lastFinalized: vi.fn(async () => ({ toJSON: () => prefix })) } },
      consts: r10Constants(),
    };
    const api: any = {
      tx: {
        hasStation: {
          openEscrow: vi.fn(),
          satisfyEscrow: vi.fn(),
          refundEscrow: vi.fn(),
        },
      },
      query: {
        hasStation: { escrows: vi.fn() },
        aleph: { lastFinalized: vi.fn() },
      },
      consts: r10Constants(),
      rpc: {
        chain: {
          getFinalizedHead: vi.fn(async () => ({ toHex: () => finalized })),
          // Called with a hex string or with the codec getFinalizedHead returns.
          getHeader: vi.fn(async (hash: string | { toHex(): string }) => ({
            number: {
              toString: () =>
                heights[typeof hash === "string" ? hash : hash.toHex()],
            },
          })),
          getBlockHash: vi.fn(async (n?: number) => ({
            toHex: () =>
              n === undefined ? best : n === 0 ? genesis : finalized,
          })),
        },
      },
      at: vi.fn(async () => view),
    };
    return { api, view };
  }
  const yp = {
    marginPercent: 20,
    maxFinalityStallBlocks: 3_600,
    finalityFreezeThresholdBlocks: 120,
  };

  it("reads the best block's height, the runtime prefix in it, and its runtime's constants", async () => {
    const { api, view } = rpc();
    expect(await new PolkadotFlopChain(api).admissionBlock()).toEqual({
      genesis,
      hash: best,
      number: 2_161_733,
      finalizedNumber: 2_161_729,
      params: yp,
    });
    expect(api.rpc.chain.getBlockHash).toHaveBeenCalledWith(); // the best block
    expect(api.at).toHaveBeenCalledWith(best);
    expect(view.query.aleph.lastFinalized).toHaveBeenCalledOnce();
  });

  it("reads a requested height only from canonical finalized state", async () => {
    const { api } = rpc();
    const chain = new PolkadotFlopChain(api);
    expect(await chain.admissionBlock(2_161_729)).toMatchObject({
      hash: finalized,
      number: 2_161_729,
    });
    expect(api.rpc.chain.getBlockHash).toHaveBeenCalledWith(2_161_729);
    await expect(chain.admissionBlock(2_161_730)).rejects.toThrow(
      "not finalized",
    );
    for (const bad of [-1, 1.5, NaN])
      await expect(chain.admissionBlock(bad)).rejects.toThrow("height");
    api.rpc.chain.getHeader = vi.fn(async () => ({
      number: { toString: () => "7" },
    }));
    await expect(chain.admissionBlock(7)).resolves.toMatchObject({ number: 7 });
    await expect(chain.admissionBlock(6)).rejects.toThrow("height mismatch");
  });

  it("reads a missing prefix as the block itself (bootstrap) and refuses a malformed one", async () => {
    expect(
      await new PolkadotFlopChain(rpc(null).api).admissionBlock(),
    ).toMatchObject({ number: 2_161_733, finalizedNumber: 2_161_733 });
    for (const prefix of [[1], "1", [-1, h], ["0x10", h]])
      await expect(
        new PolkadotFlopChain(rpc(prefix).api).admissionBlock(),
      ).rejects.toThrow(/finality prefix|finalized height/);
  });

  it("fails closed without the R10.2 constants, at connection and per block", async () => {
    const { api } = rpc();
    delete api.consts.hasStation.finalityFreezeThreshold;
    expect(() => new PolkadotFlopChain(api)).toThrow("R10.2 constants");
    const ok = rpc();
    delete (ok.view.consts.hasStation as any).maxFinalityStall;
    await expect(
      new PolkadotFlopChain(ok.api).admissionBlock(),
    ).rejects.toThrow("R10.2 constants");
    for (const value of ["-1", "0x14", "1.5", "9007199254740993"]) {
      const bad = rpc();
      bad.view.consts.hasStation.timelockSymmetrySafetyMargin = constant(value);
      await expect(
        new PolkadotFlopChain(bad.api).admissionBlock(),
      ).rejects.toThrow(/timelockSymmetrySafetyMargin/);
    }
  });
});
