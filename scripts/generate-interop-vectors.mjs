#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Generates vectors/tclk-v1.golden.json from the built reference implementation
// (run `pnpm build` first). See vectors/README.md for what this file is for.
//
// tests/vectors.test.ts already pins offer/accept ids and lines as TypeScript constants,
// produced by an independent implementation of the spec — the anti-drift gate described in
// AGENTS.md. That file is only readable by whoever can parse TypeScript, and it covers 2 of
// the 8 frame types. This script re-derives the SAME offer/accept objects (byte-identical
// inputs) plus one fully-populated, decodable example of every other frame type, and writes
// them to a single portable JSON file: something a Python, Rust, or Go port can load and
// check against directly, with no TypeScript toolchain and no test framework.
//
// Every `line` below is produced by encodeFrame() itself — never hand-typed — so the fixture
// cannot silently drift from what this reference implementation actually emits. The
// companion test (tests/interop-vectors.test.ts) re-checks that after every build: it
// decodes each `line` and asserts the result equals `frame`, and re-encodes each `frame` and
// asserts the result equals `line`, using the same *source* encoder/decoder this script's
// dist build was compiled from.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, makeAccept, makeOffer } from "../dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const PAYER_DID = "did:key:z6Mk" + "f".repeat(44);
const PAYEE_DID = "did:key:z6Mk" + "g".repeat(44);

const offer = makeOffer({
  from: PAYER_DID,
  role: "payer",
  amount: "1000000",
  asset: "FLOP",
  lock: "hash",
  rails: ["flop-htlc", "x402"],
  claimByMs: 1756703600000,
  refundAfterMs: 1756707200000,
  expiresMs: 1756700600000,
  job: { proto: "a2a", id: "task-3f", context: "ctx-1" },
  nonce: "9f2c81d04c9e1f7a",
});

const accept = makeAccept(offer, {
  from: PAYEE_DID,
  statement: "0x" + "ab".repeat(32),
  nonce: "0011223344556677",
});

const lock = {
  type: "lock",
  from: PAYER_DID,
  contract: accept.contract,
  rail: "flop-htlc",
  ref: "escrow-9001",
};

const reveal = {
  type: "reveal",
  from: PAYEE_DID,
  contract: accept.contract,
  ref: "escrow-9001",
  secret: "0x" + "11".repeat(32),
};

const refund = {
  type: "refund",
  from: PAYER_DID,
  contract: accept.contract,
  ref: "escrow-9001",
  reason: "claim window elapsed",
};

const cancel = {
  type: "cancel",
  from: PAYER_DID,
  contract: accept.contract,
  reason: "counterparty unresponsive",
};

const receipt = {
  type: "receipt",
  from: PAYEE_DID,
  contract: accept.contract,
  outcome: "claimed",
  rail: "flop-htlc",
  ref: "escrow-9001",
};

const heartbeat = {
  type: "heartbeat",
  from: PAYER_DID,
  contract: accept.contract,
  nonce: "aa11bb22cc33dd44",
  note: "still here",
};

const frames = { offer, accept, lock, reveal, refund, cancel, receipt, heartbeat };

const vectors = Object.fromEntries(
  Object.entries(frames).map(([name, frame]) => [name, { frame, line: encodeFrame(frame) }]),
);

const doc = {
  schema: "tclk-interop-vectors-v1",
  wirePrefix: "tclk1 ",
  generatedBy: "@flop-labs/tclk (reference TS implementation)",
  purpose:
    "One decodable, fully-populated example of every tclk/1 frame type, for a from-scratch " +
    "port in any language to check its encoder and decoder against without a TypeScript " +
    "toolchain. `frame` is the canonical object; `line` is exactly what encodeFrame() " +
    "produces for it and what decodeFrame() must reproduce it from.",
  vectors,
};

const outPath = join(root, "vectors", "tclk-v1.golden.json");
writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${Object.keys(vectors).length} vectors to ${outPath}`);
