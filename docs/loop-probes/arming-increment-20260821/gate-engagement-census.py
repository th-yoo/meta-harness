#!/usr/bin/env python3
"""GENERALITY CENSUS: on how many REAL terminal-bench-2 tasks does the armed
lane-A gate even engage, and on how many can it actually rule?

Zero spend. Host-dependent by nature of the question (what do the real tasks
ship?) — reads ~/z2/terminal-bench-2, same stance as census-gen.py.

Applies the plan's own structural criteria, in order:
  1. eligible   = files reachable from a COPY/ADD source under environment/
  2. series     = exactly one eligible artifact parsing as 2 numeric columns
                  with >= MIN_SERIES_ROWS (101) rows and >= 90% line coverage
  3. anchors    = >= 3 scale-persistent peaks (the detector's own output)
  4. in-domain  = max(sigma_u)/span(u) <= 0.01 under BOTH frozen families

A task must clear all four for the gate to return anything but `uncheckable`.
Run from repo root:
    python3 -B docs/loop-probes/arming-increment-20260821/gate-engagement-census.py
"""
import importlib.util
import os
import re
import statistics
import sys

spec = importlib.util.spec_from_file_location(
    "derive", "docs/loop-probes/derived-thresholds-20260821/derive.py")
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

TB = os.path.expanduser("~/z2/terminal-bench-2")
MIN_SERIES_ROWS = 101          # = the detector's widest smoothing window
DOMAIN_BOUND = 0.01            # 8.2(b) validated noise domain
METADATA = {"FROM", "RUN", "CMD", "LABEL", "MAINTAINER", "EXPOSE", "ENV",
            "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD",
            "STOPSIGNAL", "HEALTHCHECK", "SHELL"}


def copy_manifest(text):
    """Strict: anything unmodellable makes the whole manifest unresolvable."""
    joined = re.sub(r"\\[ \t]*\r?\n", " ", text)
    srcs = []
    for raw in joined.split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^(\S+)\s*(.*)$", line)
        if not m:
            return None
        directive, body = m.group(1).upper(), m.group(2)
        if directive in METADATA:
            continue
        if directive not in ("COPY", "ADD"):
            return None
        if "--from=" in body:
            return None
        parts = [t for t in body.split() if not t.startswith("--")]
        if len(parts) < 2:
            return None
        for s in parts[:-1]:
            if re.search(r"[*?\[\]]", s):
                return None
            srcs.append(s)
    return srcs


def eligible_files(env):
    df = os.path.join(env, "Dockerfile")
    if not os.path.isfile(df):
        return None
    srcs = copy_manifest(open(df, errors="replace").read())
    if srcs is None:
        return None
    out = set()
    root = os.path.realpath(env)
    for s in srcs:
        cand = os.path.realpath(os.path.join(root, s))
        if not (cand == root or cand.startswith(root + os.sep)):
            return None
        if os.path.isfile(cand):
            out.add(cand)
        elif os.path.isdir(cand):
            for r, _, fs in os.walk(cand):
                for f in fs:
                    out.add(os.path.join(r, f))
    return sorted(f for f in out if os.path.basename(f) != "Dockerfile")


def as_series(path):
    try:
        with open(path, "rb") as fh:
            head = fh.read(8000)
        if b"\x00" in head:
            return None
        text = open(path, errors="replace").read()
    except OSError:
        return None
    nonblank = [l for l in text.split("\n") if l.strip()]
    if len(nonblank) < MIN_SERIES_ROWS:
        return None
    xs, ys = d.parse_series(path)
    if len(xs) < MIN_SERIES_ROWS or len(xs) / len(nonblank) < 0.9:
        return None
    return xs, ys


def sigma_fraction(xs, ys, ufn):
    anchors = d.detect_with_tracking(ys)
    if len(anchors) < 3:
        return len(anchors), None
    step = abs(xs[1] - xs[0])
    us, sig_u = [], []
    for p, track in anchors:
        px = [xs[t] for t in track]
        sx = statistics.pstdev(px) if len(px) > 1 else step
        us.append(ufn(xs[p]))
        sig_u.append(max(abs(ufn(xs[p] + max(sx, step)) - ufn(xs[p])), d.EPS))
    span = max(us) - min(us)
    if span <= 0:
        return len(anchors), None
    return len(anchors), max(sig_u) / span


def main():
    tasks = sorted(t for t in os.listdir(TB) if os.path.isdir(os.path.join(TB, t)))
    n_env = n_resolvable = n_one_series = n_anchors = n_in_domain = 0
    rows = []
    for t in tasks:
        env = os.path.join(TB, t, "environment")
        if not os.path.isdir(env):
            continue
        n_env += 1
        files = eligible_files(env)
        if files is None:
            rows.append((t, "unresolvable-manifest", "", ""))
            continue
        n_resolvable += 1
        cands = [(f, s) for f in files if (s := as_series(f))]
        if len(cands) != 1:
            rows.append((t, f"series-candidates={len(cands)}", "", ""))
            continue
        n_one_series += 1
        path, (xs, ys) = cands[0]
        na, fx = sigma_fraction(xs, ys, lambda x: x)
        _, fi = sigma_fraction(xs, ys, lambda x: 1 / x if x else float("inf"))
        if fx is None:
            rows.append((t, f"anchors={na} (<3)", os.path.basename(path), ""))
            continue
        n_anchors += 1
        ok = fx <= DOMAIN_BOUND and (fi is not None and fi <= DOMAIN_BOUND)
        if ok:
            n_in_domain += 1
        rows.append((t, f"anchors={na}", os.path.basename(path),
                     f"sigmaFrac x={fx:.5f} 1/x={'na' if fi is None else f'{fi:.5f}'} -> "
                     f"{'IN DOMAIN' if ok else 'OUT'}"))

    print("# Gate-engagement census (generality of the armed lane-A gate)\n")
    print(f"tasks with environment/:        {n_env}")
    print(f"  resolvable COPY manifest:     {n_resolvable}")
    print(f"  exactly one numeric series:   {n_one_series}")
    print(f"  >=3 persistent anchors:       {n_anchors}")
    print(f"  INSIDE validated noise domain:{n_in_domain}   <-- gate can rule here and nowhere else\n")
    print("| task | stage reached | series | noise |")
    print("|---|---|---|---|")
    for t, stage, path, noise in rows:
        if path or "unresolvable" in stage:
            print(f"| {t} | {stage} | {path} | {noise} |")
    print(f"\n(tasks that stopped at series-candidates=0 are omitted from the table: "
          f"{sum(1 for r in rows if r[1] == 'series-candidates=0')})")


if __name__ == "__main__":
    sys.exit(main())
