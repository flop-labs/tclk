/**
 * verifyLock must not care whether AddressBook/AssetBook and the on-chain read disagree on
 * casing for the same address — see PR #21 review feedback (string equality on EVM addresses
 * broke when one side was checksummed and the other wasn't).
 */

import { describe, it, expect } from "vitest";
import {
  getAddress,
  createPublicClient,
  createWalletClient,
  custom,
  encodeErrorResult,
  decodeFunctionData,
  type Address,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  type Transport,
} from "viem";
import { foundry } from "viem/chains";

import { EvmHashRail, EVM_HASH_RAIL_ABI, type AddressBook, type AssetBook } from "../src/evm-hash-rail.js";
import type { LockTerms } from "../src/rail.js";

const PAYER_LOWER = "0xaaaa1111bbbb2222cccc3333dddd4444eeee5566" as Address;
const PAYEE_LOWER = "0xbbbb2222cccc3333dddd4444eeee5566aaaa1111" as Address;
const TOKEN_LOWER = "0xcccc3333dddd4444eeee5566aaaa1111bbbb2222" as Address;

const PAYER_CHECKSUM = getAddress(PAYER_LOWER);
const PAYEE_CHECKSUM = getAddress(PAYEE_LOWER);
const TOKEN_CHECKSUM = getAddress(TOKEN_LOWER);

const terms: LockTerms = {
  contract: "tclk1test",
  lock: "hash",
  statement: "0x" + "ab".repeat(32),
  amount: "1000000",
  asset: "FLOP",
  payer: "did:key:zPayer",
  payee: "did:key:zPayee",
  claimByMs: 1_756_700_000_000,
  refundAfterMs: 1_756_707_200_000,
};

/** locks(hashLock) tuple, with the on-chain addresses in whichever casing the chain returns. */
function locksResult(payer: Address, payee: Address, token: Address) {
  return [
    payer,
    payee,
    token,
    BigInt(terms.amount),
    BigInt(terms.claimByMs),
    BigInt(terms.refundAfterMs),
    1, // OnChainStatus.Locked
  ] as const;
}

function railWith(addressBook: AddressBook, assetBook: AssetBook, onChain: ReturnType<typeof locksResult>) {
  const publicClient = { readContract: async () => onChain } as unknown as PublicClient;
  const walletClient = {} as unknown as WalletClient<Transport, Chain, Account>;
  return new EvmHashRail({
    publicClient,
    walletClient,
    contractAddress: "0x0000000000000000000000000000000000dEaD",
    addressBook,
    assetBook,
  });
}

describe("EvmHashRail.verifyLock — address comparison is case-insensitive", () => {
  it("matches when AddressBook/AssetBook resolve lowercase but the chain returns checksummed", async () => {
    const addressBook: AddressBook = {
      resolve: (did) => (did === terms.payer ? PAYER_LOWER : PAYEE_LOWER),
    };
    const assetBook: AssetBook = { resolve: () => TOKEN_LOWER };
    const rail = railWith(addressBook, assetBook, locksResult(PAYER_CHECKSUM, PAYEE_CHECKSUM, TOKEN_CHECKSUM));

    expect(await rail.verifyLock(terms, terms.statement)).toBe(true);
  });

  it("matches when AddressBook/AssetBook resolve checksummed and the chain returns lowercase", async () => {
    const addressBook: AddressBook = {
      resolve: (did) => (did === terms.payer ? PAYER_CHECKSUM : PAYEE_CHECKSUM),
    };
    const assetBook: AssetBook = { resolve: () => TOKEN_CHECKSUM };
    const rail = railWith(addressBook, assetBook, locksResult(PAYER_LOWER, PAYEE_LOWER, TOKEN_LOWER));

    expect(await rail.verifyLock(terms, terms.statement)).toBe(true);
  });

  it("still fails closed when the addresses are genuinely different", async () => {
    const addressBook: AddressBook = { resolve: () => PAYER_LOWER };
    const assetBook: AssetBook = { resolve: () => TOKEN_LOWER };
    const rail = railWith(addressBook, assetBook, locksResult(PAYEE_CHECKSUM, PAYEE_CHECKSUM, TOKEN_CHECKSUM));

    expect(await rail.verifyLock(terms, terms.statement)).toBe(false);
  });
});

