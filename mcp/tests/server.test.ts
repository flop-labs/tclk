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
});
