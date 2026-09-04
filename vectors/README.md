# tclk/1 portable interop vectors

`tclk-v1.golden.json` is one fully-populated, decodable example of every tclk/1 frame
type (`offer`, `accept`, `lock`, `reveal`, `refund`, `cancel`, `receipt`, `heartbeat`),
meant to be loaded directly by a from-scratch implementation in **any language** — no
TypeScript toolchain, no test framework, just JSON.

## Why this exists

`tests/vectors.test.ts` already pins the offer id, the contract id, and the canonical
line for two frame types as TypeScript constants — the anti-drift gate described in
[`AGENTS.md`](../AGENTS.md). Those values were themselves produced by an independent
implementation of the spec, so they check this repo's encoding rather than restating
it. But that file is only reachable by whoever can parse TypeScript and run this
repo's test suite, and it covers 2 of the 8 frame types. This file is the same idea,
made portable and complete: every `line` here is produced by this repo's own
`encodeFrame()` — never hand-typed — and checked for exact round-trip agreement by
[`tests/interop-vectors.test.ts`](../tests/interop-vectors.test.ts) on every test run,
so it cannot silently drift from what this reference implementation actually emits.

## How to use it, from any language

For each entry under `vectors`:

1. **Encode check.** Build the frame your implementation would construct from
   `frame`'s fields, encode it with your own encoder, and compare the result
   byte-for-byte against `line`.
2. **Decode check.** Decode `line` with your own decoder and compare the result,
   field by field, against `frame`.

If either check fails, the disagreement is in your implementation, not in the vector —
see `AGENTS.md`'s rule on the golden vectors: never edit a vector to make a check pass.

`line` always starts with the `wirePrefix` (`"tclk1 "`); the remainder is the exact
canonical JSON that a signature or an id commits to (sorted keys, compact separators,
non-ASCII escaped to `\uXXXX` — see `SPEC.md` §Canonical encoding).

## Regenerating this file

Only needed if the wire format changes on purpose (and the version prefix bumps, per
`AGENTS.md`). From the repo root:

```bash
pnpm build
node scripts/generate-interop-vectors.mjs
```

Then re-run `pnpm test` — `tests/interop-vectors.test.ts` will fail loudly if the
regenerated file and the source encoder/decoder ever disagree.
