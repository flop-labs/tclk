// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { timelockSymmetryMinimum } from "../src/symmetry.js";

// Test inputs only (yellow paper v0.5.0 Appendix A); the package ships no values.
const p = { marginPercent: 20, maxFinalityStallBlocks: 3_600 };

describe("timelockSymmetryMinimum (yellow paper R10.2)", () => {
  it("is T_other plus the larger of the percent and finality margins", () => {
    expect(timelockSymmetryMinimum(3_600, p, 0)).toBe(7_200); // finality margin
    expect(timelockSymmetryMinimum(3_600, p, 1)).toBe(7_201);
    expect(timelockSymmetryMinimum(3_600, p, 100)).toBe(7_300);
    expect(timelockSymmetryMinimum(100_000, p, 0)).toBe(120_000); // percent margin
    expect(timelockSymmetryMinimum(1, p, 0)).toBe(3_601);
    expect(timelockSymmetryMinimum(0, p, 0)).toBe(3_600);
    const noStall = { marginPercent: 15, maxFinalityStallBlocks: 0 };
    expect(timelockSymmetryMinimum(7, noStall, 0)).toBe(9); // ceil(1.05) = 2
    const none = { marginPercent: 0, maxFinalityStallBlocks: 0 };
    expect(timelockSymmetryMinimum(100, none, 0)).toBe(100);
  });

  it("rounds the percent margin up exactly near the top of the safe range", () => {
    const one = { marginPercent: 1, maxFinalityStallBlocks: 0 };
    // 8e15 + 1 = 100 * 8e13 + 1, so the margin is 8e13 + 1.
    expect(timelockSymmetryMinimum(8_000_000_000_000_001, one, 0)).toBe(
      8_080_000_000_000_002,
    );
  });

  it.each([NaN, -1, 1.5, Infinity, 2 ** 53, "1", undefined, null])(
    "refuses the operand %s instead of reading it as a count",
    (bad) => {
      const x = bad as number;
      expect(() => timelockSymmetryMinimum(x, p, 0)).toThrow("T_other");
      expect(() => timelockSymmetryMinimum(1, p, x)).toThrow("finality lag");
      expect(() =>
        timelockSymmetryMinimum(1, { ...p, marginPercent: x }, 0),
      ).toThrow("parameters");
      expect(() =>
        timelockSymmetryMinimum(1, { ...p, maxFinalityStallBlocks: x }, 0),
      ).toThrow("parameters");
    },
  );

  it("refuses missing parameters", () => {
    for (const params of [undefined, null, {}, { marginPercent: 20 }])
      expect(() => timelockSymmetryMinimum(1, params as any, 0)).toThrow(
        "parameters",
      );
  });

  it("refuses a minimum outside the safe-integer range", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(() => timelockSymmetryMinimum(max, p, 0)).toThrow("overflow");
    const stall = { marginPercent: 0, maxFinalityStallBlocks: max };
    expect(() => timelockSymmetryMinimum(1, stall, 1)).toThrow("overflow");
    const two = { marginPercent: 0, maxFinalityStallBlocks: 2 };
    expect(() => timelockSymmetryMinimum(max - 1, two, 0)).toThrow("overflow");
  });
});
