/**
 * verifyLock must not care whether AddressBook/AssetBook and the on-chain read disagree on
 * casing for the same address — see PR #21 review feedback (string equality on EVM addresses
 * broke when one side was checksummed and the other wasn't).
 */

import { describe, it, expect } from "vitest";
import { getAddress, type Address, type PublicClient, type WalletClient, type Account, type Chain, type Transport } from "viem";

import { EvmHashRail, type AddressBook, type AssetBook } from "../src/evm-hash-rail.js";
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
