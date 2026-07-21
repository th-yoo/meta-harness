# Techniques employed — inventory + evidence status

*Written 2026-07-21 (post Plan-A merge, Cat-A screen complete, k-boost pending). Two purposes:
(1) a map of every technique the project employs and where it came from; (2) an honest audit of
which are **proven by our own evidence**, which are **disproven**, and which remain **unproven** —
so nobody (including us) mistakes built-and-runs for validated. Companion docs:
[`2026-07-20-next-direction.md`](2026-07-20-next-direction.md) (the pivot),
[`2026-07-20-ahe-prior-art.md`](2026-07-20-ahe-prior-art.md) (source of the adopted method),
[`explicitly-not-now.md`](explicitly-not-now.md) (deferral register), [`resume.md`](resume.md)
(live state).*

**One-sentence summary:** AHE's failure-diagnosis + component-evolution method, wrapped in a
statistical measurement discipline they lack, on infrastructure paranoid enough that the numbers
can be believed.

---

## Part 1 — Technique inventory

### A. Statistical measurement (the claimed edge)

| Technique | What / why |
|---|---|
| Band selection | Keep tasks with 0 < pass < 1 only — where a lift can flip outcomes; p≈0.5 maximizes information per trial. Full passes (aces) → regression guards; 0/k → excluded (no signal — the "haiku trap"). |
| Paired McNemar gate | Candidate vs active on identical tasks/trials; verdict from discordant pairs (fail→pass vs pass→fail). Detects lift AND regression symmetrically — directly addresses AHE's admitted regression-blindness (11% recall). |
| Held-in / held-out split | Lesson is distilled from held-in failures; the held-out band tests *generalization*. Kills overfit-to-source-task illusions (the openssl artifact class). |
| Two-stage k design | k=3 cheap screen (provisional triage labels) → k≥5 gate-grade trials on the band only. Spend where the information is. |
| Pre-registration discipline | No ad-hoc peeking; sequential testing (SPRT) deferred until a boundaries spec exists — alpha inflation would fake our own edge (`explicitly-not-now.md §7.5`). |
| Honest power accounting | 10-band × k=5 = 50 pairs/arm detects ~20pp+ lift; below that the verdict is a *provable null*, not proof of absence. Stated up front, not discovered after. |

### B. Failure analysis (adopted: AHE Agent-Debugger + MAST/TRAIL literature)

| Technique | What / why |
|---|---|
| Root-cause LLM judging | Judge receives trajectory + task instruction + the verifier verdict the agent NEVER saw → forced `failure_point / root_cause / general_mechanism` analysis (AHE's method). |
| MODE classification, not step-attribution | Classify the failure *class* (MAST: ~94% human-agreement regime) instead of pinpointing the exact step (~14% reliability). |
| `general_mechanism` = lesson distillation | The judge must output a STRUCTURAL fix for the failure class, never task-specific knowledge → directly injectable as a memory lesson. |
| Seed schema + `incomplete` amendment | Fixed mode menu (spec_precision, looks_done, comprehension, errored, capability, infra, incomplete, other); `incomplete` (ran-out-of-runway) added from prototype observation — it then dominated haiku v3 (13/19). |
| Trajectory-as-untrusted-data | Judge prompt hard-frames the trajectory as data; directives inside it are ignored (prompt-injection defense). |
| Mode-counts aggregation | Per-trajectory labels are noisy (observed: same trajectory flipped labels across judge runs); fractions over n are the stable signal. Field is `modeCounts` — raw counts, divide by `nClassified`. |

### C. Harness evolution (the self-improvement loop)

| Technique | What / why |
|---|---|
| Evolvable component = memory / boundary-case lessons | AHE's ablation winner. NOT prompt rewriting (regressed −2.3pp in AHE; our v1–v6 haiku prompt candidates all failed too), NOT verify-retry (AHE's ralph_loop lost). |
| One-component-per-edit | Single lesson per candidate → attributable credit, clean gate verdict. |
| Versioned candidate store | v0…vN with active pointer, per-version score/trajectories = provenance, rollback, and baseline identity (baseline/candidate/production share the model). |
| propose → ab → activate machinery | The automated crank. Loop-1 runs it manually once; automation exists and is validated on its reject path. |

### D. Validity engineering

Hermetic podman-per-trial sandboxing · env-artifact forensics (setup_failed / turns=0 / elapsed-
signature triage — caught 2 fake labels = 7.7% of the Cat-A pool) · timeout-visibility (timeouts
recorded as data, not skipped — Loop-3 fix) · leaderboard cross-referencing (opencode-FAIL ∩
wozcode-rate = headroom targeting; see caveat in Part 2) · atomic result writes + resume semantics
(and the B1 partial-freeze trap: strip partial/empty tasks before any `--resume`) ·
tmux-only daemonization (setsid children get silently killed) · `--no-pack-measured` against
cgroup-poisoned resource profiles.

### E. Process techniques

