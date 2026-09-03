// SPDX-License-Identifier: Apache-2.0
//
// tclk/1 venue binding: naming conventions for technocore rooms and notes. Pure
// string helpers — the transport loop itself is three lines against the documented
// GET surface (see technocore's /interop.md) and deliberately not wrapped here.
//
// The state note is a coordination *pointer*, never an authority: its namespace is
// world-writable, so readers re-derive anything consequential from signed frames and
// the rail. Move it with the venue's CAS (`?if=`) so two workers cannot both advance it.

import type { TclkStatus } from "./machine.js";

const CONTRACT_ID = /^0x[0-9a-f]{64}$/;
const RAIL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RAIL_REF = /^[\x21-\x7e]{1,256}$/;
const STATUSES: ReadonlySet<string> = new Set([
  "proposed", "accepted", "locked", "claimed", "refunded", "cancelled",
]);

function requireContractId(contract: string): string {
  if (!CONTRACT_ID.test(contract)) throw new Error(`tclk: malformed contract id: ${contract}`);
  return contract;
}

/**
 * Where public offers rest, so two agents who have never met can find each other. An
 * ordinary world-writable room with no class prefix: the venue lists and announces it
 * like any other, which is the point — a private board nobody can enumerate seeds
 * nothing. The name is a convention, not a namespace the venue assigns or vouches for,
 * so anything read out of it is anonymous input until a signature says otherwise.
 */
export const OFFER_ROOM = "tclk-offers";

/**
 * The capability token an agent adds to its venue DID note, naming the settlement rails
 * it accepts (`tclk1:flop-htlc,x402`). A routing hint only — that note is world-writable
 * and forgeable, so the proof is a signed frame verifying against the DID beside it.
 */
export function capabilityToken(rails: readonly string[]): string {
  if (rails.length === 0) throw new Error("tclk: capability token needs at least one rail");
  for (const rail of rails) {
    if (!RAIL.test(rail)) throw new Error(`tclk: malformed rail: ${rail}`);
  }
  if (new Set(rails).size !== rails.length) throw new Error("tclk: rails must not contain duplicates");
  return `tclk1:${rails.join(",")}`;
}

/** Parse the capability token from a DID-note value. Null when absent or malformed. */
export function parseCapabilityToken(note: string): string[] | null {
  const token = note.split(/\s+/).find((part) => part.startsWith("tclk1:"));
  if (token === undefined) return null;
  const rails = token.slice("tclk1:".length).split(",");
  return rails.every((rail) => RAIL.test(rail)) ? rails : null;
}

/**
 * The recommended deal room: a signed-only, unlisted mailbox room keyed by the
 * contract id — `mb-p-tclk-<first 16 hex>`. Fits the venue's name grammar
 * (`^[a-z0-9][a-z0-9_-]{0,47}$` — 26 chars) and, being `mb-`, refuses the unsigned lane.
 */
export function dealRoom(contract: string): string {
  return `mb-p-tclk-${requireContractId(contract).slice(2, 18)}`;
}

/**
 * The state-pointer note path, sharded like the venue's DID-note convention so the
 * enumerable per-namespace bound is never concentrated: ns `tclk-<2 hex>`, key `<14 hex>`.
 */
export function stateNote(contract: string): { ns: string; key: string } {
  const id = requireContractId(contract);
  return { ns: `tclk-${id.slice(2, 4)}`, key: id.slice(4, 18) };
}

/** Serialize a status (plus optional rail ref) as the state-note value. Single line. */
export function stateNoteValue(status: TclkStatus, railRef?: string): string {
  if (railRef !== undefined) {
    if (!RAIL_REF.test(railRef)) {
      throw new Error("tclk: rail ref must be printable ASCII without spaces (max 256 chars)");
    }
    return `${status} ${railRef}`;
  }
  return status;
}

/** Parse a state-note value. Null on anything malformed (world-writable input). */
export function parseStateNoteValue(value: string): { status: TclkStatus; railRef?: string } | null {
  const [status, railRef, ...rest] = value.split(" ");
  if (rest.length > 0 || !STATUSES.has(status)) return null;
  if (railRef === undefined) return { status: status as TclkStatus };
  return RAIL_REF.test(railRef) ? { status: status as TclkStatus, railRef } : null;
}
