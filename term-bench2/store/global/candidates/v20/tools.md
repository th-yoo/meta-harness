# Grep

Grep output is an aggregated, truncated rendering — the match total it reports covers every file searched, and the per-file listing under it may be cut off. Never derive a number by hand-tallying that listing. When the question is about one file, pass that file as the search path; when the question is a count, get the count from a counting command rather than from the rendered match list.

# Bash

Prefer the command that answers the question directly over one whose output you must interpret: ahead/behind status rather than log ordering for push state, a measured rate over an observed window rather than an extrapolation from an early sample, and a recomputed metric rather than a stored number produced under a different protocol. Before comparing two numbers, confirm both were produced the same way.