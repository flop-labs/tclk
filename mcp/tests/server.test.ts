// SPDX-License-Identifier: Apache-2.0
//
// The MCP wiring, over an in-memory transport: the advertised tool names are the
// contract clients program against, and a tool error must arrive as a readable message
// rather than a dropped connection.

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server.js";
import { HASH_OFFER } from "./fixtures.js";

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    createServer({ env: {} }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("createServer", () => {
  it("advertises exactly the tclk/1 tool set", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "tclk_accept_offer",
      "tclk_adaptor_adapt",
      "tclk_adaptor_extract",
      "tclk_adaptor_presign",
      "tclk_adaptor_verify",
      "tclk_apply_transcript",
      "tclk_decode",
      "tclk_make_cancel",
      "tclk_make_heartbeat",
      "tclk_make_lock",
      "tclk_make_offer",
      "tclk_make_receipt",
      "tclk_make_refund",
      "tclk_make_reveal",
      "tclk_post_frame",
      "tclk_read_room",
      "tclk_verify_secret",
      "tclk_whoami",
    ]);
    await client.close();
  });

  it("returns a tool result for a good call and a readable error for a bad one", async () => {
    const client = await connect();

    const good = await client.callTool({ name: "tclk_make_offer", arguments: HASH_OFFER });
    expect(good.isError).toBeFalsy();
    const built = JSON.parse((good.content as { text: string }[])[0].text);
    expect(built.line.startsWith("tclk1 ")).toBe(true);

    const bad = await client.callTool({
      name: "tclk_make_offer",
      arguments: { ...HASH_OFFER, refundAfterMs: HASH_OFFER.claimByMs - 1 },
    });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0].text).toMatch(/claimByMs must be strictly before/);

    await client.close();
  });

  it("validates tclk_post_frame nonce: accepts safe int or canonical 1-19 digit string, rejects unsafe numbers, malformed and leading-zero strings", async () => {
    const client = await connect();

    // 1. Safe integer is accepted (schema validation passes; error comes from frame validation)
    const safeInt = await client.callTool({
      name: "tclk_post_frame",
      arguments: { room: "lobby", line: "gm", did: "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX", sig: "x".repeat(86), nonce: 7 },
    });
    expect(safeInt.isError).toBe(true);
    expect((safeInt.content as { text: string }[])[0].text).toMatch(/not a tclk\/1 line/);

    // 2. Unsafe number > MAX_SAFE_INTEGER is rejected at schema level
    const unsafeNum = await client.callTool({
      name: "tclk_post_frame",
      arguments: { room: "lobby", line: "gm", did: "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX", sig: "x".repeat(86), nonce: 9007199254740992 },
    });
    expect(unsafeNum.isError).toBe(true);
    expect((unsafeNum.content as { text: string }[])[0].text).toMatch(/Number must be less than or equal to 9007199254740991/);

    // 3. Malformed string (non-decimal) is rejected
    const badStr = await client.callTool({
      name: "tclk_post_frame",
      arguments: { room: "lobby", line: "gm", did: "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX", sig: "x".repeat(86), nonce: "123bad" },
    });
    expect(badStr.isError).toBe(true);
    expect((badStr.content as { text: string }[])[0].text).toMatch(/Invalid arguments/);

    // 4. String exceeding 19 digits is rejected
    const tooLongStr = await client.callTool({
      name: "tclk_post_frame",
      arguments: { room: "lobby", line: "gm", did: "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX", sig: "x".repeat(86), nonce: "12345678901234567890" },
    });
    expect(tooLongStr.isError).toBe(true);
    expect((tooLongStr.content as { text: string }[])[0].text).toMatch(/Invalid arguments/);

    // 5. Valid 19-digit string passes schema validation (fails later on frame decoding)
    const validStr = await client.callTool({
      name: "tclk_post_frame",
      arguments: { room: "lobby", line: "gm", did: "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX", sig: "x".repeat(86), nonce: "1730000000000000001" },
    });
    expect(validStr.isError).toBe(true);
    expect((validStr.content as { text: string }[])[0].text).toMatch(/not a tclk\/1 line/);

    // 6. A leading zero is rejected at the schema: the record it would post is one the
    //    library's own `verifyTranscriptRecord` calls "not canonical decimal".
    const paddedStr = await client.callTool({
      name: "tclk_post_frame",
      arguments: { room: "lobby", line: "gm", did: "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX", sig: "x".repeat(86), nonce: "0000001730000000001" },
    });
    expect(paddedStr.isError).toBe(true);
    expect((paddedStr.content as { text: string }[])[0].text).toMatch(/Invalid arguments/);

    await client.close();
  });
});
