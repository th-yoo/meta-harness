#!/usr/bin/env python3
"""Length-vs-difficulty failure classification over stored TB2 trajectories.

Implements docs/loop-probes/dnc-length-vs-difficulty-20260820/pre-registration.md
verbatim. Zero model spend; deterministic. Run from the repo root:

    python3 docs/loop-probes/dnc-length-vs-difficulty-20260820/classify.py
"""
import glob
import json
import os
import re
import statistics
import sys
from collections import Counter, defaultdict

STORE = "term-bench2/store/global/candidates"
MARKERS = ("output truncated", "context low", "[truncated")


def load_sessions():
    """Yield (candidate, session-record, traj-path-or-None) for every scored session."""
    for sj in sorted(glob.glob(os.path.join(STORE, "*", "score.json"))):
        cand = os.path.basename(os.path.dirname(sj))
        with open(sj) as f:
            d = json.load(f)
        tdir = os.path.join(os.path.dirname(sj), "traj")
        for s in d.get("sessions", []):
            p = os.path.join(tdir, s["sessionID"] + ".ndjson")
            yield cand, s, (p if os.path.exists(p) else None)


def task_of(session_id):
    m = re.match(r"bench-(.+)-\d+-[0-9a-f]+$", session_id)
    return m.group(1) if m else session_id


def traj_metrics(path):
    """M2..M7 inputs from one traj file."""
    events = []
    unparseable = 0
    with open(path, "rb") as f:
        raw = f.read()
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except Exception:
            unparseable += 1
    n = len(events)
    out_bytes = 0
    err_positions = []
    marker = False
    cmd_positions = defaultdict(list)
    for i, e in enumerate(events):
        if e.get("t") != "tool":
            continue
        out = e.get("output") or ""
        out_bytes += len(out)
        if any(m in out.lower() for m in MARKERS):
            marker = True
        if e.get("error"):
            err_positions.append(i)
        args = re.sub(r"\s+", " ", (e.get("args") or ""))[:60]
        cmd_positions[(e.get("tool", "").lower(), args)].append(i)
    thrash = 0
    if n:
        final_third = 2 * n / 3
        for positions in cmd_positions.values():
            if len(positions) >= 3 and sum(1 for p in positions if p >= final_third) >= 2:
                thrash += 1
    last_err_frac = (err_positions[-1] / max(n - 1, 1)) if err_positions else None
    return {
        "events": n,
        "unparseable": unparseable,
        "bytes": len(raw),          # M2
        "out_bytes": out_bytes,     # M3
        "errors": len(err_positions),  # M4
        "last_err_frac": last_err_frac,  # M5
        "thrash": thrash,           # M6
        "marker": marker,           # M7
    }


def main():
    failed, passed = [], []
    no_traj_failed = 0
    for cand, s, p in load_sessions():
        rec = {
            "candidate": cand,
            "id": s["sessionID"],
            "task": task_of(s["sessionID"]),
            "model": s.get("model", "?"),
            "turns": s.get("turnCount", 0),
        }
        if p is None:
            if not s.get("passed"):
                no_traj_failed += 1
            continue
        rec.update(traj_metrics(p))
        (passed if s.get("passed") else failed).append(rec)

    # M8 exclusion
    excluded = [r for r in failed if r["turns"] == 0 or r["events"] < 3]
    pool = [r for r in failed if r not in excluded]

    out_q3 = statistics.quantiles([r["out_bytes"] for r in pool], n=4)[2]
    out_med = statistics.median([r["out_bytes"] for r in pool])

    def classify(r):
        if r["marker"] or (r["out_bytes"] >= out_q3 and (r["last_err_frac"] or 0) >= 0.75):
            return "LENGTH-hard"
        if r["thrash"] >= 1:
            return "LENGTH-thrash"
        if r["out_bytes"] < out_med and r["thrash"] == 0 and not r["marker"]:
            return "DIFFICULTY"
        return "AMBIGUOUS"

    for r in pool:
        r["class"] = classify(r)

    counts = Counter(r["class"] for r in pool)
    n = len(pool)
    hard = counts["LENGTH-hard"]
    thr = counts["LENGTH-thrash"]
    print(f"corpus: {len(failed)} failed with traj ({no_traj_failed} failed without traj), "
          f"{len(passed)} passed with traj; excluded (M8): {len(excluded)}")
    print(f"cutoffs: out_bytes median={out_med:.0f} q3={out_q3:.0f}")
    print(f"\nclassifiable failures: {n}")
    for k in ("LENGTH-hard", "LENGTH-thrash", "DIFFICULTY", "AMBIGUOUS"):
        print(f"  {k:14s} {counts[k]:4d}  ({100*counts[k]/n:.1f}%)")
    print(f"\nLENGTH share hard-only:   {100*hard/n:.1f}%")
    print(f"LENGTH share hard+thrash: {100*(hard+thr)/n:.1f}%")

    print("\nper-task (classifiable failures; tasks with >=3):")
    by_task = defaultdict(Counter)
    for r in pool:
        by_task[r["task"]][r["class"]] += 1
    for task, c in sorted(by_task.items(), key=lambda kv: -sum(kv[1].values())):
        tot = sum(c.values())
        if tot < 3:
            continue
        print(f"  {task:38s} n={tot:3d}  hard={c['LENGTH-hard']:2d} thrash={c['LENGTH-thrash']:2d} "
              f"diff={c['DIFFICULTY']:2d} ambig={c['AMBIGUOUS']:2d}")

    print("\nwithin-task contrast (tasks with >=1 pass and >=1 fail traj):")
    ptasks = defaultdict(list)
    for r in passed:
        ptasks[r["task"]].append(r)
    for task in sorted(ptasks):
        fails = [r for r in pool if r["task"] == task]
        if not fails:
            continue
        mp = statistics.mean([r["out_bytes"] for r in ptasks[task]])
        mf = statistics.mean([r["out_bytes"] for r in fails])
        print(f"  {task:38s} pass n={len(ptasks[task])} mean_out={mp:9.0f} | "
              f"fail n={len(fails)} mean_out={mf:9.0f} | fail/pass={mf/max(mp,1):.2f}x")

    with open(os.path.join(os.path.dirname(__file__), "sessions.json"), "w") as f:
        json.dump({"failed": pool, "excluded": excluded, "passed": passed}, f, indent=1)
    print("\nper-session detail -> sessions.json")


if __name__ == "__main__":
    sys.exit(main())
