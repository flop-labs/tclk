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
    decode_paper_record,
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


def test_astral_unicode_surrogate_escapes_and_vectors():
    # 1. BMP escape check (€ -> \u20ac)
    assert to_ascii("€") == "\\u20ac"

    # 2. Astral plane escape check (U+1F600 😀 -> \ud83d\ude00 surrogate pair)
    assert to_ascii("\U0001f600") == "\\ud83d\\ude00"
    assert to_ascii("task-😀-test") == "task-\\ud83d\\ude00-test"

    # 3. Cross-language regression vector: pins offer_id and contract_id for astral character
    # to exact byte parity with TypeScript reference implementation
    payer_did = "did:key:z6Mk" + "f" * 44
    payee_did = "did:key:z6Mk" + "g" * 44
    astral_offer_fields = {
        "amount": "100",
        "asset": "FLOP",
        "claimByMs": 1756703600000,
        "expiresMs": 1756700600000,
        "from": payer_did,
        "job": {"proto": "a2a", "id": "task-\U0001f600-test"},
        "lock": "hash",
        "nonce": "9f2c81d04c9e1f7a",
        "rails": ["flop-htlc"],
        "refundAfterMs": 1756707200000,
        "role": "payer",
        "type": "offer",
    }

    # Expected offer id matches domainHash("offer", canonicalJson(astral_offer_fields)) in TypeScript
    expected_offer_id = "0x3bd7a25a283dd9bb4d7367485f5cbb3a1434091a4aa575fd9c2f33401bb6b88f"
    oid = offer_id(astral_offer_fields)
    assert oid == expected_offer_id

    # Expected contract id matches domainHash("contract", canonicalJson({accept, offer})) in TypeScript
    astral_offer = dict(astral_offer_fields, id=oid)
    astral_accept_core = {
        "from": payee_did,
        "nonce": "0011223344556677",
        "ref": oid,
        "statement": "0x" + "ab" * 32,
    }
    expected_contract_id = "0x1280c666ff06c4396ffd1764a0ffacc807e1cf20e9112c568f52ff82a03036cc"
    cid = contract_id(astral_offer, astral_accept_core)
    assert cid == expected_contract_id



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


def test_decode_paper_record():
    valid_locked = "tclkpaper1 locked hash 0x" + "a" * 64 + " 1700000000"
    rec = decode_paper_record(valid_locked)
    assert rec is not None
    assert rec["status"] == "locked"
    assert rec["lock"] == "hash"
    assert rec["statement"] == "0x" + "a" * 64
    assert rec["refundAfterMs"] == 1700000000
    assert "secret" not in rec

    valid_claimed = "tclkpaper1 claimed hash 0x" + "a" * 64 + " 1700000000 0x" + "b" * 64
    rec_c = decode_paper_record(valid_claimed)
    assert rec_c is not None
    assert rec_c["status"] == "claimed"
    assert rec_c["secret"] == "0x" + "b" * 64

    # Rejection of malformed / untrusted inputs
    assert decode_paper_record("unlocked attacker-controlled text") is None
    assert decode_paper_record("tclkpaper1 attacker hash 0x" + "a" * 64 + " 1000") is None
    assert decode_paper_record("invalid-prefix locked hash 0x" + "a" * 64 + " 1000") is None
    assert decode_paper_record("tclkpaper1 locked invalid_lock 0x" + "a" * 64 + " 1000") is None
    assert decode_paper_record("tclkpaper1 locked hash not_a_hex_statement 1000") is None
    assert decode_paper_record("tclkpaper1 locked hash 0x" + "a" * 64 + " -500") is None
    assert decode_paper_record("tclkpaper1 claimed hash 0x" + "a" * 64 + " 1000") is None


def test_fail_closed_on_untrusted_rail():
    statement = "0x" + "2" * 64
    deadline = 1756707200000

    attacker_values = [
        "unlocked attacker-controlled text",
        "tclkpaper1 locked hash " + ("0x" + "3" * 64) + f" {deadline}",
        "tclkpaper1 locked hash " + statement + " 9999",
        "tclkpaper1 claimed hash " + statement + f" {deadline} " + ("0x" + "1" * 64),
        "locked",
        "some random locked string",
        "",
    ]

    for untrusted in attacker_values:
        parsed = decode_paper_record(untrusted) if untrusted else None
        is_valid = (
            parsed is not None
            and parsed.get("status") == "locked"
            and parsed.get("lock") == "hash"
            and parsed.get("statement") == statement
            and parsed.get("refundAfterMs") == deadline
        )
        assert is_valid is False, f"Untrusted rail text unexpectedly verified: {untrusted}"


if __name__ == "__main__":
    for name, func in list(globals().items()):
        if name.startswith("test_") and callable(func):
            func()
            print(f"PASS: {name}")
    print("\nAll Python deal unit tests passed successfully!")
