// SPDX-License-Identifier: Apache-2.0
//
// tclk/1 interop mappings: a tclk contract is the *payment leg* of a job defined in
// another protocol, never a competing task schema. These are the total, pure mappings
// from tclk status onto the lifecycles agents already speak — the same shape
// `flopStateToA2A` gives the on-chain primitives.

import type { JobRef } from "./frames.js";
import type { TclkStatus } from "./machine.js";
import type { SettlementView } from "./settlement.js";

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

/**
 * The same two lifecycles, driven from a settlement view instead of from room status.
 *
 * `tclkStatusToA2A` and `tclkStatusToAcpPhase` report what the room says: a signed `reveal`
 * is enough for `completed`. These two report what a rail confirmed. `working`,
 * `completed` and `failed` (ACP: `transaction`, `completed`, and `rejected` after a lock)
 * each require rail evidence, so a consumer that pays attention to a job's state cannot be
 * moved by a frame alone. Use them wherever the answer is read as "was this job paid".
 *
 * A room assertion the rail has not confirmed never becomes progress: a non-terminal room
 * stays `submitted` (ACP: `negotiation`), and a terminal claim nobody could check is
 * `unknown` in A2A. ACP has no such phase, so it stays `negotiation` there too.
 */
export function settlementToA2A(view: SettlementView): A2ATaskState {
  switch (view.money) {
    case "funded": return "working";
    case "claimed": return "completed";
    case "refunded": return "failed";
    case "none": return view.coordination === "cancelled" ? "canceled" : "submitted";
    case "unverified":
    case "unfunded":
      return view.coordination === "locked" ? "submitted" : "unknown";
  }
}

/** See `settlementToA2A`. */
export function settlementToAcpPhase(view: SettlementView): AcpPhase {
  switch (view.money) {
    case "funded": return "transaction";
    case "claimed": return "completed";
    case "refunded": return "rejected";
    case "none":
      if (view.coordination === "cancelled") return "rejected";
      return view.coordination === "proposed" ? "request" : "negotiation";
    case "unverified":
    case "unfunded":
      return "negotiation";
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
