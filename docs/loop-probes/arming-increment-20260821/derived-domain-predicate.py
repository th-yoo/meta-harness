#!/usr/bin/env python3
"""Does the DERIVED domain predicate (expected alternate chi2) replace the
0.01 span-ratio bound, and does graphene pass it?

Mechanism (confirmed by v7-verdict-breakdown.py: 192/192 false rejects are
reject-degenerate, 0 residual): §8.2(b)'s bound is a PROXY for alternate
distinguishability. Replace it with the thing itself, computed claim-free from
the constellation and the artifact's own per-anchor sigma:

    for each alternate pairing A (derived automorphisms + the fixed +/-1 shift):
        fit the alternate pairing of us against themselves
        X2_alt = sum( (r_i / sigma_u_i)^2 )
    checkable iff EVERY alternate has X2_alt > chi2_q(REG_LEVEL, dof)

No aggregator (each anchor carries its own sigma, so heteroscedasticity is
handled by construction) and no new constant (reuses REG_LEVEL).

Run from repo root:
    python3 -B docs/loop-probes/arming-increment-20260821/derived-domain-predicate.py
"""
import importlib.util
import math
import statistics
import sys

spec = importlib.util.spec_from_file_location(
    "derive", "docs/loop-probes/derived-thresholds-20260821/derive.py")
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


def alt_chi2(us, sig_u):
    """Min expected alternate chi2 over the alternate set, with its quantile."""
    idx = sorted(range(len(us)), key=lambda i: us[i])
    su = [us[i] for i in idx]
    ss = [sig_u[i] for i in idx]
    n = len(su)
    results = []
    # derived automorphisms
    for perm in d.automorphisms(su):
        alt = [su[p] for p in perm]
        _, _, res = d.fit_affine(su, alt)
        x2 = sum((r / max(s, d.EPS)) ** 2 for r, s in zip(res, ss))
        results.append(("automorphism", x2, d.chi2_q(d.REG_LEVEL, n - 2)))
    # the fixed +/-1 index shift
    if n - 1 >= 3:
        for lo, hi, sl in ((su[:-1], su[1:], ss[:-1]), (su[1:], su[:-1], ss[1:])):
            _, _, res = d.fit_affine(lo, hi)
            x2 = sum((r / max(s, d.EPS)) ** 2 for r, s in zip(res, sl))
            results.append(("shift", x2, d.chi2_q(d.REG_LEVEL, len(lo) - 2)))
    if not results:
        return None
    worst = min(results, key=lambda t: t[1] / t[2])
    return worst, results


def report(label, us, sig_u):
    span = max(us) - min(us)
    ratio = max(sig_u) / span
    got = alt_chi2(us, sig_u)
    if got is None:
        print(f"{label:28} n={len(us):3}  NO ALTERNATES (degenerate)")
        return
    (kind, x2, q), allr = got
    old = "IN " if ratio <= 0.01 else "OUT"
    new = "CHECKABLE  " if x2 > q else "UNCHECKABLE"
    print(f"{label:28} n={len(us):3}  span-ratio={ratio:.5f} [{old}]   "
          f"min alt X2={x2:10.1f} vs q={q:6.1f} [{new}]  (binding: {kind}, {len(allr)} alternates)")


def series(path, ufn):
    xs, us, sig_u, sy = d.series_sigmas(path, ufn)
    return us, sig_u


GRA = "term-bench2/probe-tasks/raman-fitting-audit/environment/task-deps/graphene.dat"
FX2 = "docs/loop-probes/dnc-second-fixture-20260820/fixture.dat"

print("=== real / committed fixtures ===")
for name, path in (("graphene", GRA), ("fixture-2", FX2)):
    for lbl, ufn in (("u=x", lambda x: x), ("u=1/x", lambda x: 1 / x)):
        us, sig_u = series(path, ufn)
        report(f"{name} {lbl}", us, sig_u)

print()
print("=== V7's synthetic constellation, swept (the derived predicate must")
print("    reproduce the measured accept/reject curve: in at <=1%, out at 5%) ===")
ir = [1.0, 2.3, 2.9, 5.1, 7.8]
truth = [100 + 40 * u for u in ir]
span_c = max(truth) - min(truth)
B = 40.0
for frac in (0.001, 0.005, 0.01, 0.02, 0.05):
    # V7 injected sigma in c-space; carry it back to u-space through the slope
    sig_u = [frac * span_c / B] * 5
    report(f"ir sigma={frac*100:.1f}%", ir, sig_u)

print()
print("MEASURED V7 honest false-reject rate: 0/200, 0/200, 0/200, 10/200, 182/200")
print("The derived predicate is confirmed if its CHECKABLE/UNCHECKABLE flip lands")
print("between 1% and 5%, matching where the measured curve breaks.")
