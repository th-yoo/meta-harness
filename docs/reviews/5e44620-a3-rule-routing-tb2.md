# Review — a3-rule-routing-tb2 (Plan A: contract + screens + TB2 adapter)

reviewed-range: 3c3b4c37871c501496479cfff968e28a46df1383..5e4462098c6a2b0fcc97eed42a413d35d00a454c
reviewer: fresh-context whole-branch reviewer (most capable model) + per-task fresh reviewers (SDD)
fresh-context: true
verdict: approved
findings-count: 6

14 commits implementing docs/superpowers/plans/2026-08-13-a3-rule-routing-tb2.md
(plan FLAWLESS, 3 architect rounds) under
docs/superpowers/specs/2026-08-13-a3-rule-routing-design.md (spec FLAWLESS,
4 rounds). Subagent-driven: 8 tasks, each with a fresh per-task review;
5 in-loop fix rounds; final whole-branch review + one fix wave + scoped
re-review (MERGE-READY).

## Findings (final whole-branch review; all addressed or triaged)

1. Important — check-only update ops silently swallowed by both no-op
   guards (strip() projections excluded `check`). FIXED in the fix wave
   (5e44620): projections carry {cmd, timeoutMs}; lane tests + interaction
   test added.
2. Important — no check-drop mechanism (prompt documented omit-to-drop;
   applyPlaybookOps kept on omit). FIXED: update-op check tri-state
   (null=delete / undefined=keep / object=set), prompt corrected, tests.
3. Minor — stale EnvBlock.checksHash doc. FIXED.
4. Minor — ab enforces per-layer vs run's multi-layer union (future
   asymmetry once cross-layer checks exist). DEFERRED as a recorded note;
   no cross-layer checks exist yet.
5. Minor — refusal wording/dedupe. FIXED.
6. Minor (Plan-B note) — update-op check resend resets state to shadow;
   harmless until promotion exists. DEFERRED to Plan B design.

## In-loop catches worth the record (per-task reviews)

- T3: backtick command substitution reached live tier (guard.ts separator
  class lacks backtick) — independent Tier B "substitution" reject added.
  The SAME hole exists in production cc-gate-plugin/src/gauge/guard.ts —
  ledgered for a separate F1 ruling, NOT touched on this branch.
- T6: hand-rolled timeout watchdog orphaned check process trees — fixed
  with set -m process-group kill + escalation, leak-repro test.
- T7: per-arm injection symmetry had zero regression coverage
  (mutation-survived) — arm-capture test added, mutation-verified.
- T8: budgetIdentityMatches read a verdict field no real verdict carries
  (T2 test masked it with a hand-built literal) — comparator re-pointed to
  activeChecksHash, seam test through the real verdict shape.

## Verification at merge-readiness

Full opencode-plugin suite 1954 pass / 1 skip / 2 fail / 2 errors — the
2/2 are the pre-existing minimal-llm* missing @th-yoo/cc-api-daemon
baseline, byte-identical pre/post branch. tsc clean beyond pre-existing
sibling-package noise. F1: only NEW file minimal/guard.ts +
opencode-plugin src/test touched; cc-gate-plugin, vendor/, frozen minimal/
files untouched. F2: slug-only ledger/log text, state.json carries
bulletIds+counts only — test-pinned.

## Run-time duties on first use (not code)

- First real checked-rule ab stamps a boundary ts in the adoption ledger.
- T9 probe (P2 PROBE C pattern, ≤4 haiku calls) = own sized go before any
  checked-rule arm spend.
