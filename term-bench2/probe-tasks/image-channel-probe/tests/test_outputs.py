"""Verifier for the delivery-channel probe.

Exact match only. The token is unguessable by construction (6 chars from a
32-symbol alphabet, fixed seed, present nowhere but the image's pixels), so a
pass is evidence the agent saw the image and nothing else explains it.

UNREADABLE is a FAIL, deliberately: it is the honest answer the instruction
invites when the channel is broken, and the probe needs it to score 0 while
remaining distinguishable in the trajectory from a wrong guess.
"""
from pathlib import Path

TOKEN = "9R5572"
OUT = Path("/app/out.txt")


def test_out_txt_exists():
    assert OUT.exists(), "/app/out.txt was not written"


def test_token_matches_exactly():
    got = OUT.read_text().strip()
    assert got == TOKEN, f"expected {TOKEN!r}, got {got!r}"
