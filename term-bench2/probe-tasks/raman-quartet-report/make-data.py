#!/usr/bin/env python3
"""Generator for environment/task-deps/graphene.dat (deterministic, seed 42).

Rung 1.5 of the representation-trap ablation ladder: the MINIMAL fixture the
shipped D&C merge machinery can actually engage.

Rung 0 (raman-value-report) has no series at all — the divide step has no input.
Rung 1 (raman-peak-report) is a single Lorentzian and the detector finds ONE
anchor, below mergeCheck's n>=3 floor (measured). This rung adds the D band so
four Lorentzians exist.

FOUR, not three, and the reason is a MEASURED property of the shipped machinery
rather than a design preference: mergeCheck's documented floor is n >= 3, but
conditioningCheck only adds its +-1-shift alternates when `n - 1 >= 3`, i.e.
n >= 4. At n = 3 on asymmetric geometry the automorphism set is also empty, so
the alternate set is empty and the check fail-closes as `degenerate-constellation`
even on a perfect fit (measured: a = 2.3e-13, b = 1.00000e7, the exact true
conversion, REFUSED). The real operable floor is n = 4.

G and 2D parameters mirror terminal-bench/raman-fitting's ground truth exactly.
D and D' are the defect-activated bands of a defective graphene sample; their
parameters are chosen only to be physically ordinary (weaker than G) — no value
here is read by the verifier beyond the four x0 positions.

Sampled on a uniform WAVELENGTH-nm grid (the trap axis), ascending, dot
decimals, tab-separated, no header — identical conventions to rung 1, so the
unit trap remains the only difference from a plain peak-reading task.
"""
import random
from pathlib import Path

random.seed(42)

# (name, x0 cm^-1, gamma, amplitude, offset-contribution)
PEAKS = [
    ("D",   1350.00, 28.40,  3100.00),
    ("G",   1580.30,  9.06,  8382.69),
    ("Dp",  1620.00, 12.10,  2400.00),
    ("2D",  2670.08, 17.52, 12314.42),
]
BASELINE = 5561.03
NM_LO, NM_HI, N = 3500.0, 7700.0, 3000
NOISE_SIGMA = 15.0

rows = []
for i in range(N):
    nm = NM_LO + (NM_HI - NM_LO) * i / (N - 1)
    shift = 1e7 / nm
    y = BASELINE
    for _, x0, gamma, amp in PEAKS:
        y += amp * gamma**2 / ((shift - x0) ** 2 + gamma**2)
    y += random.gauss(0.0, NOISE_SIGMA)
    rows.append((nm, y))

# every declared peak must be recoverable to well inside the +-5 verifier
# tolerance, so the tolerance can never be spent on grid or noise error
for name, x0, _, _ in PEAKS:
    nm_target = 1e7 / x0
    j = min(range(N), key=lambda k: abs(rows[k][0] - nm_target))
    lo, hi = max(0, j - 12), min(N, j + 13)
    k = max(range(lo, hi), key=lambda t: rows[t][1])
    got = 1e7 / rows[k][0]
    assert abs(got - x0) < 2.0, f"{name}: local argmax lands at {got:.2f} cm^-1, want {x0}"

out = Path(__file__).parent / "environment" / "task-deps" / "graphene.dat"
out.write_text("\n".join(f"{nm:.6f}\t{y:.6f}" for nm, y in rows) + "\n")
print(f"wrote {out} ({N} rows)")
for name, x0, _, _ in PEAKS:
    print(f"  {name:3} x0={x0:8.2f} cm^-1  (nm {1e7/x0:9.3f})")
