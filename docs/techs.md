# Techniques employed — inventory + evidence status

*Written 2026-07-21; Part 2 re-audited 2026-07-23 (post loops 1–3),
**2026-07-27 (gate era — delta section at the end of Part 2; Part 1 gains §K)**, and
**2026-08-06 (GA/probes era — Part 1 gains §L; third delta at the end)**, and
**2026-08-10 (package/dogfood era — Part 1 gains §M; fourth delta + Part 3 addendum)**. Two purposes:
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
| Spec-coverage probe (added 07-27) | RTM-style frozen `requirements.json` per task (from instruction.md only) matched against comment-stripped verify.sh; `requirement-untested` reinject names the gap. First live save same day (FA1 a2). |
| Relation probes (added 07-27) | Instruction-derived metamorphic/property scripts vs the artifact (oracle-free — the literature's standard weapon for the no-ground-truth channel); desk-validated oracle-pass/degraded-fail; `relation-violated` outcome. |

### L. Instrument, transport, seat + process-gate machinery (GA era, 2026-07-28 → 08-05; added at 08-06 re-audit)

| Technique | What / why |
|---|---|
| km-gauge v2 (shadow extractor + refiner) | Stop-time SHADOW measurement of extraction quality — derives a class (A1/A2/C/D) per cycle, never blocks; fail-loud `present:false + offReason` so silence is impossible (GA3, GA11). The §4.3 reward-calibration question's instrument. |
| Derive transports, per-caller | `selectTransport`: default `"sdk"` (direct Messages API, ~28k CC-harness tokens → ~0.7–3k, GA12); `"agent-sdk"` merged per-caller opt-in with live path PINNED IN CODE + revert-detecting test (GA13); `"agent-sdk-daemon"` literal registered, bar never run (§6e). |
| Paired-validation (pv) machinery | Standing transport-comparability instrument: stratified C-enriched shadow re-derivation, agreement ≥0.80 + missed-C cap bar, `--pair <baseline>:<shadow>` over ANY two transports, fail-closed cross-host combine, `arms` field disambiguating committed artifacts. |
| sendPrompt seats interface | Provider registry for the design-time seats (proposer/reviewer/revision): `anthropic-api` default with explicit `REASONING_ISOLATION` + maxTokens truncation guard (a cut proposal THROWS, never passes as complete); callers never see a session. |
| ACP warm lane | Host-global daemon + `SessionPool` of `/clear`-recycled warm CC CLI subprocesses (Agent-SDK `query()` under the hood) behind `KKAMAK_SEAT_PROVIDER` — premium reach via the CC credential pool during raw-API 429 walls. Send-boundary law: no-call falls back to api once; call-consumed THROWS, never falls back. RSS-sized cap (≈330 MB/session both hosts, cap 4). |
| Two-tier gate check | `scripts/gate-check.ts`: blocking tier = package-TIA-scoped fast suites (spawn-heavy files excluded by one policy regex); incumbent full check VERBATIM as a detached background run; red marker = debt, repaid by a synchronous full run next gated Stop. `KKAMAK_GATE_FULL=1` restores old behavior exactly. |
| Process gates 7a/7b | 7a doc-linter floor in the gate check (+ `KKAMAK_DEV_CHECKS` append-only drift guard); 7b merge gate: `merge-with-gate.sh` refuses any merge to main whose range lacks a committed `docs/reviews/<sha>-<slug>.md` artifact with matching range. |
| Fixture harvest (Phase 2) + sidecars | Block-time dirty-tree snapshot (temp-index `write-tree` → `refs/kkamak/fixtures/`) + km-crank harvest → TB2 fixture task; Phase 1 check-output sidecar (block excerpts → proposer evidence); Phase 3 async prompt-check with `mechanize_instead` rubric key. |
| Verification-channel ladder + C4 nudge | C1–C4 channel classification of verify evidence; C4 soft nudge built INERT (`channelNudge` absent from gate.json); nudge-vs-reject experiment pre-registered, sized go awaits base rate. |
| cls-ab classifier 2×2 | Model × prompt classifier A/B tooling (`cls-sample/run/label/score --combine`), pre-registered, 0 labels to date — constants still amendable. |
| Loop-fix probe program | P0 signal-viability (sd/mean bar) × P1 event-density × E feasibility table over B1–B4 signals and S1–S4 sources — a measured answer to "why doesn't the loop close", replacing the starvation guess with a pairing diagnosis. |
| Boundary-ts discipline | Every non-metric-neutral instrument change stamps an epoch-ms boundary in the adoption ledger; readings never pool across a boundary (9 stamped boundaries and counting). |
| Standing rules earned in this era | Activated-state suite proof for env-gated arms · bar-feasibility pre-check before building to a bar · read the dependency's own types, then measure on the wire, then assert · execute-proof over review for enforcement points. |

### M. Package, dogfood-subject + probe machinery (2026-08-07 → 08-10; added at 08-10 re-audit)

| Technique | What / why |
|---|---|
| Package extraction + SHA-pin consumption | `@th-yoo/cc-api-daemon` = the SOLE ACP implementation (`src/acp` deleted 08-09, merge `c1564c5`); consumers pin an exact commit SHA, so package pushes never reach them. Upgrade = deliberate pin bump + full gate + plugin version bump + ledger boundary ts in ONE change (0.5.0→0.7.0 done 08-10, ts 1786327038587). |
| Subject-session supervision (brief-and-verify) | Driving a live CC session via tmux as the implementer: briefs carry the measured constraints and hazards the subject cannot see (budget floors, 429-transport facts, redaction rules); the subject implements under its own armed gate; the supervisor verifies OUT-OF-BAND (adversarial probes, credential-less CI, independent test reruns) and never trusts a self-reported number it didn't reproduce. Subject reports to FILES, never panes (pane greps echo your own instructions — 6 false positives). |
| Subject-planned, supervisor-reviewed design | The planning variant: the subject writes the implementation plan against its own code (freshest knowledge), the brief delegates open decisions with recommendation-required, the supervisor verifies the plan's quoted code line-by-line against source before any build go. Caught nothing false in 2/2 uses; the subject's C2 retention-only design beat both options the brief offered. |
| Gate fast-lane test split | Slow CLI-spawn suites behind an opt-OUT env flag (`ACP_GATE_FAST`, née `KKAMAK_GATE_FAST`) set ONLY in gate.json's check string; bare `bun test` and CI always run everything; deliberate carve-outs pinned by comment (the ~1s credential-precedence guard runs in the fast lane forever). Subject-repo gated Stops 76.5s → 14.8s. |
| Elastic warm pool (floor/ceil) | Retention-only floor — never pre-spawns; exempts the `floor` most-recently-released idle entries from TTL eviction, so a floored entry always carries an isolation real traffic used. Unconditional one-per-tick shrink + acquire-miss reclaim (closes the pool-exhausted starvation window the throttle opens) + `ACP_SESSION_IDLE_MS` entry-TTL wiring. Floor never blocks daemon self-exit. |
| Zero-spend live probes as acceptance evidence | Real daemon + real `claude` CLI children against a localhost stub, run OUTSIDE the test harness before "works" is claimed: pool lifecycle, floor-retention timeline (children 2→1, retained 6x past TTL), credential precedence under the real credentialed HOME. Complement, not substitute, for hermetic suites — they catch what suites faking the exec seam structurally cannot. |
| Billing-lane guard | `authLane()` boot-time disclosure + e2e abort condition: an `ANTHROPIC_API_KEY` in env silently flips the haiku bare-SDK route from subscription to metered pay-go (credential precedence puts the key first). Made observable in the daemon's own stderr; never silent. |
| Silent-done hardening (recorded, pending) | The two-burn defect class: a classifier reading ONE channel (stdout) launders "died before producing anything" into "done"; every downstream layer (results schema, tally, monitor) faithfully propagates well-formed zeros. Hardening candidates recorded in the 05e3d1d artifact: rc!=0 + empty stdout ≠ done; a4 re-pass must read rc; tally refuses on missing results files; tripwires must cover the NEW failure mode's log signature, not the previous one's. |

### Dormant / rejected-for-now

Phase-0 self-score transport (gate found it undersized) · best-of-N / verify-retry (evaluated,
deferred per AHE ablations) · SPRT sequential gate (deferred, §7.5) · packer-flip + back-pressure
(blocked on cgroup bug) · qemu-startup + pytorch-model-recovery env fixes (deferred, band
unaffected) · `--bare` Agent-SDK mode (bills API rates — defeats the credit-pool rationale;
GA13) · git `pre-merge-commit` hook as 7b enforcement (provably unsound: ort merge never
materializes MERGE_HEAD) · blind-opus gauge anti-over-extraction patch (audit finding stands,
patch rejected; GA11).

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

---

## Part 2 — RE-AUDIT DELTA 2026-08-06 (GA/probes era: instrument + transports + seats + process gates, GA6–GA14 + loop-fix probes)

*The 07-23 and 07-27 sections above are preserved as snapshots. Everything below is the
2026-07-28 → 08-05 arc (HISTORY.md GA6–GA14 + the loop-fix probe program), audited against the
repo's own records (adoption ledger, specs, docs/reviews, gate-outcomes telemetry) plus a
host-runtime evidence sweep on yoo-mac.*

### PROVEN — new since 07-27

| Technique | Evidence |
|---|---|
| **Two-tier gate check** | Deployed both hosts (ts 1785888548054); gated-Stop `durationMs` mean **108,733 → 4,943 ms (~22x)**, confirmed by the S4 erratum after a denominator bug was caught and fixed (`198184e`). Same-day plan → SDD → review → merge. |
| **pv as a transport-comparability instrument, BOTH directions** | §6c cli-vs-sdk returned **SPLIT** (0.625 < 0.80 — the bar fired exactly as pre-registered, readings stay split forever); §6d sdk-vs-agent-sdk returned **POOLING-PERMITTED at the exact bar edge** (4/5 = 0.800, missed-C 1 = cap, wrongTransport 0). One instrument, one honest verdict each way. |
| **§6c direct-API derive transport** | Adopted default both hosts: ~28k CC-harness tokens per derive → ~0.7–3k, no behavior regression (GA12 boundary ts). |
| **Wire measurement settles what docs cannot** | Caught the Agent SDK shipping our own auto-memory into every classification (10,693 B → 1,563 B after isolation), `--bare`'s silent auth switch to API billing, and the 1-call-per-query answer (all GA13); separately, the GA14-era T4·1a probe caught `/clear` emitting its own synthetic third result frame per recycle — each one reversed a written verdict. |
| **7b merge gate blocks live** | Mechanically blocked a merge whose artifact named the wrong merge-base (this repo, 08-04 MacBook session) — the floor works on its own author. |
| **Execute-proof over review for enforcement points** | `pre-merge-commit` hook proven unsound by execution (ort merge never materializes MERGE_HEAD — hook fires blind and passes); no review round had caught it. |
| **Activated-state suite rule** | Born from v2 activation silently breaking 2 tests (2026-08-01); applied AHEAD of the warm-lane flips on both hosts — zero repeats. |
| **Cross-platform suite re-run discipline** | First darwin re-run after the ACP merges caught 35 silent failures with ONE root cause (AF_UNIX `sun_path` 104 B cap → dead sockets → tests silently degraded into fallback legs) — a class invisible on the build host. |
| **Warm-session RSS sizing method** | Process-tree sweep, platform-branched (/proc vs ps/vm_stat), measured ≈330 MB/session on BOTH host classes; recycle flat; caps held at 4 with the 8-cap explicitly refused on the 16 GB host. |
| **Gauntlet loop as PROCESS** | Fresh-context critics + frozen bars + ≤2 gap rounds: caught real defects in both transplant loops and rejected both candidates on their own bars (0 merges / 2 drops) — EMPLOYED as standing practice for adoption-grade decisions; the transplants themselves died correctly. |
| **Loop-fix probe program (P0/P1/E)** | Replaced a wrong standing diagnosis with a measured one: B2 review-findings is the ONLY viable signal (sd/mean 1.41), density exists (62.6 Stops/day), and the blocker is **pairing** — the viable signal rides the one starved source (S3, 1.43/day; 245 days) while capacity pairings (b2×s1/s2) would verdict in 6–7 days. |
| **B3 binarization** | Gauge classes admitted as a signal: D-vs-rest on measured emission cadence 18.26/day — d=0.30 reachable in 5 days. |

### DISPROVEN — new since 07-27

- **"The loop is starved of events"** — STALE diagnosis. S1 62.57 Stops/day, S2 55.43
  commits/day; the starvation is confined to S3 (review-adds, 1.43/day). Pairing, not density.
- **"The two-tier gate cut sensor emission ~25x"** — denominator bug (S4 erratum): emission
  slightly ROSE; the real effect is 22x faster Stops.
- **"Agent-SDK harness residue changes classifications vs the API SDK"** — §6d pv says
  pooling-permitted (at the edge, zero slack — kept under per-caller selection anyway).
- **`--bare` as a residue fix** — authenticates by API key = API billing; defeats the entire
  credit-pool rationale (GA13, measured on the wire).
- **Git hooks as merge-gate enforcement** — provably unsound placement (see PROVEN).
- **Stored gauge C-labels as ground truth** — blind-opus audit: stored C-precision 9/13 ≈ 69%
  (over-extraction); the correcting patch itself was rejected, the finding stands (GA11).
- **Resume prose as cross-session state** — two stale-resume incidents on one plan (Tasks 6-7
  "untouched", Task 8 "not run" — both had already run). SDD ledger + committed artifacts are
  the truth; resume.md drifts.

### UNPROVEN — the live frontier (2026-08-06)

- **The machine-authored end-to-end win** — STILL the open question from 07-23 and 07-27,
  unchanged. Now with a measured path: a b2×s1/s2 pairing verdicts in 6–7 days if the
  review-sensor synthesis (spec SOUND, unbuilt) lands.
- **Warm lane VALUE** — activated both hosts, `/clear`-recycling proven at the mechanism level,
  but **zero live seat calls have exercised it** (no daemon artifacts on yoo-mac; the daily
  proposer spawns that would have driven it failed 4/4 on a PATH bug, fixed `87d4937` —
  evidence supply restored, verdict pending).
- **Evidence-consuming machinery built ahead of its supply** (the era's recurring failure
  shape): reinject v2 (11 runs, verdict OPEN, fixtures=0) · M1v2 corpus floor (official
  reading 0/0) · cls-ab (0 labels) · channel ladder + C4 (base rate never measured, nudge
  inert) · fixture harvest (0 organic blocks) · §4.3 trial mode (A/A checkpoint never
  reached) · Path A seed tournament (no tally committed). Each is individually sound and
  collectively idle for the same reason: the loop's organic event flow hasn't fed them.
- **§6e daemon as a DERIVE transport** — literal registered, bar declared powerless pre-data,
  never run (distinct from the seat lane, which is active).
- **Review-sensor synthesis + P2 actuator-binding** — specs reviewed-to-SOUND, unbuilt,
  each needs its own go.
- (Carried: cross-family judge check unrun; SPRT deferred; mid-arm curtailment unexercised.)

### Scoreboard, one sentence (2026-08-06)

The organs multiplied and every new one is individually proven — the gauge measures, pv
compares honestly in both directions, the transports are cheap, the process gates block their
own author, and the two-tier gate gave the loop its cadence back — but the 07-27 headline is
unchanged: no machine-driven adoption yet, and the probe program has now shown exactly why —
the one viable signal rides the one starved source, so the next move is pairing (review-sensor
synthesis), not more rigor and not more machinery.

---

## Part 2 — RE-AUDIT DELTA 2026-08-10 (package/dogfood era: ACP migration, cc-api-daemon subject arc, P2 burns, pool build)

*The 07-23, 07-27 and 08-06 sections above are preserved as snapshots. This delta covers
2026-08-06 → 08-10: review-sensor arm/wedge/fix/hold, gate tier-0 narrowing, the ACP package
migration (src/acp deleted; `@th-yoo/cc-api-daemon` 0.2.0 → 0.7.0), the cc-api-daemon
dogfood-subject arc (unified daemon merge, credential lock, gate split, elastic pool), the P2
launch burns, and today's warm-lane production proof. Sources: HISTORY.md GA15 + the 08-06/08-10
entries, kkamak dogfood-log, the adoption ledger, `.km` streams on two repos, docs/reviews.*

### PROVEN — new since 08-06

| Technique | Evidence |
|---|---|
| **Completion gate on a NON-kkamak subject repo** | First armed dogfood outside the family: cc-api-daemon. One 3-round blocked cycle (verify-failed ×2 → 20 min of fixes → accepted) caught 18 failing tests — all in the §6e spend-boundary suite — before a Stop shipped them. `gateExhausted` never fired across 28 cycles. |
| **Brief-and-verify subject supervision** | 5 dispatched tasks (unified-daemon merge 5 commits, credential-precedence lock, gate split, pool plan, pool build 8 commits): subject implemented all under its own gate, first-round accepts; supervisor's out-of-band layer caught what the subject could not — the unlocked precedence claim (probe thrown away), the plan's acquire-starvation hole, the fast-lane carve-out need. Division held: constraints travel in briefs, verification is out-of-band. |
| **Gate fast-lane split transfers** | Subject-repo gated Stops 76.5s → 14.8s (5.2x) with CI still running all 247–322 tests; the 1s credential guard carved into the fast lane deliberately; CI wall-clock unchanged post-split (2m30s → 2m23s) proving the flag never leaked into CI. |
| **Measured-before-build settles blocking unknowns free** | Both of the unified-daemon spec's blockers closed by reading, zero spend: haiku-via-bare-SDK bills SUBSCRIPTION (credential-resolution chain read, no org key in env) and agent-lane peak concurrency = 2 (consumer grep: gauge serial + sensor debounced, no `Promise.all` over `daemonCall` anywhere). A third spec item (adaptive pool min=0/idle-reap) was found ALREADY BUILT — the spec was written against stale knowledge of its own codebase. |
| **Zero-spend live probes close the suite/production gap** | Three probes, zero tokens: credential precedence under real HOME (fake key sent, `authorization: null` — the adversarial case no green suite covers); pool lifecycle (2 real children under cap, retention, self-exit sweep); floor timeline (TTL eviction at the wired 4s, one-per-tick, floored child retained 6x past TTL). Each promoted a hermetic claim to an observed one. |
| **Warm lane production-exercised** | The 08-06 "zero live seat calls" gap closed 08-10: one real opus turn through the pinned 0.7.0 package — `ensureDaemon` 107ms → pooled WarmSession → `ok` in 4.3s, `canonical=claude-opus-5`, subscription lane, child retained. Mechanism now production-proven end-to-end; ORGANIC seat traffic still zero (see UNPROVEN). |
| **P2 machinery live-proven under burn** | Launch 2's clean window ran a1 REAL (turns~29, rewards landing, 4 passes / 13 clean attempts): staging, agent, verifier, review-daemon pre-start, results plumbing all worked. The burns were environment (auth wiring, token expiry), not machinery. |
| **Reading the live run catches what every suite cannot** | Both P2 burn root causes (missing `IS_SANDBOX=1` → stderr-only refusal → empty stdout → "done"; mid-run token expiry → no `turns=` line at all) were invisible to every test because every suite fakes the exec seam — and both were caught only by reading the live run. The silent-done class is now named, with hardening candidates recorded. |

### DISPROVEN — new since 08-06

- **"Gate green ⇒ CI green"** — the subject repo's earlier run: gate accepted 9/9 while GitHub
  Actions was red on three of them (tests green locally for a reason unrelated to what they
  assert — host credentials). Recorded as a LIMIT, not a defect: a check command cannot observe
  a dependence on its own environment; it IS the environment. More checks sharing an
  environment add no coverage. Fix class stolen from the subject: an explicit
  credential-scrubbed run as its own CI step.
- **"The sensor stream distinguishes a passing gate from a dead one"** — it cannot (dogfood
  correction `aec746a`): the stream appends only on cycle COMPLETION, so a frozen stream is
  consistent with idle, blocking, and dead alike. 105 minutes of silence was mis-called "gate
  stopped enforcing" before a forced Stop produced a full blocked cycle within seconds. Force a
  Stop; never sample. (Cost two opposite wrong calls in one session.)
- **"Monitor tripwires transfer across failure modes"** — launch 2's tripwire (`turns=0`) was
  pattern-matched to launch 1's signature; the auth-expiry mode prints no `turns=` line at all
  and sailed past it. A tripwire covers the failure modes it was written against, nothing else.
- **"Structurally valid results files are run truth"** — both burns produced well-formed
  results full of garbage; `p2-tally` happily wrote an all-zero verdict over missing files. The
  LOG carries the distinction; tally only when every results file exists.

### UNPROVEN — the live frontier (2026-08-10)

- **The machine-authored end-to-end win** — UNCHANGED since 07-23, three audits running. The
  measured path (b2×s1/s2 pairing) is now BUILT but not armed: review-sensor merged, blockers
  fixed (`ae6a2f6`), arming held by user (two caveats open: what counts toward the ≥25/day bar
  when the sensor only diffs the main checkout; how the env flag reaches worktree sessions).
  The 08-13 checkpoint re-dates from whenever arming lands.
- **P2's actual question** (which carrier binds rules: prose bullet vs in-container stop-gate
  vs host review + re-pass) — machinery live-proven, ZERO data; rerun #3 needs a fresh token
  window, the "NOT retrying" tripwire, and its own go. On a linux host it ALSO needs the
  `~/.claude` rw-mount ruling (operator memory naming P2 leaks into agent containers).
