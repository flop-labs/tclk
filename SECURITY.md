# Security

## Reporting a vulnerability

Open a [private security
advisory](https://github.com/flop-labs/tclk/security/advisories/new). It keeps the report private
until there is a fix, and it is the channel that reaches us today. Please do not open a public
issue for anything exploitable.

Filing one needs a GitHub account, signed in. Without one — or to send PGP — mail
<security@flop.finance>.

If that link does not give you a form, try the repository's **Security** tab and its *Report a
vulnerability* button before concluding the channel is closed. If neither works, open a public
issue saying exactly that and **nothing about the finding** — that reports a broken channel, not
the bug.

This is a library and an MCP server, not a running service, so a report is usually a frame, a
short transcript, or a dozen lines of TypeScript rather than a request trace. Name the source commit you
verified against and, for installed releases, the affected package and version
(see "Supported versions"). Expect an acknowledgement within a few working days. There is no bounty programme.

## Two facts that bound the whole surface

Read these first; they decide whether what you found is a finding.

**The core does not settle funds; the two rails have different trust models.**
`PaperRail` records the lock/claim/refund lifecycle in world-writable venue notes and
backs it with nothing. By contrast, the in-tree `flop/` package
(`@flop-labs/tclk-flop`) contains `FlopRail`, a devnet-oriented FLOP HTLC adapter
that can sign and submit escrow open, satisfy and refund transactions to a configured
chain RPC. These are value-bearing chain operations, not paper receipts. This does
not claim a production/mainnet deployment or an audit of that adapter, and the
pure core and hosted MCP server do not themselves custody funds. Security reports
about the FLOP adapter belong in the same private advisory channel as other
exploitable findings. A wire format already posted in a room outlives any release
of this package.

**`src/adaptor.ts` is unaudited reference cryptography, and says so.** Full-Schnorr, not BIP-340
x-only; random nonces; no constant-time claim; it cannot produce a Taproot-valid signature. That
is documented in the module banner, in `README.md`, and in [`SPEC.md`
§7](SPEC.md#7-security-considerations). A report whose finding is *that* will be closed with this
link. What is worth sending: a break that would survive replacing it with an audited
implementation — an adapt/extract asymmetry that leaks the payment key on a correctly used path,
a pre-signature that verifies against a statement it does not commit to, a witness recoverable
from data the protocol publishes before the reveal.

## In scope

- **Canonical encoding.** Two distinct frames that encode to one line, a line that decodes to a
  frame other than the one encoded, or any input where the bytes a signature covers are not the
  bytes stored. Sorted keys, compact separators, dropped `undefined`, `\uXXXX`-escaped non-ASCII —
  `tests/vectors.test.ts` pins this against vectors from an independent implementation.
- **Id derivation.** `offerId` / `contractId` ambiguity: two materially different offers deriving
  one id, or a field a party can vary after agreement without changing the id it is bound by.
- **State-machine guards.** `applyFrame` accepting a frame from the wrong party, out of turn,
  after a terminal status, or replayed; a rejected frame (`ok:false`) that leaves state mutated
  anyway; any status reachable that [`SPEC.md` §4](SPEC.md#4-state-machine) says is not.
- **Secret verification.** `verifySecret`, `verifyHashPreimage`, or `verifyPointWitness` returning
  true for anything that is not a witness of that statement — or throwing where the contract is to
  return `false`, since a throw on the money path is a fail-open in a caller that folds a room.
- **Deadline handling.** `validateDeadlines` admitting a `claimByMs` / `refundAfterMs` ordering
  that leaves both parties able to act, or neither. The per-rail time domain is the caller's to
  enforce (§7); the ordering rules this library states are ours.
- **FLOP settlement adapter (`flop/`).** Escrow open/claim/refund transactions, chain
  and genesis selection, local signing, finalized-state verification, and deadline
  checks are in scope. A reproducible exploitable flaw belongs in a private advisory
  even if it was observed on devnet; do not assume the paper rail's limitations apply.
- **Custody in the MCP server.** Any path that stores, logs, or echoes a minted preimage or
  witness, returns a key from the environment, or reintroduces one in a later tool result
  (`tclk_apply_transcript` reports `secretRevealed: boolean` and must never carry the value). The
  Worker's refusal to serve when `TECHNOCORE_SIGNING_KEY` or `TCLK_PAYMENT_KEY` is bound is a
  guard — a way past it is a finding.
- **Arbitration primitives.** `verifyVoteCommitment` accepting a different vote than the one
  committed, or `splitSecret` / `splitWitness` shares that recover the secret with fewer than all
  of them.
- **Packaging.** Anything reaching the published `files` list that should not ship, or a build
  that resolves a dependency the lockfile does not pin.

## What is not a vulnerability

Documented properties, not bugs. Reports about them will be closed with a link here.

- **The paper rail's records are world-writable and back nothing.** `verifyLock` returning true
  means a string is present in a namespace a stranger could have written. Two-party fair exchange
  without an arbiter is impossible; this is not a weak escrow, it is not escrow. This
  exclusion applies to `PaperRail`, not the FLOP HTLC adapter.
- **The venue is world-writable, and room content is untrusted input.** It may carry prompt
  injection aimed at whatever agent reads it. Fold frames through `applyFrame`, which is
  fail-closed by design precisely so it can be run over every line a stranger wrote.
- **The venue clock is not an oracle.** Each party checks deadlines against its own clock with
  margin, and each rail re-enforces them in its own time domain (§7).
- **A nickname proves nothing; a `did:key` does.** Identity is the transport signature, never a
  room name or a self-asserted `from`.
- **A reveal proves the payee accepted payment, not that work was delivered.** Every HTLC has this
  property. Quality is the arbitration layer's problem (§8).
- **An arbiter who holds the secret can withhold or collude, but cannot steal** — the rail pays
  the payee named in the terms ([§8.1](SPEC.md#81-one-arbiter-holds-the-secret)). Griefing bounded
  by the refund deadline is the designed trade, not a flaw.
- **k-of-n secret sharing is absent on purpose** ([§8.4](SPEC.md#84-k-of-n--not-in-this-repo)).
- **PTLC here means the protocol shape, not Bitcoin compatibility** (see above).

## Supported versions

`main` is the active fix target; there are no maintenance branches. The core
`@flop-labs/tclk` and MCP `@flop-labs/tclk-mcp` have published `0.1.0` releases.
The `flop/` adapter is present in the source tree; do not infer npm publication
or mainnet readiness from that fact. A fix committed to `main` does **not**
update already-installed packages; registry users receive it only in a later
release. Reports should identify the affected source commit and, where relevant,
the installed package and version.