Subagent-driven development (fresh implementer per task + adversarial per-task review + whole-
branch final review; TDD RED→GREEN) · pre-flight architect review of *run plans*, not just code
(caught 2 would-be data corruptions before spend) · **distance-to-verdict rule** (tooling freeze
until loop-1's gated verdict; every task must shorten distance or go to the deferral register) ·
pipeline overlap (build the analysis tool DURING the measurement run).

### F. Lesson delivery mechanics

Layered store composition (`account/project/role` → `layerStoreRoots`) → `assembleAgentsMd`
renders the active version → injected as AGENTS.md into the agent's context. Playbook/ACE
anti-bloat structure: `playbook.json` = authoritative bullets with per-bullet helpful/harmful
counters; `system.md` = rendered view; groundwork for bullet-level credit assignment +
relevance-ranked proposer retrieval. Recency-capped trajectory pruning (~20 failures/version,
documented recency bias).

### G. Judge infrastructure

Locked-down judge persona (`mh-judge`, question/plan permissions denied) · robust reply parsing
(escape-aware brace scanner, LAST-JSON-wins + shape predicate — decoy-proof; unknown mode coerced
to `other`) · judge timeout/retry envelope (90s ×3). **Unmitigated caveat: opus judging opus =
possible self-preference bias; cross-family judge is the unrun check.**

### H. Env-fidelity discipline

Answer-key removal (no `/tb`, no `/mh` mounts in agent containers; everything arrives via
`podman cp`; the oracle keeps its own mounts) · base-image approximation via one shared bench
image (+ its observed cost: the qemu apt-name drift) · confound-control provenance stamping
(`harnessMeta`: layers, active versions, pins; opencode version; model pinning; budget-identity).

### I. Resource / ops machinery

Load-aware scheduling design (measured cgroup capture → greedy sum-fit packer → online back-
pressure; increments 2–3 BLOCKED on the WSL2 shared-cgroup read bug) · host-pressure gate (pauses
new launches at load ≥2.0/core) · oauth freshness gates · orphan reaping · DONE_EXIT sentinel +
failure-signature-covering monitors · surgical diff-first store-sync (blind export = data-loss trap).

### J. Research method

Prototype-before-build (throwaway host-local scripts validated detection + haiku-improvement
before any committed code; cheapest-confirmation-first) · cross-model transfer experiment design
(same lesson, haiku vs opus — exposed the openssl artifact) · ground-truth scraping over
summarizers (playwright DOM reads after WebFetch's summary proved wrong) · prior-art mining
(leaderboard → AHE discovery → pivot) · deep-research with adversarial claim verification (24/25
confirmed) · cross-host/cross-session continuity protocol (resume.md as state carrier, git-only
transfer, memory index).

### Dormant / rejected-for-now

Phase-0 self-score transport (gate found it undersized) · best-of-N / verify-retry (evaluated,
deferred per AHE ablations) · SPRT sequential gate (deferred, §7.5) · packer-flip + back-pressure
(blocked on cgroup bug) · qemu-startup + pytorch-model-recovery env fixes (deferred, band
unaffected).

---

## Part 2 — Evidence status (audited 2026-07-21)

### PROVEN — direct empirical evidence, ours

| Technique | Evidence |
|---|---|
| Gate's REJECT side | v3 killed after held-in with 2 pass-regressions caught (loop-2). The gate stops bad candidates. |
| Failure-mode detection | Twice: prototype (3 hand-checked trajectories, accurate root causes) + shipped tool (v3: tune-mjcf 5/5 `incomplete` matches the independent timeout diagnosis; openssl → looks_done matches hand analysis). |
| Band methodology substrate | A 10-task band exists on opus-4.8 at k=3 — the measurable middle ground is real. |
| Bench infrastructure | 200+ trials survived: podman isolation, parallel width ~6, timeout recording, atomic writes, resume (post-B1-fix), tmux daemonization. |
| Env-artifact forensics | Caught 2 fake labels live (qemu apt, pytorch instant-death); distinguished timeout vs artifact vs auth signatures. |
| Prototype-before-build | Haiku no-lift proto killed a wrong path for pennies; openssl artifact caught before a k=10 spend. |
| Review-gated process | Architect pre-flight caught B1 (partial-freeze) + R1 (poisoned packer) before spend; SDD reviews caught real defects (scanner duplication, fake test-RED) pre-merge. |

### DISPROVEN — negative results, also ours, also valuable

- **Prompt-rule evolution on haiku**: v1–v6 all rejected or inconclusive (AHE independently: prompt evolution regressed).
- **Lesson injection into a capability-bound model**: haiku 0/2 → 0/2; one-shots and ignores the lesson.
- **Single-task, small-n improvement signals**: openssl 0/2 → 1/2 was a harness-deficiency artifact. n=2 anecdotes are worthless.
- **Phase-0 self-scoring as a gate input**: undersized, no signal.
- **Declared-cpus scheduling + cgroup capture on WSL2**: measured profiles are garbage on this host (shared-cgroup reads; avgCpu up to 235 "cores").
- **Leaderboard labels as band predictions**: 1-trial opencode+4.5 labels were stale for 4.8 — 6 of 26 "fails" turned out to be aces. Pool ≠ band; only the re-baseline measures.

### UNPROVEN — concentrated exactly where it should be

- **A distilled lesson lifting a strong model** — zero evidence either way. THE experiment.
- **The gate's ACCEPT path** — has never fired in project history.
- **Held-out generalization of a lesson** — never reached.
- **The autonomous crank end-to-end with a win** — machinery exists, never completed one.
- (Minor: judge self-preference bias unmeasured; prompt-injection defense untested adversarially.)

### Scoreboard, one sentence

We have a **proven laboratory** — it measures honestly, rejects reliably, and catches its own
contamination — and **zero proven improvement**; all remaining uncertainty is concentrated in the
single pending experiment (k-boost → opus taxonomy → one lesson → gated A/B), which either
converts the thesis to proven or to a provable null. Both are results.
