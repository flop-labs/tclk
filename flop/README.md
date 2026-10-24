# FlopRail

`@flop-labs/tclk-flop` implements `SettlementRail` with native FLOP HTLC escrows.
Devnet is the default. The transport lives in this separate package so the tclk
protocol library remains free of networking and Polkadot dependencies.

It uses `hasStation.openEscrow`, `satisfyEscrow` and `refundEscrow`, with locally
signed extrinsics and finalized dispatch receipts. It does not use the legacy
`hasStation_createHTLC` write RPC stubs or the inference-task HTLC API.

## Use

From this workspace, run `pnpm install --frozen-lockfile` and
`pnpm -r --include-workspace-root build`. Consumers can import the package through
its workspace dependency; publishing is a separate release step.

```ts
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { connectFlopRail } from '@flop-labs/tclk-flop';
import { lockTerms } from '@flop-labs/tclk';

await cryptoWaitReady();
const signer = new Keyring({ type: 'ed25519', ss58Format: 42 })
  .addFromSeed(yourLocal32ByteSeed);
const connection = await connectFlopRail({ signer }); // devnet
try {
  const terms = lockTerms(acceptedContractState);
  const ref = await connection.rail.lock(terms);
  // Persist ref, then publish the signed tclk lock frame with rail: 'flop-htlc'.
  // The payee independently calls verifyLock(terms, ref) before doing work.
  // The payee's local connection calls claim(ref, preimage) to settle.
  // The payer calls refund(ref) after BOTH wall time and the chain allow it.
} finally {
  await connection.disconnect();
}
```

A connection without `signer` supports verification. `connection.chain.snapshot()`
provides the current finalized height, runtime finality prefix and timestamp;
`connection.chain.snapshot(escrowId)` additionally reads the escrow. The caller
owns the RPC connection and must disconnect it. This is a trusted-RPC client,
not a light client verifying storage proofs or consensus itself.

V1 uses the exact Ed25519 public key in each party's `did:key` as its FLOP
`AccountId32`; an unrelated sr25519 wallet or an arbitrary DID-to-address map is
rejected. Both accounts must already exist on-chain, and the submitting account
needs transaction fees. `amount` is an exact decimal **base-unit** string:
`1000000000000000000` is 1 FLOP. Only the native `FLOP` asset and `lock: 'hash'`
are supported. PTLC/adaptor signing is not used.

## Network configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `network` | `devnet` | `devnet`, `testnet` or `mainnet` |
| `rpcUrl` | `wss://rpc.devnet.flop.network` on devnet | WebSocket RPC; override for local/private deployments |
| `expectedGenesisHash` | Pin the first connected devnet genesis | Explicit trusted 32-byte lowercase hex pin |
| `blockTimeMs` | `1000` | Nominal block interval agreed by both parties |
| `refundMarginBlocks` | `30` | Extra refund blocks and maximum accepted inclusion delay |
| `transactionTimeoutMs` | `120000` | Time to await finalized transaction execution |

Testnet and mainnet require **both** `rpcUrl` and `expectedGenesisHash`. FLOP's
current network registry marks these networks as planned; a configuration label
is not evidence that either has launched. Supply an operator-published endpoint
and genesis at launch. Never obtain the trusted genesis from an untrusted lock
frame. For devnet, independently compare the RPC genesis with the faucet's
`GET https://faucet.flop.network/chain`, or supply a trusted pin explicitly.
A devnet reset invalidates references from the previous genesis.

```ts
const connection = await connectFlopRail({
  network: 'testnet', // or 'mainnet'
  rpcUrl: operatorRpcUrl,
  expectedGenesisHash: operatorPublishedGenesis,
  signer,
});
```

`FlopRail(chain, config, clock)` also accepts an injected `FlopChain` for testing
or another transport. That transport must provide coherent, canonical finalized
snapshots and resolve writes only after successful finalized execution.

## Binding and deadlines

The versioned `flop1.` reference encodes public terms, network/genesis, the
escrow ID, a finalized anchor block hash and the agreed timing profile. It
contains no private key or claim secret. It remains usable in another process.
The escrow policy is exactly:

```
commitment = SHA256(canonical binding)
And[Hash(statement), Hash(SHA256(commitment))]
```

Here `statement` is already the SHA-256 hash of the secret. The public binding
witness is `SHA256(canonical binding)`; the second `Hash` leaf contains the SHA-256
of that witness. The binding includes every `LockTerms` field and the network,
genesis, anchor and timing profile. Both witnesses are supplied at claim. This
prevents reusing an escrow for a different contract, deadline or asset. The second
witness is public metadata, never a second payment secret. Anyone can relay a
claim, but payment always goes to the escrow's fixed payee.

