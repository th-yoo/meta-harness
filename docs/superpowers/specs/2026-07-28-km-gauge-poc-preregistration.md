# km-gauge PoC — pre-registration (2026-07-28)

**Status:** DRAFT — metrics below need explicit user approval before any code.
**Component name:** km-gauge (user-picked; go/no-go gauge metaphor — per-task
acceptance check derived from the prompt, held against the work at the
completion gate).
**Mode:** SHADOW ONLY. The gauge never blocks, never changes any completion-gate
decision. It derives, evaluates, and logs. Nothing else.

## 1. Question this PoC answers

Can a cheap hook-time refiner turn a raw task-shaped user prompt into an
acceptance check of measurable quality — good enough to justify designing a
blocking per-task layer later (§4.3/§4.4 integration)?

Prior-art gap it probes (2026-07-28 research): SDD tools (Spec Kit, Kiro,
cc-sdd) derive criteria but verify via LLM interpretation and never measure
derivation quality ("false sense of control" — Fowler). km-gauge = derivation
+ deterministic evaluation + measured quality via the kkamak sensor stream.

## 2. Pipeline (PoC scope)

1. **Classifier (in UserPromptSubmit hook, deterministic, no LLM):**
   task-shaped iff prompt has an imperative action verb (add/fix/implement/
   create/refactor/write/build/update/remove...) OR mentions a file path, AND
   is not question-only. Conservative: under-trigger preferred (cost control).
2. **Refiner (async, fire-and-forget):** single `claude -p` haiku call spawned
   at prompt time; runs while the main agent works the turn. Output JSON:
   `{goalSummary, criteria[] (EARS-ish), check: string|null, confidence}`.
   `check` = shell command, exit 0/1, expected-cheap. Written to
   `.km/gauge/<sessionID>-<n>.json`. Refiner crash/timeout → no file → logged
   as coverage miss. Detach + reap per interrupt-leak lesson.
3. **Shadow evaluation (in existing Stop hook, after floor-gate outcome):**
   if gauge file exists: run `check` (30s timeout) when executable; append to
   the SAME sensor stream (`.km/gate-outcomes.ndjson`) a `gauge` field:
   `{present, executable, pass, agreesWithFloor, derivationMs, confidence,
   model}`. Absent file → `{present:false}`. Zero effect on gate decision.
4. **Human labels:** end-of-window review session — user judges each
   would-have-blocked line RIGHT (real incompleteness) or WRONG (false block).
   No per-turn labeling burden during dogfood.

## 3. Pre-registered metrics + decision rule

Window: ≥30 task-shaped prompts across opt-in repos (km-play + meta-harness),
both hosts welcome (union stream), no fixed calendar deadline.

- **M0 coverage:** gauge file present at Stop on ≥70% of task-shaped prompts
  (else async timing model is broken — fix before judging M1–M3).
- **M1 executable rate:** ≥60% of present gauges carry a runnable `check`
  (runs to a clean 0/1 exit, no malformed-command error).
- **M2 false-block rate:** of would-have-blocked lines, ≤20% judged WRONG at
  review (a blocking layer built on worse than this jails the agent on bad
  criteria).
- **M3 value existence:** ≥1 would-have-blocked line judged RIGHT where the
  floor gate ACCEPTED (the gauge catches what repo-invariant checks cannot —
  the §4.4 point of the whole layer).

**Decision rule:** all four pass → write blocking-pilot design folded into
§4.3 trial machinery. M0/M1 fail → derivation/timing not viable as speced;
one redesign round allowed, then re-run window. M2/M3 fail → per-task layer
stays shadow indefinitely; the sensor dimension alone must justify the cost,
else kill. Small-N honesty: this is feasibility + calibration data collection,
not hypothesis testing — no p-values will be claimed.

## 4. Cost fencing

- Refiner = haiku, exactly 1 call per task-shaped prompt, hard daily cap 30
  calls (counter file `.km/gauge/daily-count`), opt-in via `"gauge": true` in
  `gate.json`, kill-switch `KKAMAK_GAUGE=off`.
- Live refiner calls start only on explicit go (standing spend rule) —
  building the code does not start the window.

## 5. Non-goals (v0)

No blocking. No prompt rewriting (hook is inject-only anyway). No multi-turn
task carry-forward (gauge is per-prompt; "continue" prompts classify
non-task-shaped and get no gauge). No §4.3 auto-keep/rollback integration.
No opencode port (CC plugin only).

## 6. Known risks

- Fast turns beat the async refiner → M0 measures it; mitigation candidates
  (evaluate-next-turn, lazy eval) deferred unless M0 fails.
- Weak-check risk moved up a level (refiner grades the grader) — M2 measures
  exactly this; refiner ≠ worker by construction (fresh context).
- Sensor `durationMs` human-wait inflation (SM2 finding) applies to gauge
  review timing too — interpret with care.
