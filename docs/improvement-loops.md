# Improvement loops — static & dynamic

How the harness actually gets better, in both evaluation regimes. Companion to
[evolution-loop.md](evolution-loop.md) (component architecture); this doc is the
*procedural* view: what fires, in what order, gated by what.

---

## 1. Two regimes, one core

meta-harness is one evolution core with two evaluation front-ends:

| | **static** (TB2 bench) | **dynamic** (runtime hosts) |
|---|---|---|
| entry point | `bun term-bench2/runner.ts` | opencode plugin / cc-adapter hooks |
| world | frozen 43-task set, podman sandbox | live work sessions, user's repo |
| oracle | verifier `reward.txt` 0/1 | human `/mh-score good\|bad` (judge-prefilled) |
| repeatability | full — same task ×k, paired arms | none — every session unique |
| statistics | exact McNemar + bootstrap CI + futility | trial gate (rate comparison) |
| layers fed | account (`account-global`, `account-role`) | project (`project-global`, `project-role`) |
| signal cost | $ per run | free (work happens anyway) |
| realism | benchmark (Goodhart risk) | actual daily work |

Shared core (both regimes): `harness-store.ts` (layers / candidates / trial /
activation / SessionRecord), `compose.ts` (composition + rendering),
`propose.ts` (proposer / promoter / curator), `judge.ts` (verdict logic),
meta-metrics sinks + `report-loop`.

Static = dynamic machinery with three substitutions:

```
static = dynamic
       − HarnessHost   (guest in an event loop → AgentDriver caller)
       − human score   (→ objective verifier)
       + frozen tasks  (→ repeatable, pairable, k-samplable)
```

Everything else transfers, and does.

---

## 2. Dynamic improvement loop (project layers)

Runs wherever a host lives (opencode plugin, cc-adapter). Zero marginal cost —
the signal is a by-product of normal work.

```
work session
   │ session.idle
   ▼
capture (EvolutionEngine)          degenerate sessions auto-skipped
   │                               (0 turns, or 0 tools + <50-char reply)
   ▼
judge (LLM, same judge.ts as bench)
   │  trivial:true → excluded from fitness signal
   │  else → prefills "/mh-score good|bad judge: <hint>"
   ▼
human confirms/overrides:  /mh-score good|bad [note]
   │
   ▼
recordSession → score.json (nPass/nFail + SessionRecord)
   │
   ▼ thresholds (informative sessions only)
auto-propose:   project-role ≥ 5 scores · project-global ≥ 10 scores
   │            (PROJECT_ROLE_THRESHOLD / PROJECT_GLOBAL_THRESHOLD, propose.ts:66)
   ▼
proposer session writes candidates/vN (staged, then relocated)
   │
   ▼
trial activation — vN goes live PROVISIONALLY (.trial snapshot)
   │
   ▼ resolveTrial (harness-store.ts:995), after minSessions new scores
   ├─ trialRate ≥ baselineRate  → CONFIRMED (stays active)
   └─ trialRate < baselineRate  → REVERTED  (baseline restored automatically)
        · same-model stratified, judge-trivial sessions excluded
        · manual activation during trial → trial abandoned
```

Properties:

- **Human stays the oracle**; the judge only filters trivia and prefills.
  (Judge prefill trust is earned statically — see §4.)
- **Trial gate = cheap selection**: no paired stats possible (sessions unique),
  so provisional activation + rate comparison + auto-revert is the honest gate.
- **Plateau pause (project)**: repeated non-improvement writes
  `.meta-harness/paused` — auto-propose stops, `/mh-propose` still works.

## 3. Static improvement loop (account layers)

The full referee-grade cycle. ⬛ = static step, ⬜ = dynamic-resident step.

```
0 ⬛ prep --apply                      # one-time bench image build
1 ⬛ run --layers account --k 5 …      # store-writing measurement:
      → results (per-task rates)      #   rates need k>1 (pass@1 = coin flip)
      → SessionRecords + FAILURE      #   trajectories = proposer's entire diet
        TRAJECTORIES into the store   #   (--no-store runs feed it nothing)
2 ⬛ split make --results … --band 0.2,0.8 --sentinels 3 --folds 2
      band      = tasks with headroom ("possibly improvable")
      dropped   = always-fail (cost without signal)
      sentinels = few always-pass kept as regression canaries
      folds     = held-in / held-out rotation
3 ⬜ propose (opencode /mh-propose or cc-adapter detached child)
      reads: band-task failure trajectories, scores, prior candidates,
             past ab verdicts (accepted AND rejected — both are evidence)
      writes: ONE global candidate (candidates/vN) — never per-task patches
      never sees: held-out results (cmd-ab.ts holds them back by design)
4 ⬛ ab --layer account-global --candidate vN --k K
      per task, interleaved pairs: arm A = active, arm B = pinned candidate
      held-in first → futility kill (candidate clearly behind after ≥12 tasks)
      then held-out fold + sentinels
      math: exact McNemar (b = regressions, c = gains) + bootstrap CI
            + non-regress margin + held-out guard
      → decision: accept | reject | inconclusive → ab-verdict.json
5    activate on accept (/mh-activate — pointer flip; winner must be candidate)
      reject/inconclusive → verdict stays in store as proposer evidence
6 ⬛ report-loop
      merges 3 meta-metrics sinks; PLATEAU verdict:
      last 3 ab events non-accept (per layer) OR last 4 trials without
      strict improvement → PAUSED flag → auto-propose stops
      (judge-audit runs on the side to maintain judge calibration)

repeat 3→4→5 until plateau or satisfaction; split rotate periodically.
```

