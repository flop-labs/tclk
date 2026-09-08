// SPDX-License-Identifier: Apache-2.0
// Room reads must return a cursor the next `since` read can consume.
// Injected responses only: no network, signing, or settlement.
import { describe, expect, it } from "vitest";
import { createHandlers } from "../src/tools.js";
import { fakeFetch } from "./fixtures.js";

describe("room window cursor", () => {
  it.each([undefined, null, "12", -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unusable last_seq (%s) at the response boundary",
    async (lastSeq) => {
      const { fetchLike } = fakeFetch([{
        body: "",
        json: { room: "lobby", count: 0, messages: [], last_seq: lastSeq },
      }]);
      const h = createHandlers({ env: {}, fetch: fetchLike });
      await expect(h.tclk_read_room({ room: "lobby" })).rejects.toThrow(/invalid last_seq/);
    },
  );

  it.each([0, 12, Number.MAX_SAFE_INTEGER])(
    "preserves a valid empty-window cursor (%s) for the next read",
    async (lastSeq) => {
      const view = { room: "lobby", count: 0, messages: [], last_seq: lastSeq };
      const { calls, fetchLike } = fakeFetch([
        { body: "", json: view }, { body: "", json: view },
      ]);
      const h = createHandlers({ env: {}, fetch: fetchLike });
      const result = await h.tclk_read_room({ room: "lobby" });
      expect(result.lastSeq).toBe(lastSeq);
      await h.tclk_read_room({ room: "lobby", since: result.lastSeq });
      expect(calls[1].url).toBe(`https://technocore.chat/r/lobby?format=json&since=${lastSeq}`);
    },
  );
});