/**
 * lock/claim/refund via a real viem `custom(provider)` transport instead of a stubbed
 * PublicClient/WalletClient: ABI encoding, decoding and revert-message formatting all run
 * for real, and the mock only answers at the JSON-RPC boundary. A JSON-RPC account (no local
 * signing) against a `writeContract` call with an explicit `chain` needs exactly three RPC
 * methods — eth_chainId, eth_sendTransaction, eth_getTransactionReceipt — verified against
 * this exact viem version before writing this file; no anvil, no eth_estimateGas/nonce/fee
 * calls, since the node is the one filling those in.
 */

const RAIL_CONTRACT_ADDRESS = getAddress("0x000000000000000000000000000000000000dead");
const RAIL_ACCOUNT = { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address, type: "json-rpc" } as const;
const RAIL_TX_HASH = ("0x" + "aa".repeat(32)) as `0x${string}`;

type MockRpcCall = { method: string; params?: unknown[] };

function makeMockProvider(onSend: (tx: Record<string, unknown>) => `0x${string}`, receiptStatus: "0x0" | "0x1" = "0x1") {
  const calls: MockRpcCall[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
      calls.push({ method, params });
      switch (method) {
        case "eth_chainId":
          return "0x7a69";
        case "eth_sendTransaction":
          return onSend(params![0] as Record<string, unknown>);
        case "eth_getTransactionReceipt":
          return {
            status: receiptStatus,
            transactionHash: RAIL_TX_HASH,
            blockHash: "0x" + "11".repeat(32),
            blockNumber: "0x1",
            transactionIndex: "0x0",
            from: RAIL_ACCOUNT.address,
            to: RAIL_CONTRACT_ADDRESS,
            cumulativeGasUsed: "0x5208",
            gasUsed: "0x5208",
            logs: [],
            logsBloom: "0x" + "00".repeat(256),
            type: "0x2",
          };
        default:
          throw new Error(`mock provider: unexpected RPC call ${method}`);
      }
    },
  };
  return { provider, calls };
}

const happyProvider = () => makeMockProvider(() => RAIL_TX_HASH);

/** Shapes the thrown error like a real node's revert: `data` carries an ABI-encoded
 * `Error(string)` reason, same as a Solidity `require(cond, "...")`. */
function revertProvider(reason: string) {
  return makeMockProvider(() => {
    const err = new Error(`execution reverted: ${reason}`) as Error & { code: number; data: `0x${string}` };
    err.code = 3;
    err.data = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }],
      errorName: "Error",
      args: [reason],
    });
    throw err;
  });
}

function railOn(provider: { request(args: { method: string; params?: unknown[] }): Promise<unknown> }) {
  const publicClient = createPublicClient({ chain: foundry, transport: custom(provider) });
  const walletClient = createWalletClient({ account: RAIL_ACCOUNT, chain: foundry, transport: custom(provider) });
  return new EvmHashRail({
    publicClient,
    walletClient,
    contractAddress: RAIL_CONTRACT_ADDRESS,
    addressBook: { resolve: (did) => (did === terms.payee ? PAYEE_CHECKSUM : PAYER_CHECKSUM) },
    assetBook: { resolve: () => TOKEN_CHECKSUM },
    // Strictly before `terms.refundAfterMs`, so lock()'s own pre-flight guard never trips.
    clock: () => terms.claimByMs,
  });
}

function decodedSend(calls: MockRpcCall[]) {
  const send = calls.find((c) => c.method === "eth_sendTransaction");
  if (!send) throw new Error("test bug: no eth_sendTransaction call recorded");
  const tx = send.params![0] as { data: `0x${string}` };
  return decodeFunctionData({ abi: EVM_HASH_RAIL_ABI, data: tx.data });
}

