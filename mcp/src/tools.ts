// SPDX-License-Identifier: Apache-2.0
//
// The tclk/1 tool handlers, as plain functions — no transport, no state, no custody.
//
// Every tool is a pure transform over its inputs plus, for the two transport tools, one
// HTTP call. Nothing is written to disk and nothing is cached across calls: a minted
// secret (hash preimage or point witness) is RETURNED to the caller in the same reply
// that mints it and is never stored, logged, or echoed back by any later tool. That is
// why `tclk_apply_transcript` reports only whether a secret is present, never its value.
//
// Keys come from the environment and stay there: `TECHNOCORE_SIGNING_KEY` (Ed25519 seed,
// the technocore transport identity) and `TCLK_PAYMENT_KEY` (secp256k1 scalar, adaptor
// pre-signatures). Neither is echoed by any tool, `tclk_whoami` included.

import {
  applyFrame,
  decodeFrame,
  dealRoom,
  encodeFrame,
  generateHashLock,
  generatePointLock,
  makeAccept,
  makeOffer,
  openContract,
  schnorrAdaptor,
  stateNote,
  tryDecodeFrame,
  verifySecret,
  type ContractState,
  type JobRef,
  type LockKind,
  type OfferFrame,
  type PresigRef,
  type TclkFrame,
} from "@flop-labs/tclk";

import { canonicalMessage, loadSigner, nextNonce, sweep, type Signer } from "./signing.js";
import {
  createClient,
  DEFAULT_TECHNOCORE_URL,
  type FetchLike,
  type TechnocoreClient,
} from "./technocore.js";

export interface TclkEnv {
  TECHNOCORE_SIGNING_KEY?: string;
  TCLK_PAYMENT_KEY?: string;
  TECHNOCORE_URL?: string;
}

export interface HandlerOptions {
  env?: TclkEnv;
  fetch?: FetchLike;
}

function fail(msg: string): never {
  throw new Error(`tclk-mcp: ${msg}`);
}

/** 0x-prefixed lowercase 32-byte hex, the spelling the core's crypto expects. */
function normalizeScalar(spec: string, name: string): string {
  const trimmed = spec.trim();
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    fail(`${name} must be a 32-byte scalar as 64 hex characters`);
  }
  return `0x${(trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed).toLowerCase()}`;
}

function asOffer(line: string): OfferFrame {
  const frame = decodeFrame(line);
  if (frame.type !== "offer") fail(`expected an offer line, got a ${frame.type} frame`);
  return frame;
}

