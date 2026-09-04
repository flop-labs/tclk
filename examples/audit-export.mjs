#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Reproduce a deal from two byte-exact technocore exports, with no network access.
//
//   node examples/audit-export.mjs offers.jsonl deal.jsonl 0x<contract-id>

import { readFileSync } from "node:fs";

import {
  OFFER_ROOM,
  dealRoom,
  findContractHandshake,
  foldTranscript,
  parseTranscriptExport,
} from "../dist/index.js";

const [offersFile, dealFile, contract] = process.argv.slice(2);
if (!offersFile || !dealFile || !/^0x[0-9a-f]{64}$/.test(contract ?? "")) {
  console.error("usage: audit-export.mjs <offers.jsonl> <deal.jsonl> <0x contract id>");
  process.exit(2);
}

const room = dealRoom(contract);
const board = parseTranscriptExport(OFFER_ROOM, readFileSync(offersFile, "utf8"));
const deal = parseTranscriptExport(room, readFileSync(dealFile, "utf8"));

let handshake;
try {
  handshake = findContractHandshake(board, contract);
} catch (error) {
  console.error(error instanceof Error ? error.message : "invalid offer/accept ordering");
  process.exit(1);
}
if (handshake === null) {
  console.error(`no authenticated offer/accept pair for ${contract}`);
  process.exit(1);
}

const folded = foldTranscript([handshake.offer, handshake.accept, ...deal]);
for (const step of folded.steps) {
  const verdict = step.ok ? "ok " : "BAD";
  console.log(`${verdict} ${step.room}#${step.seq} ${step.type ?? "record"}${step.reason ? ` — ${step.reason}` : ""}`);
}

if (folded.warnings?.length) {
  console.error("\nwarnings (timestamps/seq are venue metadata, not signed — see SPEC §2):");
  for (const w of folded.warnings) console.error(`  WARN: ${w}`);
  // A gap or reordering can flip claimed↔refunded with no BAD verdict (see #93).
  // A backwards timestamp can flip a deadline with all signatures valid.
  const fatal = folded.warnings.some((w) => w.includes("gap detected") || w.includes("seq not strictly increasing") || w.includes("timestamp goes backwards"));
  if (fatal) {
    console.error("\ntranscript is not per-room contiguous/monotonic — refusing to treat fold as audit proof");
    process.exit(1);
  }
}

if (folded.state === null) {
  console.error("no authenticated contract could be opened");
  process.exit(1);
}

const terminal = ["claimed", "refunded", "cancelled"].includes(folded.state.status);
console.log(`\nfold → ${folded.state.status}${terminal ? "" : " (not terminal)"}`);
if (folded.warnings?.length) {
  console.log("note: timestamps/seq are venue metadata, not covered by signature — verify settlement on the rail");
}
process.exit(terminal ? 0 : 1);
