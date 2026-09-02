#!/usr/bin/env python3
"""tclk/1 hash-lock walkthrough — a stdlib-only Python port of the wire format.

Run it:

    python examples/hashlock_walkthrough.py

Two things happen, in order:

1. The three golden vectors from `tests/vectors.test.ts` are recomputed here and
   compared byte-for-byte. If any of them disagree this script refuses to run the
   rest — a port that drifts from the vectors is wrong, never the vectors. That
   makes this file an executable cross-language check: an implementer in any
   language can diff their canonical lines and ids against what this prints.

2. A complete hash-lock deal runs offline between two parties — offer, accept,
   lock on an in-memory rail, reveal, receipt — printing every frame exactly as
   it would sit in a room message, plus each state transition. Deterministic on
   purpose (fixed nonces, fixed preimage): run it twice, get the same transcript.

No dependencies, no network, no venue. The transport layer (posting these lines
through technocore's signed lane) is deliberately out of scope — `interop.md` in
technocore-chat shows that loop, and `examples/live-deal.mjs` here drives it for
real. This file is only the frames, the ids, and the state machine.
"""

import hashlib
import json
import re
import sys

# ── Constants (SPEC.md §3) ───────────────────────────────────────────────────

TCLK_PREFIX = "tclk1 "
TCLK_DOMAIN = "FLOP::tclk::v1"
MAX_FRAME_CHARS = 4096

HEX32 = re.compile(r"^0x[0-9a-f]{64}$")
DID = re.compile(r"^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$")
AMOUNT = re.compile(r"^[1-9][0-9]*$")
NONCE = re.compile(r"^[0-9a-f]{8,64}$")
RAIL = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


class TclkError(Exception):
    pass


def fail(msg):
    raise TclkError(f"tclk: {msg}")


# ── Canonical encoding (frames.ts: canonicalJson + toAscii) ──────────────────


def canonical_json(value):
    """Deterministic JSON: sorted keys, compact separators, absent keys dropped.

    Scalars go through json.dumps with ensure_ascii=True, which emits the same
    lowercase \\uXXXX escapes (UTF-16 code units, surrogate pairs included) as
    the reference implementation's JSON.stringify + toAscii pass.
    """
    if isinstance(value, dict):
        parts = []
        for key in sorted(value.keys()):
            if value[key] is None:  # Python's spelling of "undefined: dropped"
                continue
            parts.append(f"{json.dumps(key, ensure_ascii=True)}:{canonical_json(value[key])}")
        return "{" + ",".join(parts) + "}"
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, bool) or value is None:
        fail("frame contains an unsupported value")
    return json.dumps(value, ensure_ascii=True)


def domain_hash(tag, payload):
    """sha256 over the domain-tagged, ASCII-escaped canonical payload.

    The id commits to the bytes the wire carries (the escaped form), so a frame
    with a non-ASCII field hashes identically in every conforming implementation.
    canonical_json already emits pure ASCII, so no second escape pass is needed.
    """
    data = f"{TCLK_DOMAIN}|{tag}|{payload}".encode("ascii")
    return "0x" + hashlib.sha256(data).hexdigest()


# ── Frame builders (subset: the hash-lock path) ──────────────────────────────


def offer_id(fields):
    without_id = {k: v for k, v in fields.items() if k != "id"}
    return domain_hash("offer", canonical_json(without_id))


def contract_id(offer, accept_core):
    return domain_hash("contract", canonical_json({"offer": offer, "accept": accept_core}))


def make_offer(*, frm, role, amount, asset, rails, claim_by_ms, refund_after_ms,
               expires_ms, nonce, job=None):
    if not DID.match(frm):
        fail(f"from is malformed: {frm}")
    if role not in ("payer", "payee"):
        fail("role must be payer|payee")
    if not AMOUNT.match(amount):
        fail(f"amount is malformed: {amount}")
    if not rails or any(not RAIL.match(r) for r in rails):
        fail("rails must be a non-empty array of rail ids")
    if not NONCE.match(nonce):
        fail(f"nonce is malformed: {nonce}")
    if claim_by_ms >= refund_after_ms:
        fail("claimByMs must be strictly before refundAfterMs")
    fields = {
        "type": "offer", "from": frm, "role": role, "amount": amount, "asset": asset,
        "lock": "hash", "rails": rails, "claimByMs": claim_by_ms,
        "refundAfterMs": refund_after_ms, "expiresMs": expires_ms, "nonce": nonce,
    }
    if job is not None:
        fields["job"] = job
    fields["id"] = offer_id(fields)
    return fields


def make_accept(offer, *, frm, statement, nonce):
    if offer["id"] != offer_id(offer):
        fail("offer id mismatch")
    if frm == offer["from"]:
        fail("accept.from must differ from offer.from")
    if not HEX32.match(statement):
        fail(f"statement does not fit a hash lock: {statement}")
    core = {"from": frm, "ref": offer["id"], "statement": statement, "nonce": nonce}
    return {"type": "accept", **core, "contract": contract_id(offer, core)}


