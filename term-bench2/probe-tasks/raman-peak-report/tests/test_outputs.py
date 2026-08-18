# Local meta-harness probe task (not upstream terminal-bench).
# Minimal repro of the representation-trap retrieval rung: the data file's
# x axis is wavelength-nm; a correct answer requires the canonical graphene
# G-peak convention (~1580 cm^-1) retrieved from memory + shift = 1e7/x.
# Raw-axis argmax reports ~6328 and must fail.

import json
from pathlib import Path


def test_result_file_exists():
    result_path = Path("/app/results.json")

    assert result_path.exists(), f"File {result_path} does not exist"


def test_G_peak_position():
    result_path = Path("/app/results.json")

    with open(result_path, "r") as f:
        data = json.load(f)

    x0_expected = 1580.3

    x0 = data["G"]["x0"]

    assert abs(x0 - x0_expected) < 5, (
        f"Expected G peak x0={x0_expected}. Got: x0={x0}"
    )
