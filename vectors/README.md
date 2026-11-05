# tclk/1 portable interop vectors

`tclk-v1.golden.json` is one decodable example of every tclk/1 frame type (`offer`,
`accept`, `lock`, `reveal`, `refund`, `cancel`, `receipt`, `heartbeat`), meant to be
loaded directly by a from-scratch implementation in **any language** — no TypeScript
toolchain, no test framework, just JSON.

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
The same test pins the file's exact bytes (see [Integrity](#integrity)).

## What it covers

- Every frame type, exactly once.
- Every optional field at least once, including the two nested objects, `offer.job`
  and `lock.presig` — except `paymentKey`. Adding it would change the contract id (and,
  on `offer`, the offer id), which every later frame carries, so `offer` and `accept`
  would no longer be the frames `tests/vectors.test.ts` pins.

The values are synthetic. They pass the decoder, but the eight frames are not one
consistent transcript: `reveal.secret` does not hash to `accept.statement`, and
`lock.presig`, whose nonce is the secp256k1 generator point, is not a pre-signature
over any claim message. `SPEC.md` §3.3 uses `presig` on PTLC rails, while this contract
is a hash lock on `flop-htlc`. Use the vectors to check encoding and decoding, not
settlement or the state machine.

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
non-ASCII escaped to `\uXXXX` — see [`SPEC.md` §3](../SPEC.md#3-wire-format)).

## Integrity

SHA-256 of `tclk-v1.golden.json`:

```text
31d804f7a1eba6bb6ec353bc28496f790734193f7df6f4fd27aece1dbd4f9d02
```

[`tests/interop-vectors.test.ts`](../tests/interop-vectors.test.ts) pins the same value
and fails unless the file, the test, and this page agree, so a port can pin it to know
exactly which corpus it is checking against. The hash covers the file's exact bytes,
with LF line endings: a checkout that converts them to CRLF changes it. To check a
copy, run `sha256sum tclk-v1.golden.json` (Linux), `shasum -a 256 tclk-v1.golden.json`
(macOS), or `Get-FileHash tclk-v1.golden.json` (PowerShell, which prints it in upper
case).

## Regenerating this file

Only needed when the corpus changes on purpose, i.e. new inputs in
`scripts/generate-interop-vectors.mjs`. A wire-format change bumps the prefix (`tclk2 `,
per `AGENTS.md`) and needs a new corpus, not a regeneration of this one. From the repo
root:

```bash
pnpm build
node scripts/generate-interop-vectors.mjs
```

The script prints the new file's SHA-256: update it above and in
`tests/interop-vectors.test.ts`, then re-run `pnpm test`, which fails loudly if the
file, the hash, and the source encoder/decoder ever disagree. To check that the
committed file is exactly what the script generates, without rewriting it:

```bash
pnpm build
node scripts/generate-interop-vectors.mjs --check
```
