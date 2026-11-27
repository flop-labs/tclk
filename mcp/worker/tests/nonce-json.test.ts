// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { verifyTranscriptRecord } from "@flop-labs/tclk";
import { handleRequest } from "../src/worker.js";
import { fakeFetch } from "../../tests/fixtures.js";
import { NONCE, ROOM, responseBody } from "../../../tests/nonce-fixture.js";

describe.each([false, true])("Worker tools/call read, full=%s", (full) => {
  async function call(token = NONCE, key = "no\\u006ece") {
    const { calls, fetchLike } = fakeFetch([{ body: responseBody(full, key, token) }]);
    const response = await handleRequest(new Request("https://worker.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "tclk_read_room", arguments: { room: ROOM, full } },
      }),
    }), { TECHNOCORE_URL: "https://venue.example" }, fetchLike);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://venue.example/r/${ROOM}${full ? "/export" : "?format=json"}`);
    expect(calls[0].init?.method).toBe("GET");
    return await response.json() as any;
  }

  it("preserves and verifies an escaped-key nonce through JSON-RPC", async () => {
    const body = await call();
    expect(body.error).toBeUndefined();
    expect(body.result.isError).not.toBe(true);
    const value = JSON.parse(body.result.content[0].text);
    expect(value.records).toHaveLength(1);
    expect(value.records[0].nonce).toBe(NONCE);
    expect(verifyTranscriptRecord(value.records[0]).ok).toBe(true);
    expect(verifyTranscriptRecord({ ...value.records[0], line: "tampered" }).ok).toBe(false);
  });

  it.each(["01", "\u00a01"])("returns a tool error for malformed JSON %s", async (token) => {
    const body = await call(token, "nonce");
    expect(body.result.isError).toBe(true);
  });
});
