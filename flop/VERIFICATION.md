# FlopRail verification

Verified on 2026-10-22 (Asia/Singapore), in branch `codex/floprail-devnet`,
based on tclk `5cc4ab93efbc8999a3a7e1471b639deca25998ea`.

## Workspace gates

All passed:

```sh
pnpm install --frozen-lockfile
pnpm -r --include-workspace-root build
pnpm -r --include-workspace-root test
pnpm check:protocol
git diff --check
```

249 tests: 104 protocol, 40 MCP, 33 hosted worker, 72 FlopRail. Golden vectors
and the generated protocol schema remain unchanged. The compiled package was
also imported through its public package entry point.

## Live devnet

These receipts were produced for the initial implementation at `1fe229e`.
The subsequent review fixes were validated with the workspace gates above;
no additional live transaction was required for the pre-submission checks.

Ran `node flop/examples/devnet.mjs` with fresh local Ed25519 wallets funded
with faucet test tokens. No mainnet transaction or package publication occurred.

- RPC: `wss://rpc.devnet.flop.network`.
- Genesis: `0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631`, independently matched to the faucet.
- Runtime spec version observed: `1014002`.
- Amount per escrow: `1000000000000000` base units (0.001 test FLOP).

Claim:

- Escrow: `0x6fca0e2333da351600475a298ff0bd15acc42933b1ea6873ced2c15910e2cac5`.
- Transaction: `0x634b4d1ca17876f08f805d7cb1f5a79667b2de86be44d9819abaec6d08408c03`.
- Finalized block: `0xeafcbbc66e68895b686dd3ab5ac647db41dba785cabd740e53a2727256b5794a`.
- Observed `balances.ReserveRepatriated` for the exact amount to the agreed payee,
  `hasStation.EscrowReleased`, and `system.ExtrinsicSuccess`.

Refund:

- Escrow: `0x222eb1c4dc1aee313d4e89e29ce89299cf0fb8ea16739872da21f68e78a5f851`.
- Transaction: `0x574a55ac8578514c3c22605d6fb1d9af67c2fa7b7ca351563404b1049740354c`.
- Finalized block: `0xfefa385a2438805f23e260cfb9bf66efcecdb463e065b1de896f402f666dd538`.
- Observed `balances.Unreserved` for the exact amount,
  `hasStation.EscrowRefunded`, and `system.ExtrinsicSuccess`.

Two earlier diagnostic escrows were refunded. All four test escrows were read
back from finalized state: one Released, three Refunded; none remained Open.
The live run exposed the runtime's `{and:null}` SCALE JSON encoding; its exact
shape is now a regression fixture. The demo's claim window also includes time
for real network finality and independent payee verification.

## Review follow-up

Nine additional regression tests cover journal delays past the local or chain
claim window, exhausted and last-permitted anchor allowances, chain reset,
post-journal RPC failure and safe retry, invalid recovery references, claiming
a pending reference, and connection-timeout cleanup. Rejected preflight attempts
submit no escrow and release the local duplicate guard for a fresh attempt.

The runtime uses the same public-key bytes via `bytesToHex`, recovery documentation
explains late inclusion of immortal extrinsics, and the new package and its block
deadline limitations are recorded under `[Unreleased]` in the tclk changelog.

## Design evidence and limits

The binding targets FLOP typed escrow at upstream commit
`d125e0bdcf6ea2717674b121fc418094d88d1d80`:
[open/claim/refund implementation](https://github.com/flop-labs/flop-core/blob/d125e0bdcf6ea2717674b121fc418094d88d1d80/pallets/pallets/has-station/src/lib.rs),
[network profiles](https://github.com/flop-labs/flop-core/blob/d125e0bdcf6ea2717674b121fc418094d88d1d80/sdk/typescript/src/chain.ts).

Testnet/mainnet configuration is validated offline; those networks were not used.
This is a trusted-RPC HTLC adapter with nominal block-time conversion, not an
audited mainnet deployment or a guarantee of wall-clock/cross-chain deadlines.
See [the design and recovery instructions](README.md).

All implementation changes are isolated in the tclk worktree. The original tclk
checkout's local edits and the technocore-chat checkout were preserved.
