// SPDX-License-Identifier: Apache-2.0
//
// The two transport tools, against an injected `fetch`. Nothing here touches a network.

import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";

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

  it("surfaces the venue's refusal instead of swallowing it", async () => {
    const { fetchLike } = fakeFetch([{ status: 403, body: "403 bad sig\n" }]);
    const h = createHandlers({ env: { TECHNOCORE_SIGNING_KEY: PAYER_SEED }, fetch: fetchLike });
    await expect(h.tclk_post_frame({ room: ROOM, line: offerLine() })).rejects.toThrow(
      /failed with 403: 403 bad sig/,
    );
  });
});

describe("tclk_read_room", () => {
  it("returns decodable frames and counts what it skipped", async () => {
    const line = offerLine();
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
            { seq: 11, ts: "2026-01-01T00:00:01Z", from: signer.did, text: line },
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
    expect(result.skipped).toBe(3);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({ seq: 11, from: signer.did });
    expect(result.frames[0].frame.type).toBe("offer");
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
