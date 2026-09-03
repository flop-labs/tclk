# tclk/2 design proposal

Status: **discussion draft; non-normative**. `SPEC.md` remains the normative tclk/1
specification. Nothing in this document changes the meaning of an existing `tclk1 ` line.

## Decision summary

tclk/2 should begin as a deliberately narrow **direct conditional-payment** protocol. Its
stable abstraction is:

```text
Agreement
  └─ TransferAttempt / part [0..n]
       └─ verified RailObservation [0..n]
```

An agreement records commercial intent. A transfer attempt records one concrete reservation
of value on one rail. An observation records what that rail verifiably did. These are different
objects with different identifiers and lifetimes.

The first tclk/2 profile should support direct, two-party, preimage-SHA-256 payments suitable
for the initial flop-core HTLC. Routed payments, general atomic swaps, redundant multipart
payments, and point/adaptor locks should be separate later profiles. In particular, tclk/2 must
not claim that publishing one witness in a room is a generic routed-payment protocol.

The first implementation needs at most one transfer attempt per agreement. The separate attempt
identity prevents the agreement and the rail reservation from becoming the same object, but
replacement and multipart attempt collections remain deferred until a profile needs them.

This is intentionally a wire break. tclk/1 remains decodable and replayable; new tclk/2
messages use a new prefix and domain. The tclk/1 golden vectors must not be edited.

## Why tclk/1 is not the contract to give flop-core

tclk/1 is useful coordination machinery, but it fuses concepts that real settlement systems
keep separate:

