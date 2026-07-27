# Adequacy-probe grip fix — design note (2026-07-27, office)

**STATUS UPDATE (same day): S1+S2+S3 IMPLEMENTED via TDD** — `mutate.ts`
(`__main__`-block exclusion, `allowedLines` filter), new `minimal/cover.ts`
(zero-dep sitecustomize trace hook + parser, tested against a real python3
subprocess), `complete-gate.ts` (`coveredLines` GateIO dep, coverage
provenance field, ≥1-kill round rule, static fallback on vacuity), `run.ts`
traced-verify wiring. Suites 1656+26 green (15 new tests, red-first).
Timeout-as-kill confirmed already de-facto (run.ts `timeout 120` wrapper →
non-zero exit on mutant = kill; now documented at the kill site). S4 (new
operators) + verification arm (§6) still open.

Fix design for C1's headless finding (HISTORY.md C1 section): the completion
gate's mutation adequacy probe has no grip on big python-class artifacts —
7/9 valid headless trials exhausted the completion gate (every round
mutant-survived), 6–30x time tax, zero verification signal. sparql was healthy
(one fix round then accept) — same probe, different artifact class. Design
only; no code changed yet. Queue: item 4 of the office playbook
(`docs/resume.md`), AFTER the §4.1 live smoke-test and §4.3 trial-mode design.

## 1. Root cause (two mechanisms, both in code we own)

1. **Blind site selection** (`minimal/mutate.ts generateMutants`): sites are
   picked by regex over text lines — first `<`, first `await `, first
   `if …:` per operator. The only filter is `codeLineSet` (comments +
   docstrings — the R9F fix). No knowledge of what the agent's verify.sh
   executes. On a big artifact (many methods/branches), first-match sites land
   in code no plausible verify.sh drives → the mutant cannot be killed by ANY
   honest verification → "not done" forever.
2. **All-mutants-must-die round rule** (`minimal/complete-gate.ts checkRound`):
   `survived > 0` fails the round — a single unkillable mutant poisons it.

Gap formula: execution surface of artifact >> coverage of check → mutants fall
in the gap. sparql can't have the gap (a query executes as a whole, coverage
100% by construction); headless-class python always will.

## 2. Field grounding (2026-07-27 search)

Production mutation-testing tools converged on exactly the fixes below:

- **Coverage filtering is the default, not exotic.** mutmut mutates only
  called functions by default, `mutate_only_covered_lines=true` for line-level
  coverage.py filtering; Stryker `coverageAnalysis: all|perTest` skips mutants
  on uncovered lines; PIT is coverage-driven per mutant.
- **No-coverage is a separate outcome bucket, excluded from the score.**
  Stryker: Killed / Survived / NoCoverage / Timeout, headline score
  `killed / (total − no_coverage)`. Survived (covered-but-unasserted) and
  NoCoverage carry DIFFERENT signals and different remediation.
