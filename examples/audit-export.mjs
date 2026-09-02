#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Audit a tclk/1 deal from technocore `/export` files alone — no venue, no network.
//
// `live-deal.mjs` step 5 folds a deal from the live rooms, trusting the venue's `from`.
// Since technocore keeps the signature on every signed record (#93 there), an auditor no
// longer has to: this script re-verifies each record's Ed25519 signature against the
// `did:key` beside it, then folds the frames through `applyFrame` and reports the terminal
// state. Two files in, one verdict out, reproducible by anyone holding the same exports.
//
//   curl -s https://technocore.chat/r/tclk-offers/export            > offers.jsonl
//   curl -s https://technocore.chat/r/mb-p-tclk-<16 hex>/export      > deal.jsonl
//   node examples/audit-export.mjs offers.jsonl deal.jsonl <contract id>
//
// Exit 0 only when every frame that touched the contract is signed by its `from`, the
// transport `from` matches the frame's `from`, and the fold reaches a terminal state.

import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";

import { applyFrame, openContract, tryDecodeFrame } from "../dist/index.js";

const [offersFile, dealFile, contractArg] = process.argv.slice(2);
if (!offersFile || !dealFile) {
  console.error("usage: audit-export.mjs <offers export.jsonl> <deal export.jsonl> [contract id]");
  process.exit(2);
}

/** Room name the export came from, recovered from the deal room's derived name if given. */
function records(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

/** True when `sig` is this record's `from` key signing `<room>|<nonce>|<text>`. */
function verifies(room, r) {
  if (!r.from?.startsWith("did:key:z6Mk") || !r.sig || r.nonce === undefined) return false;
  const pub = base58.decode(r.from.slice("did:key:z".length)).slice(2); // drop multicodec ed25519-pub
  const msg = new TextEncoder().encode(`${room}|${r.nonce}|${r.text}`);
  try {
    return ed25519.verify(base64urlnopad.decode(r.sig), msg, pub);
  } catch {
    return false;
  }
}

const OFFER_ROOM = "tclk-offers";
const offers = records(offersFile);
const deal = records(dealFile);

// The deal room's name is derivable from the contract id; take it from the filename when the
// contract is not given, and from the contract otherwise.
const frames = (rs, room) =>
  rs.flatMap((r) => {
    const f = tryDecodeFrame(r.text);
    return f ? [{ r, f, room }] : [];
  });

const boardFrames = frames(offers, OFFER_ROOM);
// Without an explicit contract, audit the one the deal export is about: every frame in a
// deal room names its contract, so the first decodable record settles it.
const wanted =
  contractArg ??
  deal.map((r) => tryDecodeFrame(r.text)).find((f) => f && "contract" in f)?.contract;
if (!wanted) {
  console.error("no contract given and none named in the deal export");
  process.exit(1);
}
const accept = boardFrames.find(({ f }) => f.type === "accept" && f.contract === wanted);
if (!accept) {
  console.error(`no accept for ${wanted} on the offer board (export window may have moved past it)`);
  process.exit(1);
}
const contract = accept.f.contract;
const dealRoom = `mb-p-tclk-${contract.slice(2, 18)}`;
const offer = boardFrames.find(({ f }) => f.type === "offer" && f.id === accept.f.ref);
if (!offer) {
  console.error(`offer ${accept.f.ref} not on the board (export window may have moved past it)`);
  process.exit(1);
}

let failures = 0;
const check = ({ r, f, room }, label) => {
  const sigOk = verifies(room, r);
  const fromOk = r.from === f.from;
  if (!sigOk || !fromOk) failures += 1;
  console.log(
    `${sigOk ? "ok " : "BAD"} sig  ${fromOk ? "ok " : "BAD"} from  ${label.padEnd(8)} ${room}#${r.seq}  ${f.from.slice(0, 20)}…`,
  );
};

console.log(`contract ${contract}`);
console.log(`deal room ${dealRoom}\n`);
check(offer, "offer");
check(accept, "accept");
let state = openContract(offer.f);
const acceptedAt = Date.parse(accept.r.ts);
let step = applyFrame(state, accept.f, Number.isFinite(acceptedAt) ? acceptedAt : Date.now());
if (step.state === state && step.reason) console.log(`    rejected: ${step.reason}`);
state = step.state;

for (const entry of frames(deal, dealRoom)) {
  if (entry.f.contract !== contract) continue;
  check(entry, entry.f.type);
  // Fold at the record's own timestamp so deadlines are judged as of when the frame landed.
  const at = Date.parse(entry.r.ts);
  step = applyFrame(state, entry.f, Number.isFinite(at) ? at : Date.now());
  if (step.state === state && step.reason) console.log(`    rejected: ${step.reason}`);
  state = step.state;
}

const terminal = ["claimed", "refunded", "cancelled"].includes(state.status);
console.log(`\nfold → ${state.status}${terminal ? "" : " (not terminal)"}; ${failures} signature/attribution failure(s)`);
process.exit(failures === 0 && terminal ? 0 : 1);
