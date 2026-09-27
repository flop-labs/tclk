// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { matchingRails, normalizeRailIds, railSetsMatch } from "../src/rails.js";
import { capabilityToken, parseCapabilityToken } from "../src/technocore.js";

describe("rail normalization rejects sparse caller arrays", () => {
  it.each([
    { label: "one hole", rails: new Array<string>(1) },
    { label: "explicit undefined after a rail", rails: ["paper", ...new Array<string>(1)] },
    { label: "three holes", rails: new Array<string>(3) },
  ])("rejects $label rather than emitting an invalid rail", ({ rails }) => {
      expect(() => normalizeRailIds(rails)).toThrow(/non-empty string/);
      expect(() => capabilityToken(rails)).toThrow(/non-empty string/);
    },
  );
  it("rejects a real hole after a valid rail", () => {
    const rails = ["paper"];
    rails.length = 2;
    expect(() => normalizeRailIds(rails)).toThrow(/non-empty string/);
    expect(() => capabilityToken(rails)).toThrow(/non-empty string/);
  });
  it("does not discover a common undefined rail between two sparse sets", () => {
    expect(() => railSetsMatch(new Array<string>(1), new Array<string>(1))).toThrow(/non-empty string/);
  });
  it("rejects holes in the supported list", () => {
    expect(() => matchingRails(["paper"], new Array<string>(1))).toThrow(/non-empty string/);
  });
  it("preserves valid canonicalization, intersection, and token roundtrips", () => {
    expect(normalizeRailIds([" X402 ", "PaperRail", "paper"])).toEqual(["paper", "x402"]);
    expect(matchingRails(["x402", "paper"], ["PaperRail"])).toEqual(["paper"]);
    expect(parseCapabilityToken(capabilityToken(["x402", "paper"]))).toEqual(["paper", "x402"]);
  });
});
