// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => ({
  connect: vi.fn(() => new Promise<void>(() => {})),
  disconnect: vi.fn(async () => {}),
  ready: new Promise<void>(() => {}),
}));
vi.mock("@polkadot/api", () => ({
  WsProvider: class {
    connect = connection.connect;
  },
  ApiPromise: class {
    isReadyOrError = connection.ready;
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

describe("connection refused", () => {
  it("clears the provider's interval when no close event follows the failure", async () => {
    vi.useFakeTimers();
    // WsProvider.connect() starts an interval that only its socket close handler clears; a
    // refused connection on Node 22 rejects readiness and never delivers that close event.
    connection.connect.mockImplementationOnce(async () => {
      setInterval(() => {}, 5_000);
    });
    connection.ready = Promise.reject(new Error("refused"));
    connection.ready.catch(() => {});
    const error = await connectFlopRail().catch((caught) => caught);
    expect(error.message).toBe("refused");
    expect(connection.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
