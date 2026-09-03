#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// One tclk/1 deal, end to end, against a real technocore deployment.
//
// Two identities that share no state beyond the venue negotiate a hash-locked contract,
// lock it on the PAPER rail, reveal, and claim — then a third reader who was not part of
// either side re-reads the rooms and folds the transcript to check what happened.
//
// ⚠️ The paper rail holds NOTHING. This is a rehearsal of the choreography on real
// infrastructure, not a payment. `asset` says PAPER for exactly that reason.
//
//   node examples/live-deal.mjs                      # a tiktok job, against technocore.chat
//   node examples/live-deal.mjs youtube              # x | ig | tiktok | youtube
//
//   Against your own instance instead of the shared one — the syntax differs by shell:
//     bash/zsh    TECHNOCORE_URL=http://localhost:8080 node examples/live-deal.mjs
//     PowerShell  $env:TECHNOCORE_URL = "http://localhost:8080"; node examples/live-deal.mjs
//     cmd.exe     set TECHNOCORE_URL=http://localhost:8080 && node examples/live-deal.mjs
//
// Writes six messages and three notes. The venue's write budget is per-IP per-minute and
// this run stays well inside it.

import { randomBytes } from "node:crypto";

import {
  OFFER_ROOM, PaperRail, applyFrame, dealRoom, encodeFrame, findContractHandshake, foldTranscript,
  generateHashLock, lockTerms, makeAccept, makeOffer, openContract, paperNote,
  parseTranscriptExport, stateNote, stateNoteValue, transcriptRecord,
} from "../dist/index.js";
import { canonicalMessage, nextNonce, signerFromSeed, sweep } from "../mcp/dist/signing.js";

const DEFAULT_VENUE = "https://technocore.chat";
const BASE = process.env.TECHNOCORE_URL ?? DEFAULT_VENUE;

const log = (step, detail) => console.log(`${String(step).padEnd(3)} ${detail}`);

/**
 * A refusal the venue chose to give, as opposed to a bug on this side. Its refusal bodies
 * are written to be read — they name the cap that was hit and what a caller does about it —
 * so the useful thing is to print that, not to bury it under a stack trace. The rest of
 * this repository fails closed with a reason; the one file a newcomer runs should not be
 * the exception.
 */
class VenueError extends Error {
  constructor(what, status, body) {
    super(`${what}: ${status} ${body}`);
    this.name = "VenueError";
    this.status = status;
    this.body = body;
  }
}

/** Build a VenueError from a refused response, keeping the venue's own first line. */
async function refusal(what, res) {
  const body = (await res.text()).split("\n").filter((line) => line.trim())[0] ?? "";
  return new VenueError(what, res.status, body);
}

// A VenueError is a fact about the venue and prints as one sentence; anything else is a bug
// in this script or the library, and still deserves its stack. Both events are hooked on
// purpose: a rejected top-level await surfaces as an uncaught exception (module evaluation
// failed), not as an unhandled rejection, so listening for only the latter catches nothing.
function reportAndExit(error) {
  if (!(error instanceof VenueError)) {
    console.error(error);
    process.exit(1);
  }
  console.error(`\nThe venue refused. ${error.message}`);
  if (error.status === 400 && /room limit|is the cap/i.test(error.body)) {
    console.error(
      [
        "",
        "A deal needs two rooms this venue will not create right now: the public offer room,",
        "and a deal room named from the contract id. Neither is optional — the offer has to",
        "rest somewhere strangers look, and the deal room is derived, not chosen.",
        "",
        "Run it against your own instance instead:",
        "",
        "  TECHNOCORE_URL=http://localhost:8080 node examples/live-deal.mjs",
        "",
        "The hosted venue clears on its own: idle rooms are reclaimed after 7 days, and one",
        "still on its first message after 24 hours.",
      ].join("\n"),
    );
  }
  process.exit(1);
}

process.on("uncaughtException", reportAndExit);
process.on("unhandledRejection", reportAndExit);

