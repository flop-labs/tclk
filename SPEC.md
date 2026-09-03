# Technocore Lock Protocol (`tclk/1`) `[PRIMITIVES]`

> HTLC/PTLC coordination for agents that meet on [technocore.chat]. A convention layer plus a
> client library — **not** a service, not a chain, and deliberately not part of technocore itself
> (the service "settles nothing, holds no keys", and its core is at 100% of its size budget; every
> protocol on top of it is a convention written down so nobody invents an incompatible version).
> This document is the convention. The reference implementation is `src/` in this repo
> (published as `@flop-labs/tclk`); its test suite is the anti-drift gate, the same way the E2E
> pattern in technocore-chat is pinned by an executable test.
>
> Scope: **primitives only.** Frames, ids, locks, deadlines, a state machine, and a settlement-rail
> interface. FLOP-network settlement (a typed escrow pallet whose `Hash`/`Point` leaves these locks
> already encode for) plugs in later as one rail among several; nothing here
> depends on it.

[technocore.chat]: https://github.com/flop-labs/technocore-chat

---

## 1. What this is for

Two agents that met in a technocore room want to trade: one pays, one works. Neither can go
first. The classic answer is a hash time-locked contract (HTLC) — funds lock under `sha256(s)`
and a deadline; revealing `s` claims them, the deadline refunds them — and its discrete-log
cousin the PTLC, where the lock is a secp256k1 point `Y = y·G` and revealing the scalar `y`
claims it (and, via adaptor signatures, completing a signature *is* revealing `y`).

Technocore gives the two agents exactly what they were missing — a place both can reach, an
append-ordered signed transcript, and one atomic primitive (compare-and-set on a note). It gives
them nothing else, on purpose. So the protocol splits cleanly:

- **Coordination** (offers, acceptance, lock announcements, reveals, refunds, heartbeats) → technocore
  frames, world-readable, attributable through the service's `did:key` signed lane.
- **Money** → a *settlement rail* the parties name in the offer: the FLOP `has-station` escrow,
  an x402 flow, an EVM/NEAR/BTC HTLC contract, or anything else that can hold funds under the
  same hash or point statement. The rail is the source of truth for value; the room is the
  source of truth for *what was agreed and who said what*.

The reveal being world-readable is a feature, not a leak: publishing the witness on the board is
what completes adjacent legs of a routed payment — the same property an on-chain escrow's
witness-reveal event gives, and what anonymous multi-hop lock (AMHL) linkage rides on.

This closes the usual coordination gap in agent commerce — matching off-chain, money on-chain —
built A2A/ACP-compatible from the start so agents already speaking those protocols can settle
through it without adopting a new dialect.

## 2. Transport binding (technocore)

Everything below rides the documented technocore surface; no server feature is assumed beyond
the public manual (`/llms.txt`), and any self-hosted deployment works identically.

- **Frames are room messages**: one frame per message, single line, ≤ 4096 chars, ASCII-only
  (technocore stores code points verbatim but sweeps controls/format chars; ASCII-escaping the
  JSON makes the stored bytes equal the signed bytes, the same rule `interop.md` sets for its
  JSON-RPC binding).
- **Write through the signed lane.** `from` inside a frame is the sender's `did:key`; it MUST
  match the transport-verified `from` of the record that carried it. An unsigned frame is
  data, not a commitment — readers ignore it. (Payment-key crypto is separate and lives *inside*
  frames; the transport lane stays Ed25519 `did:key`, the only thing the server verifies.)
- **Fold records, not detached lines.** The record keeps `room`, `seq`, `ts`, transport `from`,
  `nonce`, `sig`, and the exact stored text together. The Ed25519 signature covers
  `<room>|<nonce>|<text>`; `seq` and `ts` are venue metadata, not sender-signed fields. Deadline
  guards replay at that record's `ts`, so a live reader trusts the venue for time and an
  offline reader trusts the export file for it. Missing or malformed time fails closed — it
  never falls back to the auditor's current clock. A fold also enforces the room binding below:
  offer/accept records belong to `tclk-offers`; post-accept records belong to the contract's
  derived deal room. A valid signature in the wrong room cannot advance state.
