// SPDX-License-Identifier: Apache-2.0
//
// Settlement-rail names are protocol identifiers, not display labels. Normalize caller
// input before building a new frame, but do not rewrite historical tclk/1 bytes: old frames
// used a wider free-form namespace and their ids commit to those exact spellings.

import {
  CANONICAL_RAIL_ID_PATTERN,
  CANONICAL_RAIL_IDS,
  RAIL_ID_ALIASES,
} from "./frame-fields.generated.js";

export { CANONICAL_RAIL_IDS } from "./frame-fields.generated.js";
export type CanonicalRailId = (typeof CANONICAL_RAIL_IDS)[number];

const CANONICAL = new Set<string>(CANONICAL_RAIL_IDS);
const ALIASES: Readonly<Record<string, CanonicalRailId>> = RAIL_ID_ALIASES;
const RAIL_ID = new RegExp(CANONICAL_RAIL_ID_PATTERN);

function normalizedSpelling(value: string): string {
  return value.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Canonicalize a known rail id or throw loudly on an unknown namespace entry. */
export function normalizeRailId(value: string): CanonicalRailId {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("tclk: rail id must be a non-empty string");
  }
  const spelling = normalizedSpelling(value);
  if (!RAIL_ID.test(spelling)) {
    throw new Error(`tclk: malformed rail id: ${value}`);
  }
  const canonical = ALIASES[spelling] ?? spelling;
  if (!CANONICAL.has(canonical)) {
    throw new Error(`tclk: unknown rail id: ${value}`);
  }
  return canonical as CanonicalRailId;
}

/** Normalize a rail set: canonical ids, duplicates removed, stable lexical order. */
export function normalizeRailIds(values: readonly string[]): CanonicalRailId[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("tclk: rails must be a non-empty array");
  }
  return [...new Set(values.map(normalizeRailId))].sort();
}

/** True when two rail sets have any canonical rail in common; unknown ids throw. */
export function railSetsMatch(left: readonly string[], right: readonly string[]): boolean {
  return matchingRails(left, right).length > 0;
}

/** Common canonical rails, independent of list order; unknown ids throw. */
export function matchingRails(
  offered: readonly string[],
  supported: readonly string[],
): CanonicalRailId[] {
  const support = new Set(normalizeRailIds(supported));
  return normalizeRailIds(offered).filter((rail) => support.has(rail));
}

/** Membership over canonical ids; unknown inputs throw rather than silently missing. */
export function offerIncludesRail(offered: readonly string[], selected: string): boolean {
  const target = normalizeRailId(selected);
  return offered.some((rail) => normalizeRailId(rail) === target);
}