- **100% kill is an anti-pattern.** Equivalent mutants = 4–39% of mutants in
  real code (Tian et al., ISSTA'24); industry thresholds: 80%+ strong, don't
  chase 100%. Our all-must-die rule is stricter than any production tool.
- **Timeout on a mutant run = KILL** (behavior changed detectably) — needs a
  per-mutant-run time bound.
- **Cheap equivalence pre-filter**: TCE (compile both, identical output →
  discard mutant). Python analog: compare `compile()` bytecode.

## 3. Fix set

**S1 — coverage-guided site filter (structural fix).** Run the agent's
verify.sh once under line tracing (`python -m trace` or coverage.py, whichever
the task image carries) → executed-line set → one more intersection beside
`codeLineSet` in `generateMutants`. Dead-line mutants become impossible by
construction; every survival is real "executed but unasserted" signal.
Ungameable: executing a line without asserting is still caught. Fail-open: if
tracing is unavailable/errors, fall back to static filters only (S2) and
record that in the sensor line.

**S2 — static dead-zone exclusion (cheap backstop).** Extend `codeLineSet` to
exclude the `if __name__ == '__main__':` guard line and its block
(indentation-scoped). Removes one guaranteed dead zone when verify imports the
module, plus the negate-if-on-guard hazard (negated guard fires `main()` at
import time → spurious kill/hang). Subsumed by S1 when tracing works; still
wanted for the S1 fail-open path.

**S3 — survival semantics (round rule + buckets).**
- Per-mutant outcome buckets in the round result: `killed | survived |
  timeout(=killed) | equivalent-skipped`, plus `mutantsTried`. NoCoverage
  never reaches execution (S1 filters pre-generation) but the sensor records
  how many sites coverage filtering removed.
- Round pass rule v2: with `mutantsTried > 0`, require **≥1 kill** instead of
  zero survivors (junk `exit 0` verify kills nothing → still caught; honest
  verify passes despite an unkillable straggler). Record the kill ratio; a
  stricter threshold can be ratcheted later from sensor data (Stryker
  `thresholds.break` pattern).
- Distinct reinject texts: survived (covered-but-unasserted) → "strengthen
  assertions on the exercised path"; the current under-coverage message stays
  for the no-verify/verify-failed causes.
- **Vacuity hazard:** coverage filtering can empty the site list
  (`mutantsTried == 0` → round auto-accepts today). Sensor must record
  `mutantsTried`; if 0 after filtering, fall back to static-only sites rather
  than silently passing a vacuous probe.

**S4 — behavior-targeting operators (the queue-item-4 mechanism work).** New
operators aimed at the observable surface of python-class artifacts:
`return x` → `return None`, off-by-one on index arithmetic, mutate
string/buffer writes. Raises killable-mutant density. **Route through the
machine seat once §4.4 (mechanism-class proposals) exists** — operators as
proposals, exhaustion rate from `gate-outcomes.ndjson` as fitness; hand-design
only if §4.4 stalls.

**S5 — rejected: LLM-generated mutants at runtime.** Nondeterminism kills
forensics-before-verdict; per-round token cost inverts the cheap-actuator
economics; correlated blind spots with the LLM-written verify weaken the
adversarial property; domain-leak hazard (rule 3b analog). LLM intelligence
enters at design time via S4's proposal path — improvements compile into
deterministic mutate.ts code.

**Optional: bytecode-equivalence pre-filter.** `bytecodeChanged(orig,
mutated)` via `compile()` comparison, same injection shape as `syntaxOk`.
Catches semantic no-ops (the R9F docstring class) for free. Low priority —
S1+S2 already remove the known no-op classes.

## 4. Where changes land

- `minimal/mutate.ts`: `generateMutants` gains an optional allowed-line set
  (intersects like `codeLineSet`); `codeLineSet` gains the `__main__`-block
  exclusion; new operators later via S4.
- `minimal/complete-gate.ts`: `GateIO` gains optional
  `coveredLines?(): Set<number> | undefined` (impl runs traced verify;
  undefined = fail-open) and a bounded mutant-run variant of `runVerify`
  (timeout → killed). `checkRound` implements buckets + ≥1-kill rule +
  vacuity fallback. `GateRoundResult` carries the new fields.
- `gate-plugin/` and term-bench2 `run.ts` inherit through the shared core;
  sensor ndjson line gains the bucket counts (feeds §4.3 trial mode).
- Review gate and adoption gate untouched.

## 5. Threat notes (for the §4.3 design doc)

- **Self-checksum exploit:** an agent's verify.sh that hashes the artifact
  (or reads `__file__`) kills ALL mutants without testing behavior — probe
  reports perfect grip, proves nothing. Not yet observed. If gate outcomes
  become the trial-mode reward signal, this is a gameable channel; the probe
  cannot currently distinguish behavior-kill from checksum-kill.
- **False-accept class (standing watch-item, C2+C1):** every real A-side fail
  was completion-gate-accepted, grader-failed. Probe grip narrows but does not
  close this — the agent's check remains a weaker proxy than the grader's
  oracle. §4.3 must not treat completion-gate acceptance as ground truth.

### 5.1 False-accept fix directions (researched 2026-07-27; design only)

The false-accept gap is structural (invariant 1: the completion gate never
sees the grader) — narrow it + account for it, never claim it closed:

- **L4 — account (hard §4.3 constraint, field-standard):** gate-accept =
  "self-verified", NEVER "correct". Trial mode scores gate SHAPE (exhaustion,
  kill ratios, rounds), not accept rate; periodic **calibration arms** on
  bench tasks with graders measure the live false-accept rate and discount
  the daily signal. Judge-calibration literature: golden-set anchoring +
  drift monitoring is production norm, no standard cadence exists —
  pre-register ours. Reward-hacking research: LLM detectors catch only ~63%
  of hacks; gate-outcome-as-reward is a gameable channel.
- **L1 — spec-coverage probe (RTM discipline):** compile instruction.md at
  design time (frozen) into requirement IDs + acceptance criteria; probe
  demands verify.sh exercise each; reinject names the untested requirement;
  deferrals must be explicit, never silent. This is bidirectional
  requirements traceability (FDA/RTM standard) mechanized per-task. No
  grader leak — derives only from agent-visible instruction.
- **NEW — metamorphic-relation probes:** the oracle-problem literature's
  standard weapon when no ground truth exists: check RELATIONS between
  executions (terminal resize A→B→A restores screen; write N lines + scroll
  k shifts content by k), not absolute outputs. Deterministic, oracle-free,
  and reaches the exact channel artifact mutants cannot: missing/
  misunderstood code. Prime §4.4 machine-seat proposal class.
- **L2 — probe pressure (already running):** arm A a1 proved reinject
  pressure repairs some would-be false-accepts (rework passed grader).
- **L3 — independent re-reader (parked):** if ever revived, cross-family
  judge only (same-family self-preference inflation ≈5–7% documented;
  juries reduce bias 30–40% at 3–5x cost).

## 6. Verification plan (spend — needs explicit go)

### 6.1 PRE-REGISTERED arms (2026-07-27 office, sealed BEFORE launch; go given)

Host `yoo-dev`, image `localhost/mh-bench:latest`, `anthropic/claude-opus-4-8`,
system-v0 + seed-v0, completion-gate rounds 2 / mutants 4 — identical to C1
except k and host. Mechanism claims only; rewards recorded but DIRECTIONAL
(cross-host vs C1's MacBook arms — provenance rule forbids reward verdict math).

- **Arm A — headless k=5** (`--complete-gate /app/headless_terminal.py`):
  PASS = (a) ≤1/5 valid trials `gateExhausted`; (b) probe rounds report
  `coverage: "filtered"` (python artifact, traced set expected non-empty);
  (c) accepted probe rounds have `mutantsKilled ≥ 1`; (d) median per-attempt
  elapsed < 600s (C1 exhaustion class was 1000–5000s).
- **Arm B — sparql k=3** (`--complete-gate /app/solution.sparql`):
  no-regression shape: ≤1 fix round then accept per valid trial, zero
  exhaustion, no vacuous accepts (killed ≥ 1 on accepted probe rounds).
  Expected coverage provenance: `"fallback-static"` or `"off"` — a .sparql
  artifact has no python-executed lines, so the empty-set → static-fallback
  path is exercised BY DESIGN here.
- Voids: 0-turn / auth-race trials excluded per standing forensics rule
  (post-run log grep before any counting).
- C1 forensic support for the ≥1-kill rule: headless C1 a1 rounds ran
  survived 3/4 → 2/4 → 1/4 — kills happened every round; only the
  all-must-die rule burned them.

Rerun the headless gate-ON arm with S1–S3 in place: exhaustion rate expected
7/9 → ~0; time tax should compress toward the sparql shape (~2x). Any new
comparison arms at office need fresh OFFICE baselines (provenance rule —
gate.ts enforces; all 07-25/26 arms are yoo-mac.local). sparql re-run as
no-regression check on the healthy class (≥1-kill rule must not weaken its
one-fix-round shape).

### 6.2 VERDICT (2026-07-27 office, same day — arms complete, forensics clean)

Zero auth errors, zero 0-turn/timeout/suspect trials — all trials valid.

- **Arm A headless k=5: PASS.** (a) exhaustion **0/5** (C1: 7/9; Fisher
  p≈0.02) ✓; (c) every accepted probe round killed 1–2 of 4 (derived
  tried−survived) ✓; (d) median 400s (276/324/400/1012/3968 — C1 exhaustion
  class was 1000–5000s) ✓; (b) coverage provenance **formally unverifiable**
  — serializer gap (fixed same day, `3064893`) dropped the field; behavior
  consistent with filtering. Rewards 3/5 directional (no cross-host verdict
  math). a1+a5 = first-ever healthy verify-fix loops on headless: round-1
  zero kills → reinject → agent strengthened → round-2 kills → accept; a1's
  rework passed the grader (reinject repaired a would-be false-accept).
- **Arm B sparql k=3: PASS.** Zero exhaustion, zero fix rounds, rewards 3/3.
  Every trial: single accepted round, killed 2 / survived 2 of 4. Shape
  change vs C1 noted honestly: under the old all-must-die rule the 2
  survivors would have forced a fix round (C1's healthy shape); the ≥1-kill
  rule accepts immediately — verification-strengthening pressure on the
  healthy class is REDUCED by design (S3 trade-off). No harm here (3/3
  grader pass, ~1.4–2x faster than C1 gated); false-accept rate under the
  new rule = calibration-arm watch item.
- **False-accept watch-item recurs:** headless a2+a5 gate-accepted,
  grader-failed — see §5 threats; L-series fix directions + field research
  (RTM/spec-coverage, metamorphic-relation probes, judge-calibration) in the
  session notes of 2026-07-27.

## 7. Order

1. §4.1 live smoke-test (queue 2) and §4.3 design (queue 3) come first —
   unchanged.
2. S1+S2+S3 as one TDD change set in minimal/ (free until arms run).
3. S4 through the machine seat after §4.4; hand-design only on stall.
