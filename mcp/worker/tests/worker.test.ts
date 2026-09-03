// SPDX-License-Identifier: Apache-2.0
//
// The Worker's `fetch` handler, driven with synthetic `Request`s. No network: the one
// tool that would reach for one gets the suite's `fakeFetch`, and the tools that decide
// not to post never call it at all.

import { describe, expect, it } from "vitest";

import {
  HASH_OFFER, PAYEE_DID, PAYEE_SEED, PAYER_DID, PAYER_SEED, fakeFetch, hexToBytes,
} from "../../tests/fixtures.js";
import { canonicalMessage, signerFromSeed } from "../../src/signing.js";
import { handleRequest, type Env } from "../src/worker.js";
import { TOOLS } from "../src/tool-manifest.generated.js";
import type { FetchLike } from "../../src/technocore.js";

const ENV: Env = { TECHNOCORE_URL: "https://technocore.chat" };
const ROOM = "mb-p-tclk-deadbeefdeadbeef";
const payer = signerFromSeed(hexToBytes(PAYER_SEED));
const payee = signerFromSeed(hexToBytes(PAYEE_SEED));

let nextId = 1;

function rpcRequest(method: string, params?: unknown, id: string | number | null = nextId++): Request {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (id !== null) body.id = id;
  if (params !== undefined) body.params = params;
  return new Request("https://tclk-mcp.example.workers.dev/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rpc(method: string, params?: unknown, fetchImpl?: FetchLike): Promise<any> {
  const response = await handleRequest(rpcRequest(method, params), ENV, fetchImpl);
  return { status: response.status, body: await response.json() };
}

/** Call a tool and parse the JSON its single text content block carries. */
async function callTool(name: string, args: Record<string, unknown>, fetchImpl?: FetchLike) {
  const { body } = await rpc("tools/call", { name, arguments: args }, fetchImpl);
  expect(body.error, `tools/call ${name} answered a JSON-RPC error`).toBeUndefined();
  const text = body.result.content[0].text;
  const isError = body.result.isError === true;
  // A tool error's content is the message, not JSON — same as over stdio.
  return { isError, text, value: isError ? undefined : JSON.parse(text) };
}

describe("handshake", () => {
  it("echoes a protocol version it speaks and advertises tools", async () => {
    const { status, body } = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(status).toBe(200);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo).toEqual({ name: "tclk-mcp", version: "0.1.0" });
    expect(body.result.instructions).toContain("holds no custody");
  });

  it("offers the latest version rather than echoing one it does not speak", async () => {
    const { body } = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });

  it("answers a notification with 202 and no body", async () => {
    const response = await handleRequest(
      rpcRequest("notifications/initialized", {}, null),
      ENV,
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("answers ping", async () => {
    expect((await rpc("ping")).body.result).toEqual({});
  });
});

describe("tools/list", () => {
  it("lists exactly the stdio server's eighteen tools", async () => {
    const { body } = await rpc("tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(TOOLS.map((t) => t.name));
    expect(names).toHaveLength(18);
    expect(names).toContain("tclk_make_offer");
    expect(names).toContain("tclk_accept_offer");
    expect(names).toContain("tclk_post_frame");
    expect(names).toContain("tclk_whoami");
  });

  it("serves input schemas that validate identically to the generated ones", async () => {
    // The Worker corrects prose that would send a caller to an environment variable it
    // refuses to read, so `description` strings are allowed to differ. Everything a
    // client validates arguments against — property names, types, required, enums — must
    // not, or this server would accept or reject arguments the stdio build does not.
    const withoutProse = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(withoutProse);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => key !== "description")
          .map(([key, inner]) => [key, withoutProse(inner)]),
      );
    };

    const { body } = await rpc("tools/list");
    for (const tool of body.result.tools) {
      const generated = TOOLS.find((t) => t.name === tool.name);
      expect(generated, `${tool.name} is not in the manifest`).toBeDefined();
      expect(withoutProse(tool.inputSchema)).toEqual(withoutProse(generated!.inputSchema));
      expect(tool.annotations).toEqual(generated!.annotations);
    }
  });

  it("changes schema prose only where the generated prose names a refused binding", async () => {
    const { body } = await rpc("tools/list");
    for (const tool of body.result.tools) {
      const generated = TOOLS.find((t) => t.name === tool.name)!;
      const served = JSON.stringify(tool.inputSchema);
      if (served !== JSON.stringify(generated.inputSchema)) {
        // The only licensed reason to differ.
        expect(JSON.stringify(generated.inputSchema)).toContain("TCLK_PAYMENT_KEY");
        expect(served).not.toContain("TCLK_PAYMENT_KEY");
      }
    }
  });

  it("amends only the two descriptions the hosted build cannot honour", async () => {
    const { body } = await rpc("tools/list");
    const changed = body.result.tools
      .filter((t: { name: string; description: string }) => {
        const generated = TOOLS.find((g) => g.name === t.name)!;
        return t.description !== generated.description;
      })
      .map((t: { name: string }) => t.name);
    expect(changed.sort()).toEqual(["tclk_adaptor_presign", "tclk_post_frame"]);

    // Neither amended description may tell a caller to set a key this build refuses.
    for (const name of changed) {
      const tool = body.result.tools.find((t: { name: string }) => t.name === name);
      expect(tool.description).not.toContain("TCLK_PAYMENT_KEY");
      expect(tool.description).not.toContain("TECHNOCORE_SIGNING_KEY");
    }
  });
});

describe("tools/call round trip", () => {
  it("builds an offer and decodes the line it produced", async () => {
    const made = await callTool("tclk_make_offer", HASH_OFFER);
    expect(made.isError).toBe(false);
    expect(made.value.line.startsWith("tclk1 ")).toBe(true);
    expect(made.value.frame.type).toBe("offer");

    const decoded = await callTool("tclk_decode", { line: made.value.line });
    expect(decoded.value.ok).toBe(true);
    expect(decoded.value.frame).toEqual(made.value.frame);
    expect(decoded.value.frame.from).toBe(PAYER_DID);
  });

  it("mints a secret in accept_offer and returns it to the caller once", async () => {
    const offer = (await callTool("tclk_make_offer", HASH_OFFER)).value.line;
    const accepted = await callTool("tclk_accept_offer", {
      offer,
      from: PAYEE_DID,
    });
    expect(accepted.value.secret).toMatch(/^0x[0-9a-f]{64}$/);
    expect(accepted.value.contract).toMatch(/^0x[0-9a-f]{64}$/);

    // The secret verifies against the statement, and folding the transcript reports only
    // that a secret exists — never its value.
    const verified = await callTool("tclk_verify_secret", {
      lock: "hash",
      statement: accepted.value.statement,
      secret: accepted.value.secret,
    });
    expect(verified.value.valid).toBe(true);

    const folded = await callTool("tclk_apply_transcript", {
      records: [
        {
          room: "tclk-offers",
          seq: 1,
          timestampMs: HASH_OFFER.expiresMs - 2,
          sender: payer.did,
          nonce: "1001",
          signature: payer.sign(canonicalMessage("tclk-offers", 1001, offer)),
          line: offer,
        },
        {
          room: "tclk-offers",
          seq: 2,
          timestampMs: HASH_OFFER.expiresMs - 1,
          sender: payee.did,
          nonce: "1002",
          signature: payee.sign(canonicalMessage("tclk-offers", 1002, accepted.value.line)),
          line: accepted.value.line,
        },
      ],
    });
    expect(folded.value.status).toBe("accepted");
    expect(folded.value.secretRevealed).toBe(false);
    expect(folded.text).not.toContain(accepted.value.secret);
  });

  it("returns a handler's fail-closed throw as an isError result, not a protocol error", async () => {
    const failed = await callTool("tclk_read_room", { room: "Not A Room" });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("bad room name");
  });
});

describe("no custody", () => {
  it("tclk_post_frame answers with the tier-3 challenge and never reaches the network", async () => {
    const { calls, fetchLike } = fakeFetch([]);
    const line = (await callTool("tclk_make_offer", HASH_OFFER)).value.line;

    const posted = await callTool("tclk_post_frame", { room: ROOM, line }, fetchLike);
    expect(calls).toHaveLength(0);
    expect(posted.value.posted).toBe(false);
    expect(posted.value.reason).toBe("no signing identity");
    expect(posted.value.canonical).toBe(`${ROOM}|${posted.value.nonce}|${line}`);

    // The hint must say tier 2 is structurally unavailable rather than repeat the stdio
    // build's "Or set TECHNOCORE_SIGNING_KEY on this server."
    expect(posted.value.hint).toContain("cannot sign for you");
    expect(posted.value.hint).toContain("no way to be given a key");
    expect(posted.value.hint).toContain("stdio build");
    expect(posted.value.hint).not.toContain("Or set TECHNOCORE_SIGNING_KEY on this server");
  });

  it("tclk_post_frame still passes a caller's own signature through", async () => {
    const { calls, fetchLike } = fakeFetch([{ body: "ok 12" }]);
    const line = (await callTool("tclk_make_offer", HASH_OFFER)).value.line;

    const posted = await callTool(
      "tclk_post_frame",
      { room: ROOM, line, did: PAYER_DID, sig: "x".repeat(86), nonce: 7 },
      fetchLike,
    );
    expect(posted.value.posted).toBe(true);
    expect(posted.value.tier).toBe("caller-signed");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://technocore.chat/r/${ROOM}`);
  });

  it("tclk_adaptor_presign refuses structurally, naming where pre-signing belongs", async () => {
    const refused = await callTool("tclk_adaptor_presign", {
      msg: `0x${"11".repeat(32)}`,
      statement: `0x02${"22".repeat(32)}`,
    });
    expect(refused.isError).toBe(false);
    expect(refused.value.ok).toBe(false);
    expect(refused.value.error).toContain("not available on a hosted server");
    expect(refused.value.hint).toContain("stdio server");
    expect(refused.value.hint).toContain("client-side");
    // Not the stdio build's "set TCLK_PAYMENT_KEY in this server's environment".
    expect(refused.value.hint).not.toContain("set TCLK_PAYMENT_KEY");
    expect(refused.value.hint).toContain("tclk_adaptor_adapt");
  });

  it("the public-input adaptor tools still work", async () => {
    const verified = await callTool("tclk_adaptor_verify", {
      publicKey: `0x02${"22".repeat(32)}`,
      msg: `0x${"11".repeat(32)}`,
      signature: { nonce: `0x02${"33".repeat(32)}`, s: `0x${"44".repeat(32)}` },
    });
    expect(verified.value.kind).toBe("signature");
    expect(verified.value.valid).toBe(false);
  });

  it("tclk_whoami reports no identities at all", async () => {
    const who = await callTool("tclk_whoami", {});
    expect(who.value.did).toBeNull();
    expect(who.value.paymentPublicKey).toBeNull();
    expect(who.value.technocoreUrl).toBe("https://technocore.chat");
  });

  it("refuses to serve when a custody key is bound", async () => {
    for (const name of ["TECHNOCORE_SIGNING_KEY", "TCLK_PAYMENT_KEY"]) {
      const response = await handleRequest(rpcRequest("tools/list"), {
        ...ENV,
        [name]: "deadbeef",
      } as Env);
      expect(response.status).toBe(503);
      expect((await response.json() as { error: string }).error).toContain(name);
    }
  });
});

describe("HTTP and JSON-RPC framing", () => {
  const url = "https://tclk-mcp.example.workers.dev/mcp";

  it("405s a GET, with an Allow header", async () => {
    const response = await handleRequest(new Request(url), ENV);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("405s a DELETE too — there is no session to end", async () => {
    const response = await handleRequest(new Request(url, { method: "DELETE" }), ENV);
    expect(response.status).toBe(405);
  });

  it("404s any other path", async () => {
    const response = await handleRequest(
      new Request("https://tclk-mcp.example.workers.dev/", { method: "POST" }),
      ENV,
    );
    expect(response.status).toBe(404);
  });

  it("415s a body that is not declared JSON", async () => {
    const response = await handleRequest(
      new Request(url, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }),
      ENV,
    );
    expect(response.status).toBe(415);
  });

  it("-32700 on malformed JSON", async () => {
    const response = await handleRequest(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      }),
      ENV,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe(-32700);
    expect(body.id).toBeNull();
  });

  it("-32600 on a non-JSON-RPC object and on a batch", async () => {
    for (const payload of ['{"method":"ping","id":1}', '[{"jsonrpc":"2.0","method":"ping","id":1}]']) {
      const response = await handleRequest(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        }),
        ENV,
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).error.code).toBe(-32600);
    }
  });

  it("-32601 on an unknown method", async () => {
    const { body } = await rpc("resources/list");
    expect(body.error.code).toBe(-32601);
  });

  it("-32602 on an unknown tool, a bad arguments type and a missing required field", async () => {
    expect((await rpc("tools/call", { name: "tclk_nope", arguments: {} })).body.error.code).toBe(-32602);
    expect((await rpc("tools/call", { name: "tclk_decode", arguments: [] })).body.error.code).toBe(-32602);
    expect((await rpc("tools/call", { name: "tclk_decode", arguments: {} })).body.error.code).toBe(-32602);
    // A string field given a number: rejected at the boundary, not coerced.
    const wrongType = await rpc("tools/call", { name: "tclk_decode", arguments: { line: 5 } });
    expect(wrongType.body.error.code).toBe(-32602);
    expect(wrongType.body.error.message).toContain("must be a string");
    // An enum outside its set.
    const badEnum = await rpc("tools/call", {
      name: "tclk_verify_secret",
      arguments: { lock: "sha256", statement: "0x00", secret: "0x00" },
    });
    expect(badEnum.body.error.code).toBe(-32602);
  });

  it("413s an oversized body", async () => {
    const response = await handleRequest(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1_100_000) } }),
      }),
      ENV,
    );
    expect(response.status).toBe(413);
  });
});

