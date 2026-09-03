# Contributing

Bug fixes, tests, documentation, and focused enhancements are welcome. Spec questions are
welcome too: if `SPEC.md` and the code disagree, that is a bug in one of them, and saying which
is half the work.

Do not report an exploitable vulnerability in a public issue or pull request. Follow
[`SECURITY.md`](SECURITY.md) to send a private report.

## The rules that are load-bearing live in AGENTS.md

[`AGENTS.md`](AGENTS.md) is the one copy of the things a change here can quietly break — the
golden vectors and why a failing one means the wire format moved, exact canonical encoding,
fail-closed on the money path, and the MCP server holding nothing. It is written for whoever
edits the code, human or model. **Read it before your first pull request**; it is not restated
here, because a second copy would drift from it.

## Development setup

pnpm only — a stray `package-lock.json` must not be committed. The version is pinned by
`packageManager` in `package.json`, so [corepack](https://nodejs.org/api/corepack.html) picks it
up on its own.

```bash
pnpm install --frozen-lockfile
```

Turn on the repository's hooks once, in your clone:

```bash
git config core.hooksPath .githooks
```

That is one hook, `commit-msg`, and it refuses a message carrying a coding-agent session
link. Those URLs resolve for nobody but the account that made them, and a public history
cannot take one back — this repository's history was squashed once to remove them, and the
hook exists so that does not happen twice. Git will not run a hook out of a fresh clone on
its own, which is why the same check also runs on every pull request
(`scripts/no-agent-trailers.sh`, one definition, two callers).

CI runs exactly these three against the code, in this order (plus the commit-message
scan above):

```bash
pnpm install --frozen-lockfile
pnpm -r --include-workspace-root build
pnpm -r --include-workspace-root test
```

`--include-workspace-root` is not optional: the library **is** the root package (`mcp/` is the
only child), so a plain `pnpm -r` skips it and `mcp/` then builds against a stale `dist/`. The
same reason means you must build before running `examples/live-deal.mjs` — it imports `dist/`.

## Making a change

- One problem per pull request. Bug fixes and small documentation improvements can go straight to
  a pull request; discuss a change to the wire format, the state machine, or the rail interface in
  an issue first, because those are the things other people's already-posted frames depend on.
- Add tests for behavior that changes. A bug fix should include a regression test that fails
  without the fix. Prefer assertions on observable behavior over private implementation details.
- Keep `SPEC.md` and the code in agreement, and say in the pull request which one you treated as
  correct.
- Every user-visible change gets a `CHANGELOG.md` entry under `[Unreleased]`, following
  [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Leave version bumps and dated release
  sections to a maintainer.
- Avoid unrelated refactors, formatting sweeps, or version bumps in the same pull request.
- New surface on the money path: say what a hostile counterparty gets from it, or say "nothing".

## Pull requests

Explain what changes for a caller and why, link related issues, and confirm the three CI commands
pass locally. Keep the branch current with `main`; address review with additional commits or a
clean rebase. All required checks must pass before merge.
