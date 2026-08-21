#!/usr/bin/env python3
"""R3-1: does a REBUILT battery make the plateau certificate insensitive to the
instrument's output? Reuses derive.py's validated machinery, parameterizing the
persistence floor the way Task 16 would. Run from repo root."""
import importlib.util
import os
import statistics
import sys

spec = importlib.util.spec_from_file_location(
    "derive", "docs/loop-probes/derived-thresholds-20260821/derive.py")
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

GRA = "term-bench2/probe-tasks/raman-fitting-audit/environment/task-deps/graphene.dat"


def detect(ys, persistence):
    per_scale = []
    for w in range(5, 102, 2):
        sm = d.smooth(ys, w)
        thresh = sorted(sm)[int(0.9 * len(sm))]
        per_scale.append([i for i in range(1, len(sm) - 1)
                          if sm[i] > sm[i - 1] and sm[i] >= sm[i + 1] and sm[i] > thresh])
    anchors = []
    for p in per_scale[0]:
        pos, track = p, [p]
        for scale in per_scale[1:]:
            m = next((q for q in scale if abs(q - pos) <= 3), None)
            if m is None:
                break
            pos = m
            track.append(m)
        if len(track) >= persistence:
            anchors.append((p, track))
    merged = []
    for p, tr in sorted(anchors):
        if merged and p - merged[-1][0] <= 3:
            continue
        merged.append((p, tr))
    return merged


def sigmas(xs, ys, anchors):
    sm = d.smooth(ys, 5)
    resid = [y - s for y, s in zip(ys, sm)]
    step = abs(xs[1] - xs[0])
    us, sig_u = [], []
    for p, track in anchors:
        us.append(xs[p])
        px = [xs[t] for t in track]
        sx = statistics.pstdev(px) if len(px) > 1 else step
        sig_u.append(max(abs((xs[p] + max(sx, step)) - xs[p]), d.EPS))
    return us, sig_u


def verdict_vector_rebuilt(xs, ys, persistence):
    """Task 16 AS I WROTE IT: battery rebuilt from whatever anchors appear."""
    anchors = detect(ys, persistence)
    if len(anchors) < 3:
        return len(anchors), "uncheckable:n<3"
    us, sig_u = sigmas(xs, ys, anchors)
    span = max(us) - min(us)
    if span <= 0 or max(sig_u) / span > 0.01:
        return len(anchors), "uncheckable:noise"
    sig_c = [2.0 * s for s in sig_u]
    honest = [10 + 2.0 * u for u in us]
    shifted = honest[1:] + [honest[-1] + 2.0]
    reversed_ = list(reversed(honest))
    quad = [20 + 0.5 * u * u for u in us]
    vec = "|".join(d.merge_accept(us, cs, sig_c, d.REG_LEVEL)[0]
                   for cs in (honest, shifted, reversed_, quad))
    return len(anchors), vec


xs, ys = d.parse_series(GRA)
print("persistence : n_anchors : REBUILT verdict vector")
base_n = None
for k in [1, 2, 3, 5, 8, 12, 20, 30, 40, 49]:
    n, vec = verdict_vector_rebuilt(xs, ys, k)
    if k == 5:
        base_n = n
    print(f"{k:>11} : {n:>9} : {vec}")

print()
print("VERDICT: if the vector is constant while n_anchors moves, the rebuilt")
print("battery certifies parameter values whose OUTPUT changed completely.")
print(f"default (persistence=5) found n={base_n}")
