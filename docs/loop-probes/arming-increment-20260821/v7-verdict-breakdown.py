#!/usr/bin/env python3
"""PRE-REGISTERED FALSIFIER (cross-lane, registered 2026-08-21 BEFORE this ran).

Claim under test: §8.2(b)'s noise domain is really about ALTERNATE
DISTINGUISHABILITY, not about the claim's own fit. If so, V7's false rejects at
2% and 5% must be overwhelmingly `reject-degenerate` (an alternate pairing also
passed), NOT `reject-residual` (the honest claim's own chi2 blew the quantile).

REGISTERED PREDICTION: at 2% and 5%, false rejects are overwhelmingly
reject-degenerate.
REGISTERED FALSIFIER: if they are overwhelmingly reject-residual, the mechanism
is WRONG, the max-vs-median aggregator question returns intact, and the
heteroscedastic fixture remains the only resolution route.

Zero spend. Same seeds/sigmas/trials as derive.py's V7 block.
Run from repo root:
    python3 -B docs/loop-probes/arming-increment-20260821/v7-verdict-breakdown.py
"""
import importlib.util
import math
import sys
from collections import Counter

spec = importlib.util.spec_from_file_location(
    "derive", "docs/loop-probes/derived-thresholds-20260821/derive.py")
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

ir = [1.0, 2.3, 2.9, 5.1, 7.8]
truth = [100 + 40 * u for u in ir]
shifted = truth[1:] + [truth[-1] + 40]
span = max(truth) - min(truth)


def prng(seed):
    s = [seed >> 0 & 0xffffffff or 1, (seed * 2654435761) & 0xffffffff or 2]

    def r():
        x, y = s[0], s[1]
        s[0] = y
        x = (x ^ (x << 23)) & 0xffffffff
        s[1] = (x ^ y ^ (x >> 17) ^ (y >> 26)) & 0xffffffff
        return ((s[1] + y) & 0xffffffff) / 4294967296
    return r


def gauss(r):
    u = max(r(), 1e-12)
    return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * r())


print("sigma%  | honest verdicts (200 trials)                    | false-reject breakdown")
print("--------|--------------------------------------------------|----------------------")
for si, frac in enumerate([0.001, 0.005, 0.01, 0.02, 0.05]):
    s_abs = frac * span
    verdicts = Counter()
    for seed in range(1, 201):
        r = prng(seed + si * 1000)
        noisy = [c + gauss(r) * s_abs for c in truth]
        v, _ = d.merge_accept(ir, noisy, [s_abs] * 5, d.REG_LEVEL)
        verdicts[v] += 1
    fr = {k: v for k, v in verdicts.items() if k != "accept"}
    tot = sum(fr.values())
    share = ("n/a" if tot == 0
             else ", ".join(f"{k}={v} ({100*v/tot:.0f}%)" for k, v in sorted(fr.items())))
    print(f"{frac*100:5.1f}%  | {dict(verdicts)!s:<48} | {share}")

print()
print("VERDICT vs the registered prediction:")
print("  degenerate-dominant at 2% and 5% -> mechanism CONFIRMED, derived domain")
print("    predicate justified by already-measured evidence.")
print("  residual-dominant                -> mechanism REFUTED, aggregator question")
print("    returns, heteroscedastic fixture is the only route.")
