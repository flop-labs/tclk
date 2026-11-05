// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

const disconnect = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@polkadot/api", () => ({
  WsProvider: class {
    connect = vi.fn(async () => {});
  },
  ApiPromise: class {
    isReadyOrError = Promise.resolve();
    genesisHash = { toHex: () => `0x${"12".repeat(32)}` };
    disconnect = disconnect;
  },
}));
import { connectFlopRail } from "../src/chain.js";

describe("connection era option", () => {
  it("hands transactionEraBlocks to the transport, which refuses a bad one", async () => {
    await expect(connectFlopRail({ transactionEraBlocks: 48 })).rejects.toThrow(
      "flop: invalid transaction era",
    );
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
