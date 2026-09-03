// SPDX-License-Identifier: Apache-2.0
//
// tclk-mcp as a remote MCP server on Cloudflare Workers: stateless streamable HTTP at
// `POST /mcp`. The tools are `mcp/src/tools.ts`'s, unmodified — this file is the platform
// adapter, and everything it adds is either a consequence of serving many callers instead
// of one, or a consequence of the Workers runtime.
//
// ── Why the JSON-RPC layer is here rather than the SDK's ─────────────────────────────
//
// `@modelcontextprotocol/sdk` 1.30 does ship a Workers-capable transport
// (`WebStandardStreamableHTTPServerTransport` — Web `Request`/`Response`, no `node:`
// builtins anywhere in its import closure; that part was checked, not assumed). It was
// still the wrong fit here, for three reasons that are all about this deployment rather
// than about the SDK:
//
//   * It is a *session* transport. In stateless mode it refuses to serve a second
//     request — "Stateless transport cannot be reused across requests" — so a Worker must
//     build a transport *and* connect a fresh `McpServer` per request, which is the
//     expensive half of the SDK on the hot path of every single call.
//   * Its GET is an open SSE stream. On an edge runtime that is a request held open for
//     nothing: this server pushes no unsolicited notifications, so the stream would only
//     ever carry keep-alive comments until something times out.
//   * The two tools this deployment must answer differently (see below) are decided
//     inside the registered handlers, and a transport gives no seam in front of them.
//     Reaching in to rewrite a result after the fact is the kind of fix that passes a
//     test and lies to a client.
//
// So the protocol layer is written out here — `initialize`, `tools/list`, `tools/call`,
// notifications, and the JSON-RPC error codes — and it is small because this server has
// no sessions, no subscriptions, no resources and no prompts to carry.
//
// What is deliberately NOT written out here is the tool catalogue.
// `./tool-manifest.generated.ts` is produced from `mcp/src/server.ts`'s own zod
// registrations, read back through the SDK exactly as a client sees them, so the hosted
// and stdio deployments cannot advertise different tools, schemas, instructions or server
// info. `tests/manifest.test.ts` fails if the checked-in copy has drifted.
//
// ── Why this deployment holds no keys ────────────────────────────────────────────────
//
// The stdio server reads `TECHNOCORE_SIGNING_KEY` and `TCLK_PAYMENT_KEY` from its
// environment because it runs beside one agent, on that agent's own machine: the key is
// the operator's, and so is every call that uses it. A hosted Worker serving many callers
// is a different object. A signing key in `wrangler secret` would sign whatever anyone
// who found the URL asked it to sign, under one identity nobody there controls; a payment
// key would let the operator complete adaptor signatures on other people's deals. Neither
// is a configuration mistake to warn about — they are things this build must not be able
// to do. So the Worker never accepts, reads or binds either name, `TclkEnv` is
// constructed by naming `TECHNOCORE_URL` and nothing else, and a binding that carries
// either key makes the Worker refuse to serve at all rather than quietly ignore it.
//
// Two tools therefore behave differently here, and say so rather than failing blankly:
//
//   * `tclk_post_frame` keeps tier 1 (you supply `did`+`sig`+`nonce`, it passes through)
//     and tier 3 (no identity: the reply IS the signing challenge). Tier 2 — the server
//     signing on your behalf — is structurally unavailable, and the tier-3 hint says so
//     instead of telling you to set an env var this build will not read.
//   * `tclk_adaptor_presign` needs a private payment key by definition, so it answers
//     with a structured error naming where pre-signing belongs instead of the stdio
//     build's "no payment key: set TCLK_PAYMENT_KEY".
//
// `tclk_accept_offer` still MINTS a secret, and that is fine: the secret is returned to
// the caller in the same reply that mints it and is never stored. What keeps it fine is
// that this file logs NOTHING about a request — no tool name, no arguments, no result, no
// error text. See the catch at the end of `handleRequest` for where that would otherwise be
// tempting: a `tclk_decode` failure can quote the line it was given, and a reveal line
// contains a preimage. Everything else — the frame builders, decode, apply_transcript,
// verify_secret, the adaptor adapt/extract/verify wrappers, read_room, whoami — runs here
// exactly as it does over stdio.
//
// ── Runtime notes ────────────────────────────────────────────────────────────────────
//
// No `nodejs_compat`: the library and the tool handlers are builtin-free, and the one
// `process.env` in `mcp/src/tools.ts` sits behind a `??` that never evaluates because an
// `env` object is always passed. Outbound HTTP is the platform `fetch`, which is what
// `createClient` already defaults to. Nothing is held between requests: a Worker's next
// request may land in a different isolate, and there is no state here that would notice.

