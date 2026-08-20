#!/usr/bin/env python3
"""Merge=fit design probe. Implements pre-registration.md verbatim.

Zero model spend, stdlib only. Run from repo root:
    python3 docs/loop-probes/dnc-merge-fit-20260820/probe.py
"""
import statistics
import sys

FIXTURE = "term-bench2/probe-tasks/raman-fitting-audit/environment/task-deps/graphene.dat"
EPS = 1e-9
R_THRESHOLD = 3.0
DELTA_SYNTH = 5.0  # plain-gate tolerance for synthetic cases (canonical units)


def fit_affine(us, cs):
    """Least-squares y = a + b*u. Returns (a, b, rms)."""
    n = len(us)
    mu, mc = sum(us) / n, sum(cs) / n
    sxx = sum((u - mu) ** 2 for u in us)
    if sxx < EPS:
        return mc, 0.0, statistics.pstdev(cs)
    b = sum((u - mu) * (c - mc) for u, c in zip(us, cs)) / sxx
    a = mc - b * mu
    rms = (sum((a + b * u - c) ** 2 for u, c in zip(us, cs)) / n) ** 0.5
    return a, b, rms


def plain_gate(us, cs, delta):
    """The residual-only gate: every |computed - canonical| < delta under one fit."""
    a, b, _ = fit_affine(us, cs)
    return all(abs(a + b * u - c) < delta for u, c in zip(us, cs))


def conditioning_check(us, cs):
    """Shift-degeneracy ratio R = min(RMS_shifted)/max(RMS_claimed, EPS).
    REJECT if R <= R_THRESHOLD or n < 3 (or no shift leaves n-1 >= 3)."""
    n = len(us)
    if n < 3:
        return False, float("nan")
    _, _, rms_claimed = fit_affine(us, cs)
    shifted_rms = []
    if n - 1 >= 3:
        shifted_rms.append(fit_affine(us[:-1], cs[1:])[2])  # +1 index shift
        shifted_rms.append(fit_affine(us[1:], cs[:-1])[2])  # -1 index shift
    if not shifted_rms:
        return False, float("nan")
    r = min(shifted_rms) / max(rms_claimed, EPS)
    return r > R_THRESHOLD, r


def detect_peaks(xs, ys):
    """Scale-persistent local maxima per pre-registration (windows 5..101 odd,
    >=90th pct of smoothed series, persistence >=5 consecutive scales, +/-3)."""
    per_scale = []
    for w in range(5, 102, 2):
        half = w // 2
        sm = []
        for i in range(len(ys)):
            lo, hi = max(0, i - half), min(len(ys), i + half + 1)
            sm.append(sum(ys[lo:hi]) / (hi - lo))
        thresh = sorted(sm)[int(0.9 * len(sm))]
        peaks = [i for i in range(1, len(sm) - 1)
                 if sm[i] > sm[i - 1] and sm[i] >= sm[i + 1] and sm[i] > thresh]
        per_scale.append(peaks)
    # persistence: a peak at the smallest scale that has a +/-3 match in >=5
    # consecutive scales starting there
    survivors = []
    for p in per_scale[0]:
        pos, run = p, 1
        for scale in per_scale[1:]:
            match = next((q for q in scale if abs(q - pos) <= 3), None)
            if match is None:
                break
            pos, run = match, run + 1
        if run >= 5:
            survivors.append(p)
    # merge survivors closer than 3 samples
    merged = []
    for p in sorted(survivors):
        if merged and p - merged[-1] <= 3:
            continue
        merged.append(p)
    return merged


def report_case(name, us, cs, delta, expect_gate, expect_check):
    gate = plain_gate(us, cs, delta)
    ok, r = conditioning_check(us, cs)
    _, _, rms = fit_affine(us, cs)
    print(f"{name}: plain-gate={'PASS' if gate else 'REJECT'} (rms={rms:.4g}) | "
          f"check={'ACCEPT' if ok else 'REJECT'} (R={r:.3g}) | "
          f"registered-expectation gate={expect_gate} check={expect_check}")
    return gate, ok


