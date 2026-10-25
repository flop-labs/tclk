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
        messages: Array.from({ length: 50 }, (_, i) => message(151 + i)),
      },
    }]);
    const client = createClient({ fetch: fetchLike });

    await expect(client.readRoom("busy", 100)).rejects.toThrow(
      /missed room records.*since=100.*first_seq=151.*full:true.*complete export/,
    );
  });

  it("treats a server-shaped empty window as unknown, not proof of continuity", async () => {
    // Technocore read_messages returns count=0, first_seq=null and
    // last_seq=min(since, head_seq) when every newer on-disk record expired.
    // The same envelope can mean there were simply no newer messages.
    // Without an advertised retained floor/head we cannot distinguish them.
    const view = {
      room: "busy",
      count: 0,
      first_seq: null,
      last_seq: 100,
      messages: [],
    };
    const { fetchLike } = fakeFetch([{ body: "", json: view }]);
    const client = createClient({ fetch: fetchLike });

    await expect(client.readRoom("busy", 100)).resolves.toEqual(view);
  });

  it("keeps a genuinely empty room readable with the same venue shape", async () => {
    const view = {
      room: "quiet",
      count: 0,
      first_seq: null,
      last_seq: 0,
      messages: [],
    };
    const { fetchLike } = fakeFetch([{ body: "", json: view }]);
    const client = createClient({ fetch: fetchLike });

    await expect(client.readRoom("quiet", 0)).resolves.toEqual(view);
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
