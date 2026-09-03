# AGENTS.md

CI runs exactly these against the code — run them before pushing:

```bash
pnpm install --frozen-lockfile
pnpm -r --include-workspace-root build
pnpm -r --include-workspace-root test
```

CI also scans commit messages. `scripts/no-agent-trailers.sh` fails any message carrying a
coding-agent session link (`Claude-Session:`, a `claude.ai/code/session` URL); the same script
backs the opt-in `commit-msg` hook in `.githooks/`. **Do not put a session URL in a commit
message.** They resolve for nobody but the account that made them, and a public history cannot
take one back — this repository's was squashed once to remove them.

`--include-workspace-root` is not optional: the library **is** the root package (`mcp/` is
the only child), and a plain `pnpm -r` skips the root, so the library would silently never
build and `mcp/` would fail against a stale `dist/`.

## Layout

- `src/` — the library (`@flop-labs/tclk`). Pure: no network, no filesystem, no clock reads
  except the `nowMs` a caller passes in.
- `mcp/` — the MCP server (`@flop-labs/tclk-mcp`), a client of the library. Wraps it as tool
  calls and is the only half that talks to technocore over HTTP.
- `SPEC.md` — the normative protocol. Code follows the spec; when they disagree, fix the one
  that is wrong, and say which in the PR.

## Rules that are load-bearing

- **The golden vectors are the anti-drift gate.** `tests/vectors.test.ts` pins the offer id,
  contract id, and canonical frame lines as constants. They were produced by an independent
  implementation of this spec, so they check the encoding rather than restating it: if a change
  makes a vector fail, the change altered the wire format — **fix the change, or bump the
  version prefix (`tclk1 ` → `tclk2 `) deliberately.** Never edit a vector to make a test pass.
  Frames already posted in a room outlive any release of this package.
- **Canonical encoding is exact.** Sorted keys, compact separators, `undefined` dropped,
  non-ASCII `\uXXXX`-escaped. The bytes on the wire are the bytes a signature covers, and
  technocore stores code points verbatim without normalizing — so NFC and NFD of one string
  are two different frames.
- **Fail closed everywhere on the money path.** Frame validation rejects unknown keys and
  malformed values rather than coercing; `applyFrame` returns `{ok:false, reason}` and an
  unchanged state rather than throwing or half-applying; `verifySecret` and the point-lock
  checks return `false` on malformed input rather than throwing. No `unwrap_or`-shaped
  defaults, no `|| true` in a guard.
- **The MCP server holds nothing.** A minted preimage or witness is returned to the caller and
  never stored, logged, or echoed back in a later tool result (`tclk_apply_transcript` reports
  `secretRevealed: boolean`, never the secret). Keys come only from the environment. Any change
  that gives the server durable custody of a secret is a design change, not a feature.
- **`src/adaptor.ts` is unaudited reference cryptography** — full-Schnorr, not BIP-340, random
  nonces. It exists so the PTLC pre-sign → adapt → extract cycle is testable end to end. Keep
  the banner, and do not present it as production signing.

## Conventions

- pnpm only (never npm/yarn — a stray `package-lock.json` must not be committed).
- Tests are vitest. The root config is scoped to `tests/**` on purpose: the default include
  would sweep `mcp/tests` and run that suite twice.
- SemVer + Keep a Changelog; every user-visible change gets a `CHANGELOG.md` entry under
  `[Unreleased]` before release.