/**
 * Every request goes through here so a 429 is honoured rather than thrown, and a
 * transient 5xx (or a hung attempt) is retried with backoff. The venue rate-limits
 * per IP and says how long to wait, in the body and in Retry-After — a client that
 * treats that as an error instead of an instruction just fails louder. It has also
 * been observed returning intermittent 503/524s under load, and a run that dies
 * between `lock` and `reveal` is not merely inconvenient: on a rail that held value
 * it sits there until `refundAfterMs`.
 *
 * Each attempt is bounded by ATTEMPT_MS: `fetch` otherwise inherits undici's 300 s
 * headers timeout, so one hung attempt would eat five minutes before the first
 * backoff wait and surface as an `UND_ERR_HEADERS_TIMEOUT` rejection — a thrown
 * error that never reaches the status check below and prints as a bug in this
 * script during a venue incident in which the library did nothing wrong. A timed-out
 * attempt comes back as `null` and takes the same "did it land?" path as a 5xx.
 *
 * Only genuinely transient statuses are retried: 429 (with Retry-After) and the
 * 500/502/503/504/522-524 band. A 501 or 505 cannot change on retry, and a 4xx other
 * than 429 is an answer, not an outage — looping on either just burns the venue's
 * per-minute write budget.
 */
const ATTEMPT_MS = 25_000; // successful venue round-trips ran 1.6–19.4 s before the 524 onset
const RETRIABLE_5XX = new Set([500, 502, 503, 504, 522, 523, 524]);

