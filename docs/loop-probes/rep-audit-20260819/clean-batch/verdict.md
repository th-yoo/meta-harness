# Clean-batch verdict (2026-08-19) — CONTENT GATE CONFIRMED

Scored per pre-registration.md, verdict line only, mechanical.

| input | r1 | r2 | correct |
|---|---|---|---|
| E1 clean CSV | NO MISMATCH | NO MISMATCH | 2/2 |
| E2 clean spectrum (domain bait) | NO MISMATCH | NO MISMATCH | 2/2 |
| E3 clean JSON | NOLINE (fail-quiet ok) | NO MISMATCH | 2/2 |
| E4 clean log | NO MISMATCH | NO MISMATCH | 2/2 |
| T1 raman BLIND | MISMATCH | MISMATCH | 2/2 |
| T2 dates | MISMATCH | MISMATCH | 2/2 |

Decision rule met: 0 false positives / 8 clean calls (bar: 0), 4/4 trapped
fire (bar: >=3/4). **CONTENT-gated injection is deployable for lane A.**
The post-hoc 4/4 observation from the main probe is now pre-registered-
confirmed at 12/12.

Notes:
- E3-r1 emitted the v1 escape sentence instead of the verdict line
  (NOLINE). A fail-quiet gate behaves correctly; remove the redundant
  escape-sentence clause from the prompt at lane-A build time.
- T1 blind-sample (informational): gate FIRES blind, but attribution
  degrades — neither call reran the spacing argument; r1 actively rejected
  nm, r2 stopped at "worth checking before fit". Pre-registered
  consequence applies: lane A's sampler must include distribution stats
  (min/max/spacing summary), not just head/tail rows. Fairness cap noted:
  the task's "nm" axis is the solution's 1e7/x fiction, not physical
  wavelengths, so full attribution on this task is partly unfair;
  detection (the gate's job) is unaffected.
