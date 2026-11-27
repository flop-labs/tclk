// SPDX-License-Identifier: Apache-2.0
//
// The two technocore endpoints tclk needs, and nothing else: append a signed frame to
// a room, and read a room back as JSON. `fetch` is injected so tests exercise the exact
// URL and body without a network.
//
// Fail-closed on the wire: a non-2xx answer throws with the status and the venue's own
// first line (its 400s name the offending field), never a silently empty result.

import { parseRecordJson, parseTranscriptExport, type TranscriptRecord } from "@flop-labs/tclk";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

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
  const body = await response.text().catch(() => "");
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
      return await response.text();
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
      let view: unknown;
      try {
        const text = await response.text();
        view = parseRecordJson(text);
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
      return parseTranscriptExport(room, await response.text());
    },
  };
}