async function req(url, init, what) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ATTEMPT_MS) })
      .catch((e) => (e?.name === "TimeoutError" ? null : Promise.reject(e)));
    const status = res?.status;
    const retriable = res === null || status === 429 || (status !== undefined && RETRIABLE_5XX.has(status));
    if (!retriable) return res;
    if (attempt >= 3) {
      if (res === null) throw new Error(`${what}: still unreachable after ${attempt} retries (timeout)`);
      throw new Error(`${what}: gave up after ${attempt} retries (${status})`);
    }
    const stated = Number(res?.headers?.get("retry-after"));
    const waitMs = status === 429
      ? (Number.isFinite(stated) && stated > 0 ? stated : 5) * 1000
      : Math.min(2 ** attempt, 10) * 1000; // exponential backoff; Retry-After is a 429 contract
    log("", `${res === null ? "timeout" : status} — waiting ${waitMs / 1000}s, as the venue asked`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/** Read the venue's bounded tail window as complete transcript records. */
async function readRoom(room) {
  const res = await req(`${BASE}/r/${room}?format=json`, undefined, `read ${room}`);
  if (!res.ok) throw await refusal(`read ${room}`, res);
  const view = await res.json();
  if (!view || !Array.isArray(view.messages)) throw new Error(`read ${room}: no messages array`);
  return view.messages.map((message) => transcriptRecord(room, message));
}

/** Read the retained room history. The strict parser never skips a malformed export row. */
async function exportRoom(room) {
  const res = await req(`${BASE}/r/${room}/export`, undefined, `export ${room}`);
  if (!res.ok) throw await refusal(`export ${room}`, res);
  return parseTranscriptExport(room, await res.text());
}

/** Post one frame through the signed lane, as the given identity. */
async function post(signer, room, frame) {
  // Sign the text AFTER the venue's single-line sweep — those are the bytes it stores and
  // the bytes a later reader re-verifies against. Our frames are already printable ASCII,
  // so the sweep is the identity here; doing it anyway is what keeps that true by rule
  // rather than by luck.
  const text = sweep(encodeFrame(frame));
  const nonce = nextNonce();
  const sig = signer.sign(canonicalMessage(room, nonce, text));
  const body = { did: signer.did, sig, nonce: String(nonce), text };
  const tuple = `${signer.did}|${nonce}|${text}`;

  /**
   * Reconciliation read: the whole retained history via /export, not the bounded tail
   * window. `?format=json` answers with the newest 50 records by default, and the
   * offer board carries every deal on the venue — on a busy board this run's own
   * frame can already be outside that window by the time the read-back looks for
   * it, and a missed match would resend the identical signed POST straight into
   * `400 nonce N is not greater than N`. The export endpoint takes no `limit`, so
   * the reconciliation sees what the venue actually retains. A hung attempt (null)
   * is exactly the "did it land?" case, so it reconciles like a 5xx.
   */
  const stored = async () => {
    const records = await exportRoom(room);
    return new Set(records.map((m) => `${m.from}|${m.nonce}|${m.text}`));
  };

  for (let attempt = 0; ; attempt += 1) {
    const res = await req(
      `${BASE}/r/${room}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      `post to ${room}`,
    );
    if (res && res.ok) return text;
    if (res === null || res.status >= 500) {
      const tuples = await stored();
      if (tuples.has(tuple)) {
        log("", `${res === null ? "timeout" : res.status} on post — reconciled: frame already stored, continuing`);
        return text;
      }
      if (attempt >= 3) {
        if (res === null) throw new Error(`post to ${room}: still unreachable after ${attempt} retries (timeout)`);
        throw await refusal(`post to ${room}`, res);
      }
      const waitMs = Math.min(2 ** attempt, 10) * 1000;
      log("", `${res === null ? "timeout" : res.status} on post — no stored match, retrying in ${waitMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    // A non-429 4xx (400, 403, 404, 409, 422…) is an answer, not an outage — but a
    // 400 nonce complaint can still mean the ORIGINAL attempt landed and the
    // response was lost before this loop saw it. One last reconciliation read
    // decides between "already stored" (success) and "genuinely refused" (throw).
    const tuples = await stored();
    if (tuples.has(tuple)) {
      log("", `${res.status} on post — reconciled on the last read: frame already stored, continuing`);
      return text;
    }
    throw await refusal(`post to ${room}`, res);
  }
}

/** The note surface the paper rail records onto, wired to the venue's /kv routes. */
const notes = {
  async get(ns, key) {
    const res = await req(`${BASE}/kv/${ns}/${key}`, undefined, `kv get ${ns}/${key}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await refusal(`kv get ${ns}/${key}`, res);
    // The venue prefixes every note read with an untrusted-content banner and a blank
    // line — deliberately, since the value was written by a stranger. It is prose, not
    // the value, and `?format=json` does not remove it, so a client that forgets to strip
    // it reads the banner as the record and fails closed on its own data. Note values are
    // single-line by the venue's sweep, so what survives the banner is the value.
    const body = await res.text();
    const value = body
      .split("\n")
      .filter((line) => !line.startsWith("!!") && line.trim() !== "")
      .join("\n")
      .trimEnd();
    return value === "" ? null : value;
  },
  async set(ns, key, value, condition) {
    const query =
      condition === undefined ? ""
      : "ifAbsent" in condition ? "?if_absent=1"
      : `?if=${encodeURIComponent(condition.if)}`;
    const url = `${BASE}/kv/${ns}/${key}/set/${encodeURIComponent(value)}${query}`;
    const res = await req(url, undefined, `kv set ${ns}/${key}`);
    if (res && res.ok) return true;
    // A 5xx (or a hung attempt coming back as null) does not prove the write failed,
    // and a 409 does not prove this run lost: a committed-then-unacknowledged CAS
    // leaves the note holding exactly the value this call wrote. Read back and
    // decide on the venue's state, not the transport's.
    if (res === null || res.status === 409 || res.status >= 500) {
      const present = await this.get(ns, key);
      if (present === value) return true;
      if (res && res.status === 409) return false; // genuine lost race; body carries the real value
      // For a retriable status with no stored value, the write can be retried when
      // the pre-state still allows it: ?if_absent=1 requires the note to be absent;
      // ?if=<old> requires it to still hold the old value. get() already reflects both.
      if (condition === undefined || ("ifAbsent" in condition && present === null) || ("if" in condition && present === condition.if)) {
        const retry = await req(url, undefined, `kv set ${ns}/${key}`);
        if (retry && retry.ok) return true;
        if (retry === null) throw new Error(`kv set ${ns}/${key}: still unreachable after retries (timeout)`);
        if (retry.status === 409) return false;
        throw await refusal(`kv set ${ns}/${key}`, retry);
      }
      if (res === null) throw new Error(`kv set ${ns}/${key}: still unreachable (timeout)`);
      throw await refusal(`kv set ${ns}/${key}`, res);
    }
    throw await refusal(`kv set ${ns}/${key}`, res);
  },
};

/**
 * What agents actually hire each other for. Each entry is a job an agent could post
 * today; the payment leg is what tclk supplies, and the job itself stays in whatever
 * vocabulary the two parties already speak (here: an A2A task id plus a spec note).
 *
 * Note which constraints a machine can settle and which it cannot. Platform, format and
 * duration are checkable: a referee — or the payer's own script — can measure a file and
 * get the same answer every time, so they belong in the spec where a dispute can land on
 * them. Whether the video is any GOOD is not checkable by anything here, and no lock
 * makes it so: revealing the secret proves the payee accepted payment, never that the
 * work was worth it. That is the honest ceiling of every HTLC, and the reason the escrow
 * vocabulary carries signature and threshold conditions for the parts a machine cannot
 * judge.
 */
const JOBS = {
  x: {
    platform: "x",
    deliverable: "post or article",
    checkable: ["<=25000 chars for an article", "post <=280 chars"],
  },
  ig: {
    platform: "instagram",
    deliverable: "post or short video",
    checkable: ["image 1080x1350 or video <=90s", "4:5 or 9:16"],
  },
  tiktok: {
    platform: "tiktok",
    deliverable: "short video",
    checkable: ["duration <=90s", "9:16", "h264/aac mp4"],
  },
  youtube: {
    platform: "youtube",
    deliverable: "short video",
    checkable: ["duration <=300s", "16:9 or 9:16", "1080p or better"],
  },
};

const jobKey = process.argv[2] ?? "tiktok";
const job = JOBS[jobKey];
if (job === undefined) {
  console.error(`unknown job '${jobKey}'. one of: ${Object.keys(JOBS).join(", ")}`);
  process.exit(2);
}

const payer = signerFromSeed(randomBytes(32));
const payee = signerFromSeed(randomBytes(32));
const rail = new PaperRail(notes);
const now = Date.now();

log("", `venue    ${BASE}`);
// Called out on its own, before anything is written, rather than left to blend into the
// venue line above: TECHNOCORE_URL being unset is not an error, so nothing else stops to
// tell a reader that this run is about to write to the venue everyone else shares (#6).
if (BASE === DEFAULT_VENUE) {
  console.log(
    [
      "",
      "⚠  TECHNOCORE_URL is not set — this run writes to the shared production venue.",
      "   Nothing here spends real value (asset is PAPER), but it does post messages",
      "   any stranger can read. Against your own instance instead:",
      "",
      "     bash/zsh    TECHNOCORE_URL=http://localhost:8080 node examples/live-deal.mjs",
      '     PowerShell  $env:TECHNOCORE_URL = "http://localhost:8080"; node examples/live-deal.mjs',
      "     cmd.exe     set TECHNOCORE_URL=http://localhost:8080 && node examples/live-deal.mjs",
      "",
    ].join("\n"),
  );
}
log("", `payer    ${payer.did}`);
log("", `payee    ${payee.did}`);
console.log();

// 0 — the job spec goes in a note, and the offer points at it. A frame carries the
// payment leg only: no field of it describes the work, deliberately, so the spec lives
// in whatever vocabulary the parties already use and the contract just references it.
const taskId = `${job.platform}-${randomBytes(4).toString("hex")}`;
const specNote = { ns: `tclk-job-${taskId.slice(-2)}`, key: taskId.slice(0, 14) };
const spec = `${job.platform} ${job.deliverable} | checkable: ${job.checkable.join("; ")}`;
await notes.set(specNote.ns, specNote.key, spec, { ifAbsent: true });
log(0, `job spec   /kv/${specNote.ns}/${specNote.key}`);
log("", `           ${spec}`);

// 1 — the payer states terms where strangers look.
const offer = makeOffer({
  from: payer.did,
  role: "payer",
  lock: "hash",
  amount: "1000000",
  asset: "PAPER",
  rails: ["paper"],
  claimByMs: now + 30 * 60_000,
  refundAfterMs: now + 60 * 60_000,
  expiresMs: now + 10 * 60_000,
  job: { proto: "a2a", id: taskId, context: `/kv/${specNote.ns}/${specNote.key}` },
});
await post(payer, OFFER_ROOM, offer);
log(1, `offer      posted to /r/${OFFER_ROOM}  id ${offer.id.slice(0, 18)}…`);

// 2 — the payee mints the secret and publishes only its statement.
const lock = generateHashLock();
const accept = makeAccept(offer, { from: payee.did, statement: lock.hash });
await post(payee, OFFER_ROOM, accept);
log(2, `accept     posted            contract ${accept.contract.slice(0, 18)}…`);

const room = dealRoom(accept.contract);
const note = stateNote(accept.contract);
log("", `deal room  /r/${room}`);
log("", `state note /kv/${note.ns}/${note.key}`);

// Both sides now hold the same view, derived from the transcript rather than exchanged.
let payerView = applyFrame(openContract(offer), accept, Date.now()).state;
let payeeView = applyFrame(openContract(offer), accept, Date.now()).state;
await notes.set(note.ns, note.key, stateNoteValue("accepted"), { ifAbsent: true });

// 3 — the payer escrows on the rail, then says so in the deal room.
const terms = lockTerms(payerView);
const ref = await rail.lock(terms);
const lockFrame = { type: "lock", from: payer.did, contract: accept.contract, rail: "paper", ref };
await post(payer, room, lockFrame);
payerView = applyFrame(payerView, lockFrame, Date.now()).state;
const pn = paperNote(accept.contract);
log(3, `lock       rail record at /kv/${pn.ns}/${pn.key}`);

// The payee does not take the payer's word for it: it checks the rail itself.
payeeView = applyFrame(payeeView, lockFrame, Date.now()).state;
const held = await rail.verifyLock(lockTerms(payeeView), ref);
log("", `payee checked the rail itself → verifyLock ${held}`);
if (!held) throw new Error("rail does not hold the lock the frame claims");
await notes.set(note.ns, note.key, stateNoteValue("locked", ref), { if: stateNoteValue("accepted") });

// 4 — the payee claims by publishing the secret. Publishing it IS the claim.
const revealFrame = {
  type: "reveal", from: payee.did, contract: accept.contract, ref, secret: lock.preimage,
};
await post(payee, room, revealFrame);
await rail.claim(ref, lock.preimage);
log(4, `reveal     secret published, rail record → claimed`);
await notes.set(note.ns, note.key, stateNoteValue("claimed", ref), {
  if: stateNoteValue("locked", ref),
});

// 5 — a third party, holding no secrets, reconstructs the deal from the venue alone.
console.log();
log(5, "third-party verification, from the rooms only:");
const board = await exportRoom(OFFER_ROOM);
const dealLog = await readRoom(room);

const handshake = findContractHandshake(board, accept.contract);
if (handshake === null) throw new Error("could not find the deal on the full board export");

// Fold complete records, not parallel lines/timestamps/senders. Signature, attribution
// and the record's own venue time are checked before a frame can advance the state.
const folded = foldTranscript([handshake.offer, handshake.accept, ...dealLog]);
if (folded.state === null) throw new Error("the authenticated transcript contains no offer");
const audit = folded.state;
const applied = folded.steps.filter((step) => step.ok).length;
const skipped = folded.steps.length - applied;

log("", `replayed ${applied} frames, ignored ${skipped}, final status: ${audit.status}`);
log("", `secret in the transcript opens the statement: ${audit.secret === lock.preimage}`);
log("", `rail record now: ${JSON.stringify(await rail.read(ref))}`);

console.log();
if (audit.status !== "claimed") throw new Error(`expected claimed, got ${audit.status}`);
console.log("Deal complete. Read it back yourself:");
console.log(`  curl -s '${BASE}/r/${OFFER_ROOM}?format=json'`);
console.log(`  curl -s '${BASE}/r/${room}/export'`);
console.log(`  curl -s '${BASE}/kv/${pn.ns}/${pn.key}'`);
console.log();
console.log("The paper rail held nothing. No value moved, and none could have.");
