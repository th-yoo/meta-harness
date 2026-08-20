#!/usr/bin/env python3
"""Formal scoring of the O4 arm against the ALREADY-REGISTERED rule in
pre-registration.md AMENDMENT 01 (O4 was run but never scored in verdict.md —
found by the D&C spec architect review, F4). The registered metric is
CONSTANT-CONSISTENCY under the STRICT check — the declared CONSTANT token
appears in every derivation row — baseline to beat O3's 2/4. Parse rate
(strictBlock) is REPORTED for the divergence story but is NOT the scored
metric. Run from the repo root."""
import glob
import json
import os
import re

cells = sorted(glob.glob(os.path.join(os.path.dirname(__file__), "out-O4-r*.json")))
assert len(cells) == 4, f"expected 4 O4 cells, found {len(cells)}"
consistent = 0
rows = []
for p in cells:
    d = json.load(open(p))
    raw = d.get("rawAudit", "")
    m = re.search(r"^CONSTANT:\s*(\S+)", raw, re.M)
    const_tok = m.group(1) if m else None
    # O4's block is five columns: | input | computed | canonical | derivation |
    # discriminates | — the derivation is cell index 3 of each data row.
    derivs = []
    for line in raw.splitlines():
        parts = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(parts) == 5 and parts[0] not in ("input",) and not set(parts[0]) <= set("-: "):
            derivs.append(parts[3])
    ok = const_tok is not None and len(derivs) > 0 and all(const_tok in dv for dv in derivs)
    consistent += ok
    rows.append((os.path.basename(p), const_tok, len(derivs), ok, d.get("strictBlock")))
print(f"O4 CONSTANT-CONSISTENCY (strict): {consistent}/4  [registered baseline: O3 2/4]")
for name, tok, nd, ok, sb in rows:
    print(f"  {name}: CONSTANT={tok} derivation-rows={nd} consistent={ok} (strictBlock={sb} — parse metric, reported not scored)")
print("registered rule: consistency 4/4 -> adopt cross-check + column; <=2/4 -> confirms prediction (root cause F4, not F3); 3/4 -> INDETERMINATE under the registered rule")
print(f"outcome: {'ADOPT' if consistent == 4 else 'CONFIRMS PREDICTION' if consistent <= 2 else 'INDETERMINATE'}")
