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
  checkNonceOrder,
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

// `seq` and `ts` are venue metadata, so whoever hands over the file can renumber
// them; the record nonce sits inside the signed preimage and cannot follow. A
// signer's own records arriving out of the order that signer numbered them is
// therefore attested rather than asserted, and survives a renumbering.
const outOfOrder = checkNonceOrder([handshake.offer, handshake.accept, ...deal]);
for (const issue of outOfOrder) {
  const who = `${issue.sender.slice(0, 24)}…`;
  console.error(
    `BAD ${issue.room} rows ${issue.previousIndex} and ${issue.index} from ${who} are supplied ` +
    `out of the order that signer signed them (nonce ${issue.previousNonce} then ${issue.nonce})`,
  );
}

if (folded.state === null) {
  console.error("no authenticated contract could be opened");
  process.exit(1);
}

const terminal = ["claimed", "refunded", "cancelled"].includes(folded.state.status);
console.log(`\nfold → ${folded.state.status}${terminal ? "" : " (not terminal)"}`);

if (outOfOrder.length > 0) {
  console.error(
    `\nrefusing to treat this fold as evidence: ${outOfOrder.length} record(s) supplied out of signed order`,
  );
  process.exit(1);
}
process.exit(terminal ? 0 : 1);
