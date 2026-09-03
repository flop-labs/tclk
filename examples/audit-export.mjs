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
  foldTranscript,
  parseTranscriptExport,
  tryDecodeFrame,
  verifyTranscriptRecord,
} from "../dist/index.js";

const [offersFile, dealFile, contract] = process.argv.slice(2);
if (!offersFile || !dealFile || !/^0x[0-9a-f]{64}$/.test(contract ?? "")) {
  console.error("usage: audit-export.mjs <offers.jsonl> <deal.jsonl> <0x contract id>");
  process.exit(2);
}

const room = dealRoom(contract);
const board = parseTranscriptExport(OFFER_ROOM, readFileSync(offersFile, "utf8"));
const deal = parseTranscriptExport(room, readFileSync(dealFile, "utf8"));

const authenticatedFrame = (record) => {
  const verification = verifyTranscriptRecord(record);
  if (!verification.ok) return null;
  const frame = tryDecodeFrame(record.line);
  return frame !== null && frame.from === record.sender ? frame : null;
};

const acceptRecord = board.find((record) => {
  const frame = authenticatedFrame(record);
  return frame?.type === "accept" && frame.contract === contract;
});
const accept = acceptRecord && authenticatedFrame(acceptRecord);
const offerRecord = accept?.type === "accept"
  ? board.find((record) => {
      const frame = authenticatedFrame(record);
      return frame?.type === "offer" && frame.id === accept.ref;
    })
  : undefined;

if (!offerRecord || !acceptRecord) {
  console.error(`no authenticated offer/accept pair for ${contract}`);
  process.exit(1);
}

const folded = foldTranscript([offerRecord, acceptRecord, ...deal]);
for (const step of folded.steps) {
  const verdict = step.ok ? "ok " : "BAD";
  console.log(`${verdict} ${step.room}#${step.seq} ${step.type ?? "record"}${step.reason ? ` — ${step.reason}` : ""}`);
}

if (folded.state === null) {
  console.error("no authenticated contract could be opened");
  process.exit(1);
}

const terminal = ["claimed", "refunded", "cancelled"].includes(folded.state.status);
console.log(`\nfold → ${folded.state.status}${terminal ? "" : " (not terminal)"}`);
process.exit(terminal ? 0 : 1);
