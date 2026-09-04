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
  dealRoomSpan,
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

if (folded.state === null) {
  console.error("no authenticated contract could be opened");
  process.exit(1);
}

const span = dealRoomSpan(deal, contract);
const range = span.count === 0 ? "none" : `${span.firstSeq}..${span.lastSeq}`;
const verdict = span.count === 0 ? "no rows" : span.gapFree ? "no gap detected" : "GAP";
console.log(`\n${span.room}: ${span.count} verified rows, seq ${range} — ${verdict}`);
if (span.count === 0) {
  console.log("  an empty deal room reads the same whether it was censored or simply expired: the");
  console.log("  venue deletes a room after seven days with no write, and a terminal deal stops writing.");
} else if (span.gapFree) {
  console.log("  \"no gap detected\" is not a completeness proof: seq is venue metadata outside the");
  console.log("  signature, so renumbering the kept rows, or dropping the last one, leaves no gap.");
} else {
  console.log("  a position between the first and last row is missing: the room held a signed row");
  console.log("  that this file does not.");
}

const terminal = ["claimed", "refunded", "cancelled"].includes(folded.state.status);
console.log(`\nfold → ${folded.state.status}${terminal ? "" : " (not terminal)"}`);
if (span.count > 0 && !span.gapFree) {
  console.error("a signed row is missing from the deal room, so this fold is not the whole deal");
  process.exit(1);
}
process.exit(terminal ? 0 : 1);
