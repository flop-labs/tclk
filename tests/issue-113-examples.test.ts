// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, makeOffer, offerId, pointLockFromWitness, transcriptRecord } from "../src/index.js";
import { inspectBoard } from "../examples/inspect-board.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const from = "did:key:z6Mk" + "f".repeat(44);
const offer = makeOffer({
  from, role: "payer", lock: "hash", amount: "1", asset: "FLOP", rails: ["paper"],
  nonce: "11223344", expiresMs: 1000, claimByMs: 2000, refundAfterMs: 3000,
});

const row = (text: string, seq = 1) => JSON.stringify({
  text, seq, ts: "2026-09-05T00:00:00Z", from,
  // Transport nonces can exceed Number.MAX_SAFE_INTEGER.
  nonce: "9007199254740993",
});

describe("issue #113 executable examples", () => {
  it.each(["claimed", "refunded"])("runs the signed PTLC rehearsal to %s", (outcome) => {
    const output = execFileSync(process.execPath, ["examples/ptlc-walkthrough.mjs", outcome], {
      cwd: root, encoding: "utf8",
    });
    const frames = output.split("\n").filter((line) => line.startsWith("tclk1 ")).map(decodeFrame);
    expect(frames.map((frame) => frame.type)).toEqual([
      "offer", "accept", "lock", outcome === "claimed" ? "reveal" : "refund", "receipt",
    ]);
    expect(frames[0]).toMatchObject({ lock: "point", rails: ["paper"], asset: "PAPER" });
    expect(output).toContain("common rail: paper (untrusted routing hint)");
    expect(output).toContain("Rejected wrong claim message, wrong witness, and early refund.");
    expect(output).toContain(`fold → ${outcome}; optional receipt acknowledged it. No value moved.`);
    expect(output).toContain("UNAUDITED full-Schnorr, not BIP-340");
    if (outcome === "refunded") expect(output).not.toContain('"secret":');
  });

  it("counts decoder-accepted frames separately from dialects and malformed envelopes", () => {
    const report = inspectBoard([
      row(encodeFrame(offer), 10),
      ...["settle", "confirm"].map((type) => row(`tclk1 ${JSON.stringify({ type })}`)),
      row(`tclk1 ${JSON.stringify({ ...offer, method: "pay" })}`),
      row(`tclk1 ${JSON.stringify({ type: "lock", from, contract: offer.id, rail: "paper" })}`),
      row("ordinary chat"), "not json", JSON.stringify({ text: "missing metadata" }),
    ].join("\n"), "retained-export");
    expect(report.counts).toEqual({ rows: 8, malformedRows: 2, nonFrames: 1, prefixed: 5, rejected: 4, decoded: 1 });
    expect(report.rejectedClaimedTypes).toEqual({ confirm: 1, lock: 1, offer: 1, settle: 1 });
    expect(report.offerAssets).toEqual({ FLOP: 1 });
    expect(report.offeredRails).toEqual({ paper: 1 });
    expect(report.seqRange).toEqual([1, 10]);
    expect(report.validation).toContain("NOT verified");
  });

  it("reports raw aliases and canonical rail sets without rewriting historical frame ids", () => {
    const { id: _id, ...fields } = offer;
    const legacy = { ...fields, rails: ["paperrail", "paper-rail", "paper", "x402", "custom"] };
    const line = `tclk1 ${JSON.stringify({ ...legacy, id: offerId(legacy) })}`;
    const report = inspectBoard(row(line), "recording");
    expect(report.offerFrames).toBe(1);
    expect(report.offeredRails).toEqual({ paper: 1, "unregistered:custom": 1, x402: 1 });
    expect(report.rawOfferedRails).toEqual({ paperrail: 1, "paper-rail": 1, paper: 1, x402: 1, custom: 1 });
    expect(decodeFrame(line)).toMatchObject({ rails: legacy.rails, id: offerId(legacy) });
  });

  it("reports point offers and lock announcements without treating receipts as completion", () => {
    const { id: _id, type: _type, ...fields } = offer;
    const point = makeOffer({ ...fields, lock: "point", paymentKey: pointLockFromWitness("0x" + "11".repeat(32)).statement });
    const report = inspectBoard([
      row(encodeFrame(point)),
      row(encodeFrame({ type: "lock", from, contract: offer.id, rail: "paper", ref: "demo" })),
      row(encodeFrame({ type: "receipt", from, contract: offer.id, outcome: "claimed" })),
    ].join("\n"), "window");
    expect(report.offerLockKinds).toEqual({ point: 1 });
    expect(report.announcedLockRails).toEqual({ paper: 1 });
    expect(report.frameTypes.receipt).toBe(1);
    expect(report.interpretation).toContain("not completed-deal counts");
    expect(report).not.toHaveProperty("completedContracts");
  });

  it("labels empty captures, requires scope, and never echoes rejected secret values", () => {
    expect(inspectBoard("", "window")).toMatchObject({ offerFrames: 0, seqRange: null, timeRange: null });
    expect(() => inspectBoard("", "all-time")).toThrow(/scope/);
    const secret = "must-not-echo";
    const report = inspectBoard(row(`tclk1 ${JSON.stringify({ type: "reveal", secret })}`), "window");
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.rejectedClaimedTypes).toEqual({ reveal: 1 });
  });
});