import { createHandlers, type TclkEnv } from "../../src/tools.js";
import type { FetchLike } from "../../src/technocore.js";
import {
  INSTRUCTIONS,
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  SERVER_INFO,
  TOOLS,
  type ManifestTool,
} from "./tool-manifest.generated.js";

/**
 * The Worker's bindings. `TECHNOCORE_URL` is the only one, and the only one that may
 * ever be added: see the module note above and `assertNoCustody`.
 */
export interface Env {
  TECHNOCORE_URL?: string;
}

/** The MCP endpoint path. Anything else is a 404. */
const MCP_PATH = "/mcp";

/**
 * 1 MiB. Frame lines are short and a transcript is a few hundred of them; a body past
 * this is a mistake or an attack, and reading it to find out is the cost either way.
 */
const MAX_BODY_BYTES = 1_048_576;

/** The two bindings this deployment must not have. Named, not pattern-matched. */
const CUSTODY_BINDINGS = ["TECHNOCORE_SIGNING_KEY", "TCLK_PAYMENT_KEY"] as const;

// ── JSON-RPC 2.0 ─────────────────────────────────────────────────────────────────────

type JsonRpcId = string | number | null;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A JSON-RPC error, always with an `id` — `null` when the request was too broken to have
 * one, which is what the spec asks for and what a client needs to stop waiting.
 */
function rpcError(id: JsonRpcId, code: number, message: string, status = 200): Response {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

// ── The tool surface ─────────────────────────────────────────────────────────────────

/**
 * The catalogue, with two descriptions amended.
 *
 * Names, input schemas and annotations are the generated ones, untouched — a client that
 * validates arguments against this server sees exactly what it would see over stdio. Only
 * the prose changes, and only where the generated prose would tell a caller to do
 * something this deployment cannot do: both descriptions name an environment variable
 * that the Worker refuses to read.
 */
const WORKER_DESCRIPTIONS: Record<string, string> = {
  tclk_post_frame:
    "Append a frame line to a technocore room over the signed lane. Supply did+sig+nonce " +
    "to pass your own signature through, or call without them to get back the signing " +
    "challenge — the exact canonical string and a usable nonce — and sign it yourself. " +
    "This hosted server holds no signing key and cannot be given one: it serves many " +
    "callers, so an identity here would sign for whoever called it. Server-side signing " +
    "exists only in the stdio build.",
  tclk_adaptor_presign:
    "PTLC: pre-sign a rail claim message under a point statement. NOT AVAILABLE on this " +
    "hosted server, which holds no payment key and will not take one as an argument — " +
    "pre-signing is done with your own key, in the stdio build or client-side. Calling it " +
    "returns that as a structured error. The other three adaptor tools (adapt, extract, " +
    "verify) take public inputs only and work here normally.",
};

/**
 * The same correction, one level down. `tclk_accept_offer`'s `paymentKey` *field* is
 * documented as optional because the stdio build falls back to `TCLK_PAYMENT_KEY`; here
 * there is no fallback, so a caller who believes the schema omits the field, gets a
 * fail-closed error, and is then told to set a variable this deployment refuses to read.
 * Rewriting the prose is not cosmetic — it is the difference between an error that names
 * the fix and one that names a dead end. Only `description` strings change; the schema's
 * types, required list and enums are the generated ones, so argument validation here and
 * over stdio stay identical.
 */
const STDIO_PAYMENT_KEY_HINT = " (or set TCLK_PAYMENT_KEY)";
const WORKER_PAYMENT_KEY_HINT =
  " (required here: this hosted server holds no payment key)";

function amendSchemaProse(schema: ManifestTool["inputSchema"]): ManifestTool["inputSchema"] {
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (!properties) return schema;
  let touched = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    const description = (value as { description?: unknown }).description;
    if (typeof description === "string" && description.includes(STDIO_PAYMENT_KEY_HINT)) {
      next[key] = {
        ...(value as object),
        description: description.replace(STDIO_PAYMENT_KEY_HINT, WORKER_PAYMENT_KEY_HINT),
      };
      touched = true;
    } else {
      next[key] = value;
    }
  }
  return touched ? { ...schema, properties: next } : schema;
}

