# `flop-htlc` rail — design notes

> Testnet only. Not audited. This binding has not touched a chain: there is no public FLOP
> HTLC RPC as of 2026-09-18, so the rail runs against a deterministic mock and an unwired stub.
> Nothing here holds keys, signs, or moves value.

`SPEC.md` §5 names `flop-htlc` as the FLOP network's typed escrow and leaves it "to bind
later". This is that binding, as far as it can be taken without a node: `FlopHtlcRail`
(`src/flop-htlc-rail.ts`) implements `SettlementRail` against a `FlopChainClient` seam
(`src/flop-chain.ts`), with `MockFlopChain` behind it for tests and `FlopRpcChainClient` naming
what a live client must do.

The chain side is the yellow paper, v0.5.0 draft, updated 2026-09-05
(<https://flop.finance/intro/yellowpaper/>): §10 *HTLC Atomic Swap*, Appendix A parameters,
Appendix G.3 (`has-station`: `create_htlc` / `redeem_htlc` / `refund_htlc`), Appendix H.5
(status: "LIVE local mechanics; pair conformance GAP — PENDING E.48"). R2.2, §1.2 and §13 F1 are
quoted from the 2026-09-24 sync of the same draft (`flop-labs/yellowpaper` @ `3c97bbc`). Every
assumption below cites where it comes from; the ones that are assumptions rather than citations
are marked.

## What maps to what

| tclk/1 (`LockTerms`) | FLOP HTLC | Source |
|---|---|---|
| `lock: "hash"`, `statement` (32-byte sha256) | `H = SHA256(s)` | YP §10 R10.1; tclk `hashLockFromPreimage` |
| `lock: "point"` | **refused** | YP §10 defines no point predicate (see below) |
| `amount`, `asset` | escrow amount, `FLOP` only by default | assumption: one native asset per escrow |
| `payer`, `payee` (DIDs) | chain accounts via `resolveAccount(did)` | assumption; same seam as PR #125's DID→address |
| `refundAfterMs` | `T_lock` (block height) | YP §1/§2: 1-second blocks; mapping below |
| `claimByMs` | `T_other` for the R10.2 admission check | YP §10 R10.2 |
| `lock()` → ref | `create_htlc` → escrow id | YP App. G.3 |
| `claim(ref, secret)` | `redeem_htlc(id, s)`, **finalized** head strictly below `T_lock` | YP §10 state machine; R2.2; §1.2 / §13 F1 |
| `refund(ref)` | `refund_htlc(id)`, **finalized** head at/after `T_lock` | YP §10 R10.3; R2.2 |

## Time domains

tclk deadlines are unix ms on the venue's wall clock; the chain's timelock is a block height.
With 1-second blocks (§1 "All durations assume 1-second blocks"; §2 BABE authoring), the rail
projects from the tip it observes at lock time:

```
T_lock = best.number + ceil((refundAfterMs - best.timestampMs) / 1000)
```

`best.timestampMs` is the block's own `pallet_timestamp` value (assumption: the node exposes it
with the header — standard Substrate). The projection is done once, when the escrow is created;
after that the escrow's `T_lock` is the truth and the ms deadline is only used to re-derive
`T_other` for `verifyLock`.

Claim/refund boundaries are the same pair `MemoryRail` and `PaperRail` use on `refundAfterMs`,
and both read the finalized head: claim admitted while `finalized.number < T_lock`, refund
admitted once `finalized.number >= T_lock`. Neither gate reads the tip. R2.2: "Every
fund-releasing, expiry, slashing, or pruning action MUST read the finalized prefix ... never the
chain tip" — a redeem releases the escrow to the payee as surely as a refund returns it to the
payer — and R10.3 says it again for refund ("a tip-gated refund is reorg-unsafe"). One clock for
both means exactly one of claim/refund is admissible at any finalized height: R10.1's "at most
one", with no height at which neither is. `MockFlopChain.holdFinality` simulates a finality stall
so both gates are tested against it.

If block production stalls, `T_lock` arrives later in wall time than `refundAfterMs`. That
delays the payer's refund and never shortens the payee's claim window, which is the safe
direction; the reverse (blocks faster than 1 s) is not something BABE does.

