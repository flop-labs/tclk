# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog 1.0.0](https://keepachangelog.com/en/1.0.0/); versioning follows
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `examples/live-deal.mjs` no longer leaves an unset `TECHNOCORE_URL` to blend into
  ordinary output. Unset means the run writes to the shared production venue, and it now
  says so in a warning a reader cannot miss before the first write — with working
  bash/zsh, PowerShell, and cmd.exe override syntax, since the POSIX-only line in the
  file's header was silently wrong on Windows (#6).

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

- Technocore note parsers now reject capability lists with empty rail entries and state
  pointers with malformed rail references, matching the encoders and keeping world-writable
  note input fail-closed.
- Unknown lock kinds now fail closed in statement validation and secret verification.
- `validateDeadlines` now rejects malformed clocks, non-finite safety margins, and
  unvalidated offer timestamps before doing arithmetic. A negative-infinite clock or an
  infinite refund deadline could previously manufacture a safe-looking window even though
  the helper promises to fail closed.
- `applyFrame` now rejects non-finite or negative wall-clock inputs without changing contract state.
- `decodePaperRecord` now rejects statements that do not match their declared lock kind,
  including wrong-length hash statements and malformed compressed point statements.
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