For an anchor with timestamp `A`, the submitted relative timeout is:

```
ceil((refundAfterMs - A) / blockTimeMs) + refundMarginBlocks
```

The pallet sets its absolute deadline to **inclusion block + timeout**. Verification
checks that exact height and that inclusion happened within `refundMarginBlocks`
of the anchor. It requires an open escrow before `claimByMs`, the expected parties,
amount, two-leaf policy, chain identity and a runtime finality prefix below the
deadline. It fails closed on RPC errors and malformed, stale or mismatched data.

**The chain enforces block heights, not Unix milliseconds.** The conversion is a
nominal schedule plus a margin, not a promise of wall-clock expiry. A stall can
hold funds longer; a changed block rate can shift the effective deadline. The
client stops claiming at `refundAfterMs` and waits for both that time and the
runtime's finalized deadline before refunding. Other clients can still use the
on-chain claim path until its block deadline. Agree these rail semantics and
sufficient margins before accepting a deal; they do not provide a hard real-time
refund or automatic cross-chain timelock safety. The RPC must retain the anchor
state for the contract's lifetime (use an archive endpoint for long-lived locks).

## Recovery

Transactions are never automatically retried. The transport currently signs
immortal extrinsics: an uncertain transaction can remain eligible for inclusion
much later, even after the client stops waiting. A manual replacement using the
same account nonce can usurp it, so a timeout alone does not establish either
execution or cancellation. An RPC timeout can also mean a signed transaction
was included even though its receipt was lost. `FlopTransactionError`
contains `txHash`; inspect its finalized events before resubmitting. A wallet
should pass `persistPending: async (pendingRef) => { /* durable wallet journal */ }`
to `connectFlopRail`. This hook completes before signing/sending; if it fails,
no transaction is submitted. After the hook finishes, the rail rechecks the
claim window and the anchor against the latest finalized snapshot. A closed
claim window or exhausted inclusion allowance aborts before submission and
allows the wallet to prepare a fresh attempt. The library itself does not persist state.
`FlopSubmissionError` carries that same `pendingRef` and, when available, `txHash`.
Use `recoverFlopReference(pendingRef, escrowIdFromFinalizedEvent)` to reconstruct
the reference after a lost receipt, then verify it against the chain. Do not
substitute an escrow ID from a chat message.

If opening finalized but verification failed (for example, delayed inclusion),
`FlopLockError.ref` preserves the public recovery reference. Do not post it as a
verified lock. It can still be refunded once its actual deadline arrives.
One instance refuses a second submission for the same contract, including after
an uncertain result. There is no on-chain uniqueness key for a tclk contract in
this pallet: separate wallets/processes must coordinate pending operations to
avoid duplicate deposits. One escrow cannot be released and refunded twice.

The duplicate guard lives in memory, so a restarted wallet has only its journal.
`rail.sweep(refs)` takes the journal's references, refunds each Open escrow this
signer funded once its refund window is open, and returns one entry per distinct
reference: `{ ref, status, refunded, error? }`. `status` is the finalized escrow
status, `"pending"` for a zero-escrow `pendingRef` (complete it with
`recoverFlopReference` first; the sweep cannot find an escrow ID for it), or
`"failed"`. A failed refund is reported, not retried. Running the sweep again is
safe, because it reads finalized state before every refund and skips an escrow
that is no longer Open.

## Devnet exercise

Set two fresh, distinct Ed25519 seeds locally as `FLOP_PAYER_SEED` and
`FLOP_PAYEE_SEED` (32-byte `0x` hex; never commit them), then run:

```sh
node flop/examples/devnet.mjs --fund
```

The optional `--fund` requests 2 test FLOP per account from the devnet faucet and
honors one short `Retry-After` response. Omit it for funded accounts. The example
escrows 0.001 test FLOP, verifies it as the payee, claims it, then opens a second
0.001 test FLOP escrow and waits for its finalized refund. It prints public
references for recovery and never prints the preimage or seeds. It refuses other
networks. `FLOP_RPC_URL` and `FLOP_GENESIS_HASH` override the connection; the public
faucet must match that genesis when `--fund` is used.

Run `pnpm --filter @flop-labs/tclk-flop test` for offline adversarial and transport
tests. The live exercise is opt-in and never part of CI.
