// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { verifyTranscriptRecord } from "@flop-labs/tclk";
import { createHandlers } from "../src/tools.js";
import { NONCE, ROOM, TEXT, responseBody } from "../../tests/nonce-fixture.js";
import { fakeFetch } from "./fixtures.js";

describe.each([false, true])("MCP read, full=%s", (full) => {
  it.each(["nonce", "no\\u006ece", "\\u006eonce"])("retains signed nonce for %s", async (key) => {
    const { calls, fetchLike } = fakeFetch([{ body: responseBody(full, key) }]);
    const result = await createHandlers({ env: {}, fetch: fetchLike }).tclk_read_room({ room: ROOM, full });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://technocore.chat/r/${ROOM}${full ? "/export" : "?format=json"}`);
    expect(calls[0].init?.method).toBe("GET");
    expect(result.records).toHaveLength(1);
    const record = result.records[0];
    expect(record.nonce).toBe(NONCE);
    expect(record.line).toBe(TEXT);
    expect(verifyTranscriptRecord(record).ok).toBe(true);
    expect(verifyTranscriptRecord({ ...record, line: TEXT + "x" }).ok).toBe(false);
  });

  it.each(["01", "\u00a01"])("rejects invalid JSON token %s", async (token) => {
    const { fetchLike } = fakeFetch([{ body: responseBody(full, "nonce", token) }]);
    await expect(createHandlers({ env: {}, fetch: fetchLike })
      .tclk_read_room({ room: ROOM, full })).rejects.toThrow();
  });

  it.each(["1e3", "1.0", "-0"])("leaves noncanonical nonce %s for the verifier to reject", async (token) => {
    const { fetchLike } = fakeFetch([{ body: responseBody(full, "nonce", token) }]);
    const result = await createHandlers({ env: {}, fetch: fetchLike }).tclk_read_room({ room: ROOM, full });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].nonce).toBe(token);
    expect(verifyTranscriptRecord(result.records[0])).toEqual({
      ok: false, reason: "record nonce is not canonical decimal",
    });
  });
});
