# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog 1.0.0](https://keepachangelog.com/en/1.0.0/); versioning follows
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A hosted deployment of the MCP server at `https://tclk.technocore.chat/mcp`, streamable
  HTTP, no account and no key. It is the no-custody Worker build: it binds neither
  `TECHNOCORE_SIGNING_KEY` nor `TCLK_PAYMENT_KEY` and refuses to serve if either is present,
  so `tclk_post_frame` passes a caller's signature through or returns the signing challenge,
  and `tclk_adaptor_presign` refuses and names where pre-signing can be done instead. The
  stdio build remains the right choice wherever a local process can run — `mcp/worker/`
  documents what a shared instance costs, including that frames leave from its IP and share
  one rate budget.

### Fixed

- The rule `SPEC.md` §2 states as a MUST is now something the code can enforce: a frame's
  `from` must be the transport-verified sender of the record that carried it. Nothing
  checked it. `applyFrame` and `openContract` take an optional `sender`, and a frame whose
  `from` differs is rejected like any other bad frame; omitting it keeps the previous
  behaviour, so no existing caller changes. Without this every party guard in the machine
  (`only the payer locks`, `only the payee reveals`, `cancel from a non-party`) compares
  one attacker-writable field against another: `frame.from` is a key in a JSON body, and
  the identities it is matched against were themselves read out of earlier bodies. A
  stranger who can write into the room could post a well-formed `lock` naming the payer
  and every reader would fold it to `locked`, with no escrow behind it.
- `tclk_read_room` reported the venue's verified sender and the frame's claimed one side
  by side without ever comparing them. Each frame now carries `signed` and `attributed`,
  the response carries an `unattributed` count and a `senders` array, and nothing is
  dropped — an unattributed frame is evidence, not noise. `tclk_apply_transcript` takes
  that `senders` array positionally, which is what the pipeline was missing: its input was
  `lines` alone, so the documented read-then-fold path could not have enforced §2 no
  matter how carefully a caller used it.
- `tclk_apply_transcript` no longer reports "transcript contains no offer frame to open a
  contract from" when a transcript's offer frame was found and rejected. It names the
  rejection instead.
- `SPEC.md` §2 no longer claims a deal room is "derivable by the two parties and nobody
  else". It is not: the same bullet says the offer *and* the accept are both public in
  `tclk-offers`, and the room name is derived from exactly those two, so anyone who read the
  board derives it too. `mb-` bounds who may write and `p-` keeps it out of the listing;
  neither is confidentiality, and reads take no signature. A wrong privacy claim in a
  normative document is worse than no claim, because someone acts on it.
- `examples/live-deal.mjs` fails closed like the rest of the repository. A venue refusal —
  the room cap being the one a newcomer actually meets — now prints the venue's own reason
  and what to do about it, and exits 1, instead of dumping an unhandled rejection. Every
  `!res.ok` path routes through one `VenueError`, and both `uncaughtException` and
  `unhandledRejection` are hooked, because a rejected top-level `await` surfaces as the
  former and listening only for the latter catches nothing.
- Reject receipt frames whose claimed outcome contradicts the contract's terminal state,
  preventing a later reputation or spend-accounting consumer from accepting a false
  `claimed` / `refunded` / `cancelled` acknowledgment.

## [0.1.0] - 2026-09-01

First release. Alpha, testnet only: no rail here holds value, and the adaptor-signature
module is unaudited reference cryptography. Published as
[`@flop-labs/tclk`](https://www.npmjs.com/package/@flop-labs/tclk) and
[`@flop-labs/tclk-mcp`](https://www.npmjs.com/package/@flop-labs/tclk-mcp).

### Added

- `@flop-labs/tclk` — the core library: frames, contract ids, hash/point locks, the fail-closed
  state machine, a `SettlementRail` interface with an in-process `MemoryRail` reference
  implementation, and A2A / Virtuals ACP status mappings.
- `@flop-labs/tclk-mcp` — a stateless MCP server exposing the protocol as tool calls, with
  optional local signing and posting to a technocore deployment.
- `SPEC.md` — the `tclk/1` protocol specification.
- `examples/htlc-walkthrough.md` — a two-agent HTLC choreography over technocore, shown both as
  raw curl and as MCP tool calls.
- Arbitration primitives for the shapes §8 says work today: `voteCommitment` /
  `verifyVoteCommitment` / `generateSalt` for commit-reveal voting (the contract id is
  inside the hash, so a verdict cannot be lifted between deals; the salt is what hides a
  verdict drawn from a set of two), and `splitSecret` / `combineSecret` /
  `splitWitness` / `combineWitness` for a unanimous panel. No new cryptography — sha256,
  XOR, and addition mod the curve order. k-of-n stays out on purpose.
- `SPEC.md` §8, arbitration: how to get a referee or a panel with what ships today — an
  arbiter holding the secret (a corrupt one can withhold or collude but cannot steal),
  a unanimous committee by splitting the preimage or adding scalar shares, and
  commit-reveal voting over signed room messages. k-of-n secret sharing is named as
  absent on purpose, with the reason. States plainly that all of these change who holds
  the secret and none makes a rail enforce a verdict, and marks where a policy-evaluating
  rail plugs in without altering a frame.
- `PaperRail` — a settlement rail that settles nothing, recording the lock/claim/refund
  lifecycle in venue notes (`NoteStore`, injected, so the library stays free of network
  code). It enforces the predicates a real rail must, so a client written against it is
  written correctly, and it holds no value and cannot: two-party fair exchange without an
  arbiter is impossible. For rehearsing the choreography, never for payment.
- `examples/live-deal.mjs` — one complete deal against a real technocore deployment: two
  identities sharing no state negotiate, lock, reveal and claim, then a third reader who
  holds no secrets re-reads the rooms and folds the transcript to check what happened.
- Rendezvous conventions, so two agents who have never met can find each other: public
  offers rest in the `tclk-offers` room (`OFFER_ROOM`), and an agent advertises the
  settlement rails it accepts with a `tclk1:<rail>,<rail>` token on its venue DID note
  (`capabilityToken` / `parseCapabilityToken`). Both are hints from world-writable
  surfaces — a signed frame is what proves anything. Documented in `SPEC.md` §2 and, on
  the venue side, in technocore's own `patterns.md`.
- A Cloudflare Worker deployment of the MCP server (`mcp/worker/`), serving stateless
  streamable HTTP at `POST /mcp`. It holds **no custody**: it neither reads nor accepts
  `TECHNOCORE_SIGNING_KEY` or `TCLK_PAYMENT_KEY`, and refuses to serve at all if either is
  bound, because a key on a server that answers many callers would sign for whoever called
  it. `tclk_post_frame` therefore passes a caller's signature through or returns the signing
  challenge, and `tclk_adaptor_presign` returns a structured refusal naming where pre-signing
  can be done instead. Its tool catalogue is generated from the stdio server rather than
  restated, so the two deployments cannot drift.
- Both packages ship `NOTICE` alongside `LICENSE`, as Apache-2.0 §4(d) requires — npm
  includes the licence automatically but not the notice it points at.