def make_frame(frame_type, *, frm, contract, **extra):
    return {"type": frame_type, "from": frm, "contract": contract, **extra}


def encode_frame(frame):
    line = TCLK_PREFIX + canonical_json(frame)
    if len(line) > MAX_FRAME_CHARS:
        fail(f"frame exceeds the {MAX_FRAME_CHARS}-char room-message cap ({len(line)})")
    if not all(0x20 <= ord(ch) <= 0x7E for ch in line):
        fail("frame line contains non-printable-ASCII characters")
    return line


# ── Hash lock (locks.ts equivalent) ──────────────────────────────────────────


def statement_of(preimage_hex):
    raw = bytes.fromhex(preimage_hex[2:])
    return "0x" + hashlib.sha256(raw).hexdigest()


def opens(statement, secret):
    return HEX32.match(secret) is not None and statement_of(secret) == statement


# ── State machine (machine.ts, hash-lock path) ───────────────────────────────

TERMINAL = {"claimed", "refunded", "cancelled"}


def apply_frame(state, frame, now_ms):
    """Pure and fail-closed: returns (next_state, note). Invalid input never moves it."""
    status = state["status"]
    kind = frame["type"]
    if status in TERMINAL:
        return state, f"rejected: {kind} after terminal state {status}"

    if kind == "accept" and status == "proposed":
        if frame["from"] == state["offer"]["from"]:
            return state, "rejected: offerer cannot accept its own offer"
        if now_ms >= state["offer"]["expiresMs"]:
            return state, "rejected: offer expired"
        if frame["contract"] != contract_id(state["offer"], {
                k: frame[k] for k in ("from", "ref", "statement", "nonce")}):
            return state, "rejected: contract id mismatch"
        return {**state, "status": "accepted", "payee": frame["from"],
                "statement": frame["statement"], "contract": frame["contract"]}, "accepted"

    if kind == "lock" and status == "accepted":
        if frame["from"] != state["offer"]["from"]:
            return state, "rejected: only the payer locks"
        if frame["rail"] not in state["offer"]["rails"]:
            return state, f"rejected: rail {frame['rail']} not offered"
        return {**state, "status": "locked", "rail": frame["rail"],
                "railRef": frame["ref"]}, "locked"

    if kind == "reveal" and status == "locked":
        if frame["from"] != state["payee"]:
            return state, "rejected: only the payee reveals"
        if now_ms >= state["offer"]["refundAfterMs"]:
            return state, "rejected: past refundAfterMs — the refund window owns this"
        if not opens(state["statement"], frame["secret"]):
            return state, "rejected: secret does not open the statement"
        return {**state, "status": "claimed", "secret": frame["secret"]}, "claimed (terminal)"

    if kind == "refund" and status == "locked":
        if frame["from"] != state["offer"]["from"]:
            return state, "rejected: only the payer refunds"
        if now_ms < state["offer"]["refundAfterMs"]:
            return state, "rejected: before refundAfterMs"
        return {**state, "status": "refunded"}, "refunded (terminal)"

    if kind == "cancel" and status in ("proposed", "accepted"):
        return {**state, "status": "cancelled"}, "cancelled (terminal)"

    return state, f"rejected: {kind} in state {status}"


# ── In-memory rail (the executable spec of what a real rail enforces) ────────


class MemoryRail:
    id = "memory"

    def __init__(self):
        self._escrows = {}

    def lock(self, terms):
        ref = f"mem-{len(self._escrows) + 1}"
        self._escrows[ref] = {"terms": terms, "state": "locked"}
        return ref

    def verify_lock(self, terms, ref):
        e = self._escrows.get(ref)
        return e is not None and e["state"] == "locked" and e["terms"] == terms

    def claim(self, ref, secret, now_ms):
        e = self._escrows[ref]
        if e["state"] != "locked":
            fail("rail: nothing locked under this ref")
        if now_ms >= e["terms"]["refundAfterMs"]:
            fail("rail: refund window reached")
        if not opens(e["terms"]["statement"], secret):
            fail("rail: secret does not open the statement")
        e["state"] = "claimed"

    def refund(self, ref, now_ms):
        e = self._escrows[ref]
        if e["state"] != "locked" or now_ms < e["terms"]["refundAfterMs"]:
            fail("rail: refund predicates not met")
        e["state"] = "refunded"


# ── 1. Golden vectors (tests/vectors.test.ts, recomputed here) ───────────────

PAYER_DID = "did:key:z6Mk" + "f" * 44
PAYEE_DID = "did:key:z6Mk" + "g" * 44

GOLDEN_OFFER_ID = "0xd001fbbf4fa36d9ab8ea88df02a8b3303539e9d59f7ff9d9bfeb679318e9ce75"
GOLDEN_CONTRACT_ID = "0x2768bf32b455317879796093ff2e5882371cbec238611ca71f555a7fcbe58e1c"
GOLDEN_NON_ASCII_OFFER_ID = "0xfdad69c602bef151596e3e914cc3ca05b1ccd009211b57c4fdbf0ba0e0d4635b"


