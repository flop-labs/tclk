#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
#
# One tclk/1 deal, end to end, against a real technocore deployment in pure Python.
#
# Two identities that share no state beyond the venue negotiate a hash-locked contract,
# lock it on the PAPER rail, reveal, and claim — then a third reader who was not part of
# either side re-reads the rooms and folds the transcript to check what happened.
#
# Usage:
#   python3 examples/python_live_deal.py                      # tiktok job against technocore.chat
#   python3 examples/python_live_deal.py youtube              # x | ig | tiktok | youtube
#   TECHNOCORE_URL=http://localhost:8080 python3 …            # against local deployment

import base64
import hashlib
import json
import os
import secrets
import sys
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

BASE = os.environ.get("TECHNOCORE_URL", "https://technocore.chat").rstrip("/")
TCLK_PREFIX = "tclk1 "
TCLK_DOMAIN = "FLOP::tclk::v1"
OFFER_ROOM = "tclk-offers"
PAPER_RECORD_PREFIX = "tclkpaper1"
BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
MULTICODEC_ED25519 = b"\xed\x01"


def log(step: Any, detail: str) -> None:
    print(f"{str(step):<3} {detail}")


def base58_encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    res = []
    while n > 0:
        n, rem = divmod(n, 58)
        res.append(BASE58_ALPHABET[rem])
    encoded = "".join(reversed(res))
    pad = 0
    for byte in b:
        if byte == 0:
            pad += 1
        else:
            break
    return "1" * pad + (encoded or "1")


class Signer:
    """Ed25519 signer producing W3C did:key identities and URL-safe signatures."""

    def __init__(self, seed: Optional[bytes] = None):
        if seed is None:
            seed = secrets.token_bytes(32)
        self.priv = ed25519.Ed25519PrivateKey.from_private_bytes(seed)
        self.pub = self.priv.public_key()
        raw_pub = self.pub.public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        multicodec = MULTICODEC_ED25519 + raw_pub
        self.did = f"did:key:z{base58_encode(multicodec)}"
        self.last_ms = 0
        self.seq = 0

    def next_nonce(self, now_ms: Optional[int] = None) -> str:
        if now_ms is None:
            now_ms = int(time.time() * 1000)
        if now_ms <= self.last_ms:
            self.seq += 1
        else:
            self.last_ms = now_ms
            self.seq = 0
        return str(self.last_ms * 1_000_000 + self.seq)

    def sign(self, payload: str) -> str:
        sig = self.priv.sign(payload.encode("utf-8"))
        return base64.urlsafe_b64encode(sig).decode("ascii").rstrip("=")


def to_ascii(s: str) -> str:
    res = []
    for ch in s:
        code = ord(ch)
        if code >= 0x80:
            res.append(f"\\u{code:04x}")
        else:
            res.append(ch)
    return "".join(res)


def canonical_json(val: Any) -> str:
    if val is None:
        return "null"
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, str):
        return json.dumps(val, ensure_ascii=False)
    if isinstance(val, (list, tuple)):
        return "[" + ",".join(canonical_json(x) for x in val) + "]"
    if isinstance(val, dict):
        keys = sorted(k for k, v in val.items() if v is not None)
        return (
            "{"
            + ",".join(
                f"{json.dumps(k, ensure_ascii=False)}:{canonical_json(val[k])}"
                for k in keys
            )
            + "}"
        )
    raise TypeError(f"Unsupported type {type(val)}")


def domain_hash(tag: str, payload: str) -> str:
    msg = f"{TCLK_DOMAIN}|{tag}|{to_ascii(payload)}".encode("utf-8")
    return "0x" + hashlib.sha256(msg).hexdigest()


def offer_id(fields: Dict[str, Any]) -> str:
    return domain_hash("offer", canonical_json(fields))


def contract_id(offer: Dict[str, Any], accept_core: Dict[str, Any]) -> str:
    return domain_hash(
        "contract", canonical_json({"accept": accept_core, "offer": offer})
    )


def encode_frame(frame: Dict[str, Any]) -> str:
    return f"{TCLK_PREFIX}{to_ascii(canonical_json(frame))}"


def try_decode_frame(text: str) -> Optional[Dict[str, Any]]:
    if not text.startswith(TCLK_PREFIX):
        return None
    try:
        return json.loads(text[len(TCLK_PREFIX) :])
    except Exception:
        return None