- **Warm lane ORGANIC value** — mechanism production-proven (today's probe) but no organic
  seat call has ridden it; the elastic-pool knobs (`ACP_MIN_SESSIONS`, `ACP_SESSION_IDLE_MS`)
  are live in 0.7.0 with a named first consumer (P2's a4 review daemon: floor=1 + 2h idle)
  that has not yet run.
- **Silent-done hardening** — recorded, not built: rc!=0+empty-stdout classification, a4
  re-pass rc, tally refusal. The class has now burned two launches; a third burn on the same
  shape would be a process failure, not bad luck.
- (Carried: cross-family judge check unrun; SPRT deferred; mid-arm curtailment unexercised;
  reinject v2 / cls-ab / M1v2 / channel-ladder C4 still starved — the pairing fix is their
  shared unblock.)

### Scoreboard, one sentence (2026-08-10)

The system now improves OTHER codebases under its own gate — the subject arc shipped a public
package (7 versions, CI green throughout) with the supervisor catching exactly the classes the
subject structurally cannot see — but the machine-authored win is unchanged at three audits
old, its measured fix (sensor pairing) is built-and-held, and its bench instrument (P2) is
live-proven with zero data: every remaining blocker is now a decision or a rerun, not a build.

## Part 3 — Effectiveness ranking (added 2026-08-06)

*Ranked by demonstrated outcome impact — measured effect size or harms concretely prevented —
cost ignored (that's a different ranking). Sources: the Part-2 audits above, HISTORY.md
verdict rows, the adoption ledger, gate-outcomes telemetry.*

### Moved task outcomes (the product's actual wins)

| # | Technique | Measured effect | Evidence |
|---|---|---|---|
| 1 | **A2 completion gate** (binding mechanism actuator) | cancel-async 3/10 → **10/10**, p=0.0031 — largest single outcome flip ever measured here; first perfect arm on that task. | `minimal/HISTORY.md` rows R10 (lift certification) + A2 (adoption, gate-ON guards). |
| 2 | **A1 system-prompt + seed adoption** | 6/20 → **17/20** (30%→85%), pooled Fisher p=0.00106 — largest lift in project history; guards cdt 3/3 + chess 3/3; still the active base. | `minimal/HISTORY.md` rows SG (arms) + A1 (adoption, commit `4fc9d68`, `minimal/results/adoption-1-verdict.json`). |
| 3 | **G1 coverage-guided probe sites + ≥1-kill rule** | headless exhaustion 7/9 → **0/5** (p≈0.02), median 400 s vs 1000–5000 s — first healthy verify-fix loops on that artifact class. | `minimal/HISTORY.md` row G1 (pre-registered arms, same-file §6.1→§6.2 seal). |
| 4 | **v9 lesson injection** (certified, not adopted) | sparql 1/10 → **7/10** same-host, p=0.020 — proved prose grip is content-dependent; rejected on a guard (cgw 1/3 vs 3/3), effect real. | Part 2 (07-23) PROVEN table above; TB2 store v9 score records. |

### Moved system performance

| # | Technique | Measured effect | Evidence |
|---|---|---|---|
| 5 | **Two-tier gate check** | gated Stops **~22x faster** (durationMs mean 108,733 → 4,943), every cycle-ending Stop, both hosts. | Adoption ledger §"Gate check two-tier deploy" (ts 1785888548054); S4 erratum `docs/reviews/e25670f-fix-s4-denominator.md` (merge `198184e`) — the 22x is the CORRECTED number; `.km/gate-outcomes.ndjson` durationMs history. |
| 6 | **§6c direct-API derive transport** | **~10–40x token cut** per derive (~28k CC-harness tokens → ~0.7–3k), both hosts, every Stop. | Adoption ledger §"Gauge SDK-transport deploy boundary" (ts 1785684571765 / office 1785711630125); `minimal/HISTORY.md` GA12. |

### Moved decisions (harms prevented — effectiveness of the negative kind)

| # | Technique | Prevented | Evidence |
|---|---|---|---|
| 7 | **Adoption gate + guards, both directions** | Every bad adoption ever attempted: v3, v8, v9-on-guard, v10, both Gauntlet transplants. Zero bad adoptions have landed. | `minimal/HISTORY.md` rows v3-era loop-2, R-series verdict cells; Part 2 (07-23) "the gate, BOTH directions"; gauntlet ledger table Loops A + D (DROP). |
| 8 | **Token-free wire probes** | 4+ committed-but-wrong verdicts reversed pre-build: auto-memory contamination (10,693 B → 1,563 B), `--bare` billing switch, "4 calls" miscount, `/clear` third result frame. | `minimal/HISTORY.md` GA13 row (first three, named inline); the `/clear` third frame is GA14-era — T4·1a probe, `docs/resume.md` 08-04 session block. |
| 9 | **pv instrument** | Silent pooling of non-equivalent transports. §6c: SPLIT, agreement 0.625 < 0.80, missed-C 6 > cap 2. §6d: pooling-permitted at the exact edge (4/5 = 0.800, missed-C 1 = cap 1, wrongTransport 0). | `docs/gauge-pv/yoo-dev-pv-counts.json` + `docs/gauge-pv/yoo-dev-sdk-vs-agent-sdk-pv-counts.json`; extractor pre-registration spec §6c/§6d OUTCOME blocks. |
| 10 | **Fresh-context reviews + execute-proof** | stderr pipe-deadlock, Bun socket-steal, unsound `pre-merge-commit` enforcement, tautological tests, wrong merge-base artifact (7b gate blocked it live), duplicate re-implementation — all pre-merge. | `minimal/HISTORY.md` GA7/GA13/GA14 rows; adoption ledger §"Process-gate arming boundary" (placement discovery); `docs/reviews/` (13+ artifacts); GA14 review-catch list. |
| 11 | **Forensics-before-verdict** (R9F) | A wrong mechanism adoption — "4/5 lift" was nudge-text; the docstring mutant was unkillable the whole time. Zero re-trials spent. | `minimal/HISTORY.md` row R9F (`mutate.ts` codeLineSet fix). |
| 12 | **darwin re-run + activated-state disciplines** | 35 silent no-call-degraded test failures (one root cause: AF_UNIX `sun_path` 104 B cap) and the v2-activation suite break. Both standing rules, zero repeats. | `docs/reviews/81fe22c-fix-darwin-sock-len.md`; adoption ledger v2 activation log (2026-08-01) + warm-lane precondition evidence; `minimal/HISTORY.md` GA14 follow-up (a). |

### Effective as instruments (enable the rows above)

km-gauge v2 — shadow classes now feed the B3 signal (deploy: HISTORY GA3; binarization:
`docs/reviews/b6d858f-b3-binarization-ruling.md`) · gate-outcomes telemetry — root-caused the
Stop stall from its own durationMs history, 26–31 s → 151–183 s regime shift
(`.km/gate-outcomes.ndjson`; resume 08-05 gate-stall entry) · loop-fix probe program —
relocated the loop's blocker from rigor/density to signal-source pairing
(`docs/superpowers/specs/2026-08-05-loop-fix-probe-program-design.md` §Results,
`docs/loop-probes/yoo-dev-e-table.json`, review `docs/reviews/6fb1c64-loop-probes.md`).

### Proven ineffective (tried, measured, did not move outcomes)

*Distinct from the band below: these FAILED on content — wrong hypothesis, wrong channel,
wrong rule — and the gate caught each one cheaply. That is the system working; they are
correctly dead and none is a purge candidate because they are already purged.*

| # | Technique | Result | Evidence |
|---|---|---|---|
| 1 | Prose-bullet actuator (R1 on bare, pre-A1; R2–R8 on the adopted-base residual) | Zero certified effects across all 8 rounds: R1–R3 REJECT null, R4 scope-veto, R5–R6 ABSTAIN, R7 refuted the placement hypothesis in BOTH channels, R8 staged-not-gated. The post-A1 streak proper is R2–R8. Worst effect-per-trial record in the repo; only yield = channel closed, escalation to binding mechanisms. | `minimal/HISTORY.md` rows R1–R8 verdict cells; R8 "prose channel dead"; scoping matches the 07-27 section above (R5–R8 exhaustion framing). |
| 2 | Haiku-side evolution (prompt rules + lessons) | v1–v6 prompt candidates all failed; lesson injection 0/2 → 0/2 — capability-bound model, no headroom. Forced the opus pivot. | Part 2 (07-23) DISPROVEN list above; `minimal/HISTORY.md` haiku-era rows. |
| 3 | Session-carryover marker (C2) | Reward-null (B-side p=1.0) with the A-side DEPRESSED (4/12 vs 7/10, p=0.198) — borderline negative; ships default OFF. | `minimal/HISTORY.md` row C2; Part 2 (07-27) DISPROVEN "marker hygiene as a free win". |
| 4 | Machine-proposed bullets (R1, R2) | Proposer mandated behavior winners already did — nulls; first calibration points for proposer predictions. | `minimal/HISTORY.md` rows R1 (own `falsify_if` fired) + R2. |
| 5 | FA1 false-accept probes (RTM + relation/metamorphic) | CLOSED BY MATH: probe effect NULL, remaining arms futile. | `minimal/HISTORY.md` §FA1 header + row. |
| 6 | Gauntlet mechanism transplants (Loops A, D) | 0 merges: Loop A's null_precedent check satisfiable by construction BOTH rounds (reword only relocated the defect); Loop D's bar clause never engaged (corpus saturated by rejected-ledger near-dups). | Gauntlet ledger table rows A + D; GA10 row. |
| 7 | All-must-die mutant rule on large artifacts | Structurally unsatisfiable — it was burning the agents, not testing them (C1 headless 7/9 exhausted; rounds were killing 1–3/4 mutants all along). Replaced by G1's coverage-guided + ≥1-kill. | `minimal/HISTORY.md` rows C1 + G1; Part 2 (07-27) DISPROVEN. |
| 8 | v8 divergence lesson + v10 counterweighted clause | v8's "add ORDER BY" was a dev-data confound (grader order-insensitive) — gated null; v10's counterweight lost to plain clause removal. | Part 2 (07-23) DISPROVEN list above. |

### Not yet effective, whatever their promise

Warm lane · §6d agent-sdk transport · reinject v2 · fixture harvest · cls-ab · channel
ladder/C4 · M1v2 · §4.3 trial mode · Path A tournament — zero demonstrated effect to date;
all await evidence flow (see the 08-06 delta's "built ahead of supply" entry). NOT the same
failure class as the table above: nothing here has failed on content — it is starved, with
one shared upstream cause (signal-source pairing) and one shared fix candidate
(review-sensor synthesis). Nothing in this band should be cut before the pairing fix gets
its shot; everything in the table above already has been.

**Top line:** the two adopted actuators (A1, A2) and the gate that vetted them are the most
effective techniques in the project; everything else that is effective is either speed
(two-tier gate, §6c transport) or error-prevention (probes, reviews, pv, forensics).

### Part 3 addendum (2026-08-10)

*The 08-06 ranking above stands. Movements since, without rewriting the snapshot:*

- **"Moved system performance" gains a row:** subject-repo gate fast-lane split — gated Stops
  76.5s → 14.8s (5.2x), every Stop in cc-api-daemon, CI coverage unchanged (proof: CI
  wall-clock flat across the split). Same medicine as row 5, second patient.
- **"Harms prevented" gains three:** (a) the credential-precedence regression lock with
  boolean-projection assertions — closes a public-repo leak class where the failing test would
  itself print the leaked token; (b) the acquire-starvation hole caught at PLAN review, fixed
  as Task 4b before any build; (c) the billing-lane guard (`authLane` + boot log + e2e abort) —
  a stray `ANTHROPIC_API_KEY` can no longer silently flip the haiku route to metered spend.
- **"Not yet effective" band, movements:** warm lane EXITS the band at the mechanism level
  (production-exercised 08-10, one real opus turn, subscription lane) — organic value still
  pending; P2 moves from "spec SOUND, unbuilt" through built → live-proven → twice-burned →
  rerun-held; review-sensor moves from unbuilt to built-and-held (arming = user decision).
  Everything else in the band is unchanged and still shares the one upstream cause (pairing).
- **New entrant to watch, not yet rankable:** brief-and-verify subject supervision — five
  dispatched tasks, zero rework, and every catch that mattered came from the out-of-band
  layer. If it holds at n>2 repos it belongs in the process top tier; today it is one subject
  and one supervisor.
