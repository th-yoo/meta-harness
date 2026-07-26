# Daily evolution loop — design (2026-07-25)

**Status: DESIGN DOC.** Consolidates the 2026-07-25 desk discussion: how the
proposer loop reaches daily coding usage, what the minimal gate plugin is for,
and how the completion gate becomes the daily reward signal. Supersedes the
build-plan text that had accumulated in resume queue items 4/5 (those shrink to
decisions + pointer here). Companions:
[`2026-07-24-completion-gate-design.md`](2026-07-24-completion-gate-design.md) (gate mechanism),
[`2026-07-24-proposer-review-loop.md`](2026-07-24-proposer-review-loop.md) (review gate),
[`2026-07-25-gate-session-hygiene.md`](2026-07-25-gate-session-hygiene.md) (C2 channels + hygiene).

## 1. Roles — where evolution happens vs where traits get used

- **Bench (minimal/ + TB2) = evolution surface for MECHANISM-class traits.**
  Ground-truth graders exist there; gates/config/mechanisms certify there
  before touching daily use (A2 precedent).
- **Daily sessions = evolution surface for CONTEXT-class traits** (project
  bullets) — the real work distribution, evidence the bench can never have.
- **Minimal gate plugin = deployment + SENSOR.** It exports the certified gate
  to daily work AND produces the objective per-session signal the daily loop
  needs. It does NOT evolve anything by itself (no variation/selection/
  heredity — one frozen trait, applied).

Architectural statement (user-settled 2026-07-25): **the proposer is the core
engine of self-improvement**; everything else (gates, forensics, ledgers,
futility) exists to make its output trustworthy. Empirically it is also the
weakest seat (R1–R6 record: nulls + honest abstains; every certified win was
human/session-authored). This design is investment path (1) of the drift fork:
extend the machine seat rather than rename the mission.

## 2. The missing grader problem — and its solution

Daily sessions have no verify.sh ground truth. The production plugin's existing
trial mode selects on human `/mh-score` + heuristics = sparse, noisy. Selection
on noisy reward discards the week's whole discipline.

**The completion gate IS the missing grader.** Its outcomes are objective,
per-session, free: accepted at round 0 / needed N rounds / exhausted; mutants
killed vs survived; check-command pass/fail. These become the daily reward
proxy — no human in the loop.

## 3. Target daily loop

```
daily mh-sessions (gate armed via minimal gate plugin)
  → evidence: trajectories + GATE OUTCOMES (objective) + /mh-score (sparse human)
  → proposer WITH review gate + rejected ledger (ports of R4/R6 lessons)
  → trial mode: provisional adoption, scored by gate-outcome deltas over next N sessions
  → keep / rollback (adoption discipline unchanged)
```

## 4. Build stages (each evidence-gated, in order)

1. **Minimal gate plugin** (standalone, engine-free, ~150 lines + tests):
   - One hook: session.idle → applicability (gate.json present? session wrote
     files? rounds left? human typed = stand down) → run check command → fail =
     reinject evidence via client + visible round toast → exhausted = toast.
   - gate.json in repo = opt-in config: check command, rounds, marker on/off.
     Acceptance marker default ON (hygiene doc). CACHE PRESERVED — no context
     editing ever (user decision, final).
   - Records outcomes to a local ndjson (the sensor output).
   - Reuses complete-gate.ts round semantics; mutation probe = v2 (daily value
     starts with "checks must pass before done").
   - Adapter/engine split honored: gate logic platform-independent; opencode
     adapter maps session.idle + reinject transport (client API — verify at
     build time). Port-relevant facts from the 07-25 index.ts read:
     tool.execute.after already captures touched files (artifact derivation);
     engine.sessionIdle ordering hazard (gate check must precede scoring;
     separate plugin sidesteps it); toastAndSwallow = round-notice surface.
   - PREREQ: C1 held-out transfer certified (gate that ships = the validated
     one). Optional runtime scope-guard: gate.json `validatedFor` task classes.
   - **Known interaction (accepted 2026-07-26):** on mh-scored sessions, gate
     reinject turns re-fire the engine's session.idle pipeline — the human may
     see an extra score prompt per gate round; score once, at the end.
     Engine-side suppression deferred until the sensor proves the gate's daily
     value.
2. **Review gate + rejected ledger into the production proposer path**
   (engine.ts propose flow gains what minimal's R4/R6 proved: layer-1
   deterministic checks, rubric review, bounded revise, permanent rejection
   ledger as proposer input).
3. **Trial mode re-based on gate outcomes** — provisional candidates scored by
   objective gate-outcome deltas (round counts, exhaustion rate) instead of
   raw human score rate.
4. **Mechanism-class proposals** (the engine upgrade): proposer output schema
   gains a `mechanism` action (gate.json deltas: check specs, operators,
   rounds); Reviewer layer-1 checks for them; adoption gate + guards + held-out
   apply unchanged. The machine seat reaches the actuator level where R10's
   lift actually lived.

## 5. What is deliberately NOT here

- Context editing / request-time filtering (dead: ~130-turn break-even).
- Stochastic curtailment / SPRT (explicitly-not-now §7.5 stands).
- Full-plugin integration of the gate (only after the minimal plugin proves
  itself in use — Gall).
- Any daily-loop build before C2 + C1 verdicts land (bench first).
