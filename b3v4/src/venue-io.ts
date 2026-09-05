// SPDX-License-Identifier: Apache-2.0
//
// B3V4 fast-path helper — venue transport abstraction.
//
// Wraps the Technocore HTTP client with the VenueIO interface, providing
// room reads/writes and note access. The signing identity is injected
// separately so the helper never holds key material.

import {
  createClient,
  type FetchLike,
  type TechnocoreClient,
} from "@flop-labs/tclk-mcp/dist/technocore.js";
import { canonicalMessage, sweep } from "@flop-labs/tclk-mcp/dist/signing.js";
import {
  transcriptRecord,
  type TranscriptRecord,
} from "@flop-labs/tclk";
import { encodeFrame, type TclkFrame } from "@flop-labs/tclk";

import type { VenueIO, VenueSigner } from "./types.js";

const DEFAULT_TECHNOCORE_URL = "https://technocore.chat";

/**
 * Create a VenueIO backed by a real Technocore HTTP client.
 *
 * The signer is used only for postSigned — its seed never leaves the caller's
 * custody. The `nowMs` parameter is for testability; pass `Date.now` in production.
 */
export function createVenueIO(opts: {
  baseUrl?: string;
  fetch?: FetchLike;
  nowMs?: () => number;
}): VenueIO {
  const baseUrl = (opts.baseUrl ?? DEFAULT_TECHNOCORE_URL).replace(/\/+$/, "");
  const client: TechnocoreClient = createClient({
    baseUrl,
    fetch: opts.fetch,
  });

  return {
    async readRoom(room, since) {
      const view = await client.readRoom(room, since);
      const records: TranscriptRecord[] = [];
      for (const message of view.messages) {
        try {
          records.push(transcriptRecord(room, message));
        } catch {
          // Skip malformed records — a room is world-writable input.
        }
      }
      return records;
    },

    async exportRoom(room) {
      return client.exportRoom(room);
    },

    async postSigned(room, signer, line) {
      const text = sweep(line);
      if (text !== line) {
        throw new Error("b3v4: frame line does not survive the single-line sweep");
      }
      const nonce = signer.nextNonce(); // string — safe for >2^53
      const canonical = canonicalMessage(room, nonce, text);
      const sig = signer.sign(canonical);
      const response = await client.postSigned(room, {
        did: signer.did,
        sig,
        nonce,
        text,
      });
      return response;
    },

    async noteGet(ns, key) {
      const url = `${baseUrl}/kv/${ns}/${key}`;
      const res = await (opts.fetch ?? globalThis.fetch)(url, { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`b3v4: note get failed ${res.status}: ${body.split("\n")[0] ?? ""}`);
      }
      const body = await res.text();
      // Strip venue's untrusted-content banner
      const value = body
        .split("\n")
        .filter((line) => !line.startsWith("!!") && line.trim() !== "")
        .join("\n")
        .trimEnd();
      return value === "" ? null : value;
    },

    async noteSet(ns, key, value, condition) {
      const query =
        condition === undefined
          ? ""
          : "ifAbsent" in condition
            ? "?if_absent=1"
            : `?if=${encodeURIComponent(condition.if)}`;
      const url = `${baseUrl}/kv/${ns}/${key}/set/${encodeURIComponent(value)}${query}`;
      const res = await (opts.fetch ?? globalThis.fetch)(url, { method: "GET" });
      if (res.status === 409) return false;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`b3v4: note set failed ${res.status}: ${body.split("\n")[0] ?? ""}`);
      }
      return true;
    },
  };
}

/**
 * Create a mock VenueIO for testing. Tracks all operations without network.
 */
export function createMockVenueIO(): VenueIO & {
  posted: { room: string; did: string; text: string }[];
  notes: Map<string, string>;
  roomData: Map<string, TranscriptRecord[]>;
  addRoomData(room: string, records: TranscriptRecord[]): void;
} {
  const posted: { room: string; did: string; text: string }[] = [];
  const notes = new Map<string, string>();
  const roomData = new Map<string, TranscriptRecord[]>();

  return {
    posted,
    notes,
    roomData,

    addRoomData(room, records) {
      roomData.set(room, records);
    },

    async readRoom(room) {
      return roomData.get(room) ?? [];
    },

    async exportRoom(room) {
      return roomData.get(room) ?? [];
    },

    async postSigned(_room, signer, line) {
      const text = sweep(line);
      posted.push({ room: _room, did: signer.did, text });

      // Auto-add posted messages to room data for read-back verification
      const existing = roomData.get(_room) ?? [];
      existing.push({
        room: _room,
        seq: existing.length + 1,
        timestampMs: Date.now(),
        sender: signer.did,
        nonce: String(posted.length),
        signature: "mock-sig",
        line: text,
      });
      roomData.set(_room, existing);

      return "ok";
    },

    async noteGet(ns, key) {
      return notes.get(`${ns}/${key}`) ?? null;
    },

    async noteSet(ns, key, value, condition) {
      const path = `${ns}/${key}`;
      const current = notes.get(path);
      if (condition !== undefined) {
        if ("ifAbsent" in condition && current !== undefined) return false;
        if ("if" in condition && current !== condition.if) return false;
      }
      notes.set(path, value);
      return true;
    },
  };
}