describe("EvmHashRail.lock", () => {
  it("happy path: returns the hashLock as ref and sends the correct on-chain call", async () => {
    const { provider, calls } = happyProvider();
    const ref = await railOn(provider).lock(terms);

    expect(ref).toBe(terms.statement); // the contract indexes by hashLock, not by contract id

    const decoded = decodedSend(calls);
    expect(decoded.functionName).toBe("lock");
    expect(decoded.args).toEqual([
      terms.statement,
      PAYEE_CHECKSUM,
      BigInt(terms.amount),
      TOKEN_CHECKSUM,
      BigInt(terms.claimByMs),
      BigInt(terms.refundAfterMs),
    ]);
  });

  it("revert path: a contract revert surfaces as a tclk:-prefixed message carrying the reason", async () => {
    const { provider } = revertProvider("EvmHashRail: already locked");
    await expect(railOn(provider).lock(terms)).rejects.toThrow(
      'tclk: The contract function "lock" reverted with the following reason:\nEvmHashRail: already locked',
    );
  });
});

describe("EvmHashRail.claim", () => {
  const secret = "0x" + "cd".repeat(32);

  it("happy path: resolves once the receipt lands, sending hashLock and secret", async () => {
    const { provider, calls } = happyProvider();
    await expect(railOn(provider).claim(terms.statement, secret)).resolves.toBeUndefined();

    const decoded = decodedSend(calls);
    expect(decoded.functionName).toBe("claim");
    expect(decoded.args).toEqual([terms.statement, secret]);
  });

  it("revert path: a bad secret's on-chain revert is relayed, not swallowed", async () => {
    const { provider } = revertProvider("EvmHashRail: secret does not open the hashLock");
    await expect(railOn(provider).claim(terms.statement, secret)).rejects.toThrow(
      'tclk: The contract function "claim" reverted with the following reason:\nEvmHashRail: secret does not open the hashLock',
    );
  });
});

describe("EvmHashRail.refund", () => {
  it("happy path: sends only the hashLock", async () => {
    const { provider, calls } = happyProvider();
    await expect(railOn(provider).refund(terms.statement)).resolves.toBeUndefined();

    const decoded = decodedSend(calls);
    expect(decoded.functionName).toBe("refund");
    expect(decoded.args).toEqual([terms.statement]);
  });

  it("revert path before refundAfterMs: unlike lock(), refund() has no local time guard — a too-early call must surface the contract's own revert reason rather than a client-side guess", async () => {
    const { provider } = revertProvider("EvmHashRail: refund not yet available");
    await expect(railOn(provider).refund(terms.statement)).rejects.toThrow(
      'tclk: The contract function "refund" reverted with the following reason:\nEvmHashRail: refund not yet available',
    );
  });
});

/**
 * A transaction can be successfully mined (no RPC error, no thrown revert at send time) and
 * still have failed on-chain — e.g. it ran out of gas mid-execution, or reverted in a way the
 * node doesn't surface as an `eth_sendTransaction`-time error. `eth_getTransactionReceipt`
 * then answers with a full receipt whose `status` is `"0x0"`. Before this fix, none of
 * lock/claim/refund looked at that field, so a mined-but-reverted transaction would resolve
 * as if it had succeeded. See bdunn77's report.
 */
function minedButRevertedProvider() {
  return makeMockProvider(() => RAIL_TX_HASH, "0x0");
}

describe("EvmHashRail — mined but reverted transactions", () => {
  it("lock() rejects when the receipt status is reverted, not just when the send itself throws", async () => {
    const { provider } = minedButRevertedProvider();
    await expect(railOn(provider).lock(terms)).rejects.toThrow(
      `tclk: EvmHashRail: lock transaction mined but reverted on-chain (hash: ${RAIL_TX_HASH})`,
    );
  });

  it("claim() rejects when the receipt status is reverted, not just when the send itself throws", async () => {
    const { provider } = minedButRevertedProvider();
    const secret = "0x" + "cd".repeat(32);
    await expect(railOn(provider).claim(terms.statement, secret)).rejects.toThrow(
      `tclk: EvmHashRail: claim transaction mined but reverted on-chain (hash: ${RAIL_TX_HASH})`,
    );
  });

  it("refund() rejects when the receipt status is reverted, not just when the send itself throws", async () => {
    const { provider } = minedButRevertedProvider();
    await expect(railOn(provider).refund(terms.statement)).rejects.toThrow(
      `tclk: EvmHashRail: refund transaction mined but reverted on-chain (hash: ${RAIL_TX_HASH})`,
    );
  });
});
