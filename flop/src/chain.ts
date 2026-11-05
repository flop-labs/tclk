// SPDX-License-Identifier: Apache-2.0
import { ApiPromise, WsProvider } from "@polkadot/api";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  ApiDecoration,
  SubmittableExtrinsic,
} from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";
import type { Option, Struct } from "@polkadot/types";
import type { Codec, ISubmittableResult } from "@polkadot/types/types";
import {
  FlopRail,
  type FlopAdmissionBlock,
  type FlopChain,
  type FlopEscrow,
  type FlopOpenRequest,
  type FlopSnapshot,
  type FlopPendingWriter,
} from "./rail.js";
import { HEX32, resolveFlopConfig, type FlopRailConfig } from "./config.js";
import type { FlopSymmetryParams } from "./symmetry.js";

/** No secret fields: safe to retain when a transport failure leaves submission ambiguous. */
export class FlopTransactionError extends Error {
  constructor(
    message: string,
    readonly txHash: string,
  ) {
    super(message);
  }
}
/** Exported for transport tests; never retries a possibly submitted transaction. */
export function finalizedTransaction(
  tx: SubmittableExtrinsic<"promise">,
  signer: KeyringPair,
  timeoutMs: number,
): Promise<ISubmittableResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (error?: string, result?: ISubmittableResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      if (error) reject(new FlopTransactionError(error, tx.hash.toHex()));
      else resolve(result!);
    };
    const timer = setTimeout(
      () => finish("flop: finality timeout; inspect txHash before retrying"),
      timeoutMs,
    );
    // Reject using our own messages: provider errors may echo the signed preimage calldata.
    try {
      tx.signAndSend(signer, { nonce: -1 }, (result) => {
        try {
          if (
            result.status.isInvalid ||
            result.status.isDropped ||
            result.status.isUsurped ||
            result.status.isFinalityTimeout
          ) {
            finish(
              "flop: transaction rejected or finality unknown; inspect txHash before retrying",
            );
          } else if (result.status.isFinalized) {
            if (
              result.dispatchError ||
              result.events.some(
                ({ event }) =>
                  event.section === "system" &&
                  event.method === "ExtrinsicFailed",
              )
            ) {
              finish("flop: finalized extrinsic failed");
            } else if (
              !result.events.some(
                ({ event }) =>
                  event.section === "system" &&
                  event.method === "ExtrinsicSuccess",
              )
            ) {
              finish("flop: finalized extrinsic has no success event");
            } else finish(undefined, result);
          }
        } catch {
          finish("flop: malformed transaction result");
        }
      }).then(
        (stop) => {
          unsubscribe = stop;
          if (settled) stop();
        },
        () =>
          finish(
            "flop: submission failed or outcome unknown; inspect txHash before retrying",
          ),
      );
    } catch {
      finish(
        "flop: submission failed or outcome unknown; inspect txHash before retrying",
      );
    }
  });
}
function integer(value: unknown, field: string): number {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text))
    throw new Error(`flop: malformed ${field}`);
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new Error(`flop: unsafe ${field}`);
  return n;
}
/** The runtime's AlephFinalizedPrefix height as stored in the block at `number`. */
function prefixHeight(prefix: Codec, number: number): number {
  const json = prefix.toJSON();
  if (json !== null && (!Array.isArray(json) || json.length !== 2))
    throw new Error("flop: malformed runtime finality prefix");
  // Mirrors AlephFinalizedPrefix's documented bootstrap behavior exactly.
  return json === null ? number : integer(json[0], "runtime finalized height");
}
/** R10.2's parameters: the HasStation constants of the runtime at `view`'s block. */
function symmetryParams(view: ApiDecoration<"promise">): FlopSymmetryParams {
  const constants = view.consts.hasStation;
  const read = (name: string) => {
    const value = constants?.[name];
    if (value === undefined)
      throw new Error("flop: runtime lacks the R10.2 constants");
    return integer(value.toString(), `HasStation constant ${name}`);
  };
  return {
    marginPercent: read("timelockSymmetrySafetyMargin"),
    maxFinalityStallBlocks: read("maxFinalityStall"),
    finalityFreezeThresholdBlocks: read("finalityFreezeThreshold"),
  };
}

