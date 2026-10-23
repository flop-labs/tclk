// SPDX-License-Identifier: Apache-2.0
//
// The two transport tools, against an injected `fetch`. Nothing here touches a network.

import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";

import { transcriptRecord, verifyTranscriptRecord } from "@flop-labs/tclk";

import { canonicalMessage, signerFromSeed } from "../src/signing.js";
import { createHandlers } from "../src/tools.js";
import { HASH_OFFER, PAYER_SEED, fakeFetch, hexToBytes } from "./fixtures.js";

const ROOM = "mb-p-tclk-deadbeefdeadbeef";
const signer = signerFromSeed(hexToBytes(PAYER_SEED));

function offerLine(): string {
  return createHandlers({ env: {} }).tclk_make_offer(HASH_OFFER).line;
}

describe("tclk_post_frame — tier 3, no identity", () => {
  it("answers with the signing challenge rather than an empty failure", async () => {
    const { calls, fetchLike } = fakeFetch([]);
    const h = createHandlers({ env: {}, fetch: fetchLike });
    const line = offerLine();

    const result = await h.tclk_post_frame({ room: ROOM, line });
    if (result.posted) throw new Error("expected the no-identity challenge");

    expect(calls).toHaveLength(0);
    expect(result.reason).toBe("no signing identity");
    expect(result.room).toBe(ROOM);
    expect(result.text).toBe(line);
    expect(result.canonical).toBe(`${ROOM}|${result.nonce}|${line}`);
    expect(result.canonical).toBe(canonicalMessage(ROOM, result.nonce, line));
    expect(result.hint).toContain("TECHNOCORE_SIGNING_KEY");
  });

  it("refuses a partially supplied signature triple, and a line that is not a frame", async () => {
    const h = createHandlers({ env: {} });
    await expect(h.tclk_post_frame({ room: ROOM, line: offerLine(), did: signer.did })).rejects.toThrow(
      /all three of `did`, `sig` and `nonce`/,
    );
    await expect(h.tclk_post_frame({ room: ROOM, line: "gm" })).rejects.toThrow(/not a tclk\/1 line/);
  });
});

