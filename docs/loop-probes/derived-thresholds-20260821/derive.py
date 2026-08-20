#!/usr/bin/env python3
"""Reference implementation + validation per pre-registration.md.
Zero model spend, stdlib only. Run from repo root:
    python3 docs/loop-probes/derived-thresholds-20260821/derive.py
"""
import json
import math
import os
import statistics
import sys

EPS = 1e-9
LEVELS = {0.99: 2.326, 0.999: 3.090, 0.9999: 3.719}  # z-quantiles (convention)
REG_LEVEL = 0.999


def chi2_q(p, k):
    """Wilson–Hilferty approximation of the chi-square quantile (deterministic)."""
    z = LEVELS[p]
    return k * (1 - 2 / (9 * k) + z * math.sqrt(2 / (9 * k))) ** 3


def fit_affine(us, cs):
    n = len(us)
    mu, mc = sum(us) / n, sum(cs) / n
    sxx = sum((u - mu) ** 2 for u in us)
    sxy = sum((u - mu) * (c - mc) for u, c in zip(us, cs))
    b = 0.0 if sxx < EPS else sxy / sxx
    a = mc - b * mu
    res = [a + b * u - c for u, c in zip(us, cs)]
    return a, b, res


def automorphisms(us, tol=None):
    su = sorted(us)
    n = len(su)
    if n < 3:
        return []
    mind = min(su[i + 1] - su[i] for i in range(n - 1))
    t = tol if tol is not None else mind / 4
    perms = []
    images = [lambda u, m=su[0] + su[-1]: m - u]
    for k in range(1, n):
        d = su[k] - su[0]
        images += [lambda u, d=d: u + d, lambda u, d=d: u - d]
    for img in images:
        used, perm, ok = set(), [], True
        for i in range(n):
            tgt = img(su[i])
            hit = next((j for j in range(n) if j not in used and abs(su[j] - tgt) <= t), None)
            if hit is None:
                ok = False
                break
            used.add(hit)
            perm.append(hit)
        if ok and any(p != i for i, p in enumerate(perm)):
            if perm not in perms:
                perms.append(perm)
    return perms


def predicate(us, cs, sigmas, level):
    """X^2 of the affine fit's residuals against per-anchor sigma; pass iff <= chi2_q(level, n-2)."""
    n = len(us)
    if n < 3:
        return False, float("inf")
    _, _, res = fit_affine(us, cs)
    x2 = sum((r / max(s, EPS)) ** 2 for r, s in zip(res, sigmas))
    return x2 <= chi2_q(level, n - 2), x2


def merge_accept(us, cs, sigmas, level):
    """ONE predicate for both jobs: claim must pass; EVERY alternate pairing must fail."""
    idx = sorted(range(len(us)), key=lambda i: us[i])
    su = [us[i] for i in idx]
    sc = [cs[i] for i in idx]
    ss = [sigmas[i] for i in idx]
    ok, x2 = predicate(su, sc, ss, level)
    if not ok:
        return "reject-residual", x2
    alts = [[sc[p] for p in perm] for perm in automorphisms(su)]
    n = len(su)
    if n - 1 >= 3:
        # +/-1 shifts drop one anchor; sigmas follow the kept anchors
        a_ok, _ = predicate(su[:-1], sc[1:], ss[:-1], level)
        b_ok, _ = predicate(su[1:], sc[:-1], ss[1:], level)
        if a_ok or b_ok:
            return "reject-degenerate", x2
    for alt in alts:
        alt_ok, _ = predicate(su, alt, ss, level)
        if alt_ok:
            return "reject-degenerate", x2
    return "accept", x2


# ---- series-side derivation (real fixtures) --------------------------------

def parse_series(path):
    xs, ys = [], []
    for line in open(path):
        parts = line.split()
        if len(parts) != 2:
            continue
        def num(t):
            return float(t.replace(",", ".", 1)) if ("," in t and "." not in t) else float(t)
        try:
            xs.append(num(parts[0]))
            ys.append(num(parts[1]))
        except ValueError:
            pass
    return xs, ys


def smooth(ys, w):
    half = w // 2
    out = []
    for i in range(len(ys)):
        lo, hi = max(0, i - half), min(len(ys), i + half + 1)
        out.append(sum(ys[lo:hi]) / (hi - lo))
    return out


def detect_with_tracking(ys):
    """Registered detector params; returns (final_positions, per-anchor matched-position lists)."""
    per_scale = []
    for w in range(5, 102, 2):
        sm = smooth(ys, w)
        thresh = sorted(sm)[int(0.9 * len(sm))]
        per_scale.append([i for i in range(1, len(sm) - 1)
                          if sm[i] > sm[i - 1] and sm[i] >= sm[i + 1] and sm[i] > thresh])
    anchors = []
    for p in per_scale[0]:
        pos, run, track = p, 1, [p]
        for scale in per_scale[1:]:
            m = next((q for q in scale if abs(q - pos) <= 3), None)
            if m is None:
                break
            pos, run = m, run + 1
            track.append(m)
        if run >= 5:
            anchors.append((p, track))
    merged = []
    for p, tr in sorted(anchors):
        if merged and p - merged[-1][0] <= 3:
            continue
        merged.append((p, tr))
    return merged


