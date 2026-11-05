# Yellow Paper / TCLK Verification Note

Date: 2026-09-10

## Scope

I ran the TCLK test suite locally against the current checkout to verify
the settlement-rail and protocol invariants exercised by the repository.

## Result

The complete test suite passed:

- Test files: 9 passed
- Tests: 104 passed

The PaperRail-specific suite also passed:

- Test file: `tests/paper-rail.test.ts`
- Tests: 11 passed

## PaperRail properties verified

The PaperRail tests cover:

- lock → claim with a valid secret
- duplicate-lock rejection
- claim/refund deadline enforcement
- rejection of locks with an already-open refund window
- hash-lock and point-lock paths
- fail-closed verification for mismatched or tampered terms
- rejection of malformed records and statements
- record encode/decode round-tripping
- stale-view protection through compare-and-set updates
- malformed contract-ID rejection

## Interpretation

These results verify the protocol predicates exercised by the
PaperRail implementation and its fail-closed handling of the
world-writable note surface.

This should not be interpreted as evidence of real economic settlement
security. PaperRail is explicitly a rehearsal rail and moves no value;
value-bearing guarantees belong to the underlying settlement rail.

## Reproducibility

Command used:

    pnpm test

PaperRail-specific command:

    pnpm vitest run tests/paper-rail.test.ts
