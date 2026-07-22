# The minimal working system — reverse-engineered OOD (2026-07-23)

*Reverse-designed from three completed gate loops (v8 null / v9 certified-then-guard-rejected /
v10 rejected — see [`reboot.md`](reboot.md) verdict sections and [`techs.md`](techs.md) Part 2).
Every element and invariant here carries an OBSERVED failure mode from its absence — nothing is
speculative. Companion: [`loop-roadmap.md`](loop-roadmap.md) (forward plan).*

## 1. The least working design (behavioral form)

```
1. One task the agent solves INCONSISTENTLY (0 < p < 1)      # sparql, 3/10
2. A frozen scorer the agent NEVER sees                       # verifier, reward ∈ {0,1}
3. Before diagnosing: READ THE SCORER (source, design-time)   # desk-check, free
4. Read failing trajectories → write ONE rule (≤60 words),
   class-level, ADDED to context — nothing else changed       # single bullet
5. Re-run same task, same host, k≈10 both arms → significance # p=0.020 grade
6. Re-run ≥1 task the agent already aces (guard)              # collateral check
7. Lift AND guards intact → keep; else → revert + RECORD why  # versioned store
   goto 4
```

### Why each element survives the cut (observed failure without it)

| Removed element | What actually happened without it |
|---|---|
| Inconsistent task | Haiku era: 0/k tasks = no signal, weeks lost |
| Hidden frozen scorer | Phase-0 self-scoring: no signal; the `looks_done` failure mode exists *because* agents self-certify |
| Read-the-scorer-first | Loop-1: confident wrong diagnosis (ORDER-BY), 20 trials burned; the free desk-check reversed it |
| One rule at a time | Existing proposer emitted 2 edits → unattributable; v10's two-clause interaction was the poison |
| Same-host paired k≈10 | openssl 0/2→1/2 "lift" = artifact; cross-host p=0.18 vs same-host p=0.020 on identical data |
| Guard | v9 would have been a FALSE adoption — certified held-in lift + hidden guard regression (cgw 1/3) |
| Revert + record | Old loop: v2 re-derived v1's rejected rule; rejection memory is what makes iteration converge |

**Deliberately NOT in the kernel** (accelerators for scale, not conditions for working): LLM
judge/taxonomy (a human reading 7 trajectories + the verifier suffices at n=1 task), the lesson
factory, forensics tooling, multi-task bands, playbook counters, McNemar formalism (Fisher on
2×10 is fine).

## 2. Domain object model

```
                 ┌────────────── THE LOOP (Controller) ──────────────┐
                 ▼                                                    │
  Diagnostician ──► Proposer ──► Experiment ──► Gate ──► Store ───────┘
       ▲                              │            │        │ activate/revert
       │ failing Trajectories         │ runs via   │ writes  ▼
       └──────────── Store ◄── Runner ◄────────────┘      Harness(vN)
```

| Object | Responsibility | Key contract | Our implementation |
|---|---|---|---|
| **Task** | Immutable problem statement + fixtures | `id, instruction, fixtures` | TB2 task dir |
| **Scorer** | Frozen oracle; source readable at *design time*, opaque to the Agent at *run time* | `score(artifact) → 0\|1` | task verifier in container |
| **Model** | Frozen completion engine — explicitly NOT evolvable in this system | `complete(ctx) → actions` | opus-4.8 via oauth |
| **Rule** | ≤60-word class-level directive + provenance (evidence refs, predictions incl. `falsify_if`) | value object | playbook bullet |
| **Harness** | THE evolvable component; immutable version; `vN+1 = vN + exactly one Rule` | `render() → contextText` | store candidate (system.md/playbook.json) |
| **Agent** | Composition `Model + Harness + Sandbox`; no other state | `attempt(Task) → Trajectory` | opencode + AGENTS.md + podman |
| **Sandbox** | Fresh isolation per attempt | lifecycle | podman container |
| **Trial** | One attempt + reward + FULL provenance (host, model, harness-version) | record | session row in score.json |
| **Trajectory** | Evidence artifact; untrusted DATA everywhere it is read | ndjson | traj/*.ndjson |
| **Store** | Append-only ledger: harness versions, trials, verdicts, **rejected Rules** | `active()`, `record()`, `revert()` | `.meta-harness/global` (+ committed snapshot) |
| **Experiment** | Paired design: candidate-vs-baseline × (band Task + ≥1 guard Task) × k; ENFORCES same-host/same-model comparability | `run(Runner) → Evidence` | phases A/C |
| **Gate** | SOLE writer of `Store.active`: significance on band + non-regression on guards, judged against the Rule's own predictions | `judge(Evidence) → adopt \| reject(mechanism)` | Fisher/McNemar + guard check |
| **Diagnostician** | Failing Trajectories + **Scorer SOURCE** → FailureClass | `diagnose() → class` | human/desk-check (minimal); taxonomy judge (scale) |
| **Proposer** | FailureClass + rejected-Rule history → ONE Rule or **Abstain** | `propose() → Rule?` | human loops 1–3 (minimal); `bench propose-lesson` factory (scale) |
| **Runner** | Pure mechanism: executes Experiments, drives Sandbox lifecycle, records Trials. Zero policy | service | `term-bench2/runner.ts` |

## 3. The five invariants (where correctness actually lives)

1. **Information flow**: `Scorer → Agent = ∅` at runtime (Phase-0/looks_done showed why);
   `Scorer source → Diagnostician = REQUIRED` at design time (loop-1 reversal showed why).
2. **Single-Rule delta**: `Harness(vN+1) − Harness(vN) = 1 Rule` — attributability (the 2-edit
   proposal and v10's 2-clause interaction showed why).
3. **Provenance-gated comparison**: Trials comparable ⟺ same host + model + task
   (p=0.18 cross-host vs p=0.020 same-host on identical data showed why).
4. **Gate is the sole mutator of `active`** — no adoption path bypasses statistics + guards
   (v9's averted false adoption showed why).
5. **Rejected Rules are permanent Proposer input** (v2-re-derived-v1 showed why).

## 4. Outside the domain model (mechanism / ops layer)

tmux (process supervision — a deployment fact; the setsid silent-kill incident is an ops lesson,
not a design element) · monitors · forensics filters (Trial-admission hygiene; empirically needed
at scale — 7.7% contamination — but a decorator on Trial recording, not a domain object) ·
scheduler/width/host-pressure · oauth plumbing · store-sync. **Litmus test**: the design is
unchanged if tmux becomes systemd or podman becomes Firecracker — therefore they are not in the
model.

## 5. The roadmap, restated in this model's terms

`Diagnostician`, `Proposer`, and `Gate` are **policy seats**; each currently holds a human or an
LLM interchangeably (Diagnostician: human→taxonomy judge; Proposer: human→factory — both swaps
already built and validated in isolation). The self-improvement project = swapping humans out of
the policy seats one at a time **while invariant 4 holds**. The Gate seat is swapped LAST, and
its policy is code (statistics), not an LLM — that is the entire difference between this design
and vibes-gated evolution (AHE's admitted regression blindness: fix-recall 51%, regression-recall
11%).
