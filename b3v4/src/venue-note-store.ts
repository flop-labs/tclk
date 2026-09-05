// SPDX-License-Identifier: Apache-2.0
//
// B3V4 fast-path helper — Venue-backed NoteStore adapter.
//
// Bridges VenueIO.noteGet/noteSet to the NoteStore interface that PaperRail expects.
// This ensures PaperRail.lock() persists to Technocore, not to in-memory state.

import type { NoteStore } from "@flop-labs/tclk";
import type { VenueIO } from "./types.js";

/**
 * A NoteStore backed by VenueIO — PaperRail writes land on Technocore,
 * not in process memory.
 */
export class VenueNoteStore implements NoteStore {
  constructor(private readonly venue: VenueIO) {}

  async get(ns: string, key: string): Promise<string | null> {
    return this.venue.noteGet(ns, key);
  }

  async set(
    ns: string,
    key: string,
    value: string,
    condition?: { ifAbsent: true } | { if: string },
  ): Promise<boolean> {
    return this.venue.noteSet(ns, key, value, condition);
  }
}