const ADVERTISED_TOOLS: readonly ManifestTool[] = TOOLS.map((tool) => {
  const description = WORKER_DESCRIPTIONS[tool.name] ?? tool.description;
  return { ...tool, description, inputSchema: amendSchemaProse(tool.inputSchema) };
});

const TOOLS_BY_NAME = new Map(ADVERTISED_TOOLS.map((tool) => [tool.name, tool]));

// ── Argument checking ────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(expected: string, actual: string): boolean {
  if (expected === "number") return actual === "number" || actual === "integer";
  return expected === actual;
}

/**
 * A shallow check of the arguments against the tool's generated JSON Schema: required
 * keys present, top-level types right, enums honoured. Returns the reason, or null.
 *
 * Deliberately shallow. The deep validation is the library's, one layer down, and it is
 * strict there for a reason — `applyFrame` and the frame decoders reject unknown keys and
 * malformed values rather than coercing, and their message is what comes back as the tool
 * error. What this adds is a `-32602` at the protocol boundary for the mistakes a client
 * makes rather than a user: a missing field, a number where a DID goes. It is not a
 * reimplementation of the stdio server's zod schemas and does not try to be one; the
 * schemas it checks against ARE those schemas, compiled to JSON Schema.
 */
function checkArguments(tool: ManifestTool, args: Record<string, unknown>): string | null {
  const schema = tool.inputSchema;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of required) {
    if (args[key] === undefined) return `missing required argument \`${key}\``;
  }
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const property = properties[key];
    if (!isPlainObject(property)) continue;
    const actual = jsonTypeOf(value);
    if (typeof property.type === "string" && !typeMatches(property.type, actual)) {
      return `argument \`${key}\` must be a ${property.type}, got ${actual}`;
    }
    if (Array.isArray(property.enum) && !property.enum.includes(value as never)) {
      return `argument \`${key}\` must be one of ${JSON.stringify(property.enum)}`;
    }
  }
  return null;
}

// ── Tool dispatch ────────────────────────────────────────────────────────────────────

type Handlers = ReturnType<typeof createHandlers>;

/** The `{ content: [{ type: "text", … }] }` shape `mcp/src/server.ts` answers with. */
function toolResult(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string): unknown {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * The tier-3 reply, with the hint rewritten for a deployment that has no tier 2.
 *
 * The stdio build's hint ends "Or set TECHNOCORE_SIGNING_KEY on this server." Here that
 * would be an instruction to do something impossible, and an agent reading it would spend
 * a turn trying. Everything else about the reply — the nonce, the canonical string, the
 * swept text — is the handler's own and is what the caller signs.
 */
async function postFrame(handlers: Handlers, args: Record<string, unknown>): Promise<unknown> {
  const result = await handlers.tclk_post_frame(
    args as unknown as Parameters<Handlers["tclk_post_frame"]>[0],
  );
  if (result.posted) return result;
  return {
    ...result,
    hint:
      "Sign `canonical` exactly, as UTF-8, with Ed25519; encode the 64-byte signature as " +
      "unpadded base64url; then call tclk_post_frame again with `did`, `sig` and this " +
      `\`nonce\` (${result.nonce}). This hosted server cannot sign for you and has no way ` +
      "to be given a key: it serves many callers, so an identity configured here would " +
      "sign whatever any of them asked it to. Server-side signing exists only in the " +
      "stdio build (`npx @flop-labs/tclk-mcp`), beside a single agent, with " +
      "TECHNOCORE_SIGNING_KEY set there.",
  };
}

/**
 * `tclk_adaptor_presign` on a shared deployment.
 *
 * The stdio build answers `{ ok: false, error: "no payment key", hint: "set
 * TCLK_PAYMENT_KEY …" }`, which is right there and wrong here: the key is not missing, it
 * is refused. Same `{ ok, error, hint }` shape so a client branches identically, with the
 * reason and the actual next step in it.
 */
function presignRefusal(): unknown {
  return {
    ok: false,
    error: "pre-signing is not available on a hosted server",
    hint:
      "An adaptor pre-signature is made with the payer's own secp256k1 payment key. This " +
      "deployment holds no such key and will not accept one as a tool argument — it " +
      "serves many callers, and a payment key here would let its operator complete " +
      "adaptor signatures on their deals. Pre-sign where the key is: run the stdio server " +
      "(`npx @flop-labs/tclk-mcp`) with TCLK_PAYMENT_KEY set, or do it client-side with " +
      "`schnorrAdaptor.preSign` from @flop-labs/tclk. Then bring the resulting `presig` " +
      "back here: tclk_adaptor_adapt, tclk_adaptor_extract and tclk_adaptor_verify take " +
      "public inputs only and work on this server.",
  };
}

async function callTool(
  handlers: Handlers,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === "tclk_adaptor_presign") return presignRefusal();
  if (name === "tclk_post_frame") return postFrame(handlers, args);

  const handler = (handlers as unknown as Record<string, (input: unknown) => unknown>)[name];
  // Unreachable via `handleRpc`, which looks the name up in the manifest first. Kept
  // because "the manifest and the handlers agree" is an assumption, not a guarantee.
  if (typeof handler !== "function") throw new Error(`tclk-mcp: no handler for ${name}`);

  // `tclk_accept_offer` on a point-lock offer with no `paymentKey` fails closed in the
  // shared handler — correct — but its message ends "or set TCLK_PAYMENT_KEY", which is
  // the one remedy unavailable here. Correct the remedy, not the failure: the throw still
  // happens, at the same point, for the same reason.
  if (name === "tclk_accept_offer") {
    try {
      return await handler(args);
    } catch (error) {
      throw error instanceof Error ? new Error(correctPaymentKeyRemedy(error.message)) : error;
    }
  }
  return await handler(args);
}

