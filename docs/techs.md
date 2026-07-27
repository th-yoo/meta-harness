# Techniques employed — inventory + evidence status

*Written 2026-07-21; Part 2 re-audited 2026-07-23 (post loops 1–3) and
**2026-07-27 (gate era — delta section at the end of Part 2; Part 1 gains §K)**. Two purposes:
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
| propose → ab → activate machinery | The automated crank. Loops 1–3 ran it manually; the lesson FACTORY (`bench propose-lesson`, wired 2026-07-22, TDD 20 tests) automates the distill step — its first bullet (v11) is the pending gate candidate. |

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

### K. Binding actuators + machine seat (gate era, 2026-07-24 →; added at 07-27 re-audit)

| Technique | What / why |
|---|---|
| Completion gate + adequacy probe | The binding actuator (`minimal/complete-gate.ts`): refuse "done" until verify.sh exists → passes → kills injected mutants; bounded reinjection rounds; exhaustion accepts anyway (gate shapes behavior, grader owns reward — invariant 1: gate never sees grader). |
| Crude mutation operators | `mutate.ts`: deterministic regex-site operators — exactly the class weak agent suites miss; docstring + `__main__`-block lines excluded (R9F, G1). |
| Coverage-guided probe sites | `minimal/cover.ts` sitecustomize trace hook (zero-dep, every python child captured) → mutate only verify-executed lines; static fallback on vacuity; ≥1-kill round rule (field-standard: equivalent mutants 4–39%, 100%-kill is an anti-pattern). |
| Pre-arm futility designCheck | `futility.ts` design check dies BEFORE spend when the arm cannot certify (Alling curtailment for mid-arm — still unexercised). |
| Machine-enforced provenance | `gate.ts` same-host rule: refuses cross-host baseline comparisons mechanically, not by convention. |
| Review gate + rejected ledger | `review-gate.ts` over `minimal/review.ts` wired pre-createCandidate; `rejected.json` per layer feeds the proposer prompt (loop learns from rejects — the loop-2 blind-spot fix, productionized). |
| Gate plugin (daily sessions) | `gate-plugin/`: session.idle completion-gate loop, `gate.json` opt-in, ndjson outcome sensor, self-inject echo guard, `[meta-harness]` child exclusion, marker default OFF (C2 verdict). Echo timing = test-faked, smoke pending. |
| Session-hygiene marker | C2-tested countermand injection between chained tasks — reward-null, A-side depressed → ships default OFF. |
| Pre-registration, practiced | G1 sealed pass/fail criteria in the repo BEFORE launch (§6.1 → §6.2 same file). SPRT still deferred. |

### Dormant / rejected-for-now

Phase-0 self-score transport (gate found it undersized) · best-of-N / verify-retry (evaluated,
deferred per AHE ablations) · SPRT sequential gate (deferred, §7.5) · packer-flip + back-pressure
(blocked on cgroup bug) · qemu-startup + pytorch-model-recovery env fixes (deferred, band
unaffected).

---

## Part 2 — Evidence status (audited 2026-07-23, post loops 1–3)

### PROVEN — direct empirical evidence, ours

