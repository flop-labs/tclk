// SPDX-License-Identifier: Apache-2.0
// Native fetch against disposable loopback endpoints: no live venue is contacted.

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createClient } from "../src/technocore.js";
import { createHandlers } from "../src/tools.js";
import { HASH_OFFER } from "./fixtures.js";

const servers: Server[] = [];
const post = { did: "transport-test", sig: "transport-test", nonce: "7", text: "test frame" };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function venue(status: number, targetBody = "ok 7") {
  const calls: { method: string; url: string; body: string }[] = [];
  const stored: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      calls.push({ method: request.method!, url: request.url!, body });
      if (request.method === "POST") stored.push(body);
      if (request.url!.startsWith("/r/") && status >= 300 && status < 400) {
        response.writeHead(status, { location: "/target" });
        response.end("redirected\n");
      } else {
        response.writeHead(request.url === "/target" ? 200 : status);
        response.end(targetBody);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { baseUrl, client: createClient({ baseUrl }), calls, stored };
}

describe("signed-write redirects", () => {
  it.each([301, 302, 303, 307, 308])("rejects HTTP %i without following or retrying", async (status) => {
    const { client, calls } = await venue(status);
    await expect(client.postSigned("test", post)).rejects.toThrow(`failed with ${status}`);
    expect(calls).toEqual([{ method: "POST", url: "/r/test", body: JSON.stringify(post) }]);
  });

  it("keeps a direct successful POST response and body", async () => {
    const { client, calls } = await venue(201);
    await expect(client.postSigned("test", post)).resolves.toBe("ok 7");
    expect(calls).toEqual([{ method: "POST", url: "/r/test", body: JSON.stringify(post) }]);
  });

  it("does not report a redirected tool write as confirmed even if the origin stored it", async () => {
    const { baseUrl, calls, stored } = await venue(302);
    const handlers = createHandlers({ env: { TECHNOCORE_URL: baseUrl } });
    const line = handlers.tclk_make_offer(HASH_OFFER).line;
    await expect(handlers.tclk_post_frame({ room: "test", line, did: post.did, sig: post.sig, nonce: post.nonce }))
      .rejects.toThrow("failed with 302");
    // An error cannot prove that the first endpoint did not accept the write.
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]).text).toBe(line);
    expect(calls).toHaveLength(1);
  });
});

describe("ordinary read redirects", () => {
  it("still follows a room read redirect", async () => {
    const view = { room: "test", count: 0, last_seq: 0, messages: [] };
    const { client, calls } = await venue(302, JSON.stringify(view));
    await expect(client.readRoom("test", 7)).resolves.toEqual(view);
    expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "/r/test?format=json&since=7" },
      { method: "GET", url: "/target" },
    ]);
  });

  it("still follows an export redirect", async () => {
    const row = { seq: 1, ts: "2026-10-10T00:00:00Z", from: "~test", text: "hello" };
    const { client, calls } = await venue(302, JSON.stringify(row) + "\n");
    const records = await client.exportRoom("test");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ room: "test", seq: 1, line: "hello" });
    expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "/r/test/export" },
      { method: "GET", url: "/target" },
    ]);
  });
});
