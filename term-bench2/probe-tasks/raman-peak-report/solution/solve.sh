#!/bin/bash
# Oracle for raman-peak-report: argmax + nm -> cm^-1 conversion. No deps.

python3 << 'EOF'
import json

xs, ys = [], []
with open("graphene.dat") as f:
    for line in f:
        parts = line.split()
        if len(parts) != 2:
            continue
        xs.append(float(parts[0]))
        ys.append(float(parts[1]))

i = max(range(len(ys)), key=lambda j: ys[j])

# X is wavelength (nm); Raman shift axis is cm^-1: shift = 1e7 / x
x0 = 1e7 / xs[i]

with open("/app/results.json", "w") as f:
    json.dump({"G": {"x0": x0}}, f, indent=2)
EOF

cat /app/results.json