1. The counterparty always supplies `accept.statement`, while the specification says the payee
   owns the secret. A payee-opened offer therefore assigns condition creation to the payer
   ([#12](https://github.com/flop-labs/tclk/issues/12)).
2. A payer-authored `lock` frame advances the transcript machine to `locked`, and a room
   `reveal` or `refund` advances it to a monetary terminal state. A signed assertion is not
   evidence that the rail funded, claimed, or refunded anything.
3. `contract` is both the commercial agreement identifier and, in the reference rail, the
   unique lock key. That excludes retries, replacements, partial payments, and multiple rails.
4. `claimByMs`, `refundAfterMs`, and `expiresMs` mix commercial timing, coordination timing,
   and rail enforcement in one wall-clock domain. Real rails use block height, ledger close
   time, consensus time, or a bilateral clock with an explicit trust assumption.
5. `lock: "hash" | "point"` does not identify the hash algorithm, curve, encoding, signature
   construction, witness limit, or message/domain an adaptor signature commits to
   ([#36](https://github.com/flop-labs/tclk/issues/36)).
6. The state machine has no explicit, observable way to abandon an accepted but unfunded
   agreement ([#41](https://github.com/flop-labs/tclk/issues/41)).
7. The protocol describes one public witness as the propagation mechanism for routed
   payments. That is at best one direct-HTLC construction, not a safe universal routing rule.

Patching these independently would preserve the `tclk1 ` spelling while changing its security
model. A versioned replacement is clearer and safer.

## Scope and profiles

Every agreement names a profile. A profile fixes roles, condition authority, required phases,
and the safety properties consumers may rely on.

### Initial profile: `direct-conditional-payment@1`

- Exactly one payer and one payee are named explicitly in the completed terms.
- The payee is the condition authority: it supplies or signs off on the public commitment,
  regardless of which party proposed the agreement.
- The only condition suite is `preimage-sha256@1`, with a 32-byte commitment and 32-byte
  witness.
- A successful attempt transfers its amount only to `claimTo`; an expired attempt returns its
  amount only to `refundTo`.
- `claimTo` is the payee and `refundTo` is the payer in this profile.
- The rail profile states who may submit claim and refund operations. Submission authority is
  not inferred from the payout address.
- Settlement is terminal only after a trusted rail observation.
- The profile fixes the expiry clock and boundary semantics. The agreement carries one
  rail-native expiry; an earlier safe claim deadline is local policy, not protocol state.

This profile is the intended contract between tclk/2 and the first flop-core HTLC.

### Deferred profiles

- **Routed payment.** Needs per-hop or per-packet attempts, amounts, expiries, private backward
  fulfillment, and possibly path-specific release keys.
- **Atomic swap.** Needs a swap graph and explicit secret-generating leaders; a payee is not a
  universal condition owner.
- **Multipart/redundant payment.** Needs aggregate amount and threshold semantics so successful
  parts cannot overpay and stragglers cannot block forever.
- **Point/adaptor payment.** Needs an audited cryptographic suite that pins the group, point and
  scalar encodings, signature algorithm, nonce construction, signed message, and domain.

Deferring these is a scope boundary, not a claim that one direct-payment witness can safely be
reused for them.

## Objects and identifiers

### Proposal and agreement

A proposal may be authored by either party. It names proposed roles and terms but is not itself
a reservation of money. The second party signs a completed, normalized agreement. If the payee
authored the proposal, the condition may be present there; if the payer authored it, the payee
adds the condition when agreeing.

`agreementId` commits to the completed terms, both party identifiers, the proposal identifier,
and negotiation nonces. It must not depend on putting the condition in an acceptor-specific
field. Equivalent completed terms have one canonical representation before hashing.

### Transfer attempt

One agreement may have zero or more transfer attempts. Each attempt has a fresh `attemptId` and
binds at least:

```ts
interface TransferAttempt {
  attemptId: string;
  agreementId: string;
  rail: { id: string; profile: string; profileHash: string };
  amount: string;
  asset: string;
  condition: Condition;
  claimTo: string;
  refundTo: string;
  expiry: string; // canonical rail-native value; its profile defines the clock and comparison
  nonce: string;
}
```

The initial direct-payment profile permits zero or one attempt. A later profile may permit a
replacement after an earlier attempt fails, or several parts under aggregate-payment semantics.
A condition is never an identifier: future attempts may intentionally share a witness, and
unrelated attempts must not collide merely because they carry the same commitment.

`railRef` is the rail's native identifier and is bound to exactly one `attemptId` after the rail
accepts the reservation. Neither value substitutes for the other.

### Rail observation

A room participant may announce that it submitted an operation. That announcement is useful for
coordination but does not change authoritative money state. A state-advancing observation must be
verified according to the selected rail profile:

```ts
interface RailObservation {
  observationId: string;
  attemptId: string;
  railRef: string;
  status: "funded" | "claimed" | "refunded" | "rejected";
  finality: "pending" | "final";
  evidence: unknown; // closed, rail-specific schema
}
```

The registry defines how `evidence` is authenticated and checked. For flop-core this may be a
locally verified finalized transaction/event reference; another rail may use an authenticated
API response or bilateral receipt. A consumer must never silently promote `pending` evidence to
`final`.

`observationId` is an idempotency key. Replaying the same observation is a no-op. Two final
observations that claim incompatible terminal outcomes for one attempt are a verification or
rail failure, not a last-write-wins update.

## Conditions and rail capabilities

Conditions are typed suites, not informal shapes:

```ts
type Condition = {
  suite: "preimage-sha256@1";
  commitment: string; // canonical lowercase 0x + 32 bytes
};
```

A versioned rail profile should publish at least:

- supported assets and amount bounds;
- supported condition suites and maximum witness/evidence sizes;
- supported expiry clocks, boundary semantics, and minimum safety margins;
- claim and refund submission authorization;
- finality rule and observation verifier;
- whether expiry automatically transfers value or merely enables a refund operation;
- callback/reentrancy behavior; and
- a stable profile version or digest that signed agreements bind.

Matching only the canonical rail id is insufficient. XRP Ledger conditional escrow, for example,
supports PREIMAGE-SHA-256, while FRAME's generic atomic-swap pallet uses Blake2 and exposes a
proof-size compatibility requirement. A registry update must not reinterpret an agreement that
was signed against an older rail profile.

### Built-in and custom rail registration

tclk must ship useful built-in profiles without making that list a closed protocol namespace.
An application may supply a caller-owned registry and register custom rail adapters before it
creates or verifies an agreement. Registration is local configuration, not executable code
downloaded from a room and not mutable global process state.

Each entry binds:

```ts
interface RailProfileDescriptor {
  id: string;            // namespaced stable identifier
  profile: string;       // immutable semantic profile such as "direct-htlc@1"
  conditionSuites: string[];
  expiryClock: string;
  expiryEncoding: string;
  timeoutSemantics: "exclusive" | "refund-race" | "automatic-refund";
  claimAuth: string;
  refundAuth: string;
  finalityRule: string;
  verifier: string;      // stable local verifier interface/version identifier
}
```

Registration computes `profileHash` from the canonical descriptor. The signed attempt binds
`id`, `profile`, and that digest. The expiry is an opaque canonical string to the tclk core; only
the registered adapter interprets and compares it. This permits block heights, consensus
timestamps, ledger-close times, and custom monotonic counters without a generic clock union in
protocol state.

The registry must reject malformed identifiers, duplicate `(id, profile)` entries, attempts to
rebind an existing entry to a different digest, and aliases in signed bytes. An unknown profile
may be preserved while decoding or auditing, but it is unsupported for construction and cannot
advance authoritative settlement state. Two valid registries lacking a common profile report
"no match"; malformed or digest-conflicting entries fail closed.

Custom identifiers should be owner-namespaced and versioned. For tclk/1's existing identifier
grammar that means spellings such as `example.flop-htlc-v1`; tclk/2 may define a less ambiguous
structured identifier. Registration establishes local trust in the adapter and verifier—it does
not make the custom rail safe merely because it has a name.

## Time model

tclk/2 separates three kinds of time:

1. **Offer expiry** is a coordination deadline and may use qualified Unix time.
2. **Delivery or work due time** is an optional commercial term. Passing it does not itself move
   money.
3. **Attempt expiry** is the one rail-native value boundary. Whether it disables the condition
   path or merely enables a competing refund path is fixed by the selected rail profile. An
   operational "claim by" margin is derived locally and does not create another protocol state.

Expiry is not a settlement event. An expired escrow may still hold value until somebody submits
a refund. The derived state is therefore `funded + expired`, not `refunded`.

A future cross-rail profile must state and model the bounds it assumes for clock growth,
transaction inclusion, finality, observation, and propagation. Deadline staggering is a policy
over attempts in that profile, not a pair of universal wall-clock fields copied onto every rail.

For the initial executable safety model, time can be a monotonic environment predicate such as
`refundOpen`, rather than integer arithmetic. Numeric clock progress, inclusion bounds, and
eventual refund are liveness assumptions supplied by the rail profile, not base-protocol safety
facts.

## State derivation

The coordination state and money state remain separate:

```text
proposal ──agreement──▶ agreed ──funding announcement──▶ agreed/funding
     │                    │
     └────withdrawn───────┴────abandoned (only before verified funding)

attempt: unknown ──verified funded──▶ funded ──verified claimed──▶ claimed
                                          └──verified refunded─▶ refunded
```

`funded`, `claimed`, and `refunded` require verified rail observations. A witness appearing in a
room may be recorded as `witness-known`; it is not proof that a rail accepted a claim. Likewise,
a refund request is not proof that the funds returned.

Agreement-level status is derived from its attempts and profile. It is not a single mutable enum
that lets one signed message erase contradictory rail state.

## Execution and callback rules

Beneficiary and executor are separate concepts:

- `claimTo` and `refundTo` are immutable payout destinations.
- `claimAuth` and `refundAuth` come from the rail profile and may be permissionless,
  beneficiary-only, owner-only, witness-plus-signature, or another closed policy.
- A coordination frame's `from` identifies its signer; it does not prove who submitted the rail
  transaction.

Where a rail invokes external code or middleware, terminalization consumes the live lock before
any callback. Claim, refund, acknowledgement, and timeout handling must be idempotent under
duplicate delivery and safe under reentrant invocation. At-least-once observation delivery must
not create more than one monetary effect.

## Required properties and adversary model

The executable model and implementation tests should cover at least:

1. **Conservation:** an attempt never pays or refunds more than was reserved.
2. **Terminal exclusivity:** a funded attempt cannot become both claimed and refunded.
3. **Exact binding:** observation, rail reference, amount, asset, destinations, condition, and
   expiry all bind to the same attempt.
4. **Authoritative funding:** a party announcement alone never establishes that funds exist.
5. **Deadline safety:** claim cannot win outside its rail-valid interval and refund cannot win
   before its rail-valid interval; the exact boundary is specified.
6. **Replay and reentrancy safety:** duplicate, reordered, and recursive operations do not repeat
   an effect or change a terminal result.
7. **No secret custody:** shared MCP infrastructure neither stores nor later echoes a witness.
8. **Recovery visibility:** accepted but unfunded agreements can become observably abandoned;
   expired but unrefunded attempts remain distinguishable from refunds.

The environment must include independent rail clocks, bounded or unbounded message delay,
transaction inclusion/finality, duplicate observations, unavailable parties, and any watcher or
relayer assumptions. A state machine that merely contains a legal recovery action has not proved
that an honest party can get that action included in time.

## Wire and migration

- Reserve `tclk2 ` for the new frame encoding and `FLOP::tclk::v2` for identifiers/signatures.
- Keep the tclk/1 decoder, state fold, schema, and golden vectors for historical replay.
- Do not implicitly reinterpret a `tclk1 ` transcript as a tclk/2 agreement.
- New construction APIs should emit only tclk/2 once the normative spec is complete; legacy
  builders remain explicitly versioned.
- Continue merging tclk/1 fixes that preserve existing bytes, reject malformed input, bound
  resources, or improve auditability.
- Permit custom tclk/1 rail emission only through an explicit caller-owned registry. Because the
  tclk/1 wire binds Unix milliseconds rather than a native expiry, such an adapter must define and
  verify its versioned mapping from `refundAfterMs` to the rail lock. Unknown ids remain
  decode-only. A process-global `registerRail()` would introduce cross-tenant ambiguity and is not
  acceptable.
- Do not add a new value-bearing rail or a large new tclk/1 client before the tclk/2 contract is
  settled. Those implementations would either encode the assumptions above or need an immediate
  rewrite.

## Research basis

The proposal takes structure and failure modes from multiple ecosystems rather than treating one
Bitcoin construction as universal:

- [Interledger Protocol v4](https://interledger.org/developers/rfcs/interledger-protocol/) uses
  individually expiring Prepare/Fulfill/Reject packets, local per-hop amounts, and progressively
  earlier expiries. A logical payment may contain many packets.
- [STREAM](https://interledger.org/developers/rfcs/stream-protocol/) derives fulfillments and
  conditions per encrypted packet, while
  [ILP over HTTP](https://interledger.org/developers/rfcs/ilp-over-http/) specifies request
  correlation, retries, and first-reply idempotence.
- [Interledger HTLAs](https://interledger.org/developers/rfcs/hashed-timelock-agreements/)
  distinguish ledger-enforced escrow, payment-channel agreements, trustlines, and notarized
  timekeeping instead of pretending their trust assumptions are identical.
- [XRP Ledger escrow](https://xrpl.org/docs/concepts/payment-types/escrow) separates immutable
  payout destinations from transaction submitters, uses ledger close time, and leaves an expired
  escrow present until a later cancellation returns the funds.
- [Polkadot SDK FRAME atomic swap](https://paritytech.github.io/polkadot-sdk/master/pallet_atomic_swap/pallet/struct.Pallet.html)
  uses native block durations and recommends a shorter duration for the secret revealer. Its
  [configuration contract](https://docs.rs/pallet-atomic-swap/latest/pallet_atomic_swap/pallet/trait.Config.html)
  makes cross-chain proof-size compatibility an explicit atomicity assumption.
- [Cashu NUT-14](https://github.com/cashubtc/nuts/blob/main/14.md) represents receiver and refund
  authorization separately from the preimage, while
  [NUT-18](https://github.com/cashubtc/nuts/blob/main/18.md) lets a payee request a locking
  condition and requires the payee to validate the received lock itself.
- [Cosmos IBC application semantics](https://github.com/cosmos/ibc-go/blob/main/docs/docs/01-ibc/03-apps/01-apps.md)
  distinguish success/error acknowledgements and timeouts. The
  [IBC timeout-callback advisory](https://github.com/cosmos/ibc-go/security/advisories/GHSA-j496-crgh-34mx)
  is a concrete example of repeated settlement effects caused by reentrancy before consuming the
  packet commitment.
- [Try-Confirm/Cancel](https://docs.oracle.com/en/database/oracle/transaction-manager-for-microservices/26.1/tmmdv/tcc-transaction-model.html)
  independently uses a reservation identifier returned by the resource manager, followed by
  confirm or cancel. tclk/2 borrows the separation of agreement and reservation, not TCC's trust
  in a transaction coordinator.
- Herlihy's [Atomic Cross-Chain Swaps](https://arxiv.org/abs/1801.09515) models swaps as directed
  graphs and assigns secret generation to a feedback vertex set of leaders, showing why
  payee-owned conditions are a payment-profile rule rather than a universal swap rule.
- [Anonymous Multi-Hop Locks](https://www.ndss-symposium.org/wp-content/uploads/2019/02/ndss2019_09-4_Malavolta_paper.pdf)
  identifies the wormhole attack against conventional two-round payment-channel routing and uses
  an additional path-setup round with path-specific secret information.
- [Boomerang](https://arxiv.org/abs/1910.01834) shows that redundant multipart routing needs
  aggregate/threshold machinery to avoid counterparty risk and straggler stalls.
- Boyd, Gjøsteen, and Wu's
  [Tamarin analysis of HTLCs](https://fmbc.gitlab.io/2020/files/FMBC2020.pdf) finds a hidden
  relative blockchain-growth assumption. Van der Meyden's
  [atomic-swap model checking](https://arxiv.org/abs/1811.06099) shows why recovery strategies and
  liveness matter beyond reachable contract states.
- [ERC-2266](https://eips.ethereum.org/EIPS/eip-2266) and Interledger's free-option discussion
  show that atomic safety does not remove economic optionality or liquidity griefing. Premiums,
  bonds, fees, and maximum lock horizons belong in profile policy rather than the base state
  machine.
- [Cross-chain Deals and Adversarial Commerce](https://www.vldb.org/pvldb/vol13/p100-herlihy.pdf)
  explains why adversarial commercial exchange needs explicit safety, liveness, and synchrony
  assumptions rather than importing classical transaction atomicity unchanged.

## Open decisions before a normative tclk/2 spec

1. The exact flop-core clock and finality identifier, proof format, and boundary behavior.
2. Whether flop-core claim and refund submission are permissionless with fixed destinations or
   restricted to a party.
3. The evidence representation and verifier API for finalized flop-core observations.
4. Whether the initial release supports multiple sequential attempts or only reserves the model
   for them while enforcing one active attempt.
5. Whether agreement cancellation requires one signature, both signatures, or merely becomes a
   derived abandonment after its funding deadline.
6. Maximum lock horizon and whether job/payment profiles require a bond or cancellation fee to
   bound optionality and liquidity griefing.

Those decisions should be made against the flop-core HTLC specification. They do not require the
base tclk/2 wire to take on routed-payment or general atomic-swap semantics.
