#!/bin/bash
# Oracle for raman-value-report: the readout is wavelength (nm);
# Raman shift axis is cm^-1: shift = 1e7 / x.

python3 << 'EOF'
import json

x0 = 1e7 / 6327.285

with open("/app/results.json", "w") as f:
    json.dump({"G": {"x0": x0}}, f, indent=2)
EOF

cat /app/results.json