describe("tclk_post_frame — tier 2, server-signed", () => {
  it("posts the line verbatim, signed over `<room>|<nonce>|<text>`", async () => {
    const { calls, fetchLike } = fakeFetch([{ body: "ok 12" }]);
    const h = createHandlers({ env: { TECHNOCORE_SIGNING_KEY: PAYER_SEED }, fetch: fetchLike });
    const line = offerLine();

    const result = await h.tclk_post_frame({ room: ROOM, line });
    expect(result.posted).toBe(true);
    expect(result.posted && result.tier).toBe("server-signed");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://technocore.chat/r/${ROOM}`);
    expect(calls[0].init?.method).toBe("POST");

    const body = JSON.parse(String(calls[0].init?.body));
    expect(Object.keys(body).sort()).toEqual(["did", "nonce", "sig", "text"]);
    // The text posted IS the frame line — no re-encoding, or the signature would not
    // cover the bytes the venue stores.
    expect(body.text).toBe(line);
    expect(body.did).toBe(signer.did);
    expect(typeof body.nonce).toBe("string");

    const canonical = canonicalMessage(ROOM, Number(body.nonce), line);
    expect(
      ed25519.verify(
        new Uint8Array(Buffer.from(body.sig, "base64url")),
        new TextEncoder().encode(canonical),
        ed25519.getPublicKey(hexToBytes(PAYER_SEED)),
      ),
    ).toBe(true);
  });

  it("passes a caller's own did/sig/nonce straight through", async () => {
    const { calls, fetchLike } = fakeFetch([{ body: "ok 13" }]);
    const h = createHandlers({ env: {}, fetch: fetchLike });
    const line = offerLine();

    const result = await h.tclk_post_frame({
      room: ROOM,
      line,
      did: signer.did,
      sig: signer.sign(canonicalMessage(ROOM, 7, line)),
      nonce: 7,
    });
    expect(result.posted && result.tier).toBe("caller-signed");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ did: signer.did, nonce: "7", text: line });
  });

  it("passes a caller's legal 19-digit string nonce straight through without precision loss", async () => {
    const { calls, fetchLike } = fakeFetch([{ body: "ok 14" }]);
    const h = createHandlers({ env: {}, fetch: fetchLike });
    const line = offerLine();
    const nonce19 = "1730000000000000001";

    const result = await h.tclk_post_frame({
      room: ROOM,
      line,
      did: signer.did,
      sig: signer.sign(canonicalMessage(ROOM, nonce19, line)),
      nonce: nonce19,
    });
    expect(result.posted && result.tier).toBe("caller-signed");
    if (result.posted && result.tier === "caller-signed") {
      expect(result.nonce).toBe(nonce19);
    }
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.nonce).toBe(nonce19);
    // Prove no numeric precision loss occurred
    expect(String(Number(nonce19))).not.toBe(nonce19);
    expect(body.nonce).not.toBe(String(Number(nonce19)));
  });

  it("refuses a nonce spelling the library's own fold would reject", async () => {
    const { calls, fetchLike } = fakeFetch([{ body: "ok 15" }]);
    const h = createHandlers({ env: {}, fetch: fetchLike });
    const line = offerLine();
    // Canonical decimal is the whole rule: `verifyTranscriptRecord` accepts
    // /^(?:0|[1-9][0-9]*)$/ and nothing else, and `postSigned` sends the string through
    // verbatim. Posting `0000001730000000001` put a record on the board that this same
    // package then refuses to fold, and the frame cannot be taken back.
    const padded = "0000001730000000001";
    await expect(
      h.tclk_post_frame({
        room: ROOM,
        line,
        did: signer.did,
        sig: signer.sign(canonicalMessage(ROOM, padded, line)),
        nonce: padded,
      }),
    ).rejects.toThrow(/no leading zero/);
    expect(calls).toHaveLength(0);

    // The reason it must be refused, stated as the round trip it breaks.
    const record = transcriptRecord(ROOM, {
      seq: 1,
      ts: "2026-09-04T00:00:00Z",
      from: signer.did,
      nonce: padded,
      sig: signer.sign(canonicalMessage(ROOM, padded, line)),
      text: line,
    });
    expect(verifyTranscriptRecord(record)).toMatchObject({
      ok: false,
      reason: "record nonce is not canonical decimal",
    });

    // `0` itself is canonical and still accepted.
    const zero = fakeFetch([{ body: "ok 16" }]);
    const h0 = createHandlers({ env: {}, fetch: zero.fetchLike });
    const posted = await h0.tclk_post_frame({
      room: ROOM,
      line,
      did: signer.did,
      sig: signer.sign(canonicalMessage(ROOM, "0", line)),
      nonce: "0",
    });
    expect(posted.posted && posted.tier).toBe("caller-signed");
    expect(JSON.parse(String(zero.calls[0].init?.body)).nonce).toBe("0");
  });

  it("rejects an unsafe numeric nonce or malformed string in the shared handler", async () => {
    const { fetchLike } = fakeFetch([{ body: "ok 14" }]);
    const h = createHandlers({ env: {}, fetch: fetchLike });
    const line = offerLine();

    await expect(h.tclk_post_frame({
      room: ROOM,
      line,
      did: signer.did,
      sig: "x".repeat(86),
      nonce: 9007199254740992,
    })).rejects.toThrow(/must be a non-negative safe integer or 1-19 decimal digits with no leading zero/);

    await expect(h.tclk_post_frame({
      room: ROOM,
      line,
      did: signer.did,
      sig: "x".repeat(86),
      nonce: "123bad",
    })).rejects.toThrow(/must be a non-negative safe integer or 1-19 decimal digits with no leading zero/);
  });

  it("surfaces the venue's refusal instead of swallowing it", async () => {
    const { fetchLike } = fakeFetch([{ status: 403, body: "403 bad sig\n" }]);
    const h = createHandlers({ env: { TECHNOCORE_SIGNING_KEY: PAYER_SEED }, fetch: fetchLike });
    await expect(h.tclk_post_frame({ room: ROOM, line: offerLine() })).rejects.toThrow(
      /failed with 403: 403 bad sig/,
    );
  });
});

