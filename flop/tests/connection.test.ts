// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => ({
  connect: vi.fn(() => new Promise<void>(() => {})),
  disconnect: vi.fn(async () => {}),
}));
vi.mock("@polkadot/api", () => ({
  WsProvider: class {
    connect = connection.connect;
  },
  ApiPromise: class {
    isReadyOrError = new Promise<void>(() => {});
    disconnect = connection.disconnect;
  },
}));
import { connectFlopRail } from "../src/chain.js";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("connection timeout", () => {
  it("rejects and disconnects when the provider never becomes ready", async () => {
    vi.useFakeTimers();
    const result = connectFlopRail().catch((error) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await result).message).toBe("flop: connection timed out");
    expect(connection.connect).toHaveBeenCalledOnce();
    expect(connection.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
