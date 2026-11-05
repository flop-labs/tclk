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
`connection.chain.snapshot(escrowId)` additionally reads the escrow.
`connection.chain.admissionBlock()` reads the [R10.2](#timelock-symmetry-r102)
inputs in the best block, and `admissionBlock(height)` in a finalized one. The caller
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
| `blockTimeMs` | `1000` | Nominal block interval agreed by both parties (R10.2's `T_other` always counts one-second blocks) |
| `refundMarginBlocks` | `30` | Extra refund blocks and maximum accepted inclusion delay |
| `transactionTimeoutMs` | `120000` | Time to await finalized transaction execution |

There is no R10.2 option: the rule always applies, with the runtime's parameters
(see [Timelock symmetry](#timelock-symmetry-r102)).

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
snapshots, `admissionBlock` reads that take the R10.2 constants from that block's
own runtime, and resolve writes only after successful finalized execution.

## Binding and deadlines

The versioned `flop2.` reference encodes public terms, network/genesis, the
escrow ID, a finalized anchor block hash, the agreed timing profile and the R10.2
parameters the open was admitted under. It contains no private key or claim
secret. It remains usable in another process. `flop1.` references, from earlier
unreleased builds, carry no R10.2 parameters and are refused. As of 2026-10-28 (devnet
finalized #2,285,869) no `flop1.` escrow was open on devnet: the 14 that existed were
settled (6 released, 8 refunded), and testnet and mainnet were not live.
The escrow policy is exactly:

```
commitment = SHA256(canonical binding)
And[Hash(statement), Hash(SHA256(commitment))]
```

Here `statement` is already the SHA-256 hash of the secret. The public binding
witness is `SHA256(canonical binding)`; the second `Hash` leaf contains the SHA-256
of that witness. The binding includes every `LockTerms` field and the network,
genesis, anchor, timing profile and R10.2 parameters. Both witnesses are supplied
at claim. This prevents reusing an escrow for a different contract, deadline or
asset. The second witness is public metadata, never a second payment secret.
Anyone can relay a claim, but payment always goes to the escrow's fixed payee.

For an anchor with timestamp `A`, the submitted relative timeout is:

```
ceil((refundAfterMs - A) / blockTimeMs) + refundMarginBlocks
```

The pallet sets its absolute deadline to **inclusion block + timeout**. Verification
checks that exact height and that inclusion happened within `refundMarginBlocks`
of the anchor. It requires an open escrow before `claimByMs`, the expected parties,
amount, two-leaf policy, chain identity, a runtime finality prefix below the
deadline, and R10.2 admission in the block that included the escrow. It fails
closed on RPC errors and malformed, stale or mismatched data.

**The chain enforces block heights, not Unix milliseconds.** The conversion is a
nominal schedule plus a margin, not a promise of wall-clock expiry. A stall can
hold funds longer; a changed block rate can shift the effective deadline. The
client stops claiming at `refundAfterMs` and waits for both that time and the
runtime's finalized deadline before refunding. Other clients can still use the
on-chain claim path until its block deadline. Agree these rail semantics and
sufficient margins before accepting a deal; they do not provide a hard real-time
refund or automatic cross-chain timelock safety. The RPC must retain the anchor
state for the contract's lifetime (use an archive endpoint for long-lived locks).

## Timelock symmetry (R10.2)

Every lock must pass the yellow paper's R10.2 admission rule (v0.5.0 §10.1,
`yellowpaper.md` lines 1976–1989 at
[`56410c67`](https://github.com/flop-labs/yellowpaper/blob/56410c67b11292e707d32ef32e9c4ff9c02e28c7/yellowpaper.md)).
There is no option to turn it off and no caller-supplied parameter. In the block
that evaluates the admission:

1. **Finality-open gate.** If `current_finality_lag` is at or above
   `finality_freeze_threshold`, the open is refused. The relation below is
   evaluated only under that threshold.
2. **Symmetry relation.**
   `T_FLOP >= T_other + max(ceil(T_other * p / 100), max_finality_stall + current_finality_lag)`.
   Equality is accepted.

| Term | Value used |
| --- | --- |
| `p`, `max_finality_stall`, `finality_freeze_threshold` | The runtime constants `HasStation.TimelockSymmetrySafetyMargin`, `MaxFinalityStall` and `FinalityFreezeThreshold`, read in the admitting block |
| `current_finality_lag` | The admitting block's height minus the runtime finality prefix (`aleph.lastFinalized`) read in that block |
| `T_other` | `ceil((claimByMs - A) / 1000)`: one-second blocks, whatever `blockTimeMs` is |
| `T_FLOP` | The submitted relative timeout (above), margin included |

With the yellow paper's values (20 %, 3600 and 120 blocks, which devnet runtime
1014003 also reports), `refundAfterMs` has to trail `claimByMs` by about an hour,
or by a fifth of the claim window if that is longer.

Which block admits the open:

- `lock` cannot read the block that will include the open, so it evaluates the
  rule on the best block the open will build on: before journaling, and again
  after the journal, right before signing. A refusal throws `FlopAdmissionError`
  (`reason` is `finality-freeze` or `timelock-symmetry`); nothing is journaled
  or sent.
- `verifyLock` evaluates it in the escrow's `createdBlock`, the block that
  included the open, read from finalized state. `lock` ends with the same call,
  so payer and payee read the same block with the same inputs and reach the same
  verdict, however far the tip's finality falls behind later. If finality fell
  behind between the payer's check and inclusion, `lock` throws `FlopLockError`
  and the payee's `verifyLock` returns `false`; the escrow can be refunded after
  its deadline.

The reference carries the three parameters, and the binding commits the escrow
policy to them. `verifyLock` returns `false` unless they equal the
`createdBlock`'s constants, so neither party can evaluate under other numbers, and
a runtime upgrade between check and inclusion fails closed. `claim` and `refund`
never apply the rule. The exported pure helpers `checkTimelockSymmetry`,
`timelockSymmetryMinimum` and `toOneSecondBlocks` throw on any operand that is not
a non-negative safe integer rather than reading it as zero.

**What is still approximate.** tclk has no counter-chain leg: `claimByMs`, the
payee's reveal deadline, stands in for the counter-chain HTLC's duration
`T_other`. R10.2 is stated for the runtime's cross-chain opens
(`create_cross_chain_htlc`, cross-chain `create_htlc_commit`); `FlopRail` opens a
typed escrow instead, so it applies the rule itself, in the client, through a
trusted RPC, and the payer's early check can only use the best block as a stand-in
for a block that does not exist yet. Passing it is not a mainnet R10.2 conformance
claim, and the margin is an admission condition, not a guarantee of timely
inclusion.

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

If opening finalized but verification failed (for example, delayed inclusion, or
R10.2 refusing the block that included it), `FlopLockError.ref` preserves the
public recovery reference. Do not post it as a
verified lock. It can still be refunded once its actual deadline arrives.
One instance refuses a second submission for the same contract, including after
an uncertain result. There is no on-chain uniqueness key for a tclk contract in
this pallet: separate wallets/processes must coordinate pending operations to
avoid duplicate deposits. One escrow cannot be released and refunded twice.

## Devnet exercise

Set two fresh, distinct Ed25519 seeds locally as `FLOP_PAYER_SEED` and
`FLOP_PAYEE_SEED` (32-byte `0x` hex; never commit them), then run:

```sh
node flop/examples/devnet.mjs --fund [--refund]
```

The optional `--fund` requests 2 test FLOP per account from the devnet faucet and
honors one short `Retry-After` response. Omit it for funded accounts. The example
escrows 0.001 test FLOP, verifies it as the payee and claims it. Its refund
deadlines follow the runtime's R10.2 constants, about an hour after the claim
deadline on devnet, so the refund half is opt-in: with `--refund` it also opens a
second 0.001 test FLOP escrow and waits for its finalized refund. It prints public
references for recovery and never prints the preimage or seeds. It refuses other
networks. `FLOP_RPC_URL` and `FLOP_GENESIS_HASH` override the connection; the public
faucet must match that genesis when `--fund` is used.

Run `pnpm --filter @flop-labs/tclk-flop test` for offline adversarial and transport
tests. The live exercise is opt-in and never part of CI.
