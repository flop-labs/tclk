// SPDX-License-Identifier: Apache-2.0
//
// The paper rail: a settlement rail that settles nothing.
//
// ⚠️ IT HOLDS NO VALUE AND CANNOT. Every other rail is backed by something that
// arbitrates — a chain enforcing "reveal the secret or the timelock refunds", a contract
// neither party can override. This one is backed by a note on a chat service that holds
// no funds, executes nothing, and says so itself. Its records are world-writable: anyone
// can overwrite any status on any contract, and nothing here moves a coin, because there
// is no coin.
//
// It exists for one honest job: letting the whole choreography run end to end, on the
// real venue, between two processes that share no memory — so the protocol can be
// demonstrated and exercised before a rail that holds value exists. Treat a `paper` deal
// as a rehearsal. `verifyLock` returning true means a string is present in a namespace a
// stranger could have written; it is evidence of a rehearsal, never of a payment.
//
// Two-party fair exchange without an arbiter is impossible (Even–Yacobi; Pagnia–Gärtner),
// so this is not a weaker escrow — it is not escrow. A rail that holds value needs an
// arbiter, which is what the on-chain rails in SPEC.md §5 are for.

import { isValidStatement, type LockKind } from "./frames.js";
import { verifySecret } from "./locks.js";
import type { LockTerms, SettlementRail } from "./rail.js";

/** The record version, so a later shape cannot be mistaken for this one. */
export const PAPER_RECORD_PREFIX = "tclkpaper1" as const;

/**
 * The note surface the paper rail records onto. Kept as an interface so the library
 * stays free of network code: the caller supplies the venue transport (see the
 * walkthrough in examples/), and tests supply a map.
 *
 * `set` returns false when a conditional write loses — the venue answers 409 and carries
 * the value that is actually there.
 */
export interface NoteStore {
  get(ns: string, key: string): Promise<string | null>;
  set(
    ns: string,
    key: string,
    value: string,
    condition?: { ifAbsent: true } | { if: string },
  ): Promise<boolean>;
}

export type PaperStatus = "locked" | "claimed" | "refunded";

export interface PaperRecord {
  status: PaperStatus;
  lock: LockKind;
  statement: string;
  refundAfterMs: number;
  /** Present once claimed — the secret is public by then anyway, it was the claim. */
  secret?: string;
}

const CONTRACT_ID = /^0x[0-9a-f]{64}$/;

/**
 * Serialize a record to one note line. Single-line and space-separated so a human, a
 * shell, or an agent with only a fetch tool can read the state without a parser.
 */
export function encodePaperRecord(record: PaperRecord): string {
  const head = `${PAPER_RECORD_PREFIX} ${record.status} ${record.lock} ${record.statement} ${record.refundAfterMs}`;
  return record.secret === undefined ? head : `${head} ${record.secret}`;
}

/**
 * Parse a note line. Null on anything malformed — this namespace is world-writable, so
 * every read is anonymous input and a bad line must not throw inside a polling loop.
 */
export function decodePaperRecord(value: string): PaperRecord | null {
  const parts = value.split(" ");
  if (parts.length < 5 || parts.length > 6) return null;
  const [prefix, status, lock, statement, refundAfter, secret] = parts;
  if (prefix !== PAPER_RECORD_PREFIX) return null;
  if (status !== "locked" && status !== "claimed" && status !== "refunded") return null;
  if (lock !== "hash" && lock !== "point") return null;
  if (!isValidStatement(lock, statement)) return null;
  const refundAfterMs = Number(refundAfter);
  if (!Number.isSafeInteger(refundAfterMs) || refundAfterMs <= 0) return null;
  if (secret !== undefined && !/^0x[0-9a-f]{64}$/.test(secret)) return null;
  if ((status === "claimed") !== (secret !== undefined)) return null;
  return { status, lock, statement, refundAfterMs, ...(secret === undefined ? {} : { secret }) };
}

/** Where a contract's paper record lives, sharded like the state note. */
export function paperNote(contract: string): { ns: string; key: string } {
  if (!CONTRACT_ID.test(contract)) throw new Error(`tclk: malformed contract id: ${contract}`);
  return { ns: `tclk-paper-${contract.slice(2, 4)}`, key: contract.slice(4, 18) };
}

/**
 * A rail that records the lock/claim/refund lifecycle and backs it with nothing.
 *
 * It enforces the same predicates a real rail must — one lock per contract, claim only
 * with a secret that opens the statement and only strictly before `refundAfterMs`, refund
 * only at or after it — so a client written against this rail is written correctly. What
 * it cannot do is make any of that binding on a counterparty, because no value is at
 * stake and the record is world-writable.
 */
export class PaperRail implements SettlementRail {
  readonly id = "paper";
  private readonly notes: NoteStore;
  private readonly clock: () => number;

  constructor(notes: NoteStore, clock: () => number = Date.now) {
    this.notes = notes;
    this.clock = clock;
  }

