// SPDX-License-Identifier: Apache-2.0
export type FlopNetwork = "devnet" | "testnet" | "mainnet";
export interface FlopRailConfig {
  network?: FlopNetwork;
  rpcUrl?: string;
  /** Pin an operator-published genesis, never a value taken from a lock frame. */
  expectedGenesisHash?: string;
  /** Nominal block duration; FLOP currently targets one second. */
  blockTimeMs?: number;
  /** Extra blocks before refund; also bounds lock-inclusion delay. */
  refundMarginBlocks?: number;
  /**
   * Local admission floor: refuse to sign a lock with less claim window left. Inclusion,
   * finality and the payee's verification must all fit before `claimByMs`. Not part of
   * the reference, so the parties need not agree on it. 0 disables the floor.
   */
  minClaimWindowMs?: number;
}
export interface ResolvedFlopConfig {
  network: FlopNetwork;
  rpcUrl: string;
  expectedGenesisHash?: string;
  blockTimeMs: number;
  refundMarginBlocks: number;
  minClaimWindowMs: number;
}
export const HEX32 = /^0x[0-9a-f]{64}$/;
export function resolveFlopConfig(
  input: FlopRailConfig = {},
): Readonly<ResolvedFlopConfig> {
  const network = input.network ?? "devnet";
  if (!["devnet", "testnet", "mainnet"].includes(network))
    throw new Error("flop: invalid network");
  // Testnet/mainnet are planned networks, so there are no invented production defaults.
  if (network !== "devnet" && (!input.rpcUrl || !input.expectedGenesisHash)) {
    throw new Error(
      "flop: testnet/mainnet require rpcUrl and expectedGenesisHash",
    );
  }
  const rpcUrl = input.rpcUrl ?? "wss://rpc.devnet.flop.network";
  const url = new URL(rpcUrl);
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "flop: rpcUrl must be a WebSocket URL without credentials or fragment",
    );
  }
  if (
    input.expectedGenesisHash !== undefined &&
    !HEX32.test(input.expectedGenesisHash)
  ) {
    throw new Error("flop: malformed expectedGenesisHash");
  }
  const blockTimeMs = input.blockTimeMs ?? 1000;
  const refundMarginBlocks = input.refundMarginBlocks ?? 30;
  for (const [field, value] of Object.entries({
    blockTimeMs,
    refundMarginBlocks,
  })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) {
      throw new Error(`flop: invalid ${field}`);
    }
  }
  // Measured on devnet: inclusion plus finality consumed a 45 s window, not a 180 s one.
  const minClaimWindowMs = input.minClaimWindowMs ?? 90_000;
  if (
    !Number.isSafeInteger(minClaimWindowMs) ||
    minClaimWindowMs < 0 ||
    minClaimWindowMs > 0xffffffff
  )
    throw new Error("flop: invalid minClaimWindowMs");
  return Object.freeze({
    network,
    rpcUrl,
    expectedGenesisHash: input.expectedGenesisHash,
    blockTimeMs,
    refundMarginBlocks,
    minClaimWindowMs,
  });
}
