#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// A point-lock deal, from capability matching to a signed claim or refund.
// UNAUDITED reference cryptography: full-Schnorr, random nonces, NOT BIP-340.
// PaperRail holds no value. MemoryNoteStore keeps the rehearsal offline.
// Build both packages first: pnpm -r --include-workspace-root build
//   node examples/ptlc-walkthrough.mjs [claimed|refunded]

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  OFFER_ROOM, MemoryNoteStore, PaperRail, applyFrame, capabilityToken, dealRoom,
  decodeFrame, encodeFrame, foldTranscript, generatePointLock, lockTerms,
  makeAccept, makeOffer, matchingRails, openContract, parseCapabilityToken,
  schnorrAdaptor, verifyPointWitness,
} from "../dist/index.js";
import { canonicalMessage, signerFromSeed } from "../mcp/dist/signing.js";

export async function runWalkthrough(outcome = "claimed", log = console.log) {
  assert(["claimed", "refunded"].includes(outcome), "outcome must be claimed or refunded");
  log("Offline rehearsal: paper holds no value. UNAUDITED full-Schnorr, not BIP-340.");
  const payer = signerFromSeed(randomBytes(32));
  const payee = signerFromSeed(randomBytes(32));
  const payerSecret = generatePointLock().witness;
  const payerKey = schnorrAdaptor.getPublicKey(payerSecret);
  const payeeKey = schnorrAdaptor.getPublicKey(generatePointLock().witness);
  assert(payerKey && payeeKey, "payment key generation failed");
  let now = 1_800_000_000_000; // fixed clock for the offline rehearsal
  const rail = new PaperRail(new MemoryNoteStore(), () => now);

  // Capability notes are routing hints. The signed terms and rail still need verification.
  const payerNote = `offline payer ${capabilityToken(["PaperRail"])}`;
  const payeeNote = `offline payee ${capabilityToken(["memory", "paper-rail"])}`;
  const payerRails = parseCapabilityToken(payerNote);
  const payeeRails = parseCapabilityToken(payeeNote);
  assert(payerRails && payeeRails, "missing or malformed capability token");
  const common = matchingRails(payerRails, payeeRails);
  assert(common.includes(rail.id), "no supported rehearsal rail in common");
  log(`${payerNote}\n${payeeNote}\ncommon rail: ${rail.id} (untrusted routing hint)`);

  const records = [];
  const sequences = new Map();
  function record(frame, signer) {
    const line = encodeFrame(frame);
    assert.deepEqual(decodeFrame(line), frame);
    const room = frame.type === "offer" || frame.type === "accept"
      ? OFFER_ROOM : dealRoom(frame.contract);
    const seq = (sequences.get(room) ?? 0) + 1;
    sequences.set(room, seq);
    const nonce = String(records.length + 1);
    records.push({
      room, seq, timestampMs: now, sender: signer.did, nonce,
      signature: signer.sign(canonicalMessage(room, nonce, line)), line,
    });
    log(line);
  }

  const offer = makeOffer({
    from: payer.did, role: "payer", lock: "point", paymentKey: payerKey,
    amount: "1000", asset: "PAPER", rails: [rail.id],
    expiresMs: now + 60_000, claimByMs: now + 120_000, refundAfterMs: now + 180_000,
    job: { proto: "a2a", id: "offline-point-rehearsal" },
  });
  record(offer, payer);
  let state = openContract(offer);
  function advance(frame, signer) {
    const step = applyFrame(state, frame, now);
    assert(step.ok, step.reason);
    state = step.state;
    record(frame, signer);
  }

  // The payee holds y; only Y and the payment key enter the acceptance.
  const { witness, statement } = generatePointLock();
  const accept = makeAccept(offer, { from: payee.did, statement, paymentKey: payeeKey });
  advance(accept, payee);
  const terms = lockTerms(state);
  const ref = await rail.lock(terms);

  // PaperRail claims with the witness. Use a local message for the adaptor cycle;
  // a rail that settles by signature supplies its own claim message.
  const claimMessage = new TextEncoder().encode(`offline PTLC claim|${accept.contract}|${ref}`);
  const pre = schnorrAdaptor.preSign(payerSecret, claimMessage, statement);
  assert(pre, "pre-signing failed");
  advance({ type: "lock", from: payer.did, contract: accept.contract, rail: rail.id, ref, presig: pre }, payer);
  assert(await rail.verifyLock(terms, ref), "rail lock did not verify");
  // applyFrame cannot check this: the rail claim message is not in the room frame.
  assert(schnorrAdaptor.verifyPreSignature(payerKey, claimMessage, statement, pre));
  assert.equal(schnorrAdaptor.verifyPreSignature(
    payerKey, new TextEncoder().encode("wrong claim message"), statement, pre,
  ), false);

  const wrongWitness = generatePointLock().witness;
  assert.notEqual(wrongWitness, witness);
  const wrongReveal = applyFrame(state, {
    type: "reveal", from: payee.did, contract: accept.contract, ref, secret: wrongWitness,
  }, now);
  assert.equal(wrongReveal.ok, false);
  assert.equal(wrongReveal.state, state);
  await assert.rejects(rail.claim(ref, wrongWitness), /secret does not open/);
  await assert.rejects(rail.refund(ref), /refund before/);
  log("Rejected wrong claim message, wrong witness, and early refund.");

  if (outcome === "claimed") {
    const signature = schnorrAdaptor.adapt(pre, witness);
    assert(signature, "adaptation failed");
    assert(schnorrAdaptor.verifySignature(payerKey, claimMessage, signature));
    const extracted = schnorrAdaptor.extractWitness(pre, signature);
    assert(extracted && verifyPointWitness(statement, extracted), "extraction did not open Y");
    assert.equal(extracted, witness);
    await rail.claim(ref, extracted);
    advance({ type: "reveal", from: payee.did, contract: accept.contract, ref, secret: extracted }, payee);
    await assert.rejects(rail.refund(ref), /on a claimed record/);
  } else {
    // Without a revealed witness, the payer can refund once the deadline passes.
    now = offer.refundAfterMs;
    await rail.refund(ref);
    advance({ type: "refund", from: payer.did, contract: accept.contract, ref }, payer);
    await assert.rejects(rail.claim(ref, witness), /on a refunded record/);
  }

  const beforeReceipt = foldTranscript(records);
  assert.equal(beforeReceipt.state?.status, outcome); // completion does not require a receipt
  assert(beforeReceipt.steps.every((step) => step.ok));
  advance({ type: "receipt", from: payee.did, contract: accept.contract, outcome, rail: rail.id, ref }, payee);
  const folded = foldTranscript(records);
  assert(folded.steps.every((step) => step.ok), "signed transcript did not verify");
  assert.equal(folded.state?.status, outcome);
  assert.equal((await rail.read(ref))?.status, outcome);
  log(`fold → ${outcome}; optional receipt acknowledged it. No value moved.`);
  return { records, outcome, beforeReceipt: beforeReceipt.state.status, railStatus: (await rail.read(ref)).status };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runWalkthrough(process.argv[2]);
}