If finality stalls while blocks keep coming (§13 F1: "production continues; finality-sensitive
economic deadlines freeze"), the tip can pass `T_lock` before the finalized head reaches it. Both
deadlines then freeze, as §1.2 requires ("a finality stall MUST freeze economic deadlines by
construction"): the payee can still claim and the payer cannot refund yet, until the finalized
prefix reaches `T_lock`. A tip-clocked claim gets this wrong: at `T_lock = 7200`, `best = 7200`,
`finalized = 7190` it refuses the claim while the refund is still refused, so the claim deadline
runs out on the tip during the stall. That was this binding's first revision (caught in review on
PR #171); the tests now pin the case, for the rail and for the mock chain.

## R10.2 — timelock symmetry, made checkable

> **R10.2** — After converting the foreign duration to one-second FLOP blocks, `T_FLOP` MUST
> satisfy `T_other + max(ceil(T_other × p / 100), max_finality_stall + current_finality_lag)`,
> where `p` is `htlc_timelock_symmetry_safety_margin_percent`. This margin is a necessary
> admission condition, not by itself a timely-inclusion guarantee.

Issue #132 points out that nothing in tclk enforces this: `validateDeadlines` takes abstract
margins, the chain enforces only its own `T_lock`, and nobody compares the two. The rail is the
party that knows both, so it does:

- `T_other` = blocks from the tip until `claimByMs` — the coordination leg is the "foreign"
  duration here: the payee reveals in the room by `claimByMs` and then needs the redeem
  included before the finalized head reaches `T_lock`.
- `T_FLOP` = blocks from the tip until `refundAfterMs` (= `T_lock - best.number`).
- `current_finality_lag` = `best.number - finalized.number`, derived, never a separate reading.
- `p` and `max_finality_stall` come from `FlopChainClient.params()`. The library ships the
  Appendix A values of record as `FLOP_HTLC_PARAMS_V050` (`p = 20`, `max_finality_stall = 3_600`
  blocks) under that explicit name; it supplies no silent default, consistent with `locks.ts`
  ("there is no safe universal default").

`lock()` refuses terms that do not clear the minimum, with the numbers in the error.
`verifyLock()` — the payee's gate — recomputes the requirement from the tip *now* and answers
false if the escrow's remaining timelock is short of it, or if `claimByMs` is no longer ahead
of the tip. With the v0.5.0 constants the practical rule is: the refund window must be at least
one hour (3 600 blocks) plus the observed finality lag beyond the claim deadline, or 20 % of the
claim window if that is larger.

## Fail-closed surface

Consistent with `applyFrame`'s `nowMs` rule and the F1 fix, every operand is validated before
it is compared: a deadline that is not a positive safe integer, a head whose `number` or
`timestampMs` is not, chain params that are not counts, a statement that is not 32 bytes of
lowercase hex, an amount that is not a positive decimal string, an asset other than the rail's,
a payer equal to the payee. `lock`/`claim`/`refund` throw; `verifyLock` returns false and never
throws, including when the chain client itself throws.

The rail also re-checks at its own layer what the chain will check (status, hash, timelock), so
a misbehaving client cannot be talked into a state the rail would not have reached itself. The
mock chain enforces R10.1 independently: at most one of redeem/refund, from `created` only.

## What is deliberately out of scope

- **Point locks.** `SPEC.md` §5 says the FLOP escrow can be opened with a `Point(Y)` leaf. The
  yellow paper §10 defines only `H = SHA256(s)` and Appendix G.3 lists no point extrinsic. The
  rail refuses `lock: "point"` rather than invent an encoding; if the escrow grows a point
  predicate, `FlopCreateHtlc` gets a `predicate` union and this note moves. Flagged in the PR
  as a SPEC-vs-yellow-paper disagreement for the maintainers to settle.
- **R10.5 multi-block settlement** (lock a max, settle the attested actual). `LockTerms` has one
  `amount` and the contract id commits to it — issue #132 Gap 1. Not a rail concern.
- **R10.4 relayers / cross-chain pairs.** This is the FLOP leg only, with tclk as the
  coordination layer; no counter-chain, no `relay_preimage`.
- **Signing and keys.** `FlopChainClient` carries none. A live client will take a signer
  callback from whatever wallet owns the account, outside this library — the same rule the MCP
  server follows for its secrets.
- **Fees, inclusion, MAD-HTLC bribery** (§10.3). The margin is an admission condition; the
  paper says so itself.

## `FlopRpcChainClient` — what wiring it will need

Each method carries a `TODO(testnet RPC)` comment. In one place:

1. `bestHead` / `finalizedHead`: `chain_getHeader` on the best and `chain_getFinalizedHead`
   heads, plus `timestamp.now` at that block → `{ number, timestampMs }`.
2. `params`: read `htlc_timelock_symmetry_safety_margin_percent` and `max_finality_stall`
   from runtime constants; refuse to run on a hard-coded fallback.
3. `createHtlc`: `has-station.create_htlc(payee, amount, hash, timelock)` signed by the
   payer's wallet; return the escrow id from the emitted event.
4. `getHtlc`: storage read by id → `FlopHtlcRecord`.
5. `redeemHtlc` / `refundHtlc`: the corresponding extrinsics signed by payee / payer; the
   rail has already checked the height gates against the finalized head, the chain checks
   them again.

Until a public node exists, every method throws `not wired`, and `FlopHtlcRail` on top of it
fails closed (tests cover this).

## Why now

Arthur Hayes (2026-09-17, reported by PANews; `@flop_labs` RT of `@CryptoHayes`, status
`2100486806643077598`) said testnet FLOP will be tradable through HTLCs and that what the
project wants from contributors is adapters. tclk is the coordination layer the ecosystem's
HTLC deals already run on, and its `flop-htlc` rail was a table row. This makes it a binding
with a test suite, ready to point at a node.
