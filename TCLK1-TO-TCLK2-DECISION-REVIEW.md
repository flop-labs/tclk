# Review of the tclk/1 hardening and tclk/2 convergence note

Status: **review of [`TCLK1-TO-TCLK2-DECISION.md`](TCLK1-TO-TCLK2-DECISION.md) as carried by
[PR #58](https://github.com/flop-labs/tclk/pull/58)**
Date: 2026-09-04
Reviewed against: `main` at `103a1b9`, every open PR and issue on that date, and a local run of
the three CI commands on `main` (all green: 93 library, 34 MCP, 31 worker tests).

## Bottom line

1. **The six structural findings about tclk/1 are all real.** Each one was reproduced in the
   code, not just in the spec text. The note describes the protocol accurately.
2. **None of them requires a wire break for the work actually on the table.** The tclk/2
   proposal scopes its first profile to one payer, one payee, SHA-256 preimage, and at most one
   transfer attempt per agreement. Every safety property that profile needs is reachable on
   tclk/1 with byte-preserving changes: builder restrictions, a rail-verified settlement view
   that is local rather than on the wire, and a versioned deadline mapping in the rail adapter.
3. **tclk/2 remains the right home for what the proposal defers**: separate attempt identity,
   rail-native expiry, pinned point/adaptor suites, an offer that carries its own condition, a
   signed abandonment, and multi-rail reconciliation. Those cannot be added to tclk/1 without
   new keys, which every existing decoder rejects. That is a version bump in practice.
4. **Recommendation:** merge #58 as design direction, but amend decision items 5 and 6. The
   first flop-core HTLC adapter should be built against the restricted tclk/1 path, behind a
   verified settlement view, and the facts it produces about flop-core's clock, finality, and
   evidence should feed the normative tclk/2 spec. Every open decision listed at the end of the
   proposal is a flop-core fact that only a working rail can supply. Building the rail second
   means guessing those facts first.
5. **The merge queue is sound with the corrections listed below.** The most important: no
   fork PR except #53 has actually run CI (every other head is `action_required`), PR #56 has a
   bug that defeats its own purpose, and PR #16 is neither superseded nor free of a conflict
   with PR #59.

## Part 1: is tclk/2 needed, or does a low-impact tclk/1 change suffice?

The question splits per structural finding. "Byte-preserving" below means: no already-signed
`tclk1 ` line changes bytes, identifier, or fold result.

| # | Finding in the note | Verified on main | Byte-preserving tclk/1 answer | Needs tclk/2? |
| --- | --- | --- | --- | --- |
| 1 | Condition authority depends on author order (#12) | Yes. The acceptor supplies `statement` (`src/machine.ts` accept case); `reveal` requires `from === payeeDid`. A payee-authored offer makes the payer mint a secret only the payee may reveal. The MCP accept tool mints unconditionally. | Builder policy: the supported path is payer-authored. A second route also exists: the payee mints and conveys the statement before accept, which the wire already permits since nothing binds who minted it. | No, for profile 1. Yes for an offer that carries its own condition, which is a new key. |
| 2 | Assertions stand in for rail evidence | Yes, by design. `lock` moves to `locked`, `reveal` to `claimed`, `refund` to `refunded` with no rail hook. `verifyLock` is called nowhere in `src/`; only `examples/live-deal.mjs` calls it, and it does refuse to continue when the rail disagrees. The A2A and ACP mappings turn `claimed` into `completed`. | A local `SettlementView` derived from `ContractState` plus a `SettlementRail` verification result. Not a wire object. For a direct two-party payment each party verifies the rail itself, which is also how the proposal's `RailObservation` is described. Drive the interop mappings from that view for value rails. | No. The proposal's observation is also a locally verified object. |
| 3 | One identifier does two jobs | Yes. `MemoryRail` keys locks by contract; the machine has no `locked` to `accepted` return path, so a failed lock cannot be retried inside one contract. | Nothing now. Profile 1 permits at most one attempt per agreement. A failed funding is handled by refund or a new offer, which is a coordination cost, not a safety gap. | Yes, once replacement or multipart attempts are wanted. |
| 4 | Three clocks share one unit | Yes. `claimByMs` is not consulted by the machine at all; `refundAfterMs` is the only rail boundary; the boundary is consistent between the machine and `MemoryRail` (claim strictly before, refund at or after). | Adapter rule, already stated in SPEC §5: derive the native expiry from `refundAfterMs` with margin, version that mapping, and make `verifyLock` fail closed when the on-chain expiry does not match. The note's restriction item 6 already asks for this. | No for one rail. Yes for a signed native expiry across rails. |
| 5 | `point` is not a cryptographic suite (#36) | Yes. No frame carries the message `verifyPreSignature` needs; the adaptor module is declared unaudited. | Builder policy: hash locks only on the supported path. A documented per-rail derivation of the claim message is spec text only. | Yes for a pinned suite; deferred by the proposal anyway. |
| 6 | Room topology treated as protocol truth | Yes. See PRs #62 and #65 below. | One explicit post-accept transcript source, chosen by configuration. | No. This is transport policy and the tclk/2 proposal does not address it. |

Two further items the note leans on:

- **Abandonment (#41).** `accepted` becomes unprogressable at `refundAfterMs` because `lock` is
  refused from then on, but the status never changes. A derived predicate on the read side
  resolves this with no wire change, exactly as the note proposes.
- **Canonical escapes and duplicate keys (#26, #48).** The reference already produces exact
  lowercase `\uXXXX`, short escapes, raw `/`, surrogate pairs, and refuses DEL. Pinning that in
  spec text plus one vector is free. Duplicate JSON keys are currently accepted with last-wins,
  and the id check passes because the id is computed over the deduplicated object. Reject them at
  decode before parse and at emission. The "locked and refunded in the same breath" scenario in
  #26 does not occur: an offer with `expiresMs` after `refundAfterMs` can still be accepted late,
  but `lock` is then refused, so the real outcome is a stuck `accepted`.

### What a tclk/1 value rail would look like

The cost the note fears is fossilization. The actual surface is small. A `SettlementRail`
adapter takes `LockTerms`; a tclk/2 adapter would take a `TransferAttempt`. The code that builds
the escrow transaction, reads it back, claims, and refunds is the same in both; only the input
projection differs. What must be added to tclk/1 for a value rail to be safe:

1. The construction restriction the note already proposes (payer-authored, hash lock, ordered
   deadlines, required `ref`, canonical rails, caller-owned custom registry).
2. A `SettlementView` type and a function that combines a folded `ContractState` with a
   `verifyLock` result and rail-reported claim/refund evidence, so `funded`, `claimed`, and
   `refunded` are only ever asserted with rail evidence attached. Room status stays what it is
   and is documented as coordination state.
3. A versioned `refundAfterMs` to native-expiry mapping inside the flop-core adapter, checked
   by `verifyLock`.
4. Interop mappings for value rails driven from the settlement view, not from `TclkStatus`.

None of these touch a signed byte, a golden vector, or the fold of a historical transcript.

### Recommended amendments to the decision list

- **Item 5** (no partial backport): keep it for wire objects. Allow the local settlement view
  and derived predicates, which are library code, not protocol.
- **Item 6** (no value rail on tclk/1): replace with "the first flop-core adapter targets the
  restricted tclk/1 path and must ship with the settlement view; its findings about flop-core
  clock, finality, and evidence become inputs to the normative tclk/2 profile." Keep the
  requirement that no room assertion is promoted to money state.
- **PR #21 disposition** is unchanged by this: it belongs in its own package regardless of
  version, because it imports a network-capable dependency under `src/`, which AGENTS.md
  forbids.

## Part 2: corrections to the PR and issue disposition tables

Every open PR was read in full; the six library PRs were also built and tested locally on
throwaway checkouts. Findings that change a disposition or a stated reason:

1. **CI has not run on any fork PR except #53.** Every other fork head shows `build-and-test`
   as `action_required`, and the only completed check is a skipped third-party one. `BLOCKED` on
   GitHub means "required check missing", not "conflicted". Only #16, #50, #32, #21, and #45 are
   actually `dirty`. The note's sentence "must be rebased and re-run" should say "a maintainer
   must approve the workflow run"; most of these branches are already on current `main`.
2. **#63 is not a strict-hex PR.** It removes the empty-input path that returned an empty array
   and stops echoing the rejected value in the error, which matters because preimages and
   witnesses pass through that function outside any catch. Uppercase hex is still accepted at the
   `hex.ts` layer. The merge verdict stands; the stated reason should be "closes the empty-input
   hole and a secret echo in error text". Uppercase rejection at that layer is a separate change.
3. **#16 is not superseded and it conflicts with #59.** The bug reproduces on `main`: a nested
   `type` key in `job` or `presig` bypasses the closed schema and is serialized and hashed into
   the offer id. The fix is three lines once rebased. But #16 also tightens `presig.s` to exactly
   64 hex in range, while #59 pins the schema to `main`'s current 1 to 32 byte pattern. Whichever
   lands second reopens the schema/decoder gap #59 closes. Split the presig strictness out of #16
   and decide the pattern once.
4. **#56 has a bug that defeats its purpose.** The reconciliation read builds the dedupe key from
   `m.from` and `m.text`, but `exportRoom` returns `TranscriptRecord` objects whose fields are
   `sender` and `line`. The key never matches, so a post that committed but returned a 5xx is
   resent, hits the nonce check, and the run throws. The test cannot catch it because it fakes
   the export with pre-built strings. Fix the field names and add a test through a real record,
   then merge and close #45.
5. **#51's receipt binding is byte-exact while the lock path is alias-aware.** A contract locked
   under the legacy spelling `PaperRail` and receipted by the MCP tool as `paper` is rejected.
   Receipts are non-transitions, so rejecting is safe; decide whether "exact" means bytes or
   canonical id and say so in the changelog entry.
6. **#62's mechanism is narrower than described.** It does not union streams itself; it makes the
   fold admit records from two rooms in whatever order the caller supplies, with no cross-room
   tie-break. The consequence the note describes was reproduced: `[offer, accept, cancel in
   tclk-offers, lock in deal room]` with equal timestamps folds to `cancelled` in one order and
   `locked` in the other. There is a mergeable subset: keep the option plumbing and the strict
   default, but make the non-strict mode select the offer room as the only post-accept source.
   Correct the spec and changelog text, which currently assert a global room cap that the probe
   in issue #61 refutes (per-client quota of 20 rooms per day, other agents creating rooms).
7. **#65 has no mergeable subset.** It keeps the strict fold, then prints "Deal complete" when the
   fold stops at `accepted` as long as a world-writable paper note says `claimed`. Its comments
   also misdiagnose why the fold rejects (signatures verify; the room-binding step rejects), and
   it passes a second argument to a one-parameter `readRoom`. Close.
8. **#54's cap does hit the audit path.** The 1 MiB limit applies to `exportRoom`, which is what
   the MCP full-history read calls, and the test confirms an oversized export throws. "Revise"
   stands.
9. **#50 must regenerate reveal and refund with `ref`.** The conflict is against #42, which added
   `ref` to those lines on `main`. The PR's five frames decode and fold correctly today; only the
   two lines need regeneration.
10. **#32 changes the fold of one class of historical frames.** A proposed-stage `cancel` that
    named an arbitrary id used to be accepted and will be rejected. No value frame is affected and
    no builder emits cancels, so the note's "without changing protocol meaning" is defensible,
    but the changelog should state the behavior change plainly.
11. **#64 confirmed out of scope.** None of the named symbols exist in this repository and the
    cited commit is not in its history.

Dispositions that were checked and stand unchanged: #60, #59, #52, #55, #53, #21, #28, #13,
and the issue table.

## Part 3: amended merge order

1. Merge #58 with the amendments above applied to the decision note.
2. Approve CI on, then merge in this order: #60, #59, #63, #51. All four are on current `main`
   and pass locally.
3. Rebase #16 with the presig strictness split out and the `presig.s` pattern reconciled with
   #59; merge.
4. Merge #52 and #55. Fix the field names in #56, add the real-record test, merge; close #45.
5. Regenerate the two lines in #50 and merge; resolve the SPEC conflict in #32 and merge; close
   #49 and #5.
6. Land the tclk/1 construction restriction together with the settlement view and the derived
   `canLock`, `fundingDeadlinePassed`, and `refundOpen` predicates, plus emission-side checks for
   `expiresMs < claimByMs` and duplicate JSON keys. Close #12, #36, #41, #26, #48 through it.
7. Reshape #62 into a single-source option and merge; close #65, #61, #3.
8. Build the flop-core adapter against the restricted tclk/1 path with the settlement view.
   Write the normative tclk/2 direct profile from what it teaches.

## Part 4: answers to the six review questions

1. **Yes.** Historical decode and new construction may differ. The code already does this for
   rail ids and `ref`, so it is a precedent, not a new principle.
2. **No, as written.** A value rail should not merge without a rail-verified settlement view.
   It does not need to wait for tclk/2; the direct profile has no requirement tclk/1 plus that
   view cannot meet.
3. **Yes.** `claimByMs` is already advisory in the code and should stay so. tclk/2 should carry
   one native expiry.
4. **Yes.** Payer-proposed, hash-locked is the supported new path. Note that the wire also
   admits a payee-minted statement conveyed before accept, so the restriction is a choice about
   simplicity rather than the only safe option.
5. **Yes.** Reserve `final` for irreversibility within a profile. Reconciliation stays a local
   projection.
6. **Yes.** One explicit post-accept source, configured, never inferred from a union.

## Merge gates: one addition

The gate list is right. Add one item: a maintainer approves the workflow run on every fork PR
before reading its "CI green" claim, because today only one of them has run.