describe("tclk_read_room", () => {
  it("returns complete records without dropping unsigned or malformed frame lines", async () => {
    const line = offerLine();
    const nonce = 11;
    const { calls, fetchLike } = fakeFetch([
      {
        body: "",
        json: {
          room: "lobby",
          count: 4,
          first_seq: 10,
          last_seq: 13,
          messages: [
            { seq: 10, ts: "2026-01-01T00:00:00Z", from: "~stranger", text: "gm" },
            {
              seq: 11,
              ts: "2026-01-01T00:00:01Z",
              from: signer.did,
              nonce: String(nonce),
              sig: signer.sign(canonicalMessage("lobby", nonce, line)),
              text: line,
            },
            { seq: 12, ts: "2026-01-01T00:00:02Z", from: "~spoofer", text: 'tclk1 {"type":"offer"}' },
            { seq: 13, ts: "2026-01-01T00:00:03Z", from: "~stranger", text: "tclk1 not-json" },
          ],
        },
      },
    ]);
    const h = createHandlers({ env: {}, fetch: fetchLike });

    const result = await h.tclk_read_room({ room: "lobby", since: 9 });
    expect(calls[0].url).toBe("https://technocore.chat/r/lobby?format=json&since=9");
    expect(result.lastSeq).toBe(13);
    expect(result.source).toBe("window");
    expect(result.records).toHaveLength(4);
    expect(result.records[1]).toMatchObject({
      room: "lobby",
      seq: 11,
      sender: signer.did,
      nonce: "11",
      line,
    });
    expect(result.records[0]).toMatchObject({ signature: null, nonce: null, line: "gm" });

    expect(() => h.tclk_apply_transcript({ records: result.records })).toThrow(
      /offer must be posted in tclk-offers/,
    );
  });

  it("isolates a malformed envelope instead of failing the whole window read", async () => {
    const line = offerLine();
    const nonce = 11;
    const good = signer.sign(canonicalMessage("lobby", nonce, line));
    const { fetchLike } = fakeFetch([
      {
        body: "",
        json: {
          room: "lobby",
          count: 4,
          last_seq: 33,
          messages: [
            { seq: 30, ts: "2026-01-01T00:00:00Z", from: "~stranger", text: "gm" },
            // Hostile envelope: `nonce` is a JSON boolean, which transcriptRecord refuses.
            // Before the fix this one message threw and took the entire read down with it.
            { seq: 31, ts: "2026-01-01T00:00:01Z", from: "~attacker", nonce: true, text: "tclk1 x" },
            { seq: 32, ts: "2026-01-01T00:00:02Z", from: signer.did, nonce: String(nonce), sig: good, text: line },
            // A second bad shape: `from` is not a string.
            { seq: 33, ts: "2026-01-01T00:00:03Z", from: 12345, text: "gm" },
          ],
        },
      },
    ]);
    const h = createHandlers({ env: {}, fetch: fetchLike });

    const result = await h.tclk_read_room({ room: "lobby" });
    // The two well-formed envelopes survive; the two hostile ones are set aside, not dropped.
    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.seq)).toEqual([30, 32]);
    expect(result.malformed).toHaveLength(2);
    expect(result.malformed.map((m) => m.seq)).toEqual([31, 33]);
    expect(result.malformed[0].reason).toMatch(/nonce/);
    // lastSeq still reflects the venue's own count, so `since` paging is unbroken.
    expect(result.lastSeq).toBe(33);

    // The surviving signed record is intact: it carries the sender and signature the
    // venue verified, ready to hand to a fold.
    expect(result.records[1]).toMatchObject({ seq: 32, sender: signer.did, signature: good });
  });

  it("keeps the export's opposite rule: one bad row refuses the whole file", async () => {
    // Pins the asymmetry rather than leaving it to a comment. An export claims to be the
    // complete history, so it may not answer with a hole; a window may, because it says
    // which seq it could not read. If either side is ever changed, this fails.
    const good = JSON.stringify({ seq: 1, ts: "2026-01-01T00:00:00Z", from: "~a", text: "gm" });
    const bad = JSON.stringify({ seq: 2, ts: "2026-01-01T00:00:01Z", from: "~b", nonce: true, text: "gm" });
    const { fetchLike } = fakeFetch([{ body: `${good}\n${bad}\n` }]);
    const h = createHandlers({ env: {}, fetch: fetchLike });
    await expect(h.tclk_read_room({ room: "lobby", full: true })).rejects.toThrow(/line 2/);
  });

  it("records a malformed envelope with no usable seq as null", async () => {
    const { fetchLike } = fakeFetch([
      {
        body: "",
        json: {
          room: "lobby",
          count: 1,
          last_seq: 40,
          messages: [{ seq: "not-a-number", ts: "2026-01-01T00:00:00Z", from: "~x", text: "gm" }],
        },
      },
    ]);
    const h = createHandlers({ env: {}, fetch: fetchLike });
    const result = await h.tclk_read_room({ room: "lobby" });
    expect(result.records).toHaveLength(0);
    expect(result.malformed).toEqual([{ seq: null, reason: expect.stringMatching(/seq/) }]);
  });

  it("reads and strictly parses the full JSONL export", async () => {
    const line = offerLine();
    const nonce = 17;
    const exported = JSON.stringify({
      seq: 17,
      ts: "2026-01-01T00:00:01Z",
      from: signer.did,
      nonce: String(nonce),
      sig: signer.sign(canonicalMessage("tclk-offers", nonce, line)),
      text: line,
    });
    const { calls, fetchLike } = fakeFetch([{ body: `${exported}\n` }]);
    const h = createHandlers({ env: {}, fetch: fetchLike });

    const result = await h.tclk_read_room({ room: "tclk-offers", full: true });
    expect(calls[0].url).toBe("https://technocore.chat/r/tclk-offers/export");
    expect(result.source).toBe("export");
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ seq: 17, sender: signer.did, line });
    await expect(
      h.tclk_read_room({ room: "tclk-offers", full: true, since: 3 }),
    ).rejects.toThrow(/cannot be combined/);
  });

  it("refuses a bad room name before it reaches the wire", async () => {
    const { calls, fetchLike } = fakeFetch([]);
    const h = createHandlers({ env: {}, fetch: fetchLike });
    await expect(h.tclk_read_room({ room: "Lobby!" })).rejects.toThrow(/bad room name/);
    expect(calls).toHaveLength(0);
  });
});

describe("tclk_whoami", () => {
  it("reports public identities and never the seeds behind them", () => {
    const env = {
      TECHNOCORE_SIGNING_KEY: PAYER_SEED,
      TCLK_PAYMENT_KEY: "1111111111111111111111111111111111111111111111111111111111111111",
      TECHNOCORE_URL: "https://technocore.chat/",
    };
    const result = createHandlers({ env }).tclk_whoami();

    expect(result.did).toBe(signer.did);
    expect(result.paymentPublicKey).toMatch(/^0x[0-9a-f]{66}$/);
    expect(result.technocoreUrl).toBe("https://technocore.chat/");
    expect(result.notes).toEqual([]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(env.TECHNOCORE_SIGNING_KEY);
    expect(serialized).not.toContain(env.TCLK_PAYMENT_KEY);
  });

  it("says which key is missing instead of inventing an identity", () => {
    const result = createHandlers({ env: {} }).tclk_whoami();
    expect(result.did).toBeNull();
    expect(result.paymentPublicKey).toBeNull();
    expect(result.notes).toEqual([
      expect.stringContaining("TECHNOCORE_SIGNING_KEY"),
      expect.stringContaining("TCLK_PAYMENT_KEY"),
    ]);
  });
});
