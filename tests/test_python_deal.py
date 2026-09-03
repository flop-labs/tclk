import hashlib
import json
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from examples.python_live_deal import (
    Signer,
    canonical_json,
    contract_id,
    deal_room,
    domain_hash,
    encode_frame,
    encode_paper_record,
    offer_id,
    paper_note,
    state_note,
    state_note_value,
    to_ascii,
    try_decode_frame,
)


def test_signer_did_and_signatures():
    signer = Signer()
    assert signer.did.startswith("did:key:z6Mk")
    assert len(signer.did) > 40

    payload = "test-room|123456789|tclk1 {}"
    sig = signer.sign(payload)
    assert len(sig) > 40


def test_canonical_json_ordering_and_escapes():
    raw = {"z": 1, "a": "hello", "b": None, "unicode": "€"}
    c = canonical_json(raw)
    assert c == '{"a":"hello","unicode":"€","z":1}'

    ascii_form = to_ascii(c)
    assert "\\u20ac" in ascii_form


def test_deterministic_domain_hashes():
    fields = {
        "amount": "1000",
        "asset": "PAPER",
        "claimByMs": 1000,
        "expiresMs": 500,
        "from": "did:key:z6Mk1",
        "lock": "hash",
        "nonce": "abcdef",
        "rails": ["paper"],
        "refundAfterMs": 2000,
        "role": "payer",
        "type": "offer",
    }
    oid1 = offer_id(fields)
    oid2 = offer_id(fields)
    assert oid1 == oid2
    assert oid1.startswith("0x") and len(oid1) == 66


def test_contract_id_binding():
    offer = {"id": "0x" + "1" * 64, "amount": "100"}
    accept_core = {
        "from": "did:key:z6Mk2",
        "nonce": "123",
        "ref": offer["id"],
        "statement": "0x" + "2" * 64,
    }
    cid = contract_id(offer, accept_core)
    assert cid.startswith("0x") and len(cid) == 66


def test_frame_encoding_decoding():
    frame = {"type": "offer", "amount": "500", "id": "0x1234"}
    wire = encode_frame(frame)
    assert wire.startswith("tclk1 ")
    decoded = try_decode_frame(wire)
    assert decoded == frame


def test_technocore_naming_helpers():
    cid = "0x" + "a" * 64
    assert deal_room(cid) == f"mb-p-tclk-{'a'*16}"
    assert state_note(cid) == {"ns": "tclk-aa", "key": "a" * 14}
    assert paper_note(cid) == {"ns": "tclk-paper-aa", "key": "a" * 14}
    assert state_note_value("locked", "ref123") == "locked ref123"


if __name__ == "__main__":
    for name, func in list(globals().items()):
        if name.startswith("test_") and callable(func):
            func()
            print(f"PASS: {name}")
    print("\nAll Python deal unit tests passed successfully!")
