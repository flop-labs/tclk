#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Count decoded frames in a saved board capture. Does not verify signatures or settlement.
//   node examples/inspect-board.mjs <retained-export|window|recording> <messages.jsonl>
// Each JSONL row is a venue message with text, seq and ts. For a ?format=json window,
// save each member of messages as one row.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { MAX_FRAME_CHARS, TCLK_PREFIX, isTclkLine, normalizeRailId, parseRfc3339Instant, tryDecodeFrame } from "../dist/index.js";

export function inspectBoard(jsonl, scope) {
  if (!["retained-export", "window", "recording"].includes(scope)) {
    throw new Error("scope must be retained-export, window or recording");
  }
  const counts = { rows: 0, malformedRows: 0, nonFrames: 0, prefixed: 0, rejected: 0, decoded: 0 };
  const types = new Map();
  const offeredRails = new Map();
  const rawOfferedRails = new Map();
  const announcedLockRails = new Map();
  const assets = new Map();
  const lockKinds = new Map();
  const rejectedTypes = new Map();
  let minSeq = null, maxSeq = null, minTime = null, maxTime = null;
  const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  const railName = (rail) => {
    try { return normalizeRailId(rail); }
    catch { return `unregistered:${rail}`; } // historical custom rails remain visible
  };

  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    counts.rows += 1;
    let message;
    try { message = JSON.parse(line); }
    catch { counts.malformedRows += 1; continue; }
    const time = parseRfc3339Instant(message?.ts);
    if (!message || typeof message.text !== "string" ||
        !Number.isSafeInteger(message.seq) || message.seq < 0 ||
        time === null) {
      counts.malformedRows += 1;
      continue;
    }
    minSeq = minSeq === null ? message.seq : Math.min(minSeq, message.seq);
    maxSeq = maxSeq === null ? message.seq : Math.max(maxSeq, message.seq);
    minTime = minTime === null ? time : Math.min(minTime, time);
    maxTime = maxTime === null ? time : Math.max(maxTime, time);
    if (!isTclkLine(message.text)) { counts.nonFrames += 1; continue; }
    counts.prefixed += 1;
    const frame = tryDecodeFrame(message.text);
    if (frame === null) {
      counts.rejected += 1;
      // Decoder errors can contain rejected secrets; report only the claimed frame type.
      let type = "unclassified";
      if (message.text.length <= MAX_FRAME_CHARS) {
        try {
          const value = JSON.parse(message.text.slice(TCLK_PREFIX.length));
          if (typeof value?.type === "string" && /^[a-z]{1,32}$/.test(value.type)) type = value.type;
        } catch { /* A malformed JSON frame has no discriminator. */ }
      }
      count(rejectedTypes, type);
      continue;
    }
    counts.decoded += 1;
    count(types, frame.type);
    if (frame.type === "offer") {
      count(assets, frame.asset);
      count(lockKinds, frame.lock);
      for (const rail of new Set(frame.rails)) count(rawOfferedRails, rail);
      for (const rail of new Set(frame.rails.map(railName))) count(offeredRails, rail);
    }
    if (frame.type === "lock") count(announcedLockRails, railName(frame.rail));
  }
  const sorted = (map) => Object.fromEntries([...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return {
    scope, room: "tclk-offers", validation: "decodeFrame only; signatures and transitions NOT verified",
    coverage: "supplied rows only; no completeness, uniqueness or lifetime estimate",
    seqRange: minSeq === null ? null : [minSeq, maxSeq],
    timeRange: minTime === null ? null : [new Date(minTime).toISOString(), new Date(maxTime).toISOString()],
    counts, frameTypes: sorted(types), rejectedClaimedTypes: sorted(rejectedTypes),
    offerFrames: types.get("offer") ?? 0,
    offerLockKinds: sorted(lockKinds), offerAssets: sorted(assets),
    offeredRails: sorted(offeredRails), rawOfferedRails: sorted(rawOfferedRails),
    announcedLockRails: sorted(announcedLockRails),
    interpretation: "Rail counts count each rail once per frame, not payments. Multi-rail offers can count in several buckets. paper and memory hold no value, whatever the asset; other rail names do not prove settlement. Receipts are optional acknowledgments, not completed-deal counts.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [scope, file] = process.argv.slice(2);
  try {
    if (!file) throw new Error("usage: inspect-board.mjs <retained-export|window|recording> <messages.jsonl>");
    console.log(JSON.stringify(inspectBoard(readFileSync(file, "utf8"), scope), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
