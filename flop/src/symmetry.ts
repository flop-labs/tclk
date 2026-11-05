// SPDX-License-Identifier: Apache-2.0

/**
 * The yellow paper's R10.2 runtime parameters (v0.5.0 §10.1 and its parameter table), as
 * the runtime exposes them among the `HasStation` constants. This package ships no values.
 */
export interface FlopSymmetryParams {
  /** `htlc_timelock_symmetry_safety_margin_percent` (`HasStation.TimelockSymmetrySafetyMargin`). */
  marginPercent: number;
  /** `max_finality_stall`, in blocks (`HasStation.MaxFinalityStall`). */
  maxFinalityStallBlocks: number;
  /** `finality_freeze_threshold`, in blocks (`HasStation.FinalityFreezeThreshold`). */
  finalityFreezeThresholdBlocks: number;
}

/** The R10.2 operands, all counted in FLOP blocks. */
export interface TimelockSymmetryInputs {
  /** `T_FLOP`: the FLOP-leg timelock. */
  tFlopBlocks: number;
  /** `T_other`: the foreign duration, converted with `toOneSecondBlocks`. */
  tOtherBlocks: number;
  /** `current_finality_lag`: `block_number - finalized_number`, read in the block evaluating admission. */
  currentFinalityLagBlocks: number;
  params: FlopSymmetryParams;
}

/** R10.2 refused an open. `reason` names the clause that refused it. */
export class FlopAdmissionError extends Error {
  constructor(
    readonly reason: "finality-freeze" | "timelock-symmetry",
    message: string,
  ) {
    super(message);
  }
}

const blockCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Exactly the three parameters, each a u32 as the runtime declares them. A missing,
 * misspelt or extra field throws rather than leaving a clause unconfigured.
 */
export function checkSymmetryParams(
  value: unknown,
): Readonly<FlopSymmetryParams> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).sort().join() !==
      "finalityFreezeThresholdBlocks,marginPercent,maxFinalityStallBlocks"
  )
    throw new Error(
      "flop: R10.2 parameters must be exactly marginPercent, maxFinalityStallBlocks and finalityFreezeThresholdBlocks",
    );
  const { marginPercent, maxFinalityStallBlocks, finalityFreezeThresholdBlocks } =
    value as FlopSymmetryParams;
  for (const n of [
    marginPercent,
    maxFinalityStallBlocks,
    finalityFreezeThresholdBlocks,
  ])
    if (!blockCount(n) || n > 0xffffffff)
      throw new Error("flop: R10.2 parameters must be u32 integers");
  return Object.freeze({
    marginPercent,
    maxFinalityStallBlocks,
    finalityFreezeThresholdBlocks,
  });
}

/**
 * R10.2 compares durations "after converting the foreign duration to one-second FLOP
 * blocks": `ceil(ms / 1000)`, fixed by the rule rather than by any nominal block time.
 */
export function toOneSecondBlocks(durationMs: number): number {
  if (!blockCount(durationMs))
    throw new Error(
      "flop: duration must be a non-negative safe integer of milliseconds",
    );
  // Exact: durationMs is a safe integer, so durationMs / 1000 never rounds across an integer.
  return Math.ceil(durationMs / 1000);
}

/**
 * R10.2 solved for the smallest admissible FLOP timelock, in blocks:
 * `T_other + max(ceil(T_other * p / 100), max_finality_stall + current_finality_lag)`.
 *
 * Pure arithmetic over block counts. Every operand must be a non-negative safe integer and
 * nothing is defaulted: a NaN, negative, fractional or missing operand throws rather than
 * reading as zero. It is the relation only; `checkTimelockSymmetry` applies the
 * finality-open gate before it, as R10.2 requires.
 */
export function timelockSymmetryMinimum(
  tOtherBlocks: number,
  params: Pick<FlopSymmetryParams, "marginPercent" | "maxFinalityStallBlocks">,
  currentFinalityLagBlocks: number,
): number {
  if (!blockCount(tOtherBlocks))
    throw new Error("flop: T_other must be a non-negative safe integer");
  if (
    typeof params !== "object" ||
    params === null ||
    !blockCount(params.marginPercent) ||
    !blockCount(params.maxFinalityStallBlocks)
  )
    throw new Error("flop: R10.2 parameters must be non-negative safe integers");
  if (!blockCount(currentFinalityLagBlocks))
    throw new Error("flop: finality lag must be a non-negative safe integer");
  const product = tOtherBlocks * params.marginPercent;
  const finalityMargin = params.maxFinalityStallBlocks + currentFinalityLagBlocks;
  if (!Number.isSafeInteger(product) || !Number.isSafeInteger(finalityMargin))
    throw new Error("flop: R10.2 operands overflow");
  // Exact: product is a safe integer, so product / 100 never rounds across an integer.
  const required = tOtherBlocks + Math.max(Math.ceil(product / 100), finalityMargin);
  if (!Number.isSafeInteger(required))
    throw new Error("flop: R10.2 operands overflow");
  return required;
}

/**
 * R10.2 admission in the order the yellow paper fixes. First the finality-open gate: an
 * open is refused when `current_finality_lag` is at or above `finality_freeze_threshold`.
 * Only below it is the relation evaluated, `T_FLOP >= timelockSymmetryMinimum(...)`, with
 * equality admitted. Throws `FlopAdmissionError` when a clause refuses, and a plain `Error`
 * for a malformed operand or parameter: nothing is read as zero.
 */
export function checkTimelockSymmetry(inputs: TimelockSymmetryInputs): void {
  if (typeof inputs !== "object" || inputs === null)
    throw new Error("flop: R10.2 operands are missing");
  const { tFlopBlocks, tOtherBlocks, currentFinalityLagBlocks: lag } = inputs;
  const params = checkSymmetryParams(inputs.params);
  if (!blockCount(tFlopBlocks))
    throw new Error("flop: T_FLOP must be a non-negative safe integer");
  if (!blockCount(tOtherBlocks))
    throw new Error("flop: T_other must be a non-negative safe integer");
  // Checked here, not only in the minimum: NaN >= threshold is false and would pass the gate.
  if (!blockCount(lag))
    throw new Error("flop: finality lag must be a non-negative safe integer");
  if (lag >= params.finalityFreezeThresholdBlocks)
    throw new FlopAdmissionError(
      "finality-freeze",
      `flop: finality lag ${lag} is at or above the R10.2 freeze threshold ${params.finalityFreezeThresholdBlocks}; the open is refused`,
    );
  const required = timelockSymmetryMinimum(tOtherBlocks, params, lag);
  if (tFlopBlocks < required)
    throw new FlopAdmissionError(
      "timelock-symmetry",
      `flop: timeout below the R10.2 symmetry minimum: ${tFlopBlocks} blocks offered, ${required} required (T_other ${tOtherBlocks}, finality lag ${lag})`,
    );
}
