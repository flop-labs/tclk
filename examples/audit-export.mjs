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
}

// Two claims, kept apart on purpose. The replay says what these records fold to. It is not a
// statement that these are all the records, and a tool that prints one line for both invites
// the reader to hear the second.
const terminal = ["claimed", "refunded", "cancelled"].includes(folded.state.status);
console.log(`\nreplay   → ${folded.state.status}${terminal ? "" : " (not terminal)"}`);

if (span.count > 0 && !span.gapFree) {
  console.log("evidence → INCOMPLETE. A position between the first and last row is missing, so the");
  console.log("           room held a signed row that this file does not.");
  process.exit(1);
}

console.log("evidence → completeness NOT established. A gap is evidence of absence; the absence of");
console.log("           a gap is not evidence of presence, because seq is venue metadata outside the");
console.log("           signature: a supplier that renumbers the rows it keeps leaves none, and one");
console.log("           that drops the last row leaves none either.");
console.log("           Exit 0 means the replay reached a terminal status. It does not mean audited.");
process.exit(terminal ? 0 : 1);
