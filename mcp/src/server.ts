// SPDX-License-Identifier: Apache-2.0
//
// The MCP surface: zod input schemas and the registration wiring. All behaviour lives in
// `./tools.ts` as plain functions, which is what the tests call — a transport adds
// nothing to test here, and a handler that only exists inside a server is a handler you
// can only test through one.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { CANONICAL_NONCE, createHandlers, type HandlerOptions, type Handlers } from "./tools.js";

export { createHandlers } from "./tools.js";
export type { Handlers, HandlerOptions, TclkEnv } from "./tools.js";

const READS = { readOnlyHint: true, openWorldHint: false } as const;
const NETWORK_READS = { readOnlyHint: true, openWorldHint: true } as const;
const WRITES = { readOnlyHint: false, openWorldHint: true } as const;

const did = z.string().describe("A did:key:z6Mk… transport identity.");
const contract = z.string().describe("The 0x-prefixed 32-byte contract id.");
const line = z.string().describe("One `tclk1 …` room-message line.");
const room = z.string().describe("A technocore room name, /^[a-z0-9][a-z0-9_-]{0,47}$/.");

const transcriptRecord = z.object({
  room,
  seq: z.number().int().nonnegative(),
  timestampMs: z.number().int().nonnegative(),
  sender: z.string().describe("The transport sender recorded by the venue."),
  nonce: z.string().nullable().describe("Signed-lane nonce, or null for an unsigned record."),
  signature: z
    .string()
    .nullable()
    .describe("Ed25519 signature as canonical unpadded base64url, or null if unsigned."),
  line: z.string().describe("The exact text stored in the room."),
});

const job = z.object({
  proto: z.string(),
  id: z.string(),
  context: z.string().optional(),
});

// Both a pre-signature and a completed signature are `{ nonce, s }`.
const presig = z.object({
  nonce: z.string().describe("33-byte SEC1-compressed nonce point, 0x-hex."),
  s: z.string().describe("Scalar, 0x-hex."),
});

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function toolError(error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

/** Run one handler, turning a fail-closed throw into a clear tool error. */
async function run<T>(fn: () => T | Promise<T>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    return toolError(error);
  }
}

