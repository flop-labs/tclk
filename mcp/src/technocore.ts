// SPDX-License-Identifier: Apache-2.0
//
// The two technocore endpoints tclk needs, and nothing else: append a signed frame to
// a room, and read a room back as JSON. `fetch` is injected so tests exercise the exact
// URL and body without a network.
//
// Fail-closed on the wire: a non-2xx answer throws with the status and the venue's own
// first line (its 400s name the offending field), never a silently empty result.

import { parseTranscriptExport, type TranscriptRecord } from "@flop-labs/tclk";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/**
 * 1 MiB, the same budget `mcp/worker/src/worker.ts` puts on a request body, for the same
 * reason: frame lines are short and a transcript is a few hundred of them, so a body past
 * this is a mistake or an attack, and reading it to find out is the cost either way. That
 * argument does not care which direction the bytes travel, but until now only the inbound
 * side made it. A room is world-writable and append-only, so writes are cheap and the
 * history a single reader must swallow is not — `/export` returns everything ever posted.
 *
 * Applied to every venue response, error bodies included: a refusal is still a body.
 */
export const MAX_VENUE_BODY_BYTES = 1_048_576;

/**
 * Read a response body, refusing past the cap instead of buffering whatever arrives.
 * `content-length` is checked first when the venue offers one, and again while reading,
 * because that header is a claim and a chunked response carries none at all.
 */
async function readCapped(response: Response, what: string): Promise<string> {
  const tooBig = () =>
    new Error(`tclk-mcp: ${what} returned more than ${MAX_VENUE_BODY_BYTES} bytes`);

  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_VENUE_BODY_BYTES) throw tooBig();

  const body = response.body;
  if (body === null) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_VENUE_BODY_BYTES) throw tooBig();
      chunks.push(value);
    }
  } finally {
    // Stop the transfer on the refusal path; harmless once the body is already drained.
    await reader.cancel().catch(() => {});
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export const DEFAULT_TECHNOCORE_URL = "https://technocore.chat";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The signed-write body technocore accepts on `POST /r/<room>`. */
export interface SignedPost {
  did: string;
  sig: string;
  /** Sent as a string: a stored nonce may exceed 2^53 and must stay exact. */
  nonce: number | string;
  /** The swept text — exactly the bytes the signature covered. */
  text: string;
}

/** One record as `?format=json` serves it. `sig` is absent on pre-signature records. */
export interface RoomMessage {
  seq: number;
  ts: string;
  from: string;
  text: string;
  nonce?: string | number;
  sig?: string;
}

export interface RoomView {
  room: string;
  count: number;
  first_seq?: number | null;
  last_seq: number;
  messages: RoomMessage[];
}

export interface TechnocoreClient {
  readonly baseUrl: string;
  postSigned(room: string, post: SignedPost): Promise<string>;
  readRoom(room: string, since?: number): Promise<RoomView>;
  exportRoom(room: string): Promise<TranscriptRecord[]>;
}

export function assertRoomName(room: string): string {
  if (!NAME_RE.test(room)) {
    throw new Error(`tclk-mcp: bad room name ${JSON.stringify(room)}: expected /${NAME_RE.source}/`);
  }
  return room;
}

async function fail(response: Response, what: string): Promise<never> {
  const body = await readCapped(response, what).catch(() => "");
  const firstLine = body.split("\n", 1)[0] ?? "";
  throw new Error(`tclk-mcp: ${what} failed with ${response.status}${firstLine ? `: ${firstLine}` : ""}`);
}

export function createClient(opts: { baseUrl?: string; fetch?: FetchLike } = {}): TechnocoreClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_TECHNOCORE_URL).replace(/\/+$/, "");
  const doFetch: FetchLike =
    opts.fetch ?? ((input, init) => globalThis.fetch(input, init) as Promise<Response>);

  return {
    baseUrl,
    async postSigned(room, post) {
      assertRoomName(room);
      const response = await doFetch(`${baseUrl}/r/${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          did: post.did,
          sig: post.sig,
          nonce: String(post.nonce),
          text: post.text,
        }),
      });
      if (!response.ok) await fail(response, `POST /r/${room}`);
      return await readCapped(response, `POST /r/${room}`);
    },

    async readRoom(room, since) {
      assertRoomName(room);
      const query = new URLSearchParams({ format: "json" });
      if (since !== undefined) {
        if (!Number.isSafeInteger(since) || since < 0) {
          throw new Error("tclk-mcp: `since` must be a non-negative integer seq");
        }
        query.set("since", String(since));
      }
      const response = await doFetch(`${baseUrl}/r/${room}?${query.toString()}`, { method: "GET" });
      if (!response.ok) await fail(response, `GET /r/${room}`);
      const text = await readCapped(response, `GET /r/${room}`);
      let view: unknown;
      try {
        view = JSON.parse(text);
      } catch {
        throw new Error(`tclk-mcp: GET /r/${room} did not return JSON`);
      }
      const parsed = view as Partial<RoomView>;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) {
        throw new Error(`tclk-mcp: GET /r/${room} returned no messages array`);
      }
      return parsed as RoomView;
    },

    async exportRoom(room) {
      assertRoomName(room);
      const response = await doFetch(`${baseUrl}/r/${room}/export`, { method: "GET" });
      if (!response.ok) await fail(response, `GET /r/${room}/export`);
      return parseTranscriptExport(room, await readCapped(response, `GET /r/${room}/export`));
    },
  };
}
