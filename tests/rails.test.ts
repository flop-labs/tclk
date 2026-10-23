// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the settlement-rail registry helpers (SPEC §4, §5).

import { describe, expect, it } from "vitest";

import {
  CANONICAL_RAIL_IDS,
  matchingRails,
  normalizeRailId,
  normalizeRailIds,
  offerIncludesRail,
  railSetsMatch,
} from "../src/index.js";

describe("normalizeRailId", () => {
  it.each(CANONICAL_RAIL_IDS)("accepts canonical rail %s", (rail) => {
    expect(normalizeRailId(rail)).toBe(rail);
  });

  it("trims whitespace and normalizes ASCII uppercase", () => {
    expect(normalizeRailId("  PAPER  ")).toBe("paper");
    expect(normalizeRailId("FLOP-HTLC")).toBe("flop-htlc");
  });

  it.each(["PaperRail", "paperrail", "paper-rail"])(
    "maps alias %s to canonical paper",
    (alias) => {
      expect(normalizeRailId(alias)).toBe("paper");
    },
  );

  it("rejects non-strings and empty or whitespace-only input", () => {
    expect(() => normalizeRailId("" as string)).toThrow(/non-empty string/);
    expect(() => normalizeRailId("   " as string)).toThrow(/non-empty string/);
    expect(() => normalizeRailId(null as unknown as string)).toThrow(/non-empty string/);
  });

  it("rejects punctuation and malformed characters", () => {
    expect(() => normalizeRailId("flop-htlc.")).toThrow(/malformed rail id/);
    expect(() => normalizeRailId("paper rail")).toThrow(/malformed rail id/);
    expect(() => normalizeRailId("paper_rail")).toThrow(/malformed rail id/);
  });

  it("rejects an unregistered rail id loudly", () => {
    expect(() => normalizeRailId("combat")).toThrow(/unknown rail id: combat/);
    expect(() => normalizeRailId("custom-escrow")).toThrow(/unknown rail id: custom-escrow/);
  });
});

describe("normalizeRailIds", () => {
  it("deduplicates, normalizes aliases, and sorts canonically", () => {
    const input = ["x402", "paperrail", "flop-htlc", "paper", "PaperRail"];
    expect(normalizeRailIds(input)).toEqual(["flop-htlc", "paper", "x402"]);
  });

  it("rejects an empty array or non-array", () => {
    expect(() => normalizeRailIds([])).toThrow(/non-empty array/);
    expect(() => normalizeRailIds(null as unknown as string[])).toThrow(/non-empty array/);
  });

  it("throws if any element is unknown", () => {
    expect(() => normalizeRailIds(["paper", "unknown-rail"])).toThrow(/unknown rail id/);
  });
});

describe("railSetsMatch and matchingRails", () => {
  it("matches by non-empty intersection independently of list order", () => {
    expect(railSetsMatch(["paper", "x402"], ["x402", "PaperRail"])).toBe(true);
    expect(railSetsMatch(["flop-htlc"], ["paper"])).toBe(false);
    expect(matchingRails(["paper", "flop-htlc"], ["flop-htlc", "x402"])).toEqual(["flop-htlc"]);
  });

  it("throws when either set contains an unknown rail id", () => {
    expect(() => railSetsMatch(["unknown"], ["paper"])).toThrow(/unknown rail id/);
    expect(() => railSetsMatch(["paper"], ["unknown"])).toThrow(/unknown rail id/);
    expect(() => matchingRails(["unknown"], ["paper"])).toThrow(/unknown rail id/);
  });
});

describe("offerIncludesRail", () => {
  it("returns true for matching canonical rail id", () => {
    expect(offerIncludesRail(["flop-htlc", "paper"], "paper")).toBe(true);
    expect(offerIncludesRail(["paper"], "paper")).toBe(true);
  });

  it("normalizes aliases in offered and selected rails", () => {
    expect(offerIncludesRail(["PaperRail"], "paper")).toBe(true);
    expect(offerIncludesRail(["paper"], "PaperRail")).toBe(true);
    expect(offerIncludesRail(["paper-rail"], "paperrail")).toBe(true);
  });

  it("returns false when canonical rail is not in offered set", () => {
    expect(offerIncludesRail(["flop-htlc", "x402"], "paper")).toBe(false);
  });

  it("rejects unknown selected rail loudly", () => {
    expect(() => offerIncludesRail(["paper"], "unknown-rail")).toThrow(/unknown rail id/);
  });

  it("rejects unknown offered rail independently of list order", () => {
    // When unknown rail is first:
    expect(() => offerIncludesRail(["unknown-rail", "paper"], "paper")).toThrow(
      /unknown rail id: unknown-rail/,
    );
    // When unknown rail is last (previously bypassed due to short-circuit):
    expect(() => offerIncludesRail(["paper", "unknown-rail"], "paper")).toThrow(
      /unknown rail id: unknown-rail/,
    );
  });

  it("rejects empty or non-array offered rails", () => {
    expect(() => offerIncludesRail([], "paper")).toThrow(/non-empty array/);
    expect(() => offerIncludesRail(null as unknown as string[], "paper")).toThrow(
      /non-empty array/,
    );
  });
});
