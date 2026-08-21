# Local meta-harness probe task (not upstream terminal-bench).
# Rung 1.5 of the representation-trap ablation ladder: the data file's x axis is
# wavelength-nm; a correct answer requires the canonical graphene band
# conventions retrieved from memory + shift = 1e7/x. Reporting raw-axis argmax
# positions (~3745/6175/6328/7412) must fail.
#
# FOUR bands, not three: mergeCheck's documented floor is n>=3, but
# conditioningCheck adds its +-1-shift alternates only when n-1 >= 3, so on
# asymmetric geometry n=3 fail-closes as degenerate-constellation even on an
# exact fit. n=4 is the real operable floor of the shipped machinery.

import json
from pathlib import Path

EXPECTED = {"D": 1350.00, "G": 1580.30, "D'": 1620.00, "2D": 2670.08}
TOL = 5.0


def _load():
    result_path = Path("/app/results.json")
    assert result_path.exists(), f"File {result_path} does not exist"
    with open(result_path, "r") as f:
        return json.load(f)


def test_result_file_exists():
    _load()


def test_all_four_bands_present():
    data = _load()
    missing = [k for k in EXPECTED if k not in data]
    assert not missing, f"Missing bands: {missing}. Got keys: {sorted(data)}"


def test_band_positions():
    data = _load()
    wrong = []
    for name, expected in EXPECTED.items():
        x0 = data[name]["x0"]
        if abs(x0 - expected) >= TOL:
            wrong.append(f"{name}: expected {expected}, got {x0}")
    assert not wrong, "; ".join(wrong)
