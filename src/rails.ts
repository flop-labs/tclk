// SPDX-License-Identifier: Apache-2.0
//
// Settlement-rail names are protocol identifiers, not display labels. Normalize inputs
// before building a frame and reject unknown ids at every untrusted boundary so matching
// is set membership over one vocabulary rather than array/string folklore.

import { CANONICAL_RAIL_IDS } from "./frame-fields.generated.js";

export { CANONICAL_RAIL_IDS } from "./frame-fields.generated.js";
export type CanonicalRailId = (typeof CANONICAL_RAIL_IDS)[number];

const CANONICAL = new Set<string>(CANONICAL_RAIL_IDS);
const ALIASES: Readonly<Record<string, CanonicalRailId>> = {
  "paper-rail": "paper",
};

function normalizedSpelling(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s._]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/** Canonicalize a known rail id or throw loudly on an unknown namespace entry. */
export function normalizeRailId(value: string): CanonicalRailId {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("tclk: rail id must be a non-empty string");
  }
  const spelling = normalizedSpelling(value);
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

/** Set equality, independent of input order and aliases; unknown ids throw. */
export function railSetsMatch(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizeRailIds(left);
  const b = normalizeRailIds(right);
  return a.length === b.length && a.every((rail, index) => rail === b[index]);
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
