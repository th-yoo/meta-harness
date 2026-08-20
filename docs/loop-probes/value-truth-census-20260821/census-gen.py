#!/usr/bin/env python3
"""Regenerates census.md (architect finding #7: the 21/61 figure must be
reproducible). Run from repo root:
    python3 docs/loop-probes/value-truth-census-20260821/census-gen.py > docs/loop-probes/value-truth-census-20260821/census.md
NOTE: reads the real terminal-bench-2 checkout at ~/z2/terminal-bench-2 —
host-dependent by nature of the question (what does the TASK ship?)."""
import glob
import os

TB = os.path.expanduser("~/z2/terminal-bench-2")
rows = []
for td in sorted(glob.glob("term-bench2/tasks/*/")):
    task = td.rstrip("/").split("/")[-1]
    env = os.path.join(TB, task, "environment")
    files = []
    if os.path.isdir(env):
        for r, _, fs in os.walk(env):
            for f in fs:
                if f == "Dockerfile" or f.startswith("."):
                    continue
                files.append(os.path.relpath(os.path.join(r, f), env))
    rows.append((task, len(files), sorted(files)))

multi = [(t, n, fs) for t, n, fs in rows if n >= 2]
single = [(t, n, fs) for t, n, fs in rows if n == 1]
zero = [t for t, n, _ in rows if n == 0]

print("# Value-truth L-A coverage census (2026-08-21)\n")
print("Zero-spend census over real terminal-bench-2 task environments (Dockerfile")
print("excluded): can source_crosscheck find task-owned artifacts INDEPENDENT of")
print("the audited claim's input? Regenerate with census-gen.py (this dir).\n")
print(f"Tasks: {len(rows)}; multi-artifact (crosscheck candidates): {len(multi)} "
      f"({100*len(multi)/len(rows):.0f}%); single-artifact (structurally NO-SOURCE): "
      f"{len(single)}; zero-env: {len(zero)}\n")
print("| task | env files | examples |")
print("|---|---|---|")
for t, n, fs in multi:
    print(f"| {t} | {n} | {', '.join(fs[:4])} |")
print("\nExecutable-evaluator subclass (replay-the-task-tool, strongest L-A form):")
for t, n, fs in multi:
    ev = [f for f in fs if f.endswith((".py", ".c", ".rs", ".R", ".sh")) and "test" not in f]
    if ev:
        print(f"- {t}: {', '.join(ev[:4])}")
print("\nSingle-artifact (NO-SOURCE):", ", ".join(t for t, n, fs in single))
print("Zero-env:", ", ".join(zero))