| Technique | Evidence |
|---|---|
| **Lesson injection lifts a strong model (held-in)** | **v9 (interpretation-enumeration bullet): sparql 7/10 vs v7 1/10 same-host, p=0.020 — first statistically certified capability lift in project history.** Grip is CONTENT-dependent: loop-1's lesson ignored 7/8 trajectories; v9's engaged in every one. |
| **The gate, BOTH directions** | Certifies real lift (v9 p=0.020) AND rejects with mechanism: null (v8), guard-regression (v9 cgw), uncertified+regression (v10). The anti-AHE regression-blindness claim is exercised, not asserted. |
| **Guard non-regression as adoption filter** | v9 certified on held-in yet REJECTED on a guard (cgw 1/3 vs 3/3) — exactly the collateral AHE's loop cannot see (their regression-recall 11.1%). AHE's memory-hurts-easy prediction reproduced live. |
| **Verifier desk-check** | Decisive twice, free both times: reversed loop-1's diagnosis (held-out graph, order-insensitive grader); exposed cgw's double-trap (`git`@localhost vs instruction's `user@server`). Now a standing pre-distill step. |
| Taxonomy diagnosis → certifying fix-class | v9's winning lesson = the taxonomy-fed class; the "deeper" raw-trajectory analysis produced the confounded ORDER-BY lesson that gated null. |
| Lesson factory (`bench propose-lesson`) | Wired (TDD, 20 tests), validated by desk-equivalence; its unprompted clause-removal surgery retroactively validated by v10's failure. Its bullet (v11) = the pending candidate. |
| Judge injection-resistance | Live accidental adversarial test: `mh-judge` refused two full role-hijack prompts (44KB and 12KB) and held its verdict schema. |
| Gate's REJECT side (haiku era) | v3 killed after held-in with 2 pass-regressions caught (old loop-2). |
| Failure-mode detection | Prototype (3 hand-checked traj) + shipped tool (haiku v3: tune-mjcf 5/5 `incomplete` matches independent timeout diagnosis; opus v7: looks_done 5/7 → the class that certified as v9). |
| Band methodology substrate | 10-task opus band at k=3; sparql's screen estimate (1/3) reproduced at k=10 (3/10). |
| Bench infrastructure | 300+ trials survived: podman isolation, width ~6, timeout recording, atomic writes, resume (post-B1), tmux daemonization, cross-host store recipes. |
| Env-artifact forensics | 2 fake labels caught in the screen (7.7%); a turns=0 provider-error void trial caught + re-rolled in loop-3. |
| Prototype-before-build · Review-gated process | Unchanged from 07-21 audit (haiku proto, openssl artifact, B1/R1 pre-spend catches, SDD review catches). |

### DISPROVEN — negative results, ours, valuable

- **"Advisory prose never grips a strong model"** (loop-1's inference): falsified by v9 — grip is content-dependent, not channel-impossible.
- **Divergence-derived strategies as automatically trustworthy**: "add ORDER BY" looked load-bearing from pass-vs-fail comparison; grader was order-insensitive on held-out data — dev-data confound, gated null (v8). Verifier contract must vet divergence lessons (prompt rule 7 caveat).
- **Counterweighting a poison clause** (v10): retaining a harmful clause plus a counterweight lost to removing it — the factory's surgery was right, the hand-scoped edit wrong.
- **Prompt-rule evolution on haiku** (v1–v6) · **lesson injection into a capability-bound model** (haiku 0/2→0/2) · **single-task small-n signals** (openssl artifact) · **Phase-0 self-scoring** · **WSL2 cgroup capture** · **leaderboard labels as band predictions** — all as per 07-21 audit.

### UNPROVEN — the live frontier

- **NET improvement (lift with zero collateral) — i.e., a single ADOPTION**: v8/v9/v10 all rejected; active = v7, byte-identical to start. **v11 (factory-authored) is the pending test.**
- **Held-out generalization of a lesson** — loop-4's question; reserved band tasks untouched.
- **The autonomous crank end-to-end with a win** — factory authored v11; gate hasn't judged it.
- **cgw's fitness as a guard** — double-trapped task may punish every interpretation policy (flagged for review if v11 fails there with sshd+username correct).
- (Minor: judge self-preference bias unmeasured; SPRT deferred.)

### Scoreboard, one sentence (2026-07-23)

Every organ is now individually proven — diagnosis finds certifying fix-classes, the actuator
can move a strong model (p=0.020), the gate certifies and rejects truthfully in both directions —
but **no lesson has yet passed the whole body** (lift + no collateral = zero adoptions); v11,
the first candidate authored end-to-end by the machine, is the pending test of exactly that.

---

## Part 2 — RE-AUDIT DELTA 2026-07-27 (gate era: A-series adoptions, C-series measurements, G1)

*The 07-23 tables above are preserved as a snapshot. Everything below is what changed in the
four days since — the minimal-kernel track (HISTORY.md R/A/C/G series). The TB2-store track
(v7–v11) is FROZEN: v11 was never run; the machine-seat build superseded it in priority.*

### PROVEN — new since 07-23

| Technique | Evidence |
|---|---|
| **Adoption exists — the 07-23 headline frontier closed within hours, on the other track** | **A1** (system-v0+seed-v0, p=0.00106, guards cdt 3/3 + chess 3/3, 2026-07-23 MacBook) = first adoption in project history. |
| **Binding actuator moves outcomes — mechanism-class** | **R10:** fixed completion gate, cancel-async bare 3/10 vs gate-ON 10/10, **p=0.0031** — first perfect arm on that task; **A2** adopted it with gate-ON guards (first MECHANISM adoption). |
| **Prose→binding escalation was the right read** | On the post-A1 residual, the prose channel exhausted honestly (R5/R6 ABSTAIN, R7 refuted the placement hypothesis in BOTH channels, R8 staged-not-gated); the mechanism class then delivered R10. Refines loop-1's line: prose grip is content-dependent AND residual-dependent. |
| **Completion gate transfers as no-harm** | C1: held-out non-regression CERTIFIED both tasks (headless p=1.0, sparql p=0.47, same-host baselines). Value channel splits by artifact class — which became G1's target. |
| **Coverage-guided grip fix** | **G1 (same-day design→TDD→pre-registered arms→verdict):** headless exhaustion 0/5 vs C1's 7/9 (p≈0.02), median 400s vs 1000–5000s; sparql 3/3 clean. First healthy verify-fix loops ever on headless; a1's reinject rework passed the grader. |
| **Session-carryover reward null** | C2 pre-registered: B-side p=1.0 across arms; ONE real contamination event observed (raw a10, filesystem channel); marker A-side 4/12 vs 7/10 p=0.198 → marker ships default OFF. |
| **Pre-spend safety layers fire live** | Futility designCheck refused the playbook's --stop-futile as uncertifiable (zero tokens); gate.ts provenance check refused cross-host baselines and forced the same-host rerun. Both = machine-enforced discipline catching human plans. |
| **Forensics-before-verdict pays** | R9F: R9's 5 office trajectories root-caused the unkillable docstring mutant with ZERO re-trials; the "4/5 lift" was nudge-text, not mechanism — a wrong-mechanism adoption averted. |

### DISPROVEN — new since 07-23

- **All-must-die mutant rule on large artifacts**: structurally unsatisfiable (C1 headless
  7/9 exhausted; G1 forensics: rounds were killing 1–3/4 mutants all along — the rule, not
  the agents, burned them). Replaced by coverage-guided sites + ≥1-kill (field-standard).
- **Marker hygiene as a free win**: reward-null but A-side depressed (p=0.198) → default OFF.
- **Nudge-text ≈ mechanism** (R9/R9F): reinject text alone produced 4/5; the actual probe was
  unsatisfiable the whole time. Text effects and mechanism effects must be separated by design.

### UNPROVEN — the live frontier (2026-07-27)

- **Machine-authored end-to-end win** — still THE open question, now in two forms: v11
  (TB2 track, frozen-pending) and the machine seat (§4.1+§4.2 built + G1-hardened, but
  §4.3 trial mode + §4.4 mechanism proposals unbuilt → no machine-routed candidate yet).
- **Gate outcomes as a reward signal (§4.3)** — poisoned until calibrated: EVERY real failure
  across C2+C1+G1 was false-accept (gate accepted, grader failed). Calibration arms +
  "accept = self-verified, never correct" constraint designed (grip-fix §5.1), unrun.
- **Held-out LIFT** — only non-regression shown; no lesson/mechanism has certified lift on a
  held-out task.
- **Gate-plugin echo-timing** — test-faked only; live smoke deferred behind bench work (user
  2026-07-27).
- **Spec-coverage + metamorphic-relation probes** — designed (§5.1), unbuilt: the direct
  attack on the false-accept channel.
- **Mid-arm curtailment** — still unexercised (needs a lift-certifiable arm).
- **Cross-family judge check** — still unrun; field now quantifies the risk (≈5–7%
  same-family inflation).

### Scoreboard, one sentence (2026-07-27)

The 07-23 frontier fell in four days — two adoptions (A1 prompt-pair, A2 mechanism), and the
binding actuator went design → lift-certification (p=0.0031) → adoption → held-out no-harm →
same-day grip-fix verification (G1) — so the body works when humans drive the crank; what
remains unproven is the machine driving it (v11 frozen, §4.3/§4.4 unbuilt) and whether gate
outcomes can be trusted as its reward signal (false-accept calibration = the gating question).