describe("board capture timestamps", () => {
  const message = (ts: unknown) => ({ seq: 1, ts, text: encodeFrame(offer), from });

  it.each([
    "2026-09-05T12:00:00",
    "2026-09-05",
    "09/05/2026 12:00:00",
    "2026-09-05T12:00:00+0300",
    "2026-13-05T12:00:00Z",
    "2026-09-32T12:00:00Z",
    "2026-09-05T24:00:00Z",
    "2026-09-05T12:00:60Z",
    "2026-09-05T12:00:00+24:00",
    "1969-12-31T23:59:59Z",
    "not a timestamp", "", null, 1_800_000_000_000,
  ])("excludes invalid or ambiguous timestamp %j", (ts) => {
    expect(() => transcriptRecord("tclk-offers", message(ts))).toThrow(/timestamp/);
    const report = inspectBoard(JSON.stringify(message(ts)), "recording");
    expect(report.counts).toMatchObject({ rows: 1, malformedRows: 1, decoded: 0 });
    expect(report.timeRange).toBeNull();
    expect(report.seqRange).toBeNull();
  });

  it.each([
    "2026-09-05T12:00:00.125Z",
    "2026-09-05T15:00:00.125+03:00",
    "2026-09-05T06:30:00.125-05:30",
  ])("reports the same UTC instant for %s", (ts) => {
    const record = transcriptRecord("tclk-offers", message(ts));
    const report = inspectBoard(JSON.stringify(message(ts)), "retained-export");
    expect(record.timestampMs).toBe(Date.parse("2026-09-05T12:00:00.125Z"));
    expect(report.counts).toMatchObject({ malformedRows: 0, decoded: 1 });
    expect(report.timeRange).toEqual(["2026-09-05T12:00:00.125Z", "2026-09-05T12:00:00.125Z"]);
  });

  it("orders bounds by instant and excludes rejected timestamps from a mixed capture", () => {
    const report = inspectBoard([
      "2026-09-05T12:00:00Z",
      "2026-09-05T15:00:00+03:00",
      "2026-09-05T11:30:00-01:00",
      "2026-09-05T11:45:00Z",
      "2020-01-01T00:00:00",
    ].map((ts) => JSON.stringify(message(ts))).join("\n"), "recording");
    expect(report.counts).toMatchObject({ rows: 5, malformedRows: 1, decoded: 4 });
    expect(report.timeRange).toEqual(["2026-09-05T11:45:00.000Z", "2026-09-05T12:30:00.000Z"]);
  });

  it("produces identical reports in different reader timezones", () => {
    const input = [
      "2026-09-05T12:00:00", "2026-09-05T12:00:00Z", "2026-09-05T15:00:00+03:00",
    ].map((ts) => JSON.stringify(message(ts))).join("\n");
    const code = `
      import { readFileSync } from 'node:fs';
      import { inspectBoard } from './examples/inspect-board.mjs';
      console.log(JSON.stringify(inspectBoard(readFileSync(0, 'utf8'), 'recording')));
    `;
    const reports = ["UTC", "America/New_York"].map((TZ) => JSON.parse(execFileSync(
      process.execPath, ["--input-type=module", "-e", code],
      { cwd: root, env: { ...process.env, TZ }, input, encoding: "utf8" },
    )));
    expect(reports[0]).toEqual(reports[1]);
    expect(reports[0].counts).toMatchObject({ malformedRows: 1, decoded: 2 });
  });
});
