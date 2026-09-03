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

/** Bind an offer to a Virtuals ACP job. */
export function acpJob(jobId: string | number): JobRef {
  return { proto: "acp", id: String(jobId) };
}
