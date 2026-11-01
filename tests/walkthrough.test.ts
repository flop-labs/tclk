/**
 * The frames in examples/htlc-walkthrough.md are real, not illustrative: every
 * `FRAME='tclk1 …'` line decodes, the ids are the ones the library computes, and the
 * transcript folds to `claimed` on the reveal path and `refunded` on the alternative.
 * Each `from` is a real Ed25519 did:key (multicodec prefix 0xed 0x01, a point on the
 * curve), and the same lines fold as the signed technocore records those keys made, the
 * way a reader of the rooms checks them.
 * Its MCP section calls each tool with the arguments that tool's schema takes, and posts
 * each frame in the room a fold expects it in. Pinning that here keeps the walkthrough
 * from drifting from the code it demonstrates.
 */

import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { describe, it, expect } from "vitest";

import {
  OFFER_ROOM,
  applyFrame,
  dealRoom,
  decodeFrame,
  foldTranscript,
  hashLockFromPreimage,
  openContract,
  type AcceptFrame,
  type LockFrame,
  type OfferFrame,
  type RefundFrame,
  type RevealFrame,
  type TranscriptRecord,
} from "../src/index.js";
// The tool catalogue exactly as an MCP client is served it, generated from mcp/src/server.ts;
// mcp/worker/tests/manifest.test.ts fails if the two drift.
import { TOOLS } from "../mcp/worker/src/tool-manifest.generated.js";

const WALKTHROUGH = new URL("../examples/htlc-walkthrough.md", import.meta.url);
const markdown = readFileSync(WALKTHROUGH, "utf8");
const lines = [...markdown.matchAll(/^FRAME='(tclk1 [^']*)'$/gm)].map((m) => m[1]);

// The MCP section writes each call as `tool` `{…}`, with `<…>` for a value the reader fills
// in. Only argument names are checked, so a bare placeholder (a number) and the elided
// `[...]` get stand-ins; a quoted placeholder is already a JSON string.
const mcpCalls = [...markdown.matchAll(/`(tclk_[a-z_]+)`\s+`(\{[^`]*\})`/g)].map((m) => {
  const json = m[2].replace(/:<[^<>"]*>/g, ":0").replace(/\[\.\.\.\]/g, "[]");
  return { tool: m[1], text: m[2], args: JSON.parse(json) as Record<string, unknown> };
});
// In this walkthrough an inline `{…}` span is only ever a tool's arguments, so the spans are
// also collected on their own, without the tool name in front: a call whose `tool` `{json}`
// shape an edit breaks (a comma or a word between the two) then fails the test below instead
// of dropping out of the schema and room checks unnoticed.
const argumentSpans = [...markdown.matchAll(/`(\{[^`]*\})`/g)].map((m) => m[1]);

// The two parties: Ed25519 key pairs made for the walkthrough. Their private keys were
// discarded after signing the records below, so nobody can sign as either DID again.
const PAYER = "did:key:z6Mkms1BZpFLeJhsCm9FhtSFCs1JKy6gXhknjNbBA2J7FpLR";
const PAYEE = "did:key:z6MkivQpJ5k1SM5Y6D9WaD2CnxK9seKJKAwu1mmRozfvanKq";

/**
 * The Ed25519 public key behind a did:key, or a throw naming the check that failed. The
 * frame regex only sees 56 characters of the right alphabet; a signed lane needs
 * `did:key:z` + base58btc(0xed 0x01 || public key), and the key has to be a curve point.
 */
function ed25519KeyOf(did: string): Uint8Array {
  const encoded = did.startsWith("did:key:z") ? did.slice("did:key:z".length) : "";
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(encoded)) throw new Error("not a base58btc did:key");
  const tagged = base58.decode(encoded);
  if (tagged.length !== 34) throw new Error(`multicodec key is ${tagged.length} bytes, not 34`);
  if (tagged[0] !== 0xed || tagged[1] !== 0x01) {
    const prefix = [tagged[0], tagged[1]].map((b) => `0x${b.toString(16).padStart(2, "0")}`);
    throw new Error(`multicodec prefix is ${prefix.join(" ")}, not 0xed 0x01`);
  }
  const key = tagged.slice(2);
  let point: ReturnType<typeof ed25519.Point.fromBytes>;
  try {
    point = ed25519.Point.fromBytes(key);
  } catch {
    throw new Error("public key is not a point on the curve");
  }
  if (point.isSmallOrder()) throw new Error("public key is a small-order point");
  return key;
}

