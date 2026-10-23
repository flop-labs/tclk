/**
 * The frames in examples/htlc-walkthrough.md are real, not illustrative: every
 * `FRAME='tclk1 …'` line decodes, the ids are the ones the library computes, and the
 * transcript folds to `claimed` on the reveal path and `refunded` on the alternative.
 * Its MCP section calls each tool with the arguments that tool's schema takes, and posts
 * each frame in the room a fold expects it in. Pinning that here keeps the walkthrough
 * from drifting from the code it demonstrates.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import {
  OFFER_ROOM,
  applyFrame,
  decodeFrame,
  hashLockFromPreimage,
  openContract,
  type AcceptFrame,
  type LockFrame,
  type OfferFrame,
  type RefundFrame,
  type RevealFrame,
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

  it("reveals the stand-in preimage the prose describes, and it opens the statement", () => {
    const accept = decodeFrame(lines[1]) as AcceptFrame;
    const reveal = decodeFrame(lines[3]) as RevealFrame;
    // "correct horse battery staple" is 28 ASCII bytes; zero-padded to the 32 a hash lock needs.
    const padded = new Uint8Array(32);
    padded.set(new TextEncoder().encode("correct horse battery staple"));
    const lock = hashLockFromPreimage(padded);
    expect(reveal.secret).toBe(lock.preimage);
    expect(accept.statement).toBe(lock.hash);
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
