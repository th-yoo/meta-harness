# Review artifact — fix-sensor-maxbuffer (arming-checklist item)

reviewed-range: 062baf0089adafb485d7a4530a1257d00d32a66d..6815e90d07aa10f68ad09833a18219ed5f4728cb
reviewer: fresh-context-code-reviewer-subagent
fresh-context: true
verdict: approved
findings-count: 1

Two-commit branch closing the review-sensor whole-branch review's
arming-checklist item: (f9c9023) GIT_MAX_BUFFER = 16 MiB on safeExec in
review-sensor/git-diff.ts — execFileSync's default 1 MiB maxBuffer made
a >1 MiB diff throw, get swallowed, and silently become empty diff text;
(6815e90) the review's single finding fixed: a regression test whose
fixture the reviewer traced byte-exactly (~2.9 MiB unified diff — 3x
over the old default, 5x under the new ceiling; genuinely fails
pre-fix through the range-diff branch, passes post-fix with ~20k
insertions).

Reviewer verified: both diff-producing call sites go through the fixed
safeExec (shortstat companion consistent); safeExecOk needs no buffer
(stdio ignore); no other execFileSync in the sensor modules carries the
default; 16 MiB is the right layering over the 128 KiB downstream
prompt truncation. Declared residual (in-code comment): a >16 MiB diff
re-opens the same degrade path — accepted, unrealistic for accumulated
Stop-to-Stop diffs. Tests 8/8 green, tsc clean.