def check_golden_vectors():
    offer = make_offer(
        frm=PAYER_DID, role="payer", amount="1000000", asset="FLOP",
        rails=["flop-htlc", "x402"], claim_by_ms=1756703600000,
        refund_after_ms=1756707200000, expires_ms=1756700600000,
        job={"proto": "a2a", "id": "task-3f", "context": "ctx-1"},
        nonce="9f2c81d04c9e1f7a",
    )
    accept = make_accept(offer, frm=PAYEE_DID, statement="0x" + "ab" * 32,
                         nonce="0011223344556677")
    non_ascii = make_offer(
        frm=PAYER_DID, role="payer", amount="100", asset="FLOP",
        rails=["flop-htlc"], claim_by_ms=1756703600000,
        refund_after_ms=1756707200000, expires_ms=1756700600000,
        job={"proto": "a2a", "id": "tâche-1"}, nonce="9f2c81d04c9e1f7a",
    )

    checks = [
        ("offer id", offer["id"], GOLDEN_OFFER_ID),
        ("contract id", accept["contract"], GOLDEN_CONTRACT_ID),
        ("non-ASCII offer id", non_ascii["id"], GOLDEN_NON_ASCII_OFFER_ID),
    ]
    for name, got, want in checks:
        if got != want:
            print(f"GOLDEN VECTOR MISMATCH — {name}\n  got  {got}\n  want {want}")
            print("This port has drifted from the wire format; fix it, never the vector.")
            sys.exit(1)
    line = encode_frame(non_ascii)
    assert "\\u00e2" in line and all(0x20 <= ord(c) <= 0x7E for c in line)
    print(f"golden vectors: {len(checks)} ids + escape rule reproduced exactly\n")


# ── 2. The walkthrough ───────────────────────────────────────────────────────


def main():
    check_golden_vectors()

    now = 1756700000000  # a fixed clock, so the transcript is reproducible

    def say(who, frame, state, note):
        print(f"{who} posts:\n  {encode_frame(frame)}")
        print(f"  -> state: {state['status']} ({note})\n")

    # The payer opens with a public offer in `tclk-offers`.
    offer = make_offer(
        frm=PAYER_DID, role="payer", amount="250000", asset="FLOP",
        rails=["memory"], claim_by_ms=now + 3_600_000,
        refund_after_ms=now + 7_200_000, expires_ms=now + 1_800_000,
        job={"proto": "a2a", "id": "translate-42"}, nonce="c0ffee0123456789",
    )
    state = {"status": "proposed", "offer": offer}
    print(f"payer posts (room tclk-offers):\n  {encode_frame(offer)}")
    print(f"  -> state: proposed (offer id {offer['id'][:18]}…)\n")

    # The payee mints the preimage — the one secret in the whole protocol —
    # and answers with the statement. Deterministic here; random in real life.
    preimage = "0x" + hashlib.sha256(b"tclk walkthrough preimage").hexdigest()
    accept = make_accept(offer, frm=PAYEE_DID, statement=statement_of(preimage),
                         nonce="a1b2c3d4e5f60718")
    state, note = apply_frame(state, accept, now + 60_000)
    say("payee", accept, state, note)
    deal_room = "mb-p-tclk-" + state["contract"][2:18]
    print(f"both sides derive the deal room: {deal_room}\n")

    # The payer locks the funds on the rail and announces it.
    rail = MemoryRail()
    terms = {"contract": state["contract"], "statement": state["statement"],
             "amount": offer["amount"], "asset": offer["asset"],
             "refundAfterMs": offer["refundAfterMs"]}
    ref = rail.lock(terms)
    lock = make_frame("lock", frm=PAYER_DID, contract=state["contract"],
                      rail="memory", ref=ref)
    state, note = apply_frame(state, lock, now + 120_000)
    say("payer", lock, state, note)
    print(f"payee checks the rail before working: verify_lock -> {rail.verify_lock(terms, ref)}\n")

    # A wrong secret moves nothing — the guard is the transition.
    bogus = make_frame("reveal", frm=PAYEE_DID, contract=state["contract"],
                       secret="0x" + "00" * 32)
    state, note = apply_frame(state, bogus, now + 180_000)
    print(f"payee posts a WRONG secret:\n  {encode_frame(bogus)}\n  -> state: {state['status']} ({note})\n")

    # The real reveal is the claim — and, being world-readable, the propagation.
    reveal = make_frame("reveal", frm=PAYEE_DID, contract=state["contract"],
                        secret=preimage)
    state, note = apply_frame(state, reveal, now + 240_000)
    say("payee", reveal, state, note)
    rail.claim(ref, preimage, now + 240_000)

    receipt = make_frame("receipt", frm=PAYER_DID, contract=state["contract"],
                         outcome="claimed", rail="memory", ref=ref)
    print(f"payer posts:\n  {encode_frame(receipt)}")
    print(f"  -> no transition; the line a reputation layer would consume\n")

    print(f"done: contract {state['contract']} settled by revealing {preimage[:18]}…")


if __name__ == "__main__":
    main()