### Iteration types — do not conflate

```
attempt   one task try            (agent episodes inside: unbounded)
k-loop    fixed k attempts/task   MEASUREMENT — no early exit, not retry
run       all tasks × k           one version, one number set
ab        paired run + futility   one candidate, one verdict
LOOP      propose → ab → activate IMPROVEMENT — the only place versions change
```

- **k ≠ retry.** All k attempts always run; success on attempt 1 does not skip
  2..5 — the output is a *rate*, and outcome-dependent stopping biases it.
- **No improvement between rounds.** The harness is frozen for an entire
  measurement; exactly one version change per loop cycle. Otherwise a task
  flipping X→O is unattributable (luck vs improvement).
- **Cleared tasks are not skipped.** One shared system.md serves all tasks; a
  fix for task 2 can break task 88 (upstream paper: prompt edits regressed in
  5 of 7 iterations). Regression detection = McNemar's b-count + sentinels.
  Cost control comes from the band + sentinels, not from skipping.
- **No per-task patches.** Proposer reads per-task failures but must emit one
  general edit; per-task text drifts into benchmark leakage (upstream runs
  regex audits against exactly this).

### Operational gotchas (running it by hand)

- **`--results-file` forces `--no-store`** (`cmd-run.ts`: `noStore = args.noStore || resultsFile`). A run therefore either (a) writes a results-file for `split` (measurement) OR (b) feeds the store the failure trajectories the proposer reads — **never both in one run**. Step 1 (baseline, measurement) and the store-writing run that precedes propose are thus *separate* runs. The store-writing run needs no results-file and only `--k 2` (it wants failing trajectories, not rates).
- **`--resume` needs `--results-file`** (`resumeCarryForward`), so **store-writing runs are not resumable** — a reboot restarts them; keep them small (band, low k). `ab` *is* resumable.
- **Propose has no CLI.** `/mh-propose account` is opencode-plugin/cc-adapter resident (proposer independence — it must never sit next to the held-out answer key). Drive it headless via tmux opencode (`smoke/lib/oc-driver.sh`). Account layers don't auto-trial (project-only); wait for `global/candidates/vN/`.
- **Phase-0 self-check can't piggyback the store-writing run**: `--self-check` captures selfScores into the results aggregation, which needs `--results-file`, which forces `noStore` — the opposite of a store-writing run. Phase 0 needs its own `run --self-check --results-file` pass.

## 4. Cross-regime wiring

```
            ┌────────────────────── STORE (the only channel) ─────────────────────┐
  static:   │ trajectories, scores, ab-verdicts, splits, meta-metrics, candidates │
  writes ──►│                                                                     │◄── dynamic
  exhaust   └──────────────────────────────────────────────────────────────────────┘    writes
  + verdicts                     ▲                    │                                  scores +
                                 │ reads              ▼ reads                            candidates
                            proposer (⬜)         composition (both regimes render
                                                  the same active layers)
```

- **Judge exists on BOTH sides, different jobs.** Dynamic: trivial-filter +
  score prefill (assistant to the human oracle). Static: `judge-audit`
  measures judge-vs-verifier agreement, stratified by verifier class — i.e.
  static *calibrates* the judge that dynamic *uses*. Prefill trust is earned,
  not assumed.
- **Proposer is dynamic-resident BY DESIGN, not by gap.** (1) Referee
  independence: held-out results are never visible to it — a bench-resident
  proposer would sit next to the answer key. (2) Nothing static about
  generation: one-shot, no k, no verifier, no frozen inputs. It consumes
  static exhaust through the store and nothing else.
- **Promotion path**: evolve on dynamic (project layers, cheap dense signal) →
  promote what generalizes → validate on static (account layers, TB2 referee).
- **Improvement information is ~⅔ static by content**: targets (band) and
  evidence (trajectories) and verdicts (ab) all come from bench exhaust; the
  proposer contributes only the synthesis step — the pen, not the brain.

## 5. Control & safety rails

| Rail | Level | Rule |
|---|---|---|
| degenerate-session skip | dynamic capture | 0 turns, or 0 tools + <50-char reply |
| judge trivial-filter | dynamic scoring | `trivial:true` excluded from thresholds & trials |
| trial auto-revert | dynamic selection | trialRate < baselineRate → baseline restored |
| futility early-stop | static ab | candidate clearly behind after ≥12 held-in tasks |
| non-regress margin + held-out guard | static ab | accept needs more than a held-in win |
| sentinels | static split | always-pass canaries catch silent regressions |
| fold rotation | static split | limits overfit to one held-in set |
| plateau verdict | loop (both) | 3 ab non-accepts / 4 unimproved trials → PAUSED flag |
| 0-turn runs never recorded | both | timeouts can't pollute fitness |

Every generative act is bounded by a selection gate; every gate has an
auto-stop; the loop as a whole has a plateau brake. Improvement is therefore
monotone-or-halted by construction — the system can stall, but not silently
degrade.
