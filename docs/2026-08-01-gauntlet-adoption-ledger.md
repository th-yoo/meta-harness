# Gauntlet adoption ledger

Verdicts of the Gauntlet adoption loop
(`docs/superpowers/plans/2026-08-01-gauntlet-adoption-loop.md`). One row
per application; bar frozen in the plan before build; builder never graded
itself (fresh-context critics).

| Loop | Application | Branch | Verdict | Why (evidence) |
|---|---|---|---|---|
| A | reviewer null-precedent bar + biggest-gap revise (`minimal/review.ts`) | `gauntlet-sa-review-bar` | OPEN — building | — |
| C | gauntlet-shaped seed content (Path A Stage 0) | (rides tournament) | DEFERRED — decision at tournament verdict | bar = screen w/ concurrent v7 arm → k=5 McNemar → guards; employ iff gauntlet-shaped seed is certified winner |
| D | proposer ranked-gap targeting (`minimal/propose.ts`) | `gauntlet-sd-proposer-gap` @ `125ef47` (unmerged, kept for reopen) | **DROP — unproven within frozen bar** | Paired-on-same-evidence eval (2 records, 6 completed opus-5 calls): bar clause "passes review" never engaged — every qualifying record's dominant gap is saturated by a rejected-ledger near-dup (sparql→scope-leak, headless→reproduction), so both arms correctly abstained; repeat-pair remedy has no qualifying record to run on. Code itself reviewed clean (0 merge-blocking findings, tests independently verified 33+89). Directional positives recorded, NOT verdict evidence: new arm reached correct abstains with attempt-id-traceable ranked gap analysis (critic independently verified 5/6 cited attempts) at fewer calls than old (0 vs 2 on pair 2). **Reopen trigger:** fresh failure records from future bench runs (post-plateau) re-arm the paired eval; branch kept unmerged. |
| F | reinject v2 biggest-gap-first wording (`cc-gate-plugin/src/reinject.ts`) | `gauntlet-sf-reinject-v2` @ `e2ad44b`+`47af5f7` (unmerged) | **OPEN — interim code-critic PASS (2 rounds)** | Round 1 FAIL (score-cli render dropped v2 arm) → fixed + render/e2e tests; round 2 PASS: byte-identical live behavior without `KKAMAK_REINJECT_V2=1` (test-pinned), F1 verified byte-level clean, 568 tests + tsc. Suite run independently by orchestrator. Employ/drop BLOCKED on evidence: fixtures=0, live blocked-cycle flow ≈8/2.5wk. **Two user gates before merge/activation:** (1) §4.4 amendment ruling for the 3rd arm (merge ≠ activation; env-gated); (2) final bar = fixture-replay k=5 paired McNemar on ≥3 fixtures OR live n≥20 blocked cycles. Sub-threshold note for amendment author: 3-arm underpowered guard couples v0/v1 verdict availability to v2's N during ramp-up. |
| P2 | agent-node Gauntlet Evaluator (fleet spec) | (spec edit on main) | PRE-REGISTERED — experiment written into fleet spec; decision deferred to fleet existence | spec §"Pre-registered future experiment" |