// Each frame as its sender signed it over `<room>|<nonce>|<line>` before the keys were
// discarded, with nonce = seq: offer and accept on the board, the rest in the deal room.
const SIGNED = {
  offer: { seq: 1, signature: "6ljVq4VO5i2gtcyoIVTe3sibo1BJLQ8lb4qehes5mE6-8c51fGDi1x3clIqN5q1lbHJnSk2hOo-huFf_8m--Cw" },
  accept: { seq: 2, signature: "Clp1cRQ3J63UsFYoeZKGSKhwIQiZus7khued7EZF9S6l0tLaes_2uZI53KPaMS6ZfN92ljCVLtIGITMJLQnABg" },
  lock: { seq: 3, signature: "3NgZkiV274meLSBzbXsQ7DRyPuwZN8ZTkyCI4h6h2AR__e-r8_wwUWqnymRrC6MojNiYpHxPlNqYh6cvzd5nDQ" },
  reveal: { seq: 4, signature: "7zI8CQIfBlwNDBKJZRhYxBpNqWnBka08KwMlYbELn8mpS8rY_lt_S6rv1b8cN8xCHH4LhpRDHBjgkQirETkkBg" },
  refund: { seq: 5, signature: "LgPmfTC5z8iE6Cdne9b4TJ4pf1O1q2hKCdJuK5oiAzqVgsa2jwReT_K50ptrhvrM9NeTvUGDC5ROvj_7dDaOCg" },
};