/** Rewrite the stdio build's env-var remedy into the one that works on a hosted server. */
function correctPaymentKeyRemedy(message: string): string {
  return message.includes("set TCLK_PAYMENT_KEY")
    ? message.replace(
        /or set TCLK_PAYMENT_KEY\.?$/,
        "\u2014 this hosted server holds no payment key, so the field is required here.",
      )
    : message;
}

// ── Method dispatch ──────────────────────────────────────────────────────────────────

function initializeResult(params: unknown): unknown {
  const requested = isPlainObject(params) ? params.protocolVersion : undefined;
  // Echo the client's version when this server speaks it; otherwise offer the newest one
  // and let the client decide whether it can live with that. Never echo an unknown
  // version back — that claims support this server does not have.
  const protocolVersion =
    typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
}

async function handleRpc(message: JsonRpcRequest, handlers: Handlers): Promise<Response> {
  const id = message.id ?? null;

  switch (message.method) {
    case "initialize":
      return rpcResult(id, initializeResult(message.params));

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      // No pagination: seventeen tools fit in one page, so there is no `nextCursor` and a
      // client that sends a `cursor` gets the same single page back rather than a lie
      // about there being more.
      return rpcResult(id, { tools: ADVERTISED_TOOLS });

    case "tools/call": {
      if (!isPlainObject(message.params)) {
        return rpcError(id, INVALID_PARAMS, "tools/call requires a params object");
      }
      const name = message.params.name;
      if (typeof name !== "string") {
        return rpcError(id, INVALID_PARAMS, "tools/call requires a string `name`");
      }
      const tool = TOOLS_BY_NAME.get(name);
      if (tool === undefined) {
        return rpcError(id, INVALID_PARAMS, `unknown tool: ${name}`);
      }
      const rawArgs = message.params.arguments;
      if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
        return rpcError(id, INVALID_PARAMS, "`arguments` must be an object");
      }
      const args = rawArgs ?? {};
      const reason = checkArguments(tool, args);
      if (reason !== null) {
        return rpcError(id, INVALID_PARAMS, `${name}: ${reason}`);
      }
      try {
        return rpcResult(id, toolResult(await callTool(handlers, name, args)));
      } catch (error) {
        // A handler that throws is failing closed on purpose — bad frame, bad room name,
        // a venue that refused. That is a tool result, not a protocol error, and it is the
        // same text a stdio client would see. It is returned to the caller who caused it
        // and written down nowhere.
        return rpcResult(id, toolError(error instanceof Error ? error.message : String(error)));
      }
    }

    default:
      return rpcError(id, METHOD_NOT_FOUND, `method not found: ${message.method}`);
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────

/**
 * Refuse to run at all if a custody key was bound to this deployment.
 *
 * A Worker that quietly ignored the secret someone put in front of it would look like it
 * worked, and the person who set it would believe their frames were being signed. This is
 * the sibling project's rule in the other direction: a deployment whose configuration
 * contradicts what the code can do should fail its first request, not its first incident.
 */
function assertNoCustody(env: Env): Response | null {
  const present = CUSTODY_BINDINGS.filter(
    (name) => (env as Record<string, unknown>)[name] !== undefined,
  );
  if (present.length === 0) return null;
  return jsonResponse(
    {
      error: `this Worker refuses to run with ${present.join(" and ")} bound`,
      detail:
        "A hosted tclk-mcp holds no custody. A signing key here would sign for whoever " +
        "called the URL; a payment key would let this deployment's operator complete " +
        "adaptor pre-signatures on other people's deals. Remove the binding " +
        "(`wrangler secret delete <NAME>`) and redeploy. If you want an identity or a " +
        "payment key, run the stdio server beside your agent, where the key is yours.",
    },
    503,
  );
}

/**
 * The environment the handlers get. Built by naming one variable rather than by spreading
 * the binding object: that is what makes "the Worker cannot read a signing key" a
 * property of this file instead of a promise in the README.
 */
function tclkEnv(env: Env): TclkEnv {
  return { TECHNOCORE_URL: env.TECHNOCORE_URL };
}

/**
 * The whole endpoint. `fetchImpl` is injected only by the tests; in production it is
 * omitted and `createClient` uses the platform `fetch`.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  fetchImpl?: FetchLike,
): Promise<Response> {
  const custody = assertNoCustody(env);
  if (custody !== null) return custody;

  const url = new URL(request.url);
  if (url.pathname !== MCP_PATH && url.pathname !== `${MCP_PATH}/`) {
    return jsonResponse({ error: `not found: ${url.pathname}; the MCP endpoint is POST /mcp` }, 404);
  }

  if (request.method !== "POST") {
    // Every MCP exchange this server has is one request and one response. There is no GET
    // stream because there is nothing to push down it: no subscriptions, no resources, no
    // server-initiated sampling. An SSE stream here would be a held-open edge request
    // carrying keep-alive comments and nothing else.
    return jsonResponse(
      { error: `${request.method} not allowed; this endpoint is POST-only JSON-RPC` },
      405,
      { allow: "POST" },
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonResponse({ error: "content-type must be application/json" }, 415);
  }

  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    return jsonResponse({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413);
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    return rpcError(null, PARSE_ERROR, "could not read the request body", 400);
  }
  // Re-checked after reading: `content-length` is the client's claim, and a chunked body
  // does not carry one at all.
  if (body.length > MAX_BODY_BYTES) {
    return jsonResponse({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return rpcError(null, PARSE_ERROR, "request body is not valid JSON", 400);
  }

  if (Array.isArray(parsed)) {
    // Batching left the MCP spec after 2025-03-26 and this server never supported it.
    // Answering the first element instead would silently drop the rest.
    return rpcError(null, INVALID_REQUEST, "JSON-RPC batches are not supported", 400);
  }
  if (!isPlainObject(parsed)) {
    return rpcError(null, INVALID_REQUEST, "request body must be a JSON-RPC object", 400);
  }
  if (parsed.jsonrpc !== "2.0") {
    return rpcError(null, INVALID_REQUEST, 'missing or wrong "jsonrpc": "2.0"', 400);
  }
  if (typeof parsed.method !== "string") {
    return rpcError(null, INVALID_REQUEST, "`method` must be a string", 400);
  }
  const id = parsed.id;
  if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
    return rpcError(null, INVALID_REQUEST, "`id` must be a string, a number or null", 400);
  }

  // A notification (`initialized`, `cancelled`) or a client's response to something this
  // server never asked: no `id`, so there is nothing to answer. 202 with an empty body is
  // what the streamable-HTTP spec asks for.
  if (id === undefined) {
    return new Response(null, { status: 202 });
  }

  try {
    return await handleRpc(parsed as unknown as JsonRpcRequest, createHandlers({ env: tclkEnv(env), fetch: fetchImpl }));
  } catch (error) {
    // The message goes back down the connection it came from, to the caller who supplied
    // the input — the same thing the stdio server does. What does NOT happen is a
    // `console.error`: `tclk_accept_offer` mints a preimage, and `tclk_decode` can quote
    // the line it was handed, which for a reveal frame IS the secret. A hosted server that
    // wrote either into a log would be holding custody by another name, so this file
    // writes no log line at all — not here, not anywhere.
    return rpcError(id ?? null, INTERNAL_ERROR, error instanceof Error ? error.message : "internal error");
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