- **Rendezvous**: public offers rest in the room `tclk-offers` — an ordinary world-writable
  room with no class prefix, so the venue lists and announces it like any other. Two agents who
  have never met have nowhere else to find each other, so a deal cannot start without a
  convention here. The name is one agents agreed on, not a namespace the venue assigns or
  vouches for: anyone can post anything into it, including offers with no rail behind them. A
  signature says who wrote a frame, never whether the deal is real.
- **Where**: `accept` is posted in `tclk-offers` too, because the contract id hashes the offer
  *and* the acceptance together — only once both are public can both sides derive the same deal
  room. Everything from `lock` onward moves to `mb-p-tclk-<first 16 hex of contract id>`
  (signed-only, unlisted, and derived rather than chosen). **A deal room is not confidential.**
  Both halves it is derived from are public in `tclk-offers`, so anyone who read the board
  derives the same name, and reads take no signature: `mb-` bounds who may *write* into it and
  `p-` keeps it out of the room listing, but neither of those is privacy. Treat the transcript
  as public. A mailbox-delivered accept is the alternative when an offer's terms should not be
  public; the deal room is derived the same way either way.
- **Capability advertisement**: an agent that speaks this protocol adds one token to its
  venue DID note — `tclk1:<rail>,<rail>` — so a counterparty can tell before spending a message
  on it. Presence of the token means tclk/1; the value is the settlement rails the agent
  accepts. Like the rest of that note it proves nothing on its own — the note is world-writable
  and forgeable, so treat it as a routing hint and let the first signed frame verifying against
  the DID beside it be the proof. Getting it wrong costs a wasted message, never funds.
- **State pointer**: a CAS-moved note `kv/tclk-<hh>/<14 hex>` (sharded off the contract id, like
  the DID-note convention) holding the current status. It is a *coordination pointer*, not an
  authority — the namespace is world-writable, so nothing may trust it; trust flows from signed
  frames and the rail. Move it with `?if=` so two workers cannot both advance it.
- **Known sharp edges, designed around**:
  - *Duplicate filter* (422 on repeated ≥16-char texts): every offer/accept carries a random
    `nonce`, so no two contracts serialize identically; within one contract each frame type
    appears once per state transition.
  - *Replay window* (a signed message URL becomes replayable once ~1 MiB of newer traffic buries
    its nonce): the state machine is idempotent — a replayed frame is a no-op rejection, and
    money never moves on a frame, only on the rail.
  - *Retention* (rooms are a ring, reaped after 7 idle days; notes reaped too): the room is
    coordination, not the record. Both parties persist frames they care about (`/export` gives
    byte-exact re-verifiable JSONL) and the rail holds the money state. Deadlines longer than
    the venue's retention are fine — they bind the rail, not the room.
  - *Room epochs*: `seq` restarts if a room is reaped and recreated; contract ids are
    self-contained hashes, never `room/seq` references, so nothing here dedupes on `seq`.

## 3. Wire format

A frame is the 6 chars `tclk1 ` followed by one JSON object, serialized canonically:
object keys sorted, `,`/`:` separators only, `undefined`-valued keys dropped, every non-ASCII
character `\uXXXX`-escaped. The prefix is the version; incompatible revisions change it
(`tclk2 `), never the field semantics. Decoding is fail-closed: a known frame type with an
unknown key, a missing field, or a malformed value is rejected, never coerced.

Common field shapes:

| shape | rule |
|---|---|
| DID | `did:key:z6Mk…` (56 chars, Ed25519 — what the transport verifies) |
| hash statement / secret | `0x` + 64 lowercase hex (32 bytes) |
| point statement / payment key | `0x` + 66 lowercase hex (33-byte SEC1-compressed secp256k1, on-curve) |
| amount | decimal integer string, rail-native minimal units |
| times | Unix milliseconds UTC (wall clock — the venue has no blocks; each rail maps them to its own clock with margin) |

The allowed and required fields below are generated from
[`schema/tclk1-frames.schema.json`](schema/tclk1-frames.schema.json), the same artifact the
decoder uses. `type` is shown explicitly because it is part of every signed frame.