describe("no environment variable this build refuses is ever recommended", () => {
  // The two amended tool descriptions are covered above. These cover the level below
  // them: a caller who never reads a description still meets the same advice in the
  // input schema and in the error a fail-closed handler throws. Advice naming
  // TCLK_PAYMENT_KEY is a dead end here — the Worker refuses that binding outright.
  const POINT_KEY = "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

  it("does not advertise TCLK_PAYMENT_KEY in any advertised input schema", async () => {
    const { body } = await rpc("tools/list");
    const schemas = JSON.stringify(body.result.tools.map((tool: any) => tool.inputSchema));
    expect(schemas).not.toContain("TCLK_PAYMENT_KEY");
    // The correction is prose-only: the field itself must still be there, and optional.
    const accept = body.result.tools.find((tool: any) => tool.name === "tclk_accept_offer");
    expect(accept.inputSchema.properties.paymentKey).toBeDefined();
    expect(accept.inputSchema.required ?? []).not.toContain("paymentKey");
  });

  it("tells a point-lock acceptor to pass the key, not to set the env var", async () => {
    const now = Date.now();
    const offer = await callTool("tclk_make_offer", {
      from: PAYER_DID,
      role: "payer",
      lock: "point",
      amount: "100",
      asset: "FLOP",
      rails: ["flop-htlc"],
      claimByMs: now + 3_600_000,
      refundAfterMs: now + 7_200_000,
      expiresMs: now + 600_000,
      paymentKey: POINT_KEY,
    });

    const accept = await callTool("tclk_accept_offer", {
      offer: offer.value.line,
      from: PAYEE_DID,
    });

    expect(accept.isError).toBe(true);
    expect(accept.text).not.toContain("TCLK_PAYMENT_KEY");
    expect(accept.text).toContain("paymentKey");
    expect(accept.text).toContain("holds no payment key");

    // And the field, once supplied, still works — the correction fixed the advice only.
    const ok = await callTool("tclk_accept_offer", {
      offer: offer.value.line,
      from: PAYEE_DID,
      paymentKey: POINT_KEY,
    });
    expect(ok.isError).toBe(false);
    expect(ok.value.contract).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