/** `{ frame, line }` — the shape every builder tool answers with. */
function built(frame: TclkFrame): { frame: TclkFrame; line: string } {
  return { frame, line: encodeFrame(frame) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface MakeOfferInput {
  from: string;
  role: "payer" | "payee";
  amount: string;
  asset: string;
  lock: LockKind;
  rails: string[];
  claimByMs: number;
  refundAfterMs: number;
  expiresMs: number;
  paymentKey?: string;
  job?: JobRef;
  nonce?: string;
}

export interface AcceptOfferInput {
  offer: string;
  from: string;
  paymentKey?: string;
  nonce?: string;
}

export interface PostFrameInput {
  room: string;
  line: string;
  did?: string;
  sig?: string;
  nonce?: number;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export function createHandlers(options: HandlerOptions = {}) {
  const env = options.env ?? (process.env as TclkEnv);
  const technocoreUrl = env.TECHNOCORE_URL?.trim() || DEFAULT_TECHNOCORE_URL;
  const client: TechnocoreClient = createClient({ baseUrl: technocoreUrl, fetch: options.fetch });

  // Both keys are parsed once, at construction, so a malformed one surfaces as a clear
  // error on the first tool that needs it rather than as a silent no-identity fallback.
  const signer: Signer | null = env.TECHNOCORE_SIGNING_KEY?.trim()
    ? loadSigner(env.TECHNOCORE_SIGNING_KEY)
    : null;
  const paymentKey: string | null = env.TCLK_PAYMENT_KEY?.trim()
    ? normalizeScalar(env.TCLK_PAYMENT_KEY, "TCLK_PAYMENT_KEY")
    : null;

  function paymentPublicKey(): string | null {
    if (paymentKey === null) return null;
    const pub = schnorrAdaptor.getPublicKey(paymentKey);
    if (pub === null) fail("TCLK_PAYMENT_KEY is not a valid secp256k1 scalar");
    return pub;
  }

  return {
    // ── Offer / accept ───────────────────────────────────────────────────────

    tclk_make_offer(input: MakeOfferInput) {
      const frame = makeOffer(input);
      return {
        ...built(frame),
        dealNote:
          "The contract id does not exist yet: it is fixed by the accept frame, which " +
          "binds this whole offer to the acceptor's statement. Derive the deal room and " +
          "state note from the accept, not from this offer id.",
      };
    },

    /**
     * Mint the lock and accept. The acceptor is the payee-side secret holder, so the
     * secret is minted here and handed back once — it is not stored anywhere.
     */
    tclk_accept_offer(input: AcceptOfferInput) {
      const offer = asOffer(input.offer);
      const acceptorKey =
        input.paymentKey ?? (offer.lock === "point" ? (paymentPublicKey() ?? undefined) : undefined);
      if (offer.lock === "point" && acceptorKey === undefined) {
        fail(
          "this offer is a point lock, which requires the acceptor's paymentKey: pass " +
            "`paymentKey` (33-byte SEC1 hex) or set TCLK_PAYMENT_KEY",
        );
      }
      const minted =
        offer.lock === "hash"
          ? (() => {
              const lock = generateHashLock();
              return { statement: lock.hash, secret: lock.preimage };
            })()
          : (() => {
              const lock = generatePointLock();
              return { statement: lock.statement, secret: lock.witness };
            })();

      const frame = makeAccept(offer, {
        from: input.from,
        statement: minted.statement,
        paymentKey: acceptorKey,
        nonce: input.nonce,
      });
      return {
        ...built(frame),
        contract: frame.contract,
        statement: minted.statement,
        secret: minted.secret,
        dealRoom: dealRoom(frame.contract),
        stateNote: stateNote(frame.contract),
        warning:
          "keep `secret` private until reveal — it is minted here, returned once, and " +
          "never persisted by this server. Revealing it early lets anyone claim.",
      };
    },

    // ── Thin frame builders ──────────────────────────────────────────────────

    tclk_make_lock(input: { from: string; contract: string; rail: string; ref: string; presig?: PresigRef }) {
      return built({ type: "lock", ...input });
    },

    tclk_make_reveal(input: { from: string; contract: string; secret: string }) {
      return built({ type: "reveal", ...input });
    },

    tclk_make_refund(input: { from: string; contract: string; reason?: string }) {
      return built({ type: "refund", ...input });
    },

    tclk_make_cancel(input: { from: string; contract: string; reason?: string }) {
      return built({ type: "cancel", ...input });
    },

    tclk_make_receipt(input: {
      from: string;
      contract: string;
      outcome: "claimed" | "refunded" | "cancelled";
      rail?: string;
      ref?: string;
    }) {
      return built({ type: "receipt", ...input });
    },

    // ── Transcript ───────────────────────────────────────────────────────────

    tclk_decode(input: { line: string }) {
      const frame = tryDecodeFrame(input.line);
      if (frame !== null) return { ok: true as const, frame };
      try {
        decodeFrame(input.line);
      } catch (error) {
        return { ok: false as const, error: errorMessage(error) };
      }
      return { ok: false as const, error: "tclk: frame did not decode" };
    },

    /**
     * Fold a room transcript into one contract view. Lines are anonymous input, so
     * nothing here throws on a bad one: every line gets an `{ ok, reason }` verdict and
     * money-state only advances on frames that verify.
     *
     * `senders[i]` is the transport-verified `from` of the record that carried `lines[i]`
     * — `tclk_read_room` returns it as `from` on every frame. Supplying it is what makes
     * the party guards mean anything: SPEC §2 requires a frame's own `from` to match the
     * signed-lane sender, and a fold over bare lines cannot check that, because the only
     * two identities it can see both came out of the same attacker-writable JSON body.
     * A mismatch is a per-line rejection like any other, never a throw. Sparse arrays are
     * fine: an absent entry leaves that line unchecked.
     */
    tclk_apply_transcript(input: { lines: string[]; nowMs?: number; senders?: string[] }) {
      const nowMs = input.nowMs ?? Date.now();
      const steps: { index: number; type?: string; ok: boolean; reason?: string }[] = [];
      let state: ContractState | null = null;
      // Why the first offer frame did not open a contract, if one was tried. Without it
      // a transcript whose offer was rejected reports "contains no offer frame", which
      // is the one thing that is not true about it.
      let openFailure: string | null = null;

      input.lines.forEach((line, index) => {
        const frame = tryDecodeFrame(line);
        if (frame === null) {
          let reason = "not a tclk/1 frame";
          try {
            decodeFrame(line);
          } catch (error) {
            reason = errorMessage(error);
          }
          steps.push({ index, ok: false, reason });
          return;
        }
        if (state === null) {
          if (frame.type !== "offer") {
            steps.push({ index, type: frame.type, ok: false, reason: "no contract open yet" });
            return;
          }
          try {
            state = openContract(frame, input.senders?.[index]);
            steps.push({ index, type: "offer", ok: true });
          } catch (error) {
            const reason = errorMessage(error);
            openFailure ??= reason;
            steps.push({ index, type: "offer", ok: false, reason });
          }
          return;
        }
        const result = applyFrame(state, frame, nowMs, input.senders?.[index]);
        state = result.state;
        steps.push({ index, type: frame.type, ok: result.ok, reason: result.reason });
      });

      if (state === null) {
        fail(
          openFailure === null
            ? "transcript contains no offer frame to open a contract from"
            : `no contract could be opened: ${openFailure}`,
        );
      }
      const open: ContractState = state;

      return {
        status: open.status,
        contract: open.contract ?? null,
        offerId: open.offer.id,
        parties: {
          payer: open.payerDid ?? null,
          payee: open.payeeDid ?? null,
          payerKey: open.payerKey ?? null,
          payeeKey: open.payeeKey ?? null,
        },
        statement: open.statement ?? null,
        rail: open.rail ?? null,
        railRef: open.railRef ?? null,
        // The revealed secret is deliberately NOT echoed: it is in the transcript the
        // caller already holds, and this server never republishes secret material.
        secretRevealed: open.secret !== undefined,
        steps,
      };
    },

    tclk_verify_secret(input: { lock: LockKind; statement: string; secret: string }) {
      return { valid: verifySecret(input.lock, input.statement, input.secret) };
    },

    // ── Adaptor signatures (unaudited reference crypto) ──────────────────────

    tclk_adaptor_presign(input: { msg: string; statement: string }) {
      if (paymentKey === null) {
        return {
          ok: false as const,
          error: "no payment key",
          hint:
            "set TCLK_PAYMENT_KEY to a 32-byte secp256k1 scalar (64 hex characters) in " +
            "this server's environment, then retry. This server never accepts a secret " +
            "key as a tool argument.",
        };
      }
      const presig = schnorrAdaptor.preSign(paymentKey, input.msg, input.statement);
      if (presig === null) {
        return { ok: false as const, error: "pre-sign failed: malformed msg or statement" };
      }
      return { ok: true as const, presig, publicKey: paymentPublicKey() };
    },

    tclk_adaptor_adapt(input: { presig: PresigRef; witness: string }) {
      const signature = schnorrAdaptor.adapt(input.presig, input.witness);
      if (signature === null) {
        return { ok: false as const, error: "adapt failed: malformed pre-signature or witness" };
      }
      return { ok: true as const, signature };
    },

    tclk_adaptor_extract(input: { presig: PresigRef; signature: PresigRef }) {
      const witness = schnorrAdaptor.extractWitness(input.presig, input.signature);
      if (witness === null) {
        return { ok: false as const, error: "extract failed: malformed pre-signature or signature" };
      }
      return { ok: true as const, witness };
    },

    tclk_adaptor_verify(input: {
      publicKey: string;
      msg: string;
      statement?: string;
      presig?: PresigRef;
      signature?: PresigRef;
    }) {
      if ((input.presig === undefined) === (input.signature === undefined)) {
        fail("pass exactly one of `presig` (with `statement`) or `signature`");
      }
      if (input.presig !== undefined) {
        if (input.statement === undefined) fail("verifying a pre-signature needs `statement`");
        return {
          kind: "presignature" as const,
          valid: schnorrAdaptor.verifyPreSignature(
            input.publicKey,
            input.msg,
            input.statement,
            input.presig,
          ),
        };
      }
      return {
        kind: "signature" as const,
        valid: schnorrAdaptor.verifySignature(input.publicKey, input.msg, input.signature!),
      };
    },

    // ── Transport ────────────────────────────────────────────────────────────

    /**
     * Post a frame to a room. Three tiers, decided in one place (mirroring
     * technocore-mcp's `_resolve_signature`): externally supplied did+sig+nonce pass
     * through; otherwise a configured signing key signs here; otherwise the reply IS the
     * signing challenge — the exact canonical string and a usable nonce — because a tool
     * call that cannot sign is a request for a signature, not an empty failure.
     */
    async tclk_post_frame(input: PostFrameInput) {
      // A frame that does not decode must never reach the room: rooms are the shared
      // transcript, and a malformed line there is a permanent record no one can fold.
      decodeFrame(input.line);
      const text = sweep(input.line);
      if (text !== input.line) fail("frame line does not survive the single-line sweep");

      const supplied = [input.did, input.sig, input.nonce].filter((v) => v !== undefined).length;
      if (supplied > 0 && supplied < 3) {
        fail("pass all three of `did`, `sig` and `nonce`, or none of them");
      }

      if (supplied === 3) {
        const response = await client.postSigned(input.room, {
          did: input.did!,
          sig: input.sig!,
          nonce: input.nonce!,
          text,
        });
        return { posted: true as const, tier: "caller-signed", room: input.room, did: input.did!, nonce: input.nonce!, response };
      }

      const nonce = nextNonce();
      if (signer !== null) {
        const response = await client.postSigned(input.room, {
          did: signer.did,
          sig: signer.sign(canonicalMessage(input.room, nonce, text)),
          nonce,
          text,
        });
        return { posted: true as const, tier: "server-signed", room: input.room, did: signer.did, nonce, response };
      }

      return {
        posted: false as const,
        reason: "no signing identity",
        room: input.room,
        nonce,
        canonical: canonicalMessage(input.room, nonce, text),
        text,
        hint:
          "Sign `canonical` exactly, as UTF-8, with Ed25519; encode the 64-byte signature " +
          "as unpadded base64url; then call tclk_post_frame again with `did`, `sig` and " +
          `this \`nonce\` (${nonce}). Or set TECHNOCORE_SIGNING_KEY on this server.`,
      };
    },

    /**
     * Read a room and return its decodable frames, each carrying the venue's own verdict
     * on who sent it.
     *
     * `from` is the record's transport-verified sender; `frame.from` is a field inside a
     * body anyone with a socket can write. They are different things, and SPEC §2 requires
     * them to match, so this reports the comparison rather than leaving a caller to notice
     * that it never happened: `signed` says the venue carried a signature at all (the
     * unsigned lane carries none, and its `from` is a nickname that can never be a
     * did:key), and `attributed` says the frame is what its own `from` claims. Nothing is
     * dropped — an unattributed frame is still a fact about the room, and hiding it would
     * lose the evidence that someone tried. Feed `senders` to `tclk_apply_transcript` to
     * have the fold enforce it.
     */
    async tclk_read_room(input: { room: string; since?: number }) {
      const view = await client.readRoom(input.room, input.since);
      const frames: {
        seq: number;
        ts: string;
        from: string;
        signed: boolean;
        attributed: boolean;
        frame: TclkFrame;
      }[] = [];
      let skipped = 0;
      let unattributed = 0;
      for (const message of view.messages) {
        const frame = typeof message.text === "string" ? tryDecodeFrame(message.text) : null;
        if (frame === null) {
          skipped += 1;
          continue;
        }
        const signed = typeof message.sig === "string" && message.sig.length > 0;
        const attributed = signed && message.from === frame.from;
        if (!attributed) unattributed += 1;
        frames.push({ seq: message.seq, ts: message.ts, from: message.from, signed, attributed, frame });
      }
      return {
        room: view.room,
        frames,
        senders: frames.map((f) => f.from),
        skipped,
        unattributed,
        lastSeq: view.last_seq,
      };
    },

    tclk_whoami() {
      const notes: string[] = [];
      if (signer === null) notes.push("no signing key: set TECHNOCORE_SIGNING_KEY to post signed frames");
      if (paymentKey === null) notes.push("no payment key: set TCLK_PAYMENT_KEY to make adaptor pre-signatures");
      return {
        technocoreUrl,
        // Public identities only. The seeds behind them are never returned.
        did: signer?.did ?? null,
        paymentPublicKey: paymentPublicKey(),
        notes,
      };
    },
  };
}

export type Handlers = ReturnType<typeof createHandlers>;
