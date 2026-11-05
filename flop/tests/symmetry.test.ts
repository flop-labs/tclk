// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  checkSymmetryParams,
  checkTimelockSymmetry,
  FlopAdmissionError,
  timelockSymmetryMinimum,
  toOneSecondBlocks,
} from "../src/symmetry.js";

// Test inputs only: the yellow paper's values (v0.5.0 parameter table at 56410c67), which
// devnet runtime 1014003 also reports. The package ships no values.
const p = { marginPercent: 20, maxFinalityStallBlocks: 3_600 };
const YP = { ...p, finalityFreezeThresholdBlocks: 120 };
const refusal = (run: () => void): Error | undefined => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  return undefined;
};

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

describe("toOneSecondBlocks (R10.2 converts to one-second FLOP blocks)", () => {
  it.each([
    [0, 0],
    [1, 1],
    [999, 1],
    [1_000, 1],
    [1_001, 2],
    [1_999, 2],
    [2_000, 2],
    [1_800_000, 1_800],
    [3_600_000, 3_600],
    [3_600_001, 3_601],
    [Number.MAX_SAFE_INTEGER, 9_007_199_254_741],
  ])("rounds %d ms up to %d blocks", (ms, blocks) => {
    expect(toOneSecondBlocks(ms)).toBe(blocks);
  });

  it.each([NaN, -1, 1.5, Infinity, 2 ** 53, "1000", undefined, null])(
    "refuses the duration %s",
    (bad) => {
      expect(() => toOneSecondBlocks(bad as number)).toThrow("duration");
    },
  );
});

describe("checkTimelockSymmetry (R10.2: the finality-open gate, then the relation)", () => {
  const check = (
    tFlopBlocks: number,
    currentFinalityLagBlocks: number,
    params: unknown = YP,
  ) =>
    refusal(() =>
      checkTimelockSymmetry({
        tFlopBlocks,
        tOtherBlocks: 3_600,
        currentFinalityLagBlocks,
        params: params as typeof YP,
      }),
    );

  it("admits equality and refuses one block short while the lag is below the threshold", () => {
    expect(check(7_200, 0)).toBeUndefined();
    expect(check(7_319, 119)).toBeUndefined();
    const short = check(7_318, 119);
    expect(short).toBeInstanceOf(FlopAdmissionError);
    expect(short).toMatchObject({ reason: "timelock-symmetry" });
    expect(short?.message).toBe(
      "flop: timeout below the R10.2 symmetry minimum: 7318 blocks offered, 7319 required (T_other 3600, finality lag 119)",
    );
  });

  it("refuses at and above finality_freeze_threshold whatever the timeout, before the relation", () => {
    for (const lag of [120, 121, 10_000]) {
      // Long enough for any of these lags: only the gate can refuse it.
      const frozen = check(1_000_000, lag);
      expect(frozen).toBeInstanceOf(FlopAdmissionError);
      expect(frozen).toMatchObject({ reason: "finality-freeze" });
      expect(frozen?.message).toBe(
        `flop: finality lag ${lag} is at or above the R10.2 freeze threshold 120; the open is refused`,
      );
    }
    // Both clauses would refuse; the gate is evaluated first, so it is the one reported.
    expect(check(1, 120)).toMatchObject({ reason: "finality-freeze" });
    expect(check(1, 119)).toMatchObject({ reason: "timelock-symmetry" });
  });

  it("takes the threshold from the parameters, including zero", () => {
    const at = (threshold: number) => ({
      ...YP,
      finalityFreezeThresholdBlocks: threshold,
    });
    expect(check(1_000_000, 0, at(0))).toMatchObject({
      reason: "finality-freeze",
    });
    expect(check(7_300, 100, at(101))).toBeUndefined();
    expect(check(7_300, 100, at(100))).toMatchObject({
      reason: "finality-freeze",
    });
  });

  it.each([NaN, -1, 1.5, Infinity, 2 ** 53, "1", undefined, null])(
    "throws a plain error, not an admission verdict, for the operand %s",
    (bad) => {
      const base = {
        tFlopBlocks: 7_200,
        tOtherBlocks: 3_600,
        currentFinalityLagBlocks: 0,
        params: YP,
      };
      for (const field of [
        "tFlopBlocks",
        "tOtherBlocks",
        "currentFinalityLagBlocks",
      ] as const) {
        const error = refusal(() =>
          checkTimelockSymmetry({ ...base, [field]: bad as number }),
        );
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(FlopAdmissionError);
      }
    },
  );

  it.each([
    null,
    [],
    {},
    p,
    { ...YP, extra: 1 },
    { ...YP, finalityFreezeThresholdBlocks: undefined },
    { marginPercent: 20, maxFinalityStall: 3_600, finalityFreezeThreshold: 120 },
    { ...YP, marginPercent: NaN },
    { ...YP, marginPercent: -1 },
    { ...YP, marginPercent: "20" },
    { ...YP, maxFinalityStallBlocks: 1.5 },
    { ...YP, finalityFreezeThresholdBlocks: Infinity },
    { ...YP, finalityFreezeThresholdBlocks: 2 ** 32 },
  ])("refuses the malformed parameters %j", (params) => {
    const error = check(1_000_000, 0, params);
    expect(error?.message).toContain("R10.2 parameters");
    expect(error).not.toBeInstanceOf(FlopAdmissionError);
  });

  it("refuses missing operands", () => {
    for (const inputs of [undefined, null])
      expect(() => checkTimelockSymmetry(inputs as any)).toThrow("operands");
  });

  it("validates parameters into a frozen copy of exactly the three fields", () => {
    const input = { ...YP };
    const params = checkSymmetryParams(input);
    input.maxFinalityStallBlocks = 0;
    expect(params).toEqual(YP);
    expect(Object.isFrozen(params)).toBe(true);
  });
});
