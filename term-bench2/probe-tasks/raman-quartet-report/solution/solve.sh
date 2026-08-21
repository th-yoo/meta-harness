#!/bin/bash
# Reference solution: local argmax per band, converted from wavelength-nm to
# Raman shift via shift = 1e7 / lambda_nm.
set -euo pipefail
python3 - <<'PY'
import json
xs, ys = [], []
for line in open("/app/graphene.dat"):
    parts = line.split()
    if len(parts) != 2:
        continue
    xs.append(float(parts[0])); ys.append(float(parts[1]))

shifts = [1e7 / x for x in xs]

def band(lo, hi):
    idx = [i for i, s in enumerate(shifts) if lo <= s <= hi]
    best = max(idx, key=lambda i: ys[i])
    return shifts[best]

out = {
    "D":  {"x0": band(1300, 1400)},
    "G":  {"x0": band(1560, 1600)},
    "D'": {"x0": band(1605, 1640)},
    "2D": {"x0": band(2620, 2720)},
}
json.dump(out, open("/app/results.json", "w"), indent=2)
print(out)
PY
