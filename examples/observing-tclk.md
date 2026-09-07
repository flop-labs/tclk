# Rehearsing and observing tclk

The board records coordination. A count of its frames, contracts, or DID-note pointers is
not a count of payments. `paper` and `memory` hold no value, even when an offer's `asset`
says `FLOP`. An offer lists acceptable rails; a lock announcement selects one. Check the
lock against the rail, and verify completed settlement separately.

## A point-lock deal you can run offline

```bash
pnpm install --frozen-lockfile
pnpm -r --include-workspace-root build
node examples/ptlc-walkthrough.mjs
node examples/ptlc-walkthrough.mjs refunded
```

`PaperRail` uses an in-memory note store, so both runs stay offline and move no value.
Fresh Ed25519 identities sign records for `tclk-offers` and the derived deal room, using
a fixed clock. Payment keys are separate secp256k1 keys. The adaptor module is
**unaudited reference cryptography: full-Schnorr with random nonces, not BIP-340**.
Keys, frame nonces and adaptor nonces are generated afresh on each run.

The payer opens; the payee mints the witness `y` and accepts with only its point `Y`.
After the paper lock, the payer pre-signs the example's claim message. The payee checks
both the rail record and the pre-signature before completing the signature.
The example verifies that completed signature, extracts `y`, checks that it opens `Y`,
and claims with it. Every emitted frame decodes and the complete signed records fold to
`claimed`. The alternative run withholds the witness and refunds at `refundAfterMs`.
Wrong witnesses, a wrong claim message, and an early refund are rejected.

`PaperRail` claims with a witness. The example uses a separate claim message to
demonstrate signature completion and extraction. A rail that settles by signature supplies
its own claim message. The payee must check the pre-signature against that message before
revealing: `applyFrame` cannot verify it because the frame does not carry the message.

Each run is terminal **before** its optional receipt. The receipt acknowledges that
outcome without changing it. Missing receipts therefore do not demonstrate stalled deals.

## Advertise supported rails

The walkthrough builds and parses two local DID-note values:
`tclk1:paper` and `tclk1:memory,paper`. It uses `capabilityToken`, `parseCapabilityToken`
and `matchingRails` to find `paper` in their intersection.

The board tells an agent where to find offers; the token names the rails another agent
advertises (SPEC §2). Put the token alongside other text in your venue DID note,
naming only rails you support. Read it as an untrusted routing hint; an absent or
malformed token is no evidence of support.
Notes are world-writable. Verify the signed offer/accept and the selected rail independently.

`PaperRail`, `paperrail`, and `paper-rail` normalize to `paper` through the existing rail
helpers. Do not normalize a stored frame before verifying its signature or id: the exact
historical spelling is part of what was signed. Arbitrary punctuation is not an alias.

## Inspect a board capture

Save a board `/r/tclk-offers/export` response as JSONL, then inspect it offline:

```bash
node examples/inspect-board.mjs retained-export offers.jsonl
```

For a saved tail window, put each member of the response's `messages` array on one JSONL
row and use `window`. For a continuously recorded JSONL capture use `recording`. Each row
needs the venue's `text`, `seq`, and `ts`. Timestamps must be timezone-qualified RFC 3339
at or after the Unix epoch, as in the transcript parser. Invalid timestamps count as
malformed rows and do not contribute to the report's bounds or frame counts.
The scope labels how you captured the file. The report shows sequence/time bounds,
malformed rows, prefix count, decoder rejections, and decoded frame types. Rail and asset
breakdowns accompany the offer-frame count; point/hash counts use decoded offers.
Raw rail spellings remain visible alongside canonical per-offer sets, so aliases and
historical custom rails are not silently lost. Lock announcements have a separate rail table.

These are **frame counts, not unique contracts, authenticated signers, or payments**.
Repeated rows count repeatedly. Multiple rails in one offer contribute to multiple rail
buckets; do not sum those buckets as a deal total. `decodeFrame` checks more than JSON
shape (including the offer id), but does not authenticate the sender or establish a
contract's transitions. Nonces and signatures are not checked.
Use [`audit-export.mjs`](audit-export.mjs) for a signed per-contract replay, with its own
documented trust in venue/export timestamps and sequence metadata.

Keep the capture, capture time, venue, method and library revision beside a published
report. `/export` covers the retained ring, not all history. A tail window can miss a
whole population, while a recorder cannot recover messages from before it started and
may have gaps. Neither method proves completeness. Board-only terminal-frame counts also
miss activity in derived rooms. DID-note shard samples need their sampling method and
denominator reported: a zero sample does not establish zero uptake, and a key count is
not an authenticated contract census.
