// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";
import { finalizedTransaction, FlopTransactionError } from "../src/chain.js";
import { FlopSubmissionError } from "../src/rail.js";

const unsignedHash = `0x${"11".repeat(32)}`;
const signedHash = `0x${"22".repeat(32)}`;
const signer = {} as KeyringPair;
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
/** Signing reads the nonce asynchronously, then changes the encoded tx hash. */
function transaction() {
  const nonce = pending<void>();
  const subscription = pending<() => void>();
  const stop = vi.fn();
  let hash = unsignedHash;
  const tx = {
    hash: { toHex: () => hash },
    signAsync: vi.fn(async (_signer?: KeyringPair, _options?: unknown) => {
      await nonce.promise;
      hash = signedHash;
      return tx;
    }),
    send: vi.fn((_callback: unknown) => subscription.promise),
    // Baseline-compatible fixture, matching the SDK's sign-then-send pipeline.
    signAndSend: vi.fn(async (_signer, _options, callback) => {
      await tx.signAsync(_signer, _options);
      return tx.send(callback);
    }),
  };
  return {
    tx, nonce, subscription, stop,
    input: tx as unknown as SubmittableExtrinsic<"promise">,
  };
}
afterEach(() => vi.useRealTimers());

describe("signing and submission timeout boundary", () => {
  it("does not report an unsigned call hash as a transaction recovery hash", async () => {
    vi.useFakeTimers();
    const f = transaction();
    const result = finalizedTransaction(f.input, signer, 10).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    const error = await result;
    expect(error).toBeInstanceOf(FlopTransactionError);
    expect(error.txHash).toBeUndefined();
    expect(error.message).toContain("not submitted");
    expect(f.tx.send).not.toHaveBeenCalled();
    const wrapped = new FlopSubmissionError("journal-entry", error);
    expect(wrapped.pendingRef).toBe("journal-entry");
    expect(wrapped.txHash).toBeUndefined();
    expect(wrapped.message).toContain("retain pendingRef");
  });

  it("never sends when the pending nonce read completes after timeout", async () => {
    vi.useFakeTimers();
    const f = transaction();
    const result = finalizedTransaction(f.input, signer, 10).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    await result;
    f.nonce.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.tx.hash.toHex()).toBe(signedHash);
    expect(f.tx.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("redacts a signing failure and omits its unsigned hash", async () => {
    const f = transaction();
    const result = finalizedTransaction(f.input, signer, 100).catch((e) => e);
    f.nonce.reject(new Error("SECRET_IN_SIGNING_ERROR"));
    const error = await result;
    expect(error.txHash).toBeUndefined();
    expect(error.message).toContain("not submitted");
    expect(error.message).not.toContain("SECRET");
    expect(f.tx.send).not.toHaveBeenCalled();
  });

  it("reports the signed hash on send failure without leaking provider text", async () => {
    const f = transaction();
    const result = finalizedTransaction(f.input, signer, 100).catch((e) => e);
    f.nonce.resolve();
    await vi.waitFor(() => expect(f.tx.send).toHaveBeenCalledOnce());
    f.subscription.reject(new Error("SECRET_IN_SEND_ERROR"));
    const error = await result;
    expect(error.txHash).toBe(signedHash);
    expect(error.message).toContain("outcome unknown");
    expect(error.message).not.toContain("SECRET");
    expect(f.tx.send).toHaveBeenCalledOnce();
  });

  it("keeps one timeout budget across signing and finality, then cleans a late subscription", async () => {
    vi.useFakeTimers();
    const f = transaction();
    const result = finalizedTransaction(f.input, signer, 10).catch((e) => e);
    await vi.advanceTimersByTimeAsync(8);
    f.nonce.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.tx.send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2);
    const error = await result;
    expect(error.txHash).toBe(signedHash);
    expect(error.message).toContain("finality timeout");
    f.subscription.resolve(f.stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.tx.signAsync).toHaveBeenCalledWith(signer, { nonce: -1 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
