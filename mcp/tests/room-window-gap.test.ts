// SPDX-License-Identifier: Apache-2.0
// A cursor read must never masquerade as contiguous when Technocore says its
// bounded tail skipped records after the caller's last seen seq.
import { describe, expect, it } from "vitest";

import { createClient } from "../src/technocore.js";
import { fakeFetch } from "./fixtures.js";

function message(seq: number) {
  return {
    seq,
    ts: "2026-09-28T00:00:00Z",
    from: "probe",
    text: "hello",
  };
}

describe("room window gaps", () => {
  it("rejects a since window whose first_seq proves records were skipped", async () => {
    const { fetchLike } = fakeFetch([{
      body: "",
      json: {
        room: "busy",
        count: 50,
        first_seq: 151,
        last_seq: 200,
        messages: [message(151), message(200)],
      },
    }]);
    const client = createClient({ fetch: fetchLike });

    await expect(client.readRoom("busy", 100)).rejects.toThrow(
      /missed room records.*since=100.*first_seq=151.*full:true.*complete export/,
    );
  });

  it("keeps a contiguous since window readable", async () => {
    const view = {
      room: "busy",
      count: 2,
      first_seq: 101,
      last_seq: 102,
      messages: [message(101), message(102)],
    };
    const { fetchLike } = fakeFetch([{ body: "", json: view }]);
    const client = createClient({ fetch: fetchLike });

    await expect(client.readRoom("busy", 100)).resolves.toEqual(view);
  });
});
