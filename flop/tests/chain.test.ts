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
describe("snapshot read retry", () => {
  function readOnlyApi() {
    const view = {
      query: {
        timestamp: {
          now: vi.fn(async () => ({ toString: () => "1790000000000" })),
        },
        aleph: { lastFinalized: vi.fn(async () => ({ toJSON: () => null })) },
      },
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
      rpc: {
        chain: {
          getFinalizedHead: vi.fn(async () => ({ toHex: () => h })),
          getHeader: vi.fn(async () => ({ number: { toString: () => "100" } })),
          getBlockHash: vi.fn(async () => ({ toHex: () => h })),
        },
      },
      at: vi.fn(async () => view),
    };
    return api;
  }
  it("retries a transient by-hash header failure", async () => {
    const api = readOnlyApi();
    const header = api.rpc.chain.getHeader.getMockImplementation();
    api.rpc.chain.getHeader
      .mockImplementationOnce(async () => {
        throw new Error("RPC: header unavailable");
      })
      .mockImplementation(header);
    const chain = new PolkadotFlopChain(api, undefined, 120_000, 3, 0);
    await expect(chain.snapshot(undefined, h)).resolves.toMatchObject({
      hash: h,
      number: 100,
    });
    expect(api.at).toHaveBeenCalledTimes(2);
  });
  it("gives up after the configured attempts and surfaces the last error", async () => {
    const api = readOnlyApi();
    api.rpc.chain.getHeader.mockImplementation(async () => {
      throw new Error("RPC: header unavailable");
    });
    const chain = new PolkadotFlopChain(api, undefined, 120_000, 3, 0);
    await expect(chain.snapshot(undefined, h)).rejects.toThrow(
      "header unavailable",
    );
    expect(api.at).toHaveBeenCalledTimes(3);
  });
  it.each([
    [0, 0],
    [1.5, 0],
    [3, -1],
    [3, NaN],
  ])("rejects a retry policy of %s attempts / %s ms", (attempts, backoff) => {
    expect(
      () =>
        new PolkadotFlopChain(
          readOnlyApi(),
          undefined,
          120_000,
          attempts,
          backoff,
        ),
    ).toThrow("retry policy");
  });
});