  async lock(terms: LockTerms): Promise<string> {
    if (this.clock() >= terms.refundAfterMs) {
      throw new Error("tclk: refusing to lock into an already-open refund window");
    }
    // The record only stores lowercase canonical spellings (decodePaperRecord enforces
    // them), so refuse a non-canonical statement here rather than writing a record no
    // reader can parse back. Honest terms always come from lockTerms() over an accepted
    // contract, where the statement already passed isValidStatement.
    if (!isValidStatement(terms.lock, terms.statement)) {
      throw new Error("tclk: paper rail lock statement does not fit its lock kind");
    }
    if (!Number.isSafeInteger(terms.refundAfterMs) || terms.refundAfterMs <= 0) {
      throw new Error("tclk: paper rail lock refundAfterMs must be a positive unix-ms integer");
    }
    const { ns, key } = paperNote(terms.contract);
    const record: PaperRecord = {
      status: "locked",
      lock: terms.lock,
      statement: terms.statement,
      refundAfterMs: terms.refundAfterMs,
    };
    const won = await this.notes.set(ns, key, encodePaperRecord(record), { ifAbsent: true });
    if (!won) throw new Error(`tclk: paper rail already has a record for ${terms.contract}`);
    return terms.contract;
  }

  async verifyLock(terms: LockTerms, ref: string): Promise<boolean> {
    if (ref !== terms.contract) return false;
    // read() returns null for malformed ids and unparseable lines, so a malformed
    // input ends here as false. A transport failure from notes.get still throws,
    // which is correct: that is an outage, not a negative answer.
    const record = await this.read(ref);
    return (
      record !== null &&
      record.status === "locked" &&
      record.lock === terms.lock &&
      record.statement === terms.statement &&
      record.refundAfterMs === terms.refundAfterMs
    );
  }

  async claim(ref: string, secret: string): Promise<void> {
    const { current, record } = await this.requireLocked(ref, "claim");
    if (this.clock() >= record.refundAfterMs) throw new Error("tclk: claim after refundAfterMs");
    // verifySecret accepts uppercase hex, but the record encoding is canonical
    // lowercase. Store the lowercase spelling so a successful claim stays readable
    // (decodePaperRecord requires it) instead of becoming unauditable.
    const canonicalSecret = secret.toLowerCase();
    if (!verifySecret(record.lock, record.statement, canonicalSecret)) {
      throw new Error("tclk: secret does not open the statement");
    }
    await this.advance(ref, current, { ...record, status: "claimed", secret: canonicalSecret });
  }

  async refund(ref: string): Promise<void> {
    const { current, record } = await this.requireLocked(ref, "refund");
    if (this.clock() < record.refundAfterMs) throw new Error("tclk: refund before refundAfterMs");
    await this.advance(ref, current, { ...record, status: "refunded" });
  }

  /** The record as it stands, or null when absent or unparseable. */
  async read(ref: string): Promise<PaperRecord | null> {
    let ns: string;
    let key: string;
    try {
      ({ ns, key } = paperNote(ref));
    } catch {
      return null;
    }
    const value = await this.notes.get(ns, key);
    return value === null ? null : decodePaperRecord(value);
  }

  private async requireLocked(
    ref: string,
    op: string,
  ): Promise<{ current: string; record: PaperRecord }> {
    const { ns, key } = paperNote(ref);
    const current = await this.notes.get(ns, key);
    if (current === null) throw new Error(`tclk: ${op} on an unknown paper record ${ref}`);
    const record = decodePaperRecord(current);
    if (record === null) throw new Error(`tclk: ${op} on an unreadable paper record ${ref}`);
    if (record.status !== "locked") throw new Error(`tclk: ${op} on a ${record.status} record`);
    return { current, record };
  }

  /**
   * Move the record with a compare-and-set against the exact bytes read. That closes the
   * lost-update race between two of your own workers; it does NOT fence a stranger, who
   * can overwrite this note at any point — the venue orders writes, it does not own them.
   */
  private async advance(ref: string, expected: string, next: PaperRecord): Promise<void> {
    const { ns, key } = paperNote(ref);
    const won = await this.notes.set(ns, key, encodePaperRecord(next), { if: expected });
    if (!won) throw new Error(`tclk: paper record for ${ref} changed under us`);
  }
}

/** An in-memory NoteStore, for tests and for a dry run with no network. */
export class MemoryNoteStore implements NoteStore {
  private readonly values = new Map<string, string>();

  async get(ns: string, key: string): Promise<string | null> {
    return this.values.get(`${ns}/${key}`) ?? null;
  }

  async set(
    ns: string,
    key: string,
    value: string,
    condition?: { ifAbsent: true } | { if: string },
  ): Promise<boolean> {
    const path = `${ns}/${key}`;
    const current = this.values.get(path);
    if (condition !== undefined) {
      if ("ifAbsent" in condition && current !== undefined) return false;
      if ("if" in condition && current !== condition.if) return false;
    }
    this.values.set(path, value);
    return true;
  }

  /** Test helper: the raw stored line, exactly as a reader of the venue would see it. */
  raw(ns: string, key: string): string | undefined {
    return this.values.get(`${ns}/${key}`);
  }
}