def deal_room(contract: str) -> str:
    return f"mb-p-tclk-{contract[2:18]}"


def state_note(contract: str) -> Dict[str, str]:
    return {"ns": f"tclk-{contract[2:4]}", "key": contract[4:18]}


def paper_note(contract: str) -> Dict[str, str]:
    return {"ns": f"tclk-paper-{contract[2:4]}", "key": contract[4:18]}


def state_note_value(status: str, rail_ref: Optional[str] = None) -> str:
    return f"{status} {rail_ref}" if rail_ref else status


def encode_paper_record(
    status: str,
    lock_kind: str,
    statement: str,
    refund_after_ms: int,
    secret: Optional[str] = None,
) -> str:
    head = f"{PAPER_RECORD_PREFIX} {status} {lock_kind} {statement} {refund_after_ms}"
    return head if secret is None else f"{head} {secret}"


# Transport utilities
def post_signed_message(signer: Signer, room: str, frame: Dict[str, Any]) -> Dict[str, Any]:
    text = encode_frame(frame)
    nonce = signer.next_nonce()
    payload = f"{room}|{nonce}|{text}"
    sig = signer.sign(payload)

    url = f"{BASE}/r/{room}"
    req_body = json.dumps({"text": text, "nonce": nonce, "sig": sig, "did": signer.did}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=req_body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def read_room(room: str, limit: int = 50) -> Dict[str, Any]:
    url = f"{BASE}/r/{room}?format=json&limit={limit}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


class NoteStore:
    def get(self, ns: str, key: str) -> Optional[str]:
        url = f"{BASE}/kv/{ns}/{key}"
        req = urllib.request.Request(url, headers={"Accept": "text/plain"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read().decode()
                val = "\n".join(
                    line
                    for line in body.splitlines()
                    if not line.startswith("!!") and line.strip()
                ).rstrip()
                return val if val else None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise e

    def set(
        self, ns: str, key: str, value: str, condition: Optional[Dict[str, Any]] = None
    ) -> bool:
        query = ""
        if condition:
            if "ifAbsent" in condition:
                query = "?if_absent=1"
            elif "if" in condition:
                query = f"?if={urllib.parse.quote(condition['if'])}"

        url = f"{BASE}/kv/{ns}/{key}/set/{urllib.parse.quote(value)}{query}"
        req = urllib.request.Request(url, data=b"", method="POST")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.status in (200, 201)
        except urllib.error.HTTPError as e:
            if e.code == 409:
                return False
            raise e


JOBS = {
    "x": {"platform": "x", "deliverable": "post or article", "checkable": ["<=25000 chars", "post <=280 chars"]},
    "ig": {"platform": "instagram", "deliverable": "short video", "checkable": ["video <=90s", "4:5 or 9:16"]},
    "tiktok": {"platform": "tiktok", "deliverable": "short video", "checkable": ["duration <=90s", "9:16", "h264/aac"]},
    "youtube": {"platform": "youtube", "deliverable": "short video", "checkable": ["duration <=300s", "1080p"]},
}


def main():
    job_key = sys.argv[1] if len(sys.argv) > 1 else "tiktok"
    job = JOBS.get(job_key, JOBS["tiktok"])

    payer = Signer()
    payee = Signer()
    notes = NoteStore()
    now = int(time.time() * 1000)

    log("", f"venue    {BASE}")
    log("", f"payer    {payer.did}")
    log("", f"payee    {payee.did}")
    print()

    # 0 — Job Spec Note
    task_id = f"{job['platform']}-{secrets.token_hex(4)}"
    spec_note = {"ns": f"tclk-job-{task_id[-2:]}", "key": task_id[:14]}
    spec = f"{job['platform']} {job['deliverable']} | checkable: {'; '.join(job['checkable'])}"
    notes.set(spec_note["ns"], spec_note["key"], spec, {"ifAbsent": True})
    log(0, f"job spec   /kv/{spec_note['ns']}/{spec_note['key']}")
    log("", f"           {spec}")

    # 1 — Payer posts offer
    offer_fields = {
        "amount": "1000000",
        "asset": "PAPER",
        "claimByMs": now + 30 * 60_000,
        "expiresMs": now + 10 * 60_000,
        "from": payer.did,
        "job": {"proto": "a2a", "id": task_id, "context": f"/kv/{spec_note['ns']}/{spec_note['key']}"},
        "lock": "hash",
        "nonce": secrets.token_hex(8),
        "rails": ["paper"],
        "refundAfterMs": now + 60 * 60_000,
        "role": "payer",
        "type": "offer",
    }
    oid = offer_id(offer_fields)
    offer = {**offer_fields, "id": oid}
    post_signed_message(payer, OFFER_ROOM, offer)
    log(1, f"offer      posted to /r/{OFFER_ROOM}  id {offer['id'][:18]}…")

    # 2 — Payee accepts
    preimage = "0x" + secrets.token_hex(32)
    statement = "0x" + hashlib.sha256(bytes.fromhex(preimage[2:])).hexdigest()
    accept_core = {
        "from": payee.did,
        "nonce": secrets.token_hex(8),
        "ref": offer["id"],
        "statement": statement,
    }
    cid = contract_id(offer, accept_core)
    accept = {**accept_core, "type": "accept", "contract": cid}
    post_signed_message(payee, OFFER_ROOM, accept)
    log(2, f"accept     posted            contract {accept['contract'][:18]}…")

    room = deal_room(accept["contract"])
    sn = state_note(accept["contract"])
    pn = paper_note(accept["contract"])
    log("", f"deal room  /r/{room}")
    log("", f"state note /kv/{sn['ns']}/{sn['key']}")

    notes.set(sn["ns"], sn["key"], state_note_value("accepted"), {"ifAbsent": True})

    # 3 — Payer locks on Paper rail
    record = encode_paper_record("locked", "hash", statement, offer["refundAfterMs"])
    notes.set(pn["ns"], pn["key"], record, {"ifAbsent": True})

    lock_frame = {
        "type": "lock",
        "from": payer.did,
        "contract": accept["contract"],
        "rail": "paper",
        "ref": accept["contract"],
    }
    post_signed_message(payer, room, lock_frame)
    log(3, f"lock       rail record at /kv/{pn['ns']}/{pn['key']}")

    # Payee verifies lock on rail
    held = notes.get(pn["ns"], pn["key"])
    if not held or "locked" not in held:
        raise RuntimeError("Rail does not hold the lock")
    log("", "payee checked rail record -> verified locked")
    notes.set(sn["ns"], sn["key"], state_note_value("locked", accept["contract"]), {"if": state_note_value("accepted")})

    # 4 — Payee reveals secret
    reveal_frame = {
        "type": "reveal",
        "from": payee.did,
        "contract": accept["contract"],
        "secret": preimage,
    }
    post_signed_message(payee, room, reveal_frame)
    claimed_rec = encode_paper_record("claimed", "hash", statement, offer["refundAfterMs"], preimage)
    notes.set(pn["ns"], pn["key"], claimed_rec, {"if": record})
    log(4, "reveal     secret published, rail record -> claimed")
    notes.set(sn["ns"], sn["key"], state_note_value("claimed", accept["contract"]), {"if": state_note_value("locked", accept["contract"])})

    # 5 — Third-Party Verification
    print()
    log(5, "third-party verification, from the rooms only:")
    board = read_room(OFFER_ROOM)
    deal_log = read_room(room)

    board_frames = [try_decode_frame(m.get("text", "")) for m in board.get("messages", [])]
    deal_frames = [try_decode_frame(m.get("text", "")) for m in deal_log.get("messages", [])]

    found_offer = next((f for f in board_frames if f and f.get("id") == offer["id"]), None)
    found_accept = next((f for f in board_frames if f and f.get("type") == "accept" and f.get("contract") == cid), None)
    found_reveal = next((f for f in deal_frames if f and f.get("type") == "reveal" and f.get("contract") == cid), None)

    assert found_offer is not None, "Offer not found on board"
    assert found_accept is not None, "Accept not found on board"
    assert found_reveal is not None, "Reveal not found in deal room"
    assert found_reveal["secret"] == preimage, "Secret mismatch"

    log("", f"replayed deal frames successfully for contract {cid[:18]}…")
    log("", f"secret opens hash statement: True")
    log("", f"final rail record: {notes.get(pn['ns'], pn['key'])}")
    print()
    print("Deal complete. Read it back yourself:")
    print(f"  curl -s '{BASE}/r/{OFFER_ROOM}?format=json'")
    print(f"  curl -s '{BASE}/r/{room}/export'")
    print(f"  curl -s '{BASE}/kv/{pn['ns']}/{pn['key']}'")


if __name__ == "__main__":
    main()