export class PolkadotFlopChain implements FlopChain {
  readonly account?: string;
  constructor(
    readonly api: ApiPromise,
    private readonly signer?: KeyringPair,
    private readonly timeoutMs = 120_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new Error("flop: invalid transaction timeout");
    if (signer) {
      if (signer.type !== "ed25519" || signer.publicKey.length !== 32)
        throw new Error("flop: signer must use the party's Ed25519 DID key");
      this.account = `0x${bytesToHex(signer.publicKey)}`;
    }
    if (
      !api.tx.hasStation?.openEscrow ||
      !api.tx.hasStation?.satisfyEscrow ||
      !api.tx.hasStation?.refundEscrow ||
      !api.query.hasStation?.escrows ||
      !api.query.aleph?.lastFinalized
    )
      throw new Error(
        "flop: runtime lacks the required typed escrow/finality API",
      );
    const r10 = api.consts?.hasStation;
    if (
      !r10?.timelockSymmetrySafetyMargin ||
      !r10.maxFinalityStall ||
      !r10.finalityFreezeThreshold
    )
      throw new Error("flop: runtime lacks the R10.2 constants");
  }
  async snapshot(escrowId?: string, at?: string): Promise<FlopSnapshot> {
    const hash = at ?? (await this.api.rpc.chain.getFinalizedHead()).toHex();
    const [view, header, genesis] = await Promise.all([
      this.api.at(hash),
      this.api.rpc.chain.getHeader(hash),
      this.api.rpc.chain.getBlockHash(0),
    ]);
    const number = integer(header.number.toString(), "height");
    // api.at alone accepts a noncanonical block hash. Explicitly check both canonicality
    // and finalized membership, including when restoring a reference from another process.
    const finalized = await this.api.rpc.chain.getHeader(
      await this.api.rpc.chain.getFinalizedHead(),
    );
    if (
      number > integer(finalized.number.toString(), "finalized height") ||
      (await this.api.rpc.chain.getBlockHash(number)).toHex() !== hash
    )
      throw new Error("flop: snapshot is not canonical finalized state");
    const [timestamp, prefix] = await Promise.all([
      view.query.timestamp.now(),
      view.query.aleph.lastFinalized(),
    ]);
    const finalizedNumber = prefixHeight(prefix, number);
    const snapshot: FlopSnapshot = {
      genesis: genesis.toHex(),
      hash,
      number,
      timestampMs: integer(timestamp.toString(), "timestamp"),
      finalizedNumber,
    };
    if (escrowId !== undefined) {
      const codec = (await view.query.hasStation.escrows(
        escrowId,
      )) as Option<Struct>;
      if (codec.isSome) {
        const record = codec.unwrap();
        const raw = record.toJSON() as Record<string, unknown>;
        // Re-encode accounts through metadata: JSON may use SS58, while DID mapping is AccountId32.
        const account = (value: unknown) =>
          this.api.registry.createType("AccountId32", value).toHex();
        const p = raw.policy as {
          combinator: unknown;
          clauses: Record<string, unknown>[];
        };
        // Combinator has a data-bearing Threshold variant: SCALE JSON encodes And
        // as {and:null}, not the plain string used by the fieldless status enum.
        const combinator =
          p.combinator &&
          typeof p.combinator === "object" &&
          Object.keys(p.combinator).length === 1 &&
          (p.combinator as Record<string, unknown>).and === null
            ? "And"
            : JSON.stringify(p.combinator);
        const policy = {
          combinator,
          clauses: p.clauses.map((clause) => {
            const keys = Object.keys(clause);
            if (
              keys.length === 1 &&
              keys[0] === "hash" &&
              typeof clause.hash === "string"
            )
              return { Hash: clause.hash };
            return clause; // Any extra/unknown policy leaf fails the exact policy comparison.
          }),
        };
        const amount = record.get("amount")!.toString();
        const escrow: FlopEscrow = {
          id: String(raw.id),
          funder: account(raw.funder),
          payee: account(raw.payee),
          amount,
          policy,
          deadline: integer(record.get("deadline")!.toString(), "deadline"),
          createdBlock: integer(
            record.get("createdBlock")!.toString(),
            "created block",
          ),
          status: String(raw.status),
        };
        snapshot.escrow = escrow;
      }
    }
    return snapshot;
  }
  async admissionBlock(height?: number): Promise<FlopAdmissionBlock> {
    let hash: string;
    if (height === undefined) {
      // The best block, which a new open builds on. Not final: FlopRail only refuses on it.
      hash = (await this.api.rpc.chain.getBlockHash()).toHex();
    } else {
      if (!Number.isSafeInteger(height) || height < 0)
        throw new Error("flop: invalid admission block height");
      // As in snapshot(), a height-addressed read must be canonical finalized state.
      const finalized = await this.api.rpc.chain.getHeader(
        await this.api.rpc.chain.getFinalizedHead(),
      );
      if (height > integer(finalized.number.toString(), "finalized height"))
        throw new Error("flop: admission block is not finalized");
      hash = (await this.api.rpc.chain.getBlockHash(height)).toHex();
    }
    const [view, header, genesis] = await Promise.all([
      this.api.at(hash),
      this.api.rpc.chain.getHeader(hash),
      this.api.rpc.chain.getBlockHash(0),
    ]);
    const number = integer(header.number.toString(), "height");
    if (height !== undefined && number !== height)
      throw new Error("flop: admission block height mismatch");
    return {
      genesis: genesis.toHex(),
      hash,
      number,
      finalizedNumber: prefixHeight(
        await view.query.aleph.lastFinalized(),
        number,
      ),
      params: symmetryParams(view),
    };
  }
  private async send(
    tx: SubmittableExtrinsic<"promise">,
  ): Promise<ISubmittableResult> {
    if (!this.signer)
      throw new Error(
        "flop: this connection is read-only; provide a local Ed25519 signer",
      );
    return finalizedTransaction(tx, this.signer, this.timeoutMs);
  }
  async open(request: FlopOpenRequest): Promise<string> {
    const result = await this.send(
      this.api.tx.hasStation.openEscrow(
        request.payee,
        request.amount,
        request.policy,
        request.deadlineBlocks,
      ),
    );
    const events = result.events.filter(
      ({ event }) =>
        event.section === "hasStation" && event.method === "EscrowOpened",
    );
    if (events.length !== 1)
      throw new FlopTransactionError(
        "flop: finalized open lacks exactly one EscrowOpened event",
        result.txHash.toHex(),
      );
    const id = events[0].event.data[0].toString();
    if (!HEX32.test(id))
      throw new FlopTransactionError(
        "flop: malformed EscrowOpened id",
        result.txHash.toHex(),
      );
    return id;
  }
  async satisfy(id: string, preimages: readonly string[]): Promise<void> {
    await this.send(this.api.tx.hasStation.satisfyEscrow(id, preimages));
  }
  async refund(id: string): Promise<void> {
    await this.send(this.api.tx.hasStation.refundEscrow(id));
  }
}
export interface ConnectFlopRailOptions extends FlopRailConfig {
  signer?: KeyringPair;
  transactionTimeoutMs?: number;
  /** Persist public recovery data before any signed open transaction is sent. */
  persistPending?: FlopPendingWriter;
}
/** Local wallet connection. The caller owns the signer; no secret is sent to the chat/MCP server. */
export async function connectFlopRail(
  options: ConnectFlopRailOptions = {},
): Promise<{
  rail: FlopRail;
  chain: PolkadotFlopChain;
  disconnect(): Promise<void>;
}> {
  const config = resolveFlopConfig(options);
  const provider = new WsProvider(config.rpcUrl, false);
  const api = new ApiPromise({ provider, noInitWarn: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await provider.connect();
        await api.isReadyOrError;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("flop: connection timed out")),
          20_000,
        );
      }),
    ]);
    const genesis = api.genesisHash.toHex();
    if (config.expectedGenesisHash && genesis !== config.expectedGenesisHash)
      throw new Error("flop: genesis mismatch");
    // TOFU on devnet only; thereafter every operation and reference is checked against it.
    const chain = new PolkadotFlopChain(
      api,
      options.signer,
      options.transactionTimeoutMs,
    );
    const rail = new FlopRail(
      chain,
      { ...config, expectedGenesisHash: genesis },
      Date.now,
      options.persistPending,
    );
    await chain.snapshot(); // Check actual finalized storage before returning a usable rail.
    return { rail, chain, disconnect: () => api.disconnect() };
  } catch (error) {
    await api.disconnect();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