describe("examples/htlc-walkthrough.md", () => {
  it("carries five frames that all decode, in walkthrough order", () => {
    expect(lines.map((line) => decodeFrame(line).type)).toEqual([
      "offer", "accept", "lock", "reveal", "refund",
    ]);
  });

  it("folds to claimed on the reveal path and to refunded on the refund path", () => {
    const [offerLine, acceptLine, lockLine, revealLine, refundLine] = lines;
    const offer = decodeFrame(offerLine) as OfferFrame;

    const accepted = applyFrame(openContract(offer), decodeFrame(acceptLine), offer.expiresMs - 1);
    expect(accepted.ok).toBe(true);
    const locked = applyFrame(accepted.state, decodeFrame(lockLine), offer.expiresMs);
    expect(locked.ok).toBe(true);
    expect(locked.state.status).toBe("locked");
    // reveal/refund name the same rail reference the lock announced (SPEC §3: ref must equal lock.ref).
    const lockRef = (decodeFrame(lockLine) as LockFrame).ref;
    expect((decodeFrame(revealLine) as RevealFrame).ref).toBe(lockRef);
    expect((decodeFrame(refundLine) as RefundFrame).ref).toBe(lockRef);

    const claimed = applyFrame(locked.state, decodeFrame(revealLine), offer.refundAfterMs - 1);
    expect(claimed.ok).toBe(true);
    expect(claimed.state.status).toBe("claimed");

    const refunded = applyFrame(locked.state, decodeFrame(refundLine), offer.refundAfterMs);
    expect(refunded.ok).toBe(true);
    expect(refunded.state.status).toBe("refunded");
  });

  it("is sent by two real Ed25519 did:keys: prefix 0xed 0x01 and a point on the curve", () => {
    const senders = lines.map((line) => decodeFrame(line).from);
    for (const did of senders) expect(ed25519KeyOf(did)).toHaveLength(32);
    expect(senders).toEqual([PAYER, PAYEE, PAYER, PAYEE, PAYER]);
  });

  it("refuses the earlier placeholder DIDs, each for the check it fails", () => {
    // Until this example was regenerated: `l` is not base58, and 37 characters follow the `z`.
    expect(() => ed25519KeyOf("did:key:z6MkPayerExampleDid1111111111111111111")).toThrow(
      "not a base58btc did:key",
    );
    // A placeholder that passes the frame regex (56 characters, base58) has the wrong prefix.
    expect(() => ed25519KeyOf("did:key:z6MkPayer111111111111111111111111111111111111111")).toThrow(
      "multicodec prefix is 0xed 0x00, not 0xed 0x01",
    );
    // The right prefix in front of those same 32 bytes: still not a key, as they are off the curve.
    expect(() => ed25519KeyOf("did:key:z6MkgpJ2Lnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFH")).toThrow(
      "public key is not a point on the curve",
    );
  });

  it("folds as signed records, offer and accept on the board and the rest in the deal room", () => {
    const [offerLine, acceptLine, lockLine, revealLine, refundLine] = lines;
    const offer = decodeFrame(offerLine) as OfferFrame;
    const room = dealRoom((decodeFrame(acceptLine) as AcceptFrame).contract);
    // Each side posted its own frames; the fold checks the signature against the sender's
    // did:key and the frame's `from` against the sender. timestamp is venue metadata.
    const record = (
      signed: { seq: number; signature: string }, inRoom: string, timestampMs: number,
      sender: string, line: string,
    ): TranscriptRecord => ({
      room: inRoom, seq: signed.seq, timestampMs, sender, nonce: String(signed.seq),
      signature: signed.signature, line,
    });
    const opening = [
      record(SIGNED.offer, OFFER_ROOM, offer.expiresMs - 60_000, PAYER, offerLine),
      record(SIGNED.accept, OFFER_ROOM, offer.expiresMs - 1, PAYEE, acceptLine),
      record(SIGNED.lock, room, offer.expiresMs, PAYER, lockLine),
    ];

    const claimed = foldTranscript([
      ...opening, record(SIGNED.reveal, room, offer.refundAfterMs - 1, PAYEE, revealLine),
    ]);
    expect(claimed.steps.filter((step) => !step.ok)).toEqual([]);
    expect(claimed.state?.status).toBe("claimed");

    const refunded = foldTranscript([
      ...opening, record(SIGNED.refund, room, offer.refundAfterMs, PAYER, refundLine),
    ]);
    expect(refunded.steps.filter((step) => !step.ok)).toEqual([]);
    expect(refunded.state?.status).toBe("refunded");
  });

  it("reveals the preimage the accept's statement commits to, as the prose recomputes it", () => {
    const accept = decodeFrame(lines[1]) as AcceptFrame;
    const reveal = decodeFrame(lines[3]) as RevealFrame;
    expect(hashLockFromPreimage(reveal.secret).hash).toBe(accept.statement);
    // The note under step 2 names this statement and hashes exactly these 32 bytes.
    const { statement } = accept;
    expect(markdown).toContain(`\`${statement.slice(0, 6)}…${statement.slice(-4)}\` is the sha256`);
    expect(markdown).toContain(`bytes.fromhex("${reveal.secret.slice(2)}")`);
  });

  it("parses every argument object in the walkthrough as a tool call", () => {
    expect(
      mcpCalls.map((call) => call.text),
      "an inline `{…}` span that was not parsed as `tool` `{json}`",
    ).toEqual(argumentSpans);
  });

  it("calls every MCP tool with exactly the arguments its schema takes", () => {
    expect(mcpCalls.map((call) => call.tool)).toEqual(
      expect.arrayContaining([
        "tclk_make_offer", "tclk_post_frame", "tclk_read_room", "tclk_accept_offer",
        "tclk_make_lock", "tclk_make_reveal", "tclk_apply_transcript",
      ]),
    );
    for (const { tool, args } of mcpCalls) {
      const schema = TOOLS.find((t) => t.name === tool)?.inputSchema as
        | { properties?: Record<string, unknown>; required?: string[] }
        | undefined;
      expect(schema, `${tool} is not a tclk-mcp tool`).toBeDefined();
      const given = Object.keys(args);
      const known = Object.keys(schema?.properties ?? {});
      expect(given.filter((name) => !known.includes(name)), `${tool}: unknown arguments`).toEqual([]);
      expect(
        (schema?.required ?? []).filter((name) => !given.includes(name)),
        `${tool}: missing required arguments`,
      ).toEqual([]);
    }
  });

  it("posts offer and accept to the offer board and the rest to the deal room (SPEC §2)", () => {
    const roomFor: Record<string, string> = {
      "<offer line>": OFFER_ROOM,
      "<accept line>": OFFER_ROOM,
      "<lock line>": "<deal room>",
      "<reveal line>": "<deal room>",
    };
    const posts = mcpCalls.filter((call) => call.tool === "tclk_post_frame").map((call) => call.args);
    expect(new Set(posts.map((post) => post.line))).toEqual(new Set(Object.keys(roomFor)));
    for (const post of posts) {
      expect(post.room, `room for ${String(post.line)}`).toBe(roomFor[String(post.line)]);
    }
  });
});