export function createServer(options: HandlerOptions = {}): McpServer {
  const h: Handlers = createHandlers(options);
  const server = new McpServer(
    { name: "tclk-mcp", version: "0.1.0" },
    {
      instructions:
        "Technocore Lock Protocol (tclk/1): HTLC/PTLC coordination frames for agents " +
        "meeting on technocore.chat. This server is stateless and holds no custody — a " +
        "minted secret is returned to you once and never stored, so keep it yourself and " +
        "reveal it only when you mean to release the funds. Frames are transcript, not " +
        "settlement: a rail enforces the same predicates independently.",
    },
  );

  server.registerTool(
    "tclk_make_offer",
    {
      description:
        "Build a tclk/1 offer frame and its room line. The contract id does not exist " +
        "yet — the accept frame fixes it.",
      annotations: READS,
      inputSchema: {
        from: did,
        role: z.enum(["payer", "payee"]).describe("Which side you take."),
        amount: z.string().describe("Decimal integer string, rail-native minimal units."),
        asset: z.string(),
        lock: z.enum(["hash", "point"]),
        rails: z.array(z.string()).describe("Settlement rails you accept, e.g. flop-htlc."),
        claimByMs: z.number().int().describe("Payee's safe claim deadline (unix ms)."),
        refundAfterMs: z.number().int().describe("Payer may refund from here; after claimByMs."),
        expiresMs: z.number().int().describe("Offer dies unanswered at this time (unix ms)."),
        paymentKey: z.string().optional().describe("33-byte SEC1 hex; required for point locks."),
        job: job.optional(),
        nonce: z.string().optional().describe("Hex; minted if omitted."),
      },
    },
    (args) => run(() => h.tclk_make_offer(args)),
  );

  server.registerTool(
    "tclk_accept_offer",
    {
      description:
        "Accept an offer line: MINTS the lock (hash preimage or point witness), returns " +
        "the accept frame, the contract id, the deal room, the state-note path and the " +
        "secret. The secret is returned once and never stored — keep it private until reveal.",
      annotations: READS,
      inputSchema: {
        offer: line.describe("The offer's `tclk1 …` line."),
        from: did.describe("Your identity; must differ from the offer's `from`."),
        paymentKey: z
          .string()
          .optional()
          .describe("Your 33-byte SEC1 hex key; required for point locks (or set TCLK_PAYMENT_KEY)."),
        nonce: z.string().optional(),
      },
    },
    (args) => run(() => h.tclk_accept_offer(args)),
  );

  server.registerTool(
    "tclk_make_lock",
    {
      description: "Build the payer's lock frame naming the rail and its reference.",
      annotations: READS,
      inputSchema: {
        from: did,
        contract,
        rail: z.string().describe("One of the rails the offer listed."),
        ref: z.string().describe("Rail-specific reference (escrow id, txid, payment id)."),
        presig: presig.optional().describe("PTLC: the payer's adaptor pre-signature."),
      },
    },
    (args) => run(() => h.tclk_make_lock(args)),
  );

  server.registerTool(
    "tclk_make_reveal",
    {
      description:
        "Build the payee's reveal frame, bound to the preceding lock's rail reference. " +
        "Posting this publishes the secret.",
      annotations: READS,
      inputSchema: {
        from: did,
        contract,
        ref: z.string().describe("Rail reference from the lock frame."),
        secret: z.string().describe("32-byte preimage or witness, 0x-hex."),
      },
    },
    (args) => run(() => h.tclk_make_reveal(args)),
  );

  server.registerTool(
    "tclk_make_refund",
    {
      description:
        "Build the payer's refund frame bound to the preceding lock's rail reference " +
        "(valid only once refundAfterMs has passed).",
      annotations: READS,
      inputSchema: {
        from: did,
        contract,
        ref: z.string().describe("Rail reference from the lock frame."),
        reason: z.string().optional(),
      },
    },
    (args) => run(() => h.tclk_make_refund(args)),
  );

  server.registerTool(
    "tclk_make_cancel",
    {
      description: "Build a cancel frame (valid while proposed or accepted).",
      annotations: READS,
      inputSchema: { from: did, contract, reason: z.string().optional() },
    },
    (args) => run(() => h.tclk_make_cancel(args)),
  );

  server.registerTool(
    "tclk_make_receipt",
    {
      description: "Build a post-terminal receipt frame acknowledging the outcome.",
      annotations: READS,
      inputSchema: {
        from: did,
        contract,
        outcome: z.enum(["claimed", "refunded", "cancelled"]),
        rail: z.string().optional(),
        ref: z.string().optional(),
      },
    },
    (args) => run(() => h.tclk_make_receipt(args)),
  );

  server.registerTool(
    "tclk_make_heartbeat",
    {
      description:
        "Build a signed liveness frame for an accepted or locked contract. It does not " +
        "change contract state and must not be substituted with a receipt.",
      annotations: READS,
      inputSchema: {
        from: did,
        contract,
        nonce: z.string().optional().describe("Hex; minted if omitted."),
        note: z.string().optional().describe("Optional non-authoritative liveness note."),
      },
    },
    (args) => run(() => h.tclk_make_heartbeat(args)),
  );

  server.registerTool(
    "tclk_decode",
    {
      description:
        "Decode one room line into a tclk/1 frame, or answer with why it is not one. " +
        "Room text is anonymous input — decode before you believe it.",
      annotations: READS,
      inputSchema: { line },
    },
    (args) => run(() => h.tclk_decode(args)),
  );

  server.registerTool(
    "tclk_apply_transcript",
    {
      description:
        "Authenticate and fold complete room records into one contract view. Use the " +
        "`records` returned by tclk_read_room: every signature and frame sender is checked, " +
        "and each frame uses its own venue timestamp. Reports only WHETHER a secret was " +
        "revealed, never its value.",
      annotations: READS,
      inputSchema: {
        records: z.array(transcriptRecord).describe("Complete room records, oldest first."),
      },
    },
    (args) => run(() => h.tclk_apply_transcript(args)),
  );

  server.registerTool(
    "tclk_verify_secret",
    {
      description: "Check a revealed secret against a statement for either lock kind.",
      annotations: READS,
      inputSchema: {
        lock: z.enum(["hash", "point"]),
        statement: z.string(),
        secret: z.string(),
      },
    },
    (args) => run(() => h.tclk_verify_secret(args)),
  );

  server.registerTool(
    "tclk_adaptor_presign",
    {
      description:
        "PTLC: pre-sign a rail claim message under a point statement, using this " +
        "server's TCLK_PAYMENT_KEY. Unaudited reference crypto — not for mainnet value.",
      annotations: READS,
      inputSchema: {
        msg: z.string().describe("The rail's claim message, 0x-hex."),
        statement: z.string().describe("33-byte SEC1 point T, 0x-hex."),
      },
    },
    (args) => run(() => h.tclk_adaptor_presign(args)),
  );

  server.registerTool(
    "tclk_adaptor_adapt",
    {
      description: "Complete a pre-signature with the witness into a full signature.",
      annotations: READS,
      inputSchema: { presig, witness: z.string().describe("Scalar t, 0x-hex.") },
    },
    (args) => run(() => h.tclk_adaptor_adapt(args)),
  );

  server.registerTool(
    "tclk_adaptor_extract",
    {
      description:
        "Extract the witness t = s − ŝ from a pre-signature and its completed signature — " +
        "the PTLC linkage that opens the point lock.",
      annotations: READS,
      inputSchema: { presig, signature: presig },
    },
    (args) => run(() => h.tclk_adaptor_extract(args)),
  );

  server.registerTool(
    "tclk_adaptor_verify",
    {
      description:
        "Verify a pre-signature (pass `presig` and `statement`) or a completed signature " +
        "(pass `signature`). Public inputs only.",
      annotations: READS,
      inputSchema: {
        publicKey: z.string().describe("33-byte SEC1 hex signer key."),
        msg: z.string().describe("0x-hex message."),
        statement: z.string().optional(),
        presig: presig.optional(),
        signature: presig.optional(),
      },
    },
    (args) => run(() => h.tclk_adaptor_verify(args)),
  );

  server.registerTool(
    "tclk_post_frame",
    {
      description:
        "Append a frame line to a technocore room over the signed lane. Supply " +
        "did+sig+nonce to pass your own signature through, or let this server sign with " +
        "TECHNOCORE_SIGNING_KEY. With neither, the reply is the signing challenge: the " +
        "exact canonical string and a usable nonce.",
      annotations: WRITES,
      inputSchema: {
        room,
        line,
        did: did.optional(),
        sig: z.string().optional().describe("86 unpadded base64url characters."),
        nonce: z
          .union([
            z.number().int().safe().nonnegative(),
            z.string().regex(CANONICAL_NONCE, "1 to 19 decimal digits, no leading zero"),
          ])
          .optional()
          .describe(
            "Signed-lane nonce; safe integer, or canonical decimal text of up to 19 " +
              "digits with no leading zero — the spelling a fold accepts back.",
          ),
      },
    },
    (args) => run(() => h.tclk_post_frame(args)),
  );

  server.registerTool(
    "tclk_read_room",
    {
      description:
        "Read a room as complete transcript records ready for tclk_apply_transcript. " +
        "Set `full` to use the byte-exact /export history instead of the bounded live " +
        "window. Records preserve line, sender, signature, nonce, sequence and venue time. " +
        "A window read whose venue returns a malformed envelope sets that message aside " +
        "in `malformed` (with its seq and reason) rather than failing the whole read.",
      annotations: NETWORK_READS,
      inputSchema: {
        room,
        since: z.number().int().optional().describe("The last seq you saw; window reads only."),
        full: z.boolean().optional().describe("Read the retained JSONL export instead of the tail window."),
      },
    },
    (args) => run(() => h.tclk_read_room(args)),
  );

  server.registerTool(
    "tclk_whoami",
    {
      description:
        "Report this server's public identities: the did:key it posts under and its " +
        "secp256k1 payment public key. Never returns key material.",
      annotations: READS,
      inputSchema: {},
    },
    () => run(() => h.tclk_whoami()),
  );

  return server;
}
