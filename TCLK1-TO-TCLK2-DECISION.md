# tclk/1 hardening and tclk/2 convergence

Status: **decision note for team review**  
Date: 2026-09-04  
Companion design: [`TCLK2-PROPOSAL.md`](TCLK2-PROPOSAL.md)  
Normative protocol today: [`SPEC.md`](SPEC.md)

## Decision requested

Approve the following direction before merging implementation work:

1. Merge the non-normative tclk/2 proposal in
   [PR #58](https://github.com/flop-labs/tclk/pull/58) as the design direction, not as a change to
   the current wire protocol.
2. Keep every historical `tclk1 ` frame decodable and byte-exact. Never edit the golden vectors
   to accommodate a new interpretation.
3. Continue merging tclk/1 changes that fail closed, preserve bytes, bind evidence more exactly,
   bound resources, or repair examples without changing protocol meaning.
4. Make one coherent, documented restriction to **new tclk/1 construction**: support the direct,
   payer-proposed, hash-lock path as the production-shaped path; leave legacy forms replayable.
   This is a builder/API policy, not a new tclk/1 wire profile.
5. Do not partially backport tclk/2's agreement, transfer-attempt, observation, native-expiry, or
   profile-digest objects into tclk/1. Implement them together behind the `tclk2 ` prefix.
6. Do not merge a value-bearing rail into tclk/1. The first flop-core HTLC integration should
   implement the reviewed tclk/2 direct-payment profile.

The practical result is a smaller state model now, less tclk/1 code to discard, and an explicit
compatibility promise: old traffic remains auditable, while new traffic stops relying on the
parts of tclk/1 whose security meaning is underspecified.

## Why make this decision now

tclk has launched, but it has not yet crossed the expensive compatibility boundary: the repository
ships `PaperRail`, which rehearses a lifecycle but holds no value. This is the best point at which
to remove claims the implementation cannot justify before flop-core treats them as a contract.

There are two different meanings of "breaking change" here:

- Reinterpreting an already-signed `tclk1 ` line is a dangerous wire break. It changes the bytes or
  security meaning of durable public evidence. We should not do it.
- Refusing to construct a new ambiguous or unsafe tclk/1 deal is a deliberate API restriction.
  Existing lines still decode and replay. At alpha, this is the cheaper and safer kind of break.

The recommendation uses the second kind where necessary and reserves the first kind for an honest
`tclk2 ` prefix and signature domain.

## Background: the four layers that must not be conflated

The current discussions become much simpler if four artifacts are kept separate.

### 1. Historical wire evidence

A `tclk1 ` frame is canonical, signed coordination evidence. Its exact encoded bytes determine its
identifier and signature. The decoder must preserve the historical grammar closely enough to audit
already-posted lines, even when a new builder would refuse to emit the same shape.

### 2. New construction policy

Builders decide which new agreements this release is willing to create. They can be stricter than
the historical decoder: canonical rail identifiers only, registered adapters only, payer-authored
offers only, and no production claim for the unaudited point-lock path.

### 3. Coordination state

The room transcript proves that a named signer made a statement in a named room. It can derive
states such as `accepted`, "funding announced", or `witness-known`. It does not prove that an
escrow exists or that money moved.

### 4. Authoritative settlement state

Only a rail-specific verifier can establish funded, claimed, or refunded value. tclk/2 makes this
boundary explicit with verified `RailObservation` objects. Treating a signed room frame as money
state would preserve a simple enum at the cost of giving that enum a false meaning.

This separation is the central reason not to grow the tclk/1 state machine further.

## What is structurally wrong with tclk/1 as a value contract

The problem is not one missing guard. tclk/1 combines concepts that real settlement systems keep
separate:

1. **Condition authority depends on author order.** The acceptor always supplies the statement,
   while the specification describes the payee as the party that owns and reveals the secret. A
   payee-authored offer therefore makes the payer construct a condition it cannot later reveal
   ([issue #12](https://github.com/flop-labs/tclk/issues/12)).
2. **Assertions stand in for rail evidence.** A payer-signed `lock` changes transcript state to
   `locked`; a room `reveal` or `refund` changes it to a monetary-sounding terminal state. These
   statements may coordinate a rail action, but they are not proof that the rail performed it.
3. **One identifier does two jobs.** `contract` identifies both commercial terms and the concrete
   lock. That leaves no clean identity for a retry, replacement, partial payment, or second rail.
4. **Three clocks share one unit without sharing one authority.** `expiresMs` is coordination time,
   `claimByMs` is an operational safety margin, and `refundAfterMs` is intended to describe rail
   enforcement. Real rails may use height, consensus time, ledger-close time, or a bilateral clock.
5. **`point` is not a cryptographic suite.** It does not pin the signing construction, message,
   domain, nonce rules, or production-compatible signature format. The frame does not carry the
   message required by the stated pre-signature verifier
   ([issue #36](https://github.com/flop-labs/tclk/issues/36)), and the repository's adaptor code is
   explicitly unaudited reference cryptography.
6. **The room topology is treated as protocol truth.** A derived room is useful transport policy,
   but admitting multiple room streams without one authenticated total order makes replay
   ambiguous. Falling back while skipping strict audit is worse: the example can report success
   after its own evidence verifier refused the transcript.

Fixing these one at a time inside the old object would produce a protocol that still says `tclk1`
but no longer means what existing implementations signed. The tclk/2 separation is smaller than
that accumulation of exceptions.

## Properties that drive the decision

These are ordered deliberately: safety invariants first, reachable flows second, and temporal
expectations last. A model that reaches a happy path does not establish the invariants, and a legal
refund transition does not establish that a refund will eventually be included.

### Safety invariants — high impact

These directly govern whether the first value-bearing rail can lose, duplicate, or misattribute
value:

1. **Conservation:** one attempt cannot claim or refund more than it reserved.
2. **Terminal exclusivity:** one attempt cannot become both finally claimed and finally refunded.
3. **Exact binding:** the rail reference, amount, asset, condition, destinations, expiry, and
   observation all bind to the same attempt.
4. **Authoritative funding:** a participant's announcement cannot establish funded value without a
   successful rail verifier.
5. **Boundary safety:** claim and refund are accepted only in the intervals defined by the selected
   rail profile, including the exact equality boundary.
6. **Replay and reentrancy safety:** duplicate, reordered, or recursively delivered operations do
   not repeat a monetary effect or replace a terminal outcome.
7. **Deterministic audit:** the same authenticated evidence has one result. Caller-provided ordering
   across incomparable room streams cannot choose between `cancelled` and `locked`.
8. **No shared secret custody:** the MCP service never stores or later echoes a preimage or witness.
9. **Immutable profile meaning:** a registry update cannot reinterpret a signed attempt; the signed
   rail profile digest identifies the verifier contract used at construction.

### Reachability witnesses — high or medium impact

The executable tclk/2 model should demonstrate traces that reach each required shape:

- a payer proposal that the payee completes with the condition, followed by verified funding and
  verified claim;
- a payee proposal that the payee already condition-authorizes, followed by the same settlement
  path;
- verified funding followed by expiry becoming open and a verified refund;
- an agreed but never-funded agreement becoming observably non-actionable without inventing a
  monetary terminal state;
- an unknown or locally untrusted rail profile remaining decodable for audit while being unable to
  construct an attempt or advance authoritative settlement;
- duplicate observations leaving the same derived result.

Reaching these states in simulation is evidence about sampled traces, not a proof that the safety
invariants hold for all traces. The invariants need bounded exhaustive checking where feasible and
implementation tests at the rail boundary.

### Temporal and environment expectations — explicit assumptions

The base protocol cannot promise these without assumptions supplied by a rail profile:

- a valid submitted claim is eventually included and observed;
- a valid refund is eventually included after expiry;
- the rail clock progresses;
- finality is eventually reached and does not later reverse;
- an honest watcher sees the relevant condition or timeout in time;
- message and observation delay stay within any deadline margin used by a routed profile.

The first safety model can use a monotonic predicate such as `refundOpen`. Numeric clock progress,
bounded inclusion, and eventual recovery belong in later liveness checks against the actual
flop-core semantics. Encoding several integers in the base state would not make these assumptions
true.

## The tclk/1 simplification we can make now

The goal is to narrow new behavior without changing historical bytes.

### Preserve unchanged

- Keep the `tclk1 ` prefix, decoder, canonical encoder, identifiers, signatures, state fold, and
  golden vectors.
- Keep both `claimByMs` and `refundAfterMs` on the tclk/1 wire.
- Keep decoding legacy payee-authored offers, point locks, custom rail identifiers, and terminal
  frames without `ref` when historical compatibility requires it.
- Keep point/adaptor primitives and end-to-end reference tests, with the unaudited banner.

### Restrict new construction

1. **Payer-authored offers only for the supported tclk/1 payment flow.** The payee accepts and
   supplies the hash condition, matching who later reveals the secret. Payee-authored historical
   offers still replay.
2. **Hash locks only for production-shaped new deals.** Point locks remain explicit reference or
   legacy functionality until a profile pins an audited suite and its signed message. Do not imply
   that the current `point` spelling is Bitcoin PTLC compatible.
3. **Require `expiresMs < claimByMs < refundAfterMs` on new emissions.** This closes the ordering
   ambiguity in [issue #26](https://github.com/flop-labs/tclk/issues/26) without changing a
   historical decoder.
4. **Treat `claimByMs` as advisory policy.** It is the latest safe local initiation target, not a
   second rail transition. tclk/1 already permits a reveal until `refundAfterMs`; preserve that
   behavior. `refundAfterMs` remains the only tclk/1 rail boundary.
5. **Require `ref` from new reveal/refund builders.** Historical absence remains decodable; a
   supplied mismatch fails closed. The main branch already implements this direction.
6. **Use a caller-owned custom rail registry.** A new custom rail must be explicitly configured,
   owner-namespaced, versioned, and map `refundAfterMs` to its native expiry. Unknown identifiers
   are decode-only. Avoid process-global mutation and never load adapter code from a room.
7. **Do not add `abandoned` or `expired` wire states.** Expose derived predicates such as
   `canLock`, `fundingDeadlinePassed`, and `refundOpen`. Expiry enables an action; it is not proof
   that the action happened.

`direct-conditional-payment@1` should remain the name of the actual tclk/2 profile. Giving the
restricted tclk/1 builder the same on-wire profile name would falsely imply that old frames bind all
of its semantics.

## What must wait for tclk/2

The following pieces are valuable only when introduced as one coherent signed model:

- separate `agreementId` and `attemptId` values;
- a rail-native opaque expiry with profile-defined clock and equality semantics;
- signed rail `id`, immutable semantic `profile`, and canonical `profileHash`;
- verified pending/final observations with idempotency keys;
- replacement or multipart attempts;
- point/adaptor suites that pin all cryptographic details;
- routed-payment deadline staggering and private backward fulfillment;
- normalized cross-rail reconciliation fields;
- reversible or chargeback-capable settlement profiles.

For the initial direct profile, `final` should mean **economically irreversible within the selected
profile's stated trust and finality model**. ACH returns, card chargebacks, administrative rollback,
or probabilistic finality that can still be displaced cannot be mapped to that state. A future
reversible-rail profile may need provisional settlement and reversal observations; adding a generic
`reversed` value now would claim common semantics that have not been specified.

Likewise, settled amount, fee, net amount, and value date should remain in the rail-specific
evidence schema for now. Applications may derive a local normalized reconciliation view, but that
view is not authoritative protocol state until units, sign conventions, fee ownership, and value
date semantics are defined across at least two real rails.

## Current pull-request disposition

This table reflects the live repository on 2026-09-04. `BLOCKED` or `DIRTY` on GitHub means the
branch must be rebased and re-run through the required CI before merge; it is not itself a design
rejection.

| PR | Disposition | Reason |
| --- | --- | --- |
| [#58](https://github.com/flop-labs/tclk/pull/58) tclk/2 proposal | **Merge after team review** | Establishes the target boundary without changing tclk/1. This note resolves the migration decision and clarifies irreversible finality and reconciliation scope. |
| [#63](https://github.com/flop-labs/tclk/pull/63) strict hex | **Rebase, then merge** | Fail-closed canonical validation; reduces ambiguity without widening accepted bytes. |
| [#60](https://github.com/flop-labs/tclk/pull/60) decode size cap | **Rebase, then merge** | Applies the encoder's resource bound to untrusted input. |
| [#59](https://github.com/flop-labs/tclk/pull/59) schema/decoder agreement | **Rebase, then merge** | The published schema must not authorize frames the money-path decoder rejects. |
| [#51](https://github.com/flop-labs/tclk/pull/51) receipt binding / zero witness | **Rebase, then merge** | Exact rail/reference binding and fail-closed scalar validation are direct safety fixes. |
| [#16](https://github.com/flop-labs/tclk/pull/16) nested unknown keys | **Repair/rebase, then merge** | Closed schemas must be recursive; a nested `type` must not bypass unknown-key rejection. |
| [#52](https://github.com/flop-labs/tclk/pull/52) malformed window record isolation | **Rebase, then merge** | One hostile record should not erase other independently authenticated records. Preserve an explicit rejected-record audit result. |
| [#55](https://github.com/flop-labs/tclk/pull/55) exact string nonce | **Rebase, then merge** | Prevents numeric coercion from changing signature-covered evidence. |
| [#56](https://github.com/flop-labs/tclk/pull/56) bounded operation retries | **Rebase, then merge** | Centralizes transient retry and timeout policy. It supersedes #45 and closes issue #2. |
| [#50](https://github.com/flop-labs/tclk/pull/50) walkthrough frames | **Resolve conflicts, then merge** | Documentation examples must pass the real decoder and match their stated commitment. |
| [#32](https://github.com/flop-labs/tclk/pull/32) proposed cancel binding | **Repair conflicts, then merge** | Fixes the tclk/1 ambiguity in issue #5 without creating a new lifecycle state. |
| [#62](https://github.com/flop-labs/tclk/pull/62) dual-room fallback | **Do not merge as written** | It unions two streams with no authenticated total order; tied timestamps can yield different terminal states from the same evidence. Select exactly one post-accept source. |
| [#65](https://github.com/flop-labs/tclk/pull/65) example-only fallback | **Do not merge as written** | It retries into the offer room and then accepts an audit result after strict transcript verification refused those records. An example must not label unauditable completion as success. |
| [#54](https://github.com/flop-labs/tclk/pull/54) response cap | **Revise** | A blanket cap also truncates `/export`, the full-history audit path. Stream or paginate exports; cap only bounded endpoints. |
| [#53](https://github.com/flop-labs/tclk/pull/53) uppercase commitments | **Close** | Accepting uppercase expands canonical tclk/1 input and collapses byte-distinct spellings. Canonical commitments remain lowercase. |
| [#45](https://github.com/flop-labs/tclk/pull/45) per-attempt timeout | **Close as superseded by #56** | Retry, timeout, and reconciliation should live in one operation-layer abstraction. |
| [#21](https://github.com/flop-labs/tclk/pull/21) EVM rail | **Postpone and retarget to tclk/2** | A value-bearing rail would fossilize tclk/1's fused contract/attempt identity and wall-clock assumptions. |
| [#28](https://github.com/flop-labs/tclk/pull/28) autonomous Python client | **Postpone or close** | It duplicates a lifecycle that is about to be narrowed and would become a second implementation to migrate. |
| [#13](https://github.com/flop-labs/tclk/pull/13) Python walkthrough | **Reduce scope** | Keep an independent golden-vector checker in CI; drop the duplicate lifecycle state machine. |

## Current issue disposition

| Issue | Disposition | Reason |
| --- | --- | --- |
| [#64](https://github.com/flop-labs/tclk/issues/64) work quantity as settlement | **Close or transfer** | The named `analyzeDeal`, `DealIntent`, and `toTclkOffer` surfaces are not in this repository. The semantic boundary belongs in the job-to-payment adapter that owns them. |
| [#61](https://github.com/flop-labs/tclk/issues/61) room binding | **Keep until one-source policy lands** | The useful problem is transport fallback under a per-client room quota; the solution must not union unordered streams or bypass audit. |
| [#57](https://github.com/flop-labs/tclk/issues/57) tclk/2 design | **Close with #58** | The proposal records the design boundary and remaining flop-core-specific decisions. |
| [#49](https://github.com/flop-labs/tclk/issues/49) broken walkthrough | **Close with #50** | The repaired example should be decoder-tested. |
| [#48](https://github.com/flop-labs/tclk/issues/48) canonical JSON escapes | **Fix now** | Identifier and future profile-hash bytes require exact lowercase escapes, surrogate behavior, short escapes, slash behavior, and DEL policy. Add independent vectors. |
| [#41](https://github.com/flop-labs/tclk/issues/41) abandonment | **Resolve with derived actionability** | Do not add a signed terminal state for the absence of funding. Expose whether funding is still actionable; model explicit abandonment in tclk/2 agreement state. |
| [#36](https://github.com/flop-labs/tclk/issues/36) missing presig message | **Restrict new point emission; defer suite to tclk/2** | The missing signed-message contract cannot be repaired by another optional tclk/1 field without changing the suite's meaning. |
| [#26](https://github.com/flop-labs/tclk/issues/26) independent interop gaps | **Split and close through focused fixes** | Require new-emission deadline ordering, reject duplicate JSON keys, pin canonical escapes/provenance, and retain the independent vectors. |
| [#12](https://github.com/flop-labs/tclk/issues/12) payee-authored secret custody | **Restrict new tclk/1 emission; solve generally in tclk/2** | Payer-proposed tclk/1 restores the documented direct-payment role. tclk/2 makes condition authority independent of author order. |
| [#5](https://github.com/flop-labs/tclk/issues/5) proposed cancel identity | **Close with repaired #32** | Bind proposed cancellation to the offer identity and keep receipt handling explicit. |
| [#4](https://github.com/flop-labs/tclk/issues/4) private reporting | **Enable administratively** | This is repository security configuration, independent of the protocol queue. |
| [#3](https://github.com/flop-labs/tclk/issues/3) room quota bootstrap | **Update and close with room-source policy** | The observed refusal is a per-client room-creation quota, not proof of a globally full venue. |
| [#2](https://github.com/flop-labs/tclk/issues/2) transient 5xx | **Close with #56** | One bounded operation layer should own retry and reconciliation. |

## Structural improvements that close several items at once

### A. One schema-owned validation pipeline

Generate or derive recursive allowed-key sets, canonical scalar/hex validators, size limits, and
JSON-schema constraints from one contract. This consolidates #16, #59, #60, #63, and part of #48
and #26. Keep independent golden vectors outside that generator so the implementation cannot
approve its own encoding drift.

### B. One transcript-source policy

Represent transcript input as an explicit source choice:

```text
offer and accept: offer room
post-accept:       derived room OR offer room, fixed for the fold
```

The chosen source is policy/configuration, not inferred by unioning whatever records the caller
provides. The audit output should name the source, rejected records, and whether every applied
record passed signature, sender, room, and sequence checks. This replaces both #62 and #65 and can
close #61 and #3.

### C. One operation-layer venue client

Centralize bounded request size, streaming export, per-operation timeout, retry classification,
idempotency, reconciliation after uncertain responses, and exact nonce handling. This consolidates
#2, #45, #54, #55, #56, and earlier example-specific retry patches. Examples should call this
layer rather than implement their own failure semantics.

### D. Versioned construction surfaces

Expose the supported tclk/1 builder policy separately from the historical decoder, and make the
tclk/2 profile registry caller-owned and digest-bound. This gives #12, #36, #41, and the future
flop-core rail one deliberate migration point rather than separate compatibility exceptions.

## Recommended merge order by return on effort

1. **Merge #58 after review.** It prevents new work from targeting the wrong abstraction and costs
   no runtime compatibility.
2. **Land the byte-preserving fail-closed batch:** #63, #60, #59, #51, #16, then #48's canonical
   escape rules. These protect every consumer of hostile wire input.
3. **Land evidence and operation integrity:** #52, #55, and #56; close #45 and #2.
4. **Repair user-facing correctness:** #50 and #32; close #49 and #5.
5. **Make the coherent tclk/1 new-construction restriction** described above; resolve #12, #36,
   #41, and the remaining focused parts of #26 in that decision or linked PRs.
6. **Replace #62 and #65 with one deterministic transcript-source policy.** Do not trade audit
   determinism for liveness under a room quota.
7. **Write the normative tclk/2 spec and executable safety model**, then bind the first flop-core
   HTLC rail. Retarget #21 or use it only as rail-adapter research after that contract is fixed.

This order favors changes that prevent ambiguous or hostile input from entering any model, then
repairs operational evidence, and only then changes supported construction policy.

## Merge gates

Every implementation PR should satisfy all applicable gates:

- rebased on current `main`, with conflicts resolved semantically rather than mechanically;
- `pnpm install --frozen-lockfile`;
- `pnpm -r --include-workspace-root build`;
- `pnpm -r --include-workspace-root test`;
- no edits to golden vectors unless the PR deliberately introduces `tclk2 `;
- an `[Unreleased]` changelog entry for user-visible behavior;
- malformed, duplicate, boundary, replay, and reordering tests for the touched money path;
- exact preservation of state on rejection;
- no room assertion promoted to authoritative rail state;
- no secret persisted, logged, or echoed by shared infrastructure.

For the tclk/2 model, report safety checks, reachability traces, and temporal assumptions
separately. Random simulation should be reported as the number of sampled runs, step bound, and
observed counterexamples; it must not be described as proof.

## Consequences and trade-offs

The direction deliberately gives up some apparent breadth:

- tclk/1 stops presenting payee-authored direct deals and point locks as equally supported new
  value flows;
- EVM and other value-bearing rail integrations wait for a profile that can state their real
  clocks, evidence, and finality;
- applications with custom rails must provide explicit local configuration;
- a room-quota fallback takes more design work than reading both rooms.

In exchange, the codebase has one honest compatibility rule, one smaller supported tclk/1 path,
and one clean place to add real settlement semantics. This is lower total work than completing
multiple clients and rails against tclk/1 and immediately migrating all of them.

## Review questions for the team

1. Do we agree that historical decode/replay and new construction may have different acceptance
   policies?
2. Do we agree that no value-bearing rail should merge until the tclk/2 direct profile and
   flop-core clock/finality evidence are normative?
3. Do we agree that `claimByMs` remains advisory in tclk/1 and that tclk/2 carries one
   authoritative rail-native expiry?
4. Do we agree that the supported new tclk/1 path is payer-proposed and hash-locked, while legacy
   point/payee-proposed traffic remains auditable?
5. Do we agree that `final` is reserved for economically irreversible observations within a
   profile, and that reconciliation normalization remains a local projection for now?
6. Do we agree to replace the dual-room and audit-bypass fallbacks with one explicit post-accept
   transcript source?

If these answers are yes, the merge queue above can proceed without waiting for every tclk/2 wire
field to be designed. The remaining open design questions are then confined to the flop-core rail
profile rather than leaking back into tclk/1.
