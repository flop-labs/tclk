// SPDX-License-Identifier: Apache-2.0
//
// tclk/1 `evm-htlc` settlement rail (SPEC.md §5) — hash-lock only. Binds LockTerms onto
// contracts/EvmHashRail.sol. Point-lock (`t*G == Y`) is a separate rail, out of scope here.
//
// Not part of the main barrel: this is the package's only dependency on an EVM library, kept
// behind the "@flop-labs/tclk/evm-hash-rail" subpath so nothing pulls in viem unless it asks
// to. viem is an optional peerDependency for the same reason.
//
// DID -> chain-address mapping is deliberately NOT part of LockTerms: tclk's DIDs (did:key,
// Ed25519) and an EVM account (secp256k1) are unrelated key material, and the protocol layer
// has no business bridging that. The caller supplies the mapping at construction time, the
// same way PaperRail takes a NoteStore — a rail's external dependencies are its own concern.

import type { Address, Hex, PublicClient, WalletClient, Account, Chain, Transport } from "viem";
import type { LockTerms, SettlementRail } from "./rail.js";

export const EVM_HASH_RAIL_ABI = [
  {
    type: "function",
    name: "lock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "hashLock", type: "bytes32" },
      { name: "payee", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "token", type: "address" },
      { name: "claimByMs", type: "uint256" },
      { name: "refundAfterMs", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "hashLock", type: "bytes32" },
      { name: "preimage", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "hashLock", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "locks",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "payer", type: "address" },
      { name: "payee", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "claimByMs", type: "uint256" },
      { name: "refundAfterMs", type: "uint256" },
      { name: "status", type: "uint8" },
    ],
  },
] as const;

/** Mirrors the Solidity `Status` enum in contracts/EvmHashRail.sol, in declaration order. */
const enum OnChainStatus {
  None = 0,
  Locked = 1,
  Claimed = 2,
  Refunded = 3,
}

/** Resolves a tclk DID to the EVM address it should be paid at, or throws if unknown. */
export interface AddressBook {
  resolve(did: string): Address;
}

/** Resolves a tclk `asset` identifier (e.g. "FLOP") to the ERC20 contract that represents it. */
export interface AssetBook {
  resolve(asset: string): Address;
}

/**
 * Binds tclk's SettlementRail interface onto contracts/EvmHashRail.sol.
 *
 * One instance is bound to one EVM account (`walletClient`) — the same way each party in
 * examples/live-deal.mjs holds its own rail handle. The party calling `lock`/`refund` must be
 * this account; `claim` is permissionless on-chain, so any instance can relay it.
 *
 * `ref` here is the on-chain lock key, `terms.statement` (the hashLock) — NOT `terms.contract`
 * like MemoryRail/PaperRail use. The contract has no notion of the tclk contract id; the
 * hashLock is what it actually indexes locks by.
 */
export class EvmHashRail implements SettlementRail {
  readonly id = "evm-htlc";

  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient<Transport, Chain, Account>;
  private readonly contractAddress: Address;
  private readonly addressBook: AddressBook;
  private readonly assetBook: AssetBook;
  private readonly clock: () => number;

  constructor(options: {
    publicClient: PublicClient;
    walletClient: WalletClient<Transport, Chain, Account>;
    contractAddress: Address;
    addressBook: AddressBook;
    assetBook: AssetBook;
    clock?: () => number;
  }) {
    this.publicClient = options.publicClient;
    this.walletClient = options.walletClient;
    this.contractAddress = options.contractAddress;
    this.addressBook = options.addressBook;
    this.assetBook = options.assetBook;
    this.clock = options.clock ?? Date.now;
  }

  async lock(terms: LockTerms): Promise<string> {
    if (terms.lock !== "hash") {
      throw new Error(`tclk: EvmHashRail only supports hash locks, got ${terms.lock}`);
    }
    if (this.clock() >= terms.refundAfterMs) {
      throw new Error("tclk: refusing to lock into an already-open refund window");
    }

    const hashLock = terms.statement as Hex;
    const payee = this.addressBook.resolve(terms.payee);
    const token = this.assetBook.resolve(terms.asset);

    try {
      const hash = await this.walletClient.writeContract({
        address: this.contractAddress,
        abi: EVM_HASH_RAIL_ABI,
        functionName: "lock",
        args: [hashLock, payee, BigInt(terms.amount), token, BigInt(terms.claimByMs), BigInt(terms.refundAfterMs)],
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
    } catch (err) {
      throw new Error(`tclk: ${extractRevertReason(err)}`);
    }

    // The contract indexes by hashLock, not by the tclk contract id — this IS the ref.
    return hashLock;
  }

  async verifyLock(terms: LockTerms, ref: string): Promise<boolean> {
    if (terms.lock !== "hash" || ref !== terms.statement) return false;
    try {
      const [payer, payee, token, amount, claimByMs, refundAfterMs, status] =
        await this.publicClient.readContract({
          address: this.contractAddress,
          abi: EVM_HASH_RAIL_ABI,
          functionName: "locks",
          args: [ref as Hex],
        });
      return (
        status === OnChainStatus.Locked &&
        payer === this.addressBook.resolve(terms.payer) &&
        payee === this.addressBook.resolve(terms.payee) &&
        token === this.assetBook.resolve(terms.asset) &&
        amount === BigInt(terms.amount) &&
        claimByMs === BigInt(terms.claimByMs) &&
        refundAfterMs === BigInt(terms.refundAfterMs)
      );
    } catch {
      return false;
    }
  }

  async claim(ref: string, secret: string): Promise<void> {
    try {
      const hash = await this.walletClient.writeContract({
        address: this.contractAddress,
        abi: EVM_HASH_RAIL_ABI,
        functionName: "claim",
        args: [ref as Hex, secret as Hex],
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
    } catch (err) {
      throw new Error(`tclk: ${extractRevertReason(err)}`);
    }
  }

  async refund(ref: string): Promise<void> {
    try {
      const hash = await this.walletClient.writeContract({
        address: this.contractAddress,
        abi: EVM_HASH_RAIL_ABI,
        functionName: "refund",
        args: [ref as Hex],
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
    } catch (err) {
      throw new Error(`tclk: ${extractRevertReason(err)}`);
    }
  }
}

/**
 * viem surfaces a revert's require() string as `shortMessage` (and nests the same text
 * through `.walk()` for wrapped errors) — pull that out so callers see "tclk: EvmHashRail:
 * ..." instead of an ABI-encoding dump. Falls back to the raw error, never throws itself.
 */
function extractRevertReason(err: unknown): string {
  if (err && typeof err === "object") {
    const withMessage = err as { shortMessage?: unknown; message?: unknown };
    if (typeof withMessage.shortMessage === "string") return withMessage.shortMessage;
    if (typeof withMessage.message === "string") return withMessage.message;
  }
  return String(err);
}
