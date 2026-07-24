# Completion gate + adequacy probe (B′) — design (2026-07-24)

The binding actuator. Targets BOTH verified failure causes from the cancel-async
forensics: (1) loop exit on self-assessed green; (2) wrong-SHAPED tests — green
suites that never exercise the failing conjunction (queued × awaiting-cleanup,
ground-truth-verified by running the grader's shapes against the five extracted
implementations).

Industry grounding: Stop-hook/pre-completion-gate is the adopted pattern
(prompt instructions measure 70–90% compliance — our system-v0 measured 85%,
dead center; hooks measure ~100%); MutGen: LLM test suites did NOT improve over
4 iterations without mutation feedback (53% mutation score, flat), with
mutation feedback → 89.5%. A naive test-gate alone would NOT have caught the
R7 fails (their tests were green); the adequacy probe is what closes that hole.

## 1. Mechanism (run.ts, per attempt)

```
opencode run (attempt as today)
        │ agent exits ("done")
        ▼
[gate round r = 0..R-1, R default 2]
  1. VERIFY-EXISTS: /app/verify.sh present + executable?
       missing → reinject: "not done: leave a runnable verification script
       at /app/verify.sh (exit 0 = verified) and run it"
  2. VERIFY-RUNS: podman exec verify.sh → exit != 0 →
       reinject: "not done: your verification fails: <tail of output>"
  3. ADEQUACY PROBE: k mutants of the artifact (see §2); for each,
       run verify.sh against the mutant; mutant SURVIVES (verify still
       green) → reinject: "not done: your verification did not detect an
       injected fault: <unified diff of mutant>. Your scenarios under-cover
       the contract — combine boundary conditions (capacity limits,
       blocking/awaiting operations inside promised paths) and re-verify."
  all pass → accept attempt → grade as today
  r == R and still failing → accept anyway (grade as today), record gateExhausted
        │
  reinject = opencode run --session <id> <message>   (same session, same
  container; sessionID parsed from the run's JSON events)
```

- The gate NEVER runs or sees the task grader (invariant 1 intact: probe is
  grader-independent — mutants + the agent's own checks only).
- Bounded: R gate rounds per attempt (default 2), probe capped at k mutants
  (default 4), per-round wall-clock budget; all bounds recorded in the trial.
- Trial record gains: gateRounds, gateOutcomes[], mutantsTried/Killed,
  gateExhausted — forensics surface.

## 2. Adequacy probe (v1: crude, language-light)

Mutation operators over the artifact files the task required (never over
verify.sh or fixtures), applied one at a time, syntax-checked (`py_compile` /
`node --check`) before use, sampled up to k valid mutants:

- delete an `await ` keyword (keeps expression)
- swap `<` ↔ `<=`, `>` ↔ `>=`
- negate an `if` condition
- delete one statement line inside a `finally:` / `except:` block
- swap `and` ↔ `or`

Rationale: crude operators are exactly the class that survives weak suites
(MutGen "boundary value blindness"). A verify.sh that trivially exits 0 is
caught immediately — every mutant survives. For our verified bug: removing the
re-`cancel()` call or an `await` in the cleanup path survives all five failing
implementations' suites, and dies under a2's.

## 3. Agent-facing contract (one paragraph, injected by run.ts only when the
gate is enabled — appended to the instruction, NOT baked into system-v0)

"Before you finish: leave a runnable verification script at /app/verify.sh
(exit 0 = verified) that exercises each promised behavior of your artifact,
including scenarios that combine boundary conditions. The harness will run it,
and may inject faults into your artifact to check that your script detects
them. You are done only when the harness accepts."

Keeping the contract out of system-v0 keeps the A/B one-variable: arms differ
by the MECHANISM (+its one-paragraph contract), not by base-prompt content.

## 4. Experiment (the mechanism is a Harness candidate like any other)

- Arms: adopted base (system-v0+seed-v0) vs adopted base + `--complete-gate`,
  cancel-async k=10, same host/model/driver. Guards cdt+chess k=3 (gate ON —
  collateral = wasted gate rounds/cost on easy tasks), sparql k=3 info.
- Judged by gate.ts (statistics + guard non-regression) — invariant 4: the
  completion gate is a candidate, not an adoption bypass.
- Prediction (pre-registered): converts R7-class fails (green-but-gentle
  suites) into a2-class grinds via surviving-mutant evidence; falsify_if:
  no pass-rate lift, or guards regress on gate-round churn, or agents game
  verify.sh faster than the probe catches them.
- Cost note: reinjected rounds lengthen attempts (bounded by R×budget);
  futility stopping (E) should land in the same experiment script.

## 5. Failure modes, pre-registered

- **Gaming**: trivial verify.sh (exit 0) → all mutants survive → caught round 1.
  Subtler: verify.sh that checks file existence only — same catch.
- **Unfair mutants**: probe mutates code irrelevant to the contract → false
  inadequacy churn. Mitigation: operators restricted to required artifact
  files; cap k; accept-after-R keeps it non-fatal.
- **Cost blowup**: R×k bounded; per-round wall-clock cap; recorded.
- **Session-continuation fragility**: `opencode run --session` in-container —
  if unavailable, fallback = fresh run with injected "not done" context block
  (state on disk per Ralph pattern).

## 6. Seat interactions

- Proposer backlog item 2 unblocks: bullets may now propose CHECK SPECS
  (content for the gate's reinjection guidance) — machine-enforced, decay-free.
- HISTORY/ledger: gate verdicts and mechanism A/B recorded like rounds.
- Kill criterion: if the A/B shows no directional lift on the residual it was
  built for (cancel-async), the mechanism goes to the ledger like any bullet.

## 7. Build plan (TDD)

1. `minimal/mutate.ts`: operators + syntax-check + sampler (pure, unit-tested).
2. run.ts: `--complete-gate [R]` — post-exit gate rounds, session reinjection,
   trial-record fields (tested via injectable exec/run fns).
3. Experiment script + gate.ts run (spend — needs go).
