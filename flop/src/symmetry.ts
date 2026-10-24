// SPDX-License-Identifier: Apache-2.0

/**
 * The two runtime parameters of the yellow paper's R10.2 timelock-symmetry margin
 * (v0.5.0 §10). Read them from the live runtime constants; this package ships no values.
 */
export interface FlopSymmetryParams {
  /** `htlc_timelock_symmetry_safety_margin_percent`. */
  marginPercent: number;
  /** `max_finality_stall`, in blocks. */
  maxFinalityStallBlocks: number;
}

const blockCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * R10.2 solved for the smallest admissible FLOP timelock, in blocks:
 * `T_other + max(ceil(T_other * p / 100), max_finality_stall + current_finality_lag)`.
 *
 * Pure arithmetic over block counts. Every operand must be a non-negative safe integer and
 * nothing is defaulted: a NaN, negative, fractional or missing operand throws rather than
 * reading as zero. How FlopRail derives the operands, and why that is a testnet-only
 * approximation of R10.2 rather than conformance, is in the package README.
 */
export function timelockSymmetryMinimum(
  tOtherBlocks: number,
  params: FlopSymmetryParams,
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