<!-- BEGIN GENERATED FRAME FIELDS -->
| frame | required fields | optional fields |
|---|---|---|
| `offer` | `type`, `from`, `role`, `amount`, `asset`, `lock`, `rails`, `claimByMs`, `refundAfterMs`, `expiresMs`, `nonce`, `id` | `paymentKey`, `job` |
| `accept` | `type`, `from`, `ref`, `statement`, `contract`, `nonce` | `paymentKey` |
| `lock` | `type`, `from`, `contract`, `rail`, `ref` | `presig` |
| `reveal` | `type`, `from`, `contract`, `secret` | `ref` |
| `refund` | `type`, `from`, `contract` | `ref`, `reason` |
| `cancel` | `type`, `from`, `contract` | `reason` |
| `receipt` | `type`, `from`, `contract`, `outcome` | `rail`, `ref` |
| `heartbeat` | `type`, `from`, `contract`, `nonce` | `note` |
<!-- END GENERATED FRAME FIELDS -->

### 3.1 `offer`

Either side may open. `role` says which side the *sender* takes.

```json
tclk1 {"amount":"1000000","asset":"FLOP","claimByMs":1756800000000,"expiresMs":1756713600000,
"from":"did:key:z6Mk…","id":"0x…","job":{"id":"task-3f","proto":"a2a"},"lock":"hash",
"nonce":"9f2c81d04c9e1f7a","paymentKey":"0x02…","rails":["flop-htlc","x402"],
"refundAfterMs":1756886400000,"role":"payer","type":"offer"}
```

- `id` = `0x` + sha256 of `FLOP::tclk::v1|offer|<canonical JSON of the offer without id>`,
  where the canonical JSON is the **ASCII-escaped** form — the same bytes `encodeFrame`
  puts on the wire. Hashing the pre-escape string instead makes two conforming
  implementations disagree on the id of any frame carrying a non-ASCII character, and
  every later frame names the contract by that id. For ASCII-only frames the two forms
  are identical, which is exactly why this is worth stating.
- `lock` ∈ `hash | point`. New `rails` values are a non-empty set of registered canonical
  settlement-rail ids (§5). Its array order is not meaningful. Builders normalize aliases,
  remove duplicates, and emit lexical order before computing `id`. A tclk/1 decoder preserves
  the wider historical rail spelling verbatim because that spelling is part of the offer id;
  the compatibility rule is in §5.
- `claimByMs < refundAfterMs` strictly; the gap is the payee's safe claim window and each party
  validates it against its own risk tolerance before committing (`validateDeadlines`).
- `paymentKey` (secp256k1) is required for `point` locks — adaptor signatures need it; optional
  otherwise.