def main():
    print("== synthetic cases (canonicals self-defined; frozen family y=a+b*u) ==")
    # T1/T2: equal-spaced constellation, u = 1..5, truth c = 100 + 40*u
    us_eq = [1.0, 2.0, 3.0, 4.0, 5.0]
    truth_eq = [100 + 40 * u for u in us_eq]
    shifted_eq = truth_eq[1:] + [truth_eq[-1] + 40]  # consistent +1-index shift
    report_case("T1 equal+shifted(all wrong)", us_eq, shifted_eq, DELTA_SYNTH, "PASS", "REJECT")
    report_case("T2 equal+honest", us_eq, truth_eq, DELTA_SYNTH, "PASS", "REJECT")
    # T3/T4: irregular constellation
    us_ir = [1.0, 2.3, 2.9, 5.1, 7.8]
    truth_ir = [100 + 40 * u for u in us_ir]
    shifted_ir = truth_ir[1:] + [truth_ir[-1] + 40]
    report_case("T3 irregular+honest", us_ir, truth_ir, DELTA_SYNTH, "PASS", "ACCEPT")
    report_case("T4 irregular+shifted", us_ir, shifted_ir, DELTA_SYNTH, "REJECT", "(report)")

    print("\n== T5 real fixture geometry (no identity claim) ==")
    xs, ys = [], []
    with open(FIXTURE) as f:
        for line in f:
            parts = line.split()
            if len(parts) == 2:
                # EU decimal commas in this fixture variant (transport-level
                # tolerance, mirrors parseFirstColNum in convention-audit.ts)
                xs.append(float(parts[0].replace(",", ".", 1) if "," in parts[0] else parts[0]))
                ys.append(float(parts[1].replace(",", ".", 1) if "," in parts[1] else parts[1]))
    peaks = detect_peaks(xs, ys)
    px = [xs[p] for p in peaks]
    print(f"persistent peaks: n={len(peaks)} at x={[f'{v:.1f}' for v in px]}")
    for uname, ufn in (("x", lambda v: v), ("1/x", lambda v: 1.0 / v)):
        if len(px) < 2:
            break
        us = sorted(ufn(v) for v in px)
        d = [b - a for a, b in zip(us, us[1:])]
        cv = statistics.pstdev(d) / statistics.mean(d) if len(d) > 1 else float("nan")
        print(f"  u={uname}: min_du={min(d):.6g} spacing_CV={cv:.3f} "
              f"({'NEAR-REGULAR (attack live)' if cv < 0.15 else 'irregular'})")
        print(f"    delta bound formula: delta < |b| * {min(d):.6g} / 2 (b from the merge fit)")


if __name__ == "__main__":
    sys.exit(main())


# ---- addendum-01 extension (architect review F1/F2/F13) ----------------

def conditioning_check_v2(us, cs):
    """v2: alternate set = {+1 shift, -1 shift, full reversal}."""
    n = len(us)
    if n < 3:
        return False, float("nan")
    _, _, rms_claimed = fit_affine(us, cs)
    alts = []
    if n - 1 >= 3:
        alts.append(fit_affine(us[:-1], cs[1:])[2])
        alts.append(fit_affine(us[1:], cs[:-1])[2])
    alts.append(fit_affine(us, list(reversed(cs)))[2])
    r = min(alts) / max(rms_claimed, EPS)
    return r > R_THRESHOLD, r


def addendum():
    print("== addendum-01: architect-review attacks (registered in addendum-01-pre.md) ==")
    us_ir = [1.0, 2.3, 2.9, 5.1, 7.8]
    truth_ir = [100 + 40 * u for u in us_ir]
    us_eq = [1.0, 2.0, 3.0, 4.0, 5.0]
    truth_eq = [100 + 40 * u for u in us_eq]
    us_sym = [1.0, 2.0, 6.0, 10.0, 11.0]
    truth_sym = [100 + 40 * u for u in us_sym]

    cases = [
        ("T6  value-fab (invented a=7,b=3)", us_ir, [7 + 3 * u for u in us_ir]),
        ("T7a reversal on equal-spaced", us_eq, list(reversed(truth_eq))),
        ("T7b reversal on irregular-asym", us_ir, list(reversed(truth_ir))),
        ("T8  +2-shift on equal-spaced", us_eq, truth_eq[2:] + [truth_eq[-1] + 40, truth_eq[-1] + 80]),
        ("T9  two-element swap on irregular", us_ir, [truth_ir[0], truth_ir[3], truth_ir[2], truth_ir[1], truth_ir[4]]),
        ("T10 reversal on SYMMETRIC irregular", us_sym, list(reversed(truth_sym))),
    ]
    for name, us, cs in cases:
        gate = plain_gate(us, cs, DELTA_SYNTH)
        ok1, r1 = conditioning_check(us, cs)
        ok2, r2 = conditioning_check_v2(us, cs)
        _, _, rms = fit_affine(us, cs)
        print(f"{name}: plain-gate={'PASS' if gate else 'REJECT'} (rms={rms:.4g}) | "
              f"v1={'ACCEPT' if ok1 else 'REJECT'} (R={r1:.3g}) | "
              f"v2={'ACCEPT' if ok2 else 'REJECT'} (R={r2:.3g})")
    print("\nv2 regression over T1-T4 originals:")
    for name, us, cs in [("T1", us_eq, truth_eq[1:] + [truth_eq[-1] + 40]),
                          ("T2", us_eq, truth_eq),
                          ("T3", us_ir, truth_ir),
                          ("T4", us_ir, truth_ir[1:] + [truth_ir[-1] + 40])]:
        ok2, r2 = conditioning_check_v2(us, cs)
        print(f"  {name}: v2={'ACCEPT' if ok2 else 'REJECT'} (R={r2:.3g})")
