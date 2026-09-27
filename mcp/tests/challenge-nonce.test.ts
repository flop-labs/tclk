// SPDX-License-Identifier: Apache-2.0
// All keys below are published test vectors; the venue is an in-memory double.
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createHandlers, type PostFrameInput } from "../src/tools.js";
import { createServer } from "../src/server.js";
import { signerFromSeed } from "../src/signing.js";
import { HASH_OFFER, PAYER_SEED, fakeFetch, hexToBytes } from "./fixtures.js";

const room = "tclk-offers";
const line = createHandlers({ env: {} }).tclk_make_offer(HASH_OFFER).line;
const floor = 1789031965581931047n; // Replay floor in issue #184.
const selected = "1789031965581931048";
const signer = signerFromSeed(hexToBytes(PAYER_SEED));

describe("caller-selected challenge nonce", () => {
  it("signs and posts a 19-digit challenge above the venue floor without rounding", async () => {
    let requests = 0;
    const h = createHandlers({ env: {}, fetch: async (_url, init) => {
      requests++;
      const post = JSON.parse(String(init?.body));
      expect(post.nonce).toBe(selected);
      const canonical = `${room}|${post.nonce}|${post.text}`;
      const valid = ed25519.verify(
        new Uint8Array(Buffer.from(post.sig, "base64url")),
        new TextEncoder().encode(canonical),
        ed25519.getPublicKey(hexToBytes(PAYER_SEED)),
      );
      return new Response("venue result", { status: valid && BigInt(post.nonce) > floor ? 200 : 403 });
    } });
    // The cast also lets this regression execute against the unmodified API.
    const challenge = await h.tclk_post_frame({ room, line, challengeNonce: selected } as PostFrameInput);
    expect(requests).toBe(0);
    expect(challenge.posted).toBe(false);
    if (challenge.posted) throw new Error("expected a challenge");
    expect(challenge.nonce).toBe(selected);
    expect(challenge.canonical).toBe(`${room}|${selected}|${line}`);
    const posted = await h.tclk_post_frame({
      room, line, did: signer.did, sig: signer.sign(challenge.canonical), nonce: challenge.nonce,
    });
    expect(posted.posted).toBe(true);
    expect(requests).toBe(1);
  });

  it.each(["0", "1", "9999999999999999999"])("keeps the exact canonical boundary %s", async (nonce) => {
    const { calls, fetchLike } = fakeFetch([]);
    const h = createHandlers({ env: {}, fetch: fetchLike });
    const result = await h.tclk_post_frame({ room, line, challengeNonce: nonce } as PostFrameInput);
    expect(result.nonce).toBe(nonce);
    expect(calls).toHaveLength(0);
  });

  it.each(["", "00", "01", "-1", "+1", "1.0", "1e3", " 1", "1\n", "1\r", "１", "10000000000000000000", 7, null])(
    "refuses a malformed challenge nonce %j before any network call", async (nonce) => {
      const { calls, fetchLike } = fakeFetch([]);
      const h = createHandlers({ env: {}, fetch: fetchLike });
      await expect(h.tclk_post_frame({ room, line, challengeNonce: nonce } as unknown as PostFrameInput))
        .rejects.toThrow(/challengeNonce/);
      expect(calls).toHaveLength(0);
    },
  );

  it("does not sign or post when a challenge-only request has a configured key", async () => {
    const { calls, fetchLike } = fakeFetch([{ body: "ok" }]);
    const h = createHandlers({ env: { TECHNOCORE_SIGNING_KEY: PAYER_SEED }, fetch: fetchLike });
    await expect(h.tclk_post_frame({ room, line, challengeNonce: selected } as PostFrameInput))
      .rejects.toThrow(/challengeNonce.*no signing identity/);
    expect(calls).toHaveLength(0);
  });

  it.each([{ did: signer.did }, { sig: "x".repeat(86) }, { nonce: 7 }, { did: signer.did, sig: "x".repeat(86), nonce: 7 }])(
    "refuses mixing a challenge nonce with supplied signature fields %j", async (fields) => {
      const { calls, fetchLike } = fakeFetch([{ body: "ok" }]);
      const h = createHandlers({ env: {}, fetch: fetchLike });
      await expect(h.tclk_post_frame({ room, line, ...fields, challengeNonce: selected } as PostFrameInput))
        .rejects.toThrow(/challengeNonce/);
      expect(calls).toHaveLength(0);
    },
  );

  it("leaves the default generator independent of caller-selected high values", async () => {
    const h = createHandlers({ env: {}, fetch: fakeFetch([]).fetchLike });
    const before = await h.tclk_post_frame({ room, line });
    await h.tclk_post_frame({ room, line, challengeNonce: "9999999999999999999" } as PostFrameInput);
    const after = await h.tclk_post_frame({ room, line });
    expect(typeof after.nonce).toBe("number");
    expect(after.nonce).toBeGreaterThan(before.nonce);
    expect(BigInt(after.nonce)).toBeLessThan(floor);
    if (after.posted) throw new Error("expected a challenge");
    expect(after.hint).toMatch(/replay floor/);
    expect(after.hint).toMatch(/challengeNonce/);
  });

  it("accepts the new field through MCP without schema stripping", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "challenge-test", version: "0.0.0" });
    const { calls, fetchLike } = fakeFetch([]);
    const server = createServer({ env: {}, fetch: fetchLike });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      expect(tools.tools.find(t => t.name === "tclk_post_frame")?.inputSchema.properties)
        .toHaveProperty("challengeNonce");
      const result = await client.callTool({ name: "tclk_post_frame", arguments: { room, line, challengeNonce: selected } });
      expect(result.isError).toBeFalsy();
      const body = JSON.parse((result.content as { text: string }[])[0].text);
      expect(body.nonce).toBe(selected);
      expect(body.canonical).toBe(`${room}|${selected}|${line}`);
      const invalid = await client.callTool({ name: "tclk_post_frame", arguments: { room, line, challengeNonce: "01" } });
      expect(invalid.isError).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