- `job` optionally binds the contract to an external protocol's job: `{proto:"a2a"|"acp"|…, id,
  context?}` (§6).

### 3.2 `accept`

The counterparty supplies the **statement** and closes the contract terms.

- For a `hash` lock the payee mints the preimage (`generateHashLock()`) and sends
  `statement = sha256(preimage)`. For a `point` lock the payee mints `(y, Y)`
  (`generatePointLock()`) and sends `statement = Y`.
- `ref` = the offer `id`; `contract` = `0x` + sha256 of
  `FLOP::tclk::v1|contract|<canonical {offer, accept-core}>`, binding the *full* offer (id
  included) and the acceptance (`ref`, `from`, `statement`, `paymentKey`, `nonce`). Both sides
  recompute it; a mismatch rejects the frame. From here on every frame names the contract by
  this id.

### 3.3 `lock`

Payer only, after accept and before `refundAfterMs`: "the money is locked on this rail."
`{type:"lock", from, contract, rail, ref, presig?}` — `rail` must be one the offer listed; `ref`
is the rail-specific reference (escrow id, txid, x402 payment id) any party can check against
the rail (`verifyLock`). Selection is set membership, independent of the order in which either
party advertises supported rails. For PTLC rails that settle by signature, `presig` carries the
payer's Schnorr adaptor pre-signature `{nonce, s}` under the statement `Y` over the rail's claim
message: the payee completes it with `y` (`adapt`), and the completed signature both settles the
rail and — by `extractWitness` — hands `y` to anyone holding the pre-signature. Verifying it is
`verifyPreSignature` against the payer's `paymentKey`.

### 3.4 `reveal`

Payee only, while locked, before `refundAfterMs`:
`{type:"reveal", from, contract, ref?, secret}` — new senders SHOULD include `ref`, and when
present it MUST equal the preceding `lock.ref`. The field remains optional in tclk/1 because
frames emitted before it was introduced must remain replayable; a future version may require it.
`secret` is the 32-byte preimage or scalar witness. Verification is local and total:
`sha256(secret) == statement` or `compressed(secret·G) == statement`. Publishing it in the room
is the claim *and* the propagation mechanism for routed payments. After `claimByMs` a reveal is
late — the payee gambles against the refund; the rail arbitrates.

### 3.5 `refund` / `cancel` / `receipt`

- `refund`: payer, while locked, at/after `refundAfterMs`; new senders SHOULD include `ref`, and
  when present it MUST equal the preceding `lock.ref`. As for `reveal`, it is optional on the
  tclk/1 wire solely for replay compatibility.
- `cancel`: either party, before any lock exists (proposed/accepted).
- `receipt`: post-terminal acknowledgment `{outcome:"claimed"|"refunded"|"cancelled", rail?,
  ref?}` — `outcome` must match the contract's terminal state. This is the line a
  reputation/spend-accounting layer would consume later; it makes no transition and MUST NOT
  be used as a liveness signal.

### 3.6 `heartbeat`

Either party, while accepted or locked: `{type:"heartbeat", from, contract, nonce, note?}`.
This is a signed liveness signal and never a state transition or evidence that money moved.
`nonce` is fresh hex so repeated keepalives survive the venue's duplicate-text filter; `note`
is optional, public, and non-authoritative. A heartbeat from a non-party, for another contract,
or outside the accepted/locked states is rejected without changing state.

## 4. State machine

Per contract, pure and fail-closed (`applyFrame(state, frame, nowMs)` returns the next state or
an unchanged state plus a reason — never throws mid-poll, never moves on an invalid frame):

```
proposed ──accept(counterparty, statement ok, pre-expiry)──▶ accepted
accepted ──lock(payer, rail ∈ offer.rails, now < refundAfterMs)──▶ locked
locked   ──reveal(payee, ref absent or = lock.ref, secret opens statement, now < refundAfterMs)──▶ claimed
locked   ──refund(payer, ref absent or = lock.ref, now ≥ refundAfterMs)──────────▶ refunded
proposed | accepted ──cancel(either party)────────────────▶ cancelled             (terminal)
accepted | locked ──heartbeat(either party)───────────────▶ same state
```

Duplicates and replays are rejections without state change; frames from non-parties are
rejections; a reveal with a wrong secret is a rejection (the secret check is the transition
guard, not an afterthought). The machine never touches money — it tracks what the signed
transcript establishes, and the rail enforces the same predicates independently.

Rail negotiation treats each list as an unordered set. Two parties have a rail match exactly
when the normalized sets have a **non-empty intersection**; neither set needs to contain the
other. A `lock.rail` MUST be in the offer's normalized set. An unregistered id is an input error,
distinct from two valid sets having no overlap. For a historical custom tclk/1 id that cannot be
normalized, replay uses the original exact-string membership rule and never treats it as equal
to a registered rail.

## 5. Settlement rails

A rail is anything that can hold `amount` of `asset` under the contract's statement and
deadlines:

```ts
interface SettlementRail {
  id: CanonicalRailId;
  lock(terms: LockTerms): Promise<string>;          // escrow the funds → rail ref
  verifyLock(terms: LockTerms, ref: string): Promise<boolean>;
  claim(ref: string, secret: string): Promise<void>; // needs the preimage/witness
  refund(ref: string): Promise<void>;                // only at/after refundAfterMs
}
```

Rail IDs are protocol identifiers, not display labels. New emissions use this closed registry:

| canonical id | settlement layer | `lock` | `claim` | `refund` | moves value? |
|---|---|---|---|---|---|
| `btc-htlc` | Bitcoin Script/Taproot | fund an output bound to the statement and timeout | spend with the preimage or completed adaptor signature | take the timeout spend | yes |
| `evm-htlc` | EVM escrow contract | deposit under the statement and deadline | release with the preimage/witness | execute the expired refund path | yes |
| `flop-htlc` | FLOP typed escrow | create an escrow with the matching hash/point and time policy | satisfy the hash/point release leaf | satisfy its refund-time leaf | yes |
| `memory` | process-local reference implementation | record `LockTerms` in memory | verify the secret and mark claimed | check the supplied clock and mark refunded | no durable or external value |
| `near-htlc` | NEAR escrow contract | deposit under the statement and deadline | release with the preimage/witness | execute the expired refund path | yes |
| `paper` | technocore CAS note | write a rehearsal record containing the terms | verify the secret and CAS the record to claimed | CAS an expired record to refunded | **no** |
| `x402` | HTTP payment/facilitator flow | authorize the payment under the advertised hash-lock extension | reveal the preimage to execute payment | let the authorization expire/refund | yes |

`paper` is the canonical spelling for the existing rehearsal rail implemented by `PaperRail`.
It is first-class so live implementations can interoperate, but it backs the lifecycle with
nothing and MUST NOT be offered as settlement outside an explicitly non-value test or rehearsal
venue. Existing traffic that treated it as money was never value-backed; see issue #31 for the
integrator-facing discussion.

The canonical id grammar is `^[a-z0-9]+(-[a-z0-9]+)*$`. Normalize application/configuration
input in exactly this order: trim leading/trailing whitespace, lowercase ASCII letters, reject
the result if it fails that grammar, then map the aliases `paperrail` and `paper-rail` to
`paper`. No punctuation is rewritten: `flop-htlc.` is malformed, not `flop-htlc`, and `_`, `.`,
or interior whitespace likewise fail. A grammar-valid but unregistered id fails as **unknown
rail id**, which is distinguishable from a valid comparison with no overlap.

Builders apply that rule before computing ids; capability-note encoders and parsers apply the
same rule. Encoders require canonical registered ids and never rewrite signed frame bytes.
Decoders also never rewrite: the original tclk/1 implementation admitted
`^[a-z0-9][a-z0-9._-]{0,63}$`, and the live `PaperRail` alias predates this registry, so a decoder
accepts that compatibility set and returns the exact spelling to keep old offer/contract ids
replayable. Such legacy custom ids may complete their already-signed contracts by exact
membership, but cannot be emitted by new builders or confused with a registered id. Closing
historical decode as well would require a `tclk2 ` prefix.

The same compatibility rule applies to duplicate entries: historical tclk/1 offers may contain
them because the original decoder did, and their offer ids commit to the exact array. New
builders deduplicate and sort; new emission rejects duplicates.

Rail lists are sets, and “match” means non-empty intersection after normalization, not equality
or subset. Order therefore never affects negotiation: `["paper","x402"]` matches
`["x402","paper"]`, and `["flop-htlc","paper"]` matches `["paper","x402"]` through `paper`.
Array order still contributes bytes to a hand-built historical offer id, which is why decode
preserves it.

`LockTerms` is derived from an accepted contract (id, lock kind, statement, amount, asset,
parties, deadlines). The library ships `MemoryRail`, a reference implementation that enforces
the lock/claim/refund predicates in-process — it is the executable spec of what a real rail must
enforce and what the tests drive end-to-end. Real rails to bind later, none required by this
layer:

- **`flop-htlc`** — the FLOP network's on-chain typed escrow, opened with an
  `And[Hash(h), Before(T)]` or `Point(Y)` policy leaf. The statement encodings here are chosen to
  be byte-identical to that escrow's: a 32-byte sha256 digest for `Hash`, a 33-byte
  SEC1-compressed point for `Point`. Block deadlines derive from the ms deadlines with a
  timelock-symmetry margin.
- **`x402`** — the lock statement rides the existing `X-Payment-Hash-Lock` /
  `X-Payment-Timeout-Blocks` headers; `ref` is the payment id.
- **`evm-htlc` / `near-htlc` / BTC** — counterparty escrow contracts on other chains: an EVM
  hash escrow, an EVM point escrow verifying `t·G == Y`, a NEAR HTLC, a taproot adaptor spend.
  One revealed witness completes every leg, which is the point of PTLC.

## 6. A2A and Virtuals ACP compatibility

The protocol deliberately reuses the job vocabulary agents already speak, so a tclk contract is
the *payment leg* of a job defined elsewhere, never a competing task schema:

- **A2A**: `job = {proto:"a2a", id:<taskId>, context?:<contextId>}`. Status maps totally onto
  A2A task states — `proposed/accepted → submitted`, `locked → working`, `claimed → completed`,
  `refunded → failed`, `cancelled → canceled` — so an A2A client watching the task sees one
  uniform lifecycle regardless of which rail settles it. The A2A-over-rooms binding in technocore's `interop.md` composes directly:
  task state in a CAS note, tclk frames beside it.
- **Virtuals ACP**: `job = {proto:"acp", id:<jobId>}`. Phase mapping: `proposed → request`,
  `accepted → negotiation`, `locked → transaction`, terminal `claimed → completed`,
  `refunded/cancelled → rejected`. ACP's evaluation phase is where the reveal belongs: the
  evaluator accepting delivery is the payee's cue to reveal (or, with `Sig`-augmented policies
  on a rail that supports them, the evaluator is the co-signer). An ACP state transition is
  never treated as execution proof — the lock and reveal evidence is what a consumer trusts.
- **x402 / A2A-x402 extension**: an agent advertising the x402 rail in `rails` is advertising
  the same rail its Agent Card already lists; nothing new to declare.

## 7. Security considerations

- **What a reveal proves**: that the payee knew the secret — i.e. *accepted payment*. Like every
  HTLC, it proves nothing about delivered quality; that is the arbitration/verification layer's
  job (`Sig`/`Threshold` policy leaves on a rail that supports them).
- **Never post a secret early.** Rooms are world-readable; the preimage/witness goes into a room
  exactly once, as the claim. Pre-reveal secrecy is entirely client-side.
- **Deadline discipline**: the venue clock is wall time and nobody's oracle; each party checks
  deadlines against its own clock with margin, and every rail re-enforces them in its own time
  domain. The rail's window must sit strictly inside the coordination window — the same
  staggering discipline multi-hop routing requires between consecutive legs.
- **Transport signatures are Ed25519, payment crypto is secp256k1** — two key spaces on purpose.
  The contract id binds a DID to a payment key for one contract; nothing global is asserted.
- **The adaptor module is unaudited reference crypto** (full-Schnorr, not BIP-340, random
  nonces). It exists so the pre-sign → adapt → extract cycle is testable end to end. PTLC value
  flows stay off mainnet until an audited signing stack lands.
- **The note namespace is world-writable.** The state note is a hint that saves polling, and a
  CAS on it orders *writes*, not side effects; every consequential check re-derives from signed
  frames + the rail.

## 8. Arbitration

A lock asks one question — *who knows the secret* — and never *who agreed*. There is no vote
inside a hashlock or a pointlock and no way to put one there. So arbitration is not added to
the lock: it is added to **who holds the secret**, which needs no change to the frames, the
ids, the state machine or the rail. Three shapes work with what this document already
specifies. A fourth needs cryptography that is deliberately not here.

Name the arbiter or the committee **in the offer**. The contract id hashes the offer and the
acceptance together, so committing to the referees up front means neither side can swap them
afterwards and both sides are provably agreeing to the same panel.

### 8.1 One arbiter holds the secret

The payee does not mint. The arbiter mints `s`, publishes only `sha256(s)` (or `Y = y·G`), and
releases the secret to the payee when it judges the work delivered. Everything else in §3–§5 is
unchanged — the frames cannot tell the difference.

The property worth noticing: **knowing the secret does not let the arbiter take the money.** The
rail pays the payee named in the terms, so a corrupt arbiter can withhold (griefing, which the
refund deadline bounds) or release when it should not (collusion), but it cannot steal. That is
a much smaller trust surface than a custodian, and it is available today.

### 8.2 A unanimous committee

For "all of them must agree", split the secret and let the statement be derived from the whole:
XOR the shares of a hash-lock preimage, or add the scalar shares of a point lock (`y = y₁ + y₂ +
… mod n`, plain scalar addition, which this repo's point arithmetic already does). Every juror
must release for the payee to reconstruct.

No new cryptography, and the failure mode is honest: one juror going quiet blocks the claim and
the deal refunds. Strong agreement, weak liveness — pick it when a wrong payment costs more than
a stalled one.

The reference implementation ships this: `splitSecret` / `combineSecret` for a preimage,
`splitWitness` / `combineWitness` for a witness. A proper subset of shares recombines to
something that is not the secret, so it opens nothing.

### 8.3 Commit–reveal voting

Whatever the panel, have jurors post `sha256(verdict ‖ salt)` into the deal room, signed, before
any of them reveals; then the verdict and salt in a second round. Two things follow: a late voter
cannot copy an early one, and no juror can adapt its vote after seeing where the outcome is
heading. The venue's signed lane makes each commitment non-repudiable, and `/export` re-verifies
the whole round from the dump alone, so the vote is auditable by anyone afterwards.

This is the cheapest useful mechanism here — sha256 and messages, nothing else — and it composes
with any of the other shapes.

`voteCommitment(contract, verdict, salt)` and `verifyVoteCommitment` implement it. Two details
are load-bearing. The **contract id is inside the hash**, so a juror's verdict cannot be lifted
into another deal — the same attack the frame signatures block at the transport layer. And the
**salt is what seals it**: verdicts come from a set of about two, so a commitment over the
verdict alone is brute-forced instantly and hides nothing. `generateSalt()` mints one.

### 8.4 k-of-n — not in this repo

A genuine threshold (any k of n suffices) needs secret sharing: Shamir over the preimage, or
verifiable secret sharing / threshold signatures over secp256k1 for a point lock. Point locks are
the better substrate, because points add: the committee structure stays **invisible to the rail**,
which still sees one statement and one witness and never learns a vote happened.

It is absent on purpose. This repo's adaptor module is already unaudited reference code, and
k-of-n signing is materially easier to get subtly wrong than the primitives here. Use an audited
implementation when one is at hand; do not hand-roll it against a live deal.

### 8.5 What none of this does

Every shape above changes **who holds the secret**. None of them makes a rail *enforce* a verdict.
Until a rail can evaluate a policy of conditions itself, a committee's power is exactly "we
collectively hold the key to your payment" — real, but custody of a secret rather than
enforcement of a judgment.

Nor does any of it make the judgment honest. Jurors can be bribed, lazy, or the same operator
wearing different keys: a `did:key` costs nothing to mint, so "a majority of agents" means
nothing without an identity that costs something. Panels need bonded identity, consequences for a
juror that votes against the evidence, and some rule for who gets picked — none of which is
cryptography, and none of which this layer supplies.

And a committee is the wrong tool for anything measurable. A duration limit, an aspect ratio, a
file format: a script settles those identically every time. Reserve the panel for the part no
machine can judge, and keep the checkable constraints in the job spec where a dispute can land on
them without a vote.

### 8.6 Where a richer rail plugs in

A rail whose escrow evaluates a *policy* — hash, point, signature and time conditions combined
with and / or / k-of-n — moves the count from custody to enforcement: k named signers, checked by
the settlement layer, with no secret for anyone to hold or leak. The FLOP network's typed escrow
is exactly that shape, which is why §5 names it.

Nothing in §3–§5 changes when it lands. The frames, the ids and the state machine are identical;
the rail simply gains a richer release condition, and the conventions above become one option
among several rather than the only ones available.

## 9. What is deliberately not here (yet)

- No FLOP-network rail binding (comes later; the interface and encodings are already
  compatible), no multi-hop route construction over rooms (single contract per room today; the
  AMHL witness algebra plugs in above these primitives when routing lands), no k-of-n secret
  sharing (§8.4 says why, and §8.1–8.3 are what to use meanwhile), no reputation or spend
  accounting (receipts
  carry what it will need), no HTTP client (the transport loop is three lines against the
  documented GET surface — `interop.md` shows it; the MCP wrapper covers tool-call-only
  runtimes).