def series_sigmas(path, ufn):
    xs, ys = parse_series(path)
    anchors = detect_with_tracking(ys)
    sm = smooth(ys, 5)
    resid = [y - s for y, s in zip(ys, sm)]
    med = statistics.median(resid)
    sigma_y = 1.4826 * statistics.median(abs(r - med) for r in resid)
    step = abs(xs[1] - xs[0])
    us, sig_u = [], []
    for p, track in anchors:
        us.append(ufn(xs[p]))
        # position spread across persistent scales, in x units -> u units via local derivative
        px = [xs[t] for t in track]
        sx = statistics.pstdev(px) if len(px) > 1 else step
        du = abs(ufn(xs[p] + max(sx, step)) - ufn(xs[p]))
        sig_u.append(max(du, EPS))
    return xs, us, sig_u, sigma_y


def main():
    out = []
    def rep(tag, got, exp):
        mark = "OK" if got == exp else "*** DEVIATES ***"
        out.append(f"{tag}: got={got} expected={exp} [{mark}]")

    # --- synthetic V1-V6 (sigma floored at EPS) ---
    truth = lambda us: [100 + 40 * u for u in us]
    eq, ir, sym = [1, 2, 3, 4, 5], [1.0, 2.3, 2.9, 5.1, 7.8], [1, 2, 6, 10, 11]
    sig = lambda us: [EPS] * len(us)
    for lvl in LEVELS:
        r1, _ = merge_accept(eq, truth(eq)[1:] + [truth(eq)[-1] + 40], sig(eq), lvl)
        r2, _ = merge_accept(eq, truth(eq), sig(eq), lvl)
        r3, _ = merge_accept(ir, truth(ir), sig(ir), lvl)
        r4, _ = merge_accept(ir, truth(ir)[1:] + [truth(ir)[-1] + 40], sig(ir), lvl)
        r5, _ = merge_accept(ir, [7 + 3 * u for u in ir], sig(ir), lvl)
        r6, _ = merge_accept(sym, list(reversed(truth(sym))), sig(sym), lvl)
        if lvl == REG_LEVEL:
            rep("V1 eq+shift", r1, "reject-degenerate")
            rep("V2 eq honest", r2, "reject-degenerate")
            rep("V3 ir honest", r3, "accept")
            rep("V4 ir shifted", r4, "reject-residual")
            rep("V5 value-fab", r5, "accept")
            rep("V6 sym reversal", r6, "reject-degenerate")
        out.append(f"  [sensitivity lvl={lvl}] V1..V6 = {r1[:9]},{r2[:9]},{r3[:9]},{r4[:9]},{r5[:9]},{r6[:9]}")

    # --- V7 noise sweep re-run (same seeds/sigmas/trials as addendum-02) ---
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
    T = truth(ir)
    SH = T[1:] + [T[-1] + 40]
    span = max(T) - min(T)
    for si, s_frac in enumerate([0.001, 0.005, 0.01, 0.02, 0.05]):
        s_abs = s_frac * span
        fr = fa = 0
        for seed in range(1, 201):
            r = prng(seed + si * 1000)
            noise = lambda: gauss(r) * s_abs
            hv, _ = merge_accept(ir, [c + noise() for c in T], [s_abs] * 5, REG_LEVEL)
            sv, _ = merge_accept(ir, [c + noise() for c in SH], [s_abs] * 5, REG_LEVEL)
            fr += hv != "accept"
            fa += sv == "accept"
        out.append(f"V7 sigma={s_frac*100:.1f}%: honest-false-reject={fr}/200 shifted-false-accept={fa}/200")

    # --- V8-V10 fixture 2 (real series-side derivation) ---
    d2 = "docs/loop-probes/dnc-second-fixture-20260820"
    tr = json.load(open(os.path.join(d2, "truth.json")))
    xs, us, sig_u, sigma_y = series_sigmas(os.path.join(d2, "fixture.dat"), lambda x: x)
    a_t, b_t = tr["a"], tr["b"]
    sig_c = [abs(b_t) * s for s in sig_u]
    oracle = [a_t + b_t * u for u in us]
    r8, x8 = merge_accept(us, oracle, sig_c, REG_LEVEL)
    rep(f"V8 fx2 oracle (n={len(us)}, sigma_y={sigma_y:.1f})", r8, "accept")
    r10a, _ = merge_accept(us, oracle[1:] + [oracle[-1] + b_t], sig_c, REG_LEVEL)
    r10b, _ = merge_accept(us, list(reversed(oracle)), sig_c, REG_LEVEL)
    rep("V10 fx2 b1 shifted", r10a, "reject-residual")
    out.append(f"V10 fx2 b2 reversed: got={r10b} expected=reject (either reason)"
               + (" [OK]" if r10b != "accept" else " [*** DEVIATES ***]"))
    r9, x9 = merge_accept(us, [20 + 0.5 * u * u for u in us], sig_c, REG_LEVEL)
    rep("V9 fx2 b3 quadratic (F1 closure)", r9, "reject-residual")

    # --- V11 graphene (real series, inv-x family honest synthetic claim) ---
    g = "term-bench2/probe-tasks/raman-fitting-audit/environment/task-deps/graphene.dat"
    xs, us, sig_u, sigma_y = series_sigmas(g, lambda x: x)
    sig_c = [2.0 * s for s in sig_u]
    claim = [10 + 2.0 * u for u in us]
    r11, x11 = merge_accept(us, claim, sig_c, REG_LEVEL)
    rep(f"V11 graphene honest (n={len(us)}, sigma_y={sigma_y:.1f})", r11, "accept")

    print("\n".join(out))


if __name__ == "__main__":
    sys.exit(main())
