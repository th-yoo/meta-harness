#!/usr/bin/env python3
"""Generator for environment/task-deps/graphene.dat (deterministic, seed 42).

Single Lorentzian G peak, parameters mirroring terminal-bench/raman-fitting's
G-peak ground truth (x0=1580.3 cm^-1, gamma=9.06, A=8382.69, offset=5561.03).
Sampled on a uniform WAVELENGTH-nm grid (the trap axis), ascending, dot
decimals, tab-separated, no header. Kept confounds: none — the unit trap is
the only rung (no fitting needed, single peak, no decimal commas, ascending x).

Asserts the argmax row converts to within 2 cm^-1 of 1580.3 so the +-5
verifier tolerance can never be spent on grid/noise error.
"""
import math
import random
from pathlib import Path

random.seed(42)

X0, GAMMA, A, OFFSET = 1580.3, 9.06, 8382.69, 5561.03
NM_LO, NM_HI, N = 5800.0, 7100.0, 1500
NOISE_SIGMA = 15.0

rows = []
for i in range(N):
    nm = NM_LO + (NM_HI - NM_LO) * i / (N - 1)
    shift = 1e7 / nm
    y = A * GAMMA**2 / ((shift - X0) ** 2 + GAMMA**2) + OFFSET
    y += random.gauss(0.0, NOISE_SIGMA)
    rows.append((nm, y))

i_max = max(range(N), key=lambda j: rows[j][1])
argmax_shift = 1e7 / rows[i_max][0]
assert abs(argmax_shift - X0) < 2.0, f"argmax lands at {argmax_shift:.2f} cm^-1"

out = Path(__file__).parent / "environment" / "task-deps" / "graphene.dat"
out.write_text("\n".join(f"{nm:.6f}\t{y:.6f}" for nm, y in rows) + "\n")
print(f"wrote {out} ({N} rows); argmax -> {argmax_shift:.3f} cm^-1 "
      f"(raw nm {rows[i_max][0]:.3f})")
