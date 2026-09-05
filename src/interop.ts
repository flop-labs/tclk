// SPDX-License-Identifier: Apache-2.0
//
// tclk/1 interop mappings: a tclk contract is the *payment leg* of a job defined in
// another protocol, never a competing task schema. These are the total, pure mappings
// from tclk status onto the lifecycles agents already speak — the same shape
// `flopStateToA2A` gives the on-chain primitives.

import type { JobRef } from "./frames.js";
import type { TclkStatus } from "./machine.js";

/** The A2A task states, as the A2A spec defines them. */
export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "unknown";

/** Total mapping onto the A2A task state machine. */
export function tclkStatusToA2A(status: TclkStatus): A2ATaskState {
  switch (status) {
    case "proposed": return "submitted";
    case "accepted": return "submitted";
    // Funds committed, work in progress, awaiting the reveal.
    case "locked": return "working";
    case "claimed": return "completed";
    case "refunded": return "failed";
    case "cancelled": return "canceled";
  }
}

/** Virtuals ACP job phases (request → negotiation → transaction → evaluation → done). */
export type AcpPhase =
  | "request"
  | "negotiation"
  | "transaction"
  | "evaluation"
  | "completed"
  | "rejected";

/**
 * Total mapping onto ACP phases. ACP's evaluation sits inside `locked`: the evaluator
 * accepting delivery is the payee's cue to reveal — an ACP state transition is never
 * itself treated as execution proof (same stance as the Virtuals ACP bridge).
 */
export function tclkStatusToAcpPhase(status: TclkStatus): AcpPhase {
  switch (status) {
    case "proposed": return "request";
    case "accepted": return "negotiation";
    case "locked": return "transaction";
    case "claimed": return "completed";
    case "refunded": return "rejected";
    case "cancelled": return "rejected";
  }
}

/** Bind an offer to an A2A task. */
export function a2aJob(taskId: string, contextId?: string): JobRef {
  return contextId === undefined
    ? { proto: "a2a", id: taskId }
    : { proto: "a2a", id: taskId, context: contextId };
}

/**
 * Bind an offer to a Virtuals ACP job.
 *
 * `number` is accepted because an ACP job id reads as one, and `String(jobId)` was silently
 * wrong for two shapes of it. A job id above `Number.MAX_SAFE_INTEGER` has already been
 * rounded by the time this function sees it — `9007199254740993` arrives as
 * `9007199254740992` — and the offer id, then the contract id, commit to the *rounded*
 * value. The result is a payment leg bound to a job nobody opened, with every signature
 * valid and no error anywhere: the same failure the transport nonce path already refuses
 * numerically (see `mcp/src/technocore.ts`, "a stored nonce may exceed 2^53 and must stay
 * exact"). A non-integral or non-finite number was worse still, since `String()` renders it
 * as `1.5`, `NaN` or `1e+21` and the frame validator has no opinion on the contents of
 * `job.id`.
 *
 * So the numeric arm is narrowed to what it can carry losslessly, and the remedy is in the
 * message: pass the id as a decimal string, which is exact at any width. Builder-side only
 * — `validateFrame` and the decoder are untouched, because a frame already posted in a room
 * must keep decoding whatever it says.
 */
export function acpJob(jobId: string | number): JobRef {
  if (typeof jobId === "number" && !Number.isSafeInteger(jobId)) {
    throw new Error(
      `tclk: ACP job id ${jobId} is not a safe integer, so a number cannot carry it ` +
        "exactly — pass it as a decimal string. The offer and contract ids commit to this " +
        "value, and a rounded one binds the payment to a different job",
    );
  }
  return { proto: "acp", id: String(jobId) };
}
