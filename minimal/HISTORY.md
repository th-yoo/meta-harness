# minimal/ evolution history

Append-only round log for the minimal loop (kernel: [`docs/minimal-loop-ood.md`](../docs/minimal-loop-ood.md)).
One entry per adoption-gate verdict. `rejected.json` is the machine-form rejection
ledger (invariant 5 — permanent proposer input). This file is the human-readable
lineage.

## The three gates — canonical names (do not say bare "gate" in new docs)

| Name | Level | Decides | Seat | Code |
|---|---|---|---|---|
| **Completion gate** | one attempt, at "done" | is this attempt's work verified? (verify.sh + mutation probe; reinjects evidence, bounded rounds) | code | `complete-gate.ts` + `mutate.ts`, run.ts `--complete-gate`; daily deployments: opencode `gate-plugin/` (2026-07-26, mutants=0 v1, marker OFF; **LIVE-VERIFIED SM1**) + CC `cc-gate-plugin/` (**kkamak plugin, SHIPPED+SMOKE-VERIFIED SM2**, merge 6d443df); both write one `.km/gate-outcomes.ndjson` stream |
| **Review gate** | one proposal, pre-spend | is this candidate bullet fit to test? (dup/scope/leak checks + rubric; bounded revise loop) | LLM + deterministic layer-1 | minimal: propose.ts Reviewer seat (`review.ts`); production: `opencode-plugin/src/review-gate.ts` + per-layer `rejected.json` (ported 2026-07-26) |
| **Adoption gate** | the active base | does this candidate replace the base? (Fisher lift + guard non-regression + forensics void-exclusion) | code, sole base-mutator | `gate.ts` |

Modifiers: "gate-ON/OFF arm" = completion gate armed/not; "gate reinjection" =
one completion-gate evidence message; A1/A2 = adoption-gate ADOPT verdicts.
Related but distinct: futility stopping (`futility.ts`) curtails ARMS, decides
nothing about candidates; the task grader/scorer is the benchmark's own verifier,
not one of our gates.

**Active base:** `harness/system-v0.md` (`--system`) + `harness/seed-v0.md` (`--harness`)
**+ completion gate (`--complete-gate <artifact>`, adoption A2 2026-07-25)** —
context layer since adoption-1 (`4fc9d68`); mechanism layer since A2
(`adoption-2-gate-verdict.json`: R10 lift p=0.0031 + cdt 2/2 + chess 3/3
gate-ON holds). Every post-adoption PROSE candidate was rejected/abstained/
vetoed — the playbook's text hasn't grown since A1; the loop's second
adopted trait is a mechanism. **Standing open: held-out gate transfer
(overfit caveat) — gate designed from cancel-async forensics.**

## A2 — completion-gate adoption (2026-07-25, MacBook) — ADOPT

- **gate.ts combined verdict:** R10 lift (10/10 vs 3/10, p=0.0031) + guards
  gate-ON: count-dataset-tokens 2/2 valid (2 VM-clock-skew voids stripped +
  rerolled clean under the new preflight; valid pass a3 turns=2 — gate
  exercised and satisfied on a non-code artifact) + chess-best-move 3/3 all
  turns=1 (zero gate friction). One-variable guard pairs: [adopted base,
  gate-OFF] 3/3 baselines vs [adopted base, gate-ON] — delta = gate only.
- **Tax verdict: none measurable at k=3** — no spurious refusals, no wrong
  answers induced, time comparable (chess 198–345s).
- **Session infra shipped en route:** clock-skew preflight (`dc24972`,
  clock.ts — podman VM ~17h behind after mac sleep = TLS cert-not-yet-valid
  0-turn deaths, 2 trials lost then rerolled; subagent-built TDD);
  scheduler reservation layer + darwin reap fix earlier (`c493799`).
- **Meaning:** first mechanism-class trait through the full discipline —
  designed (R9) → falsified-in-part by forensics (R9F: nudge, not mechanism)
  → fixed → certified (R10) → guard-held → adopted. The actuator-escalation
  thesis (loop-2 TB2 → R5/R6 prose exhaustion → binding actuator) is now
  carried to adoption, entirely under gate-as-code.
- **NOT claimed:** transfer. The gate has never run on a task it wasn't
  designed from. Held-out arms (headless-terminal + build-free fresh pick,
  or staging-gap fix to unlock build-pmars/polyglot-rust-c) = next gate
  experiment before any generalization language.
- **ATTRIBUTION CORRECTION (user-caught, 2026-07-25):** the headline
  "3/10 → 10/10, p=0.0031" compares BARE vs the FULL STACK
  (system+seed+gate) — three components, not the gate alone. Honest
  decomposition, all same-host MacBook: bare 3/10 → adopted base 5/10
  (p=0.65, base's held-out contribution here uncertified) → adopted+gate
  10/10. **Gate's own increment = 5/10 → 10/10, Fisher p=0.0325 — still
  independently certified at α=0.05** (day skew 07-23 vs 07-24 noted). The
  A2 ADOPT stands on the gate-only comparison; the 0.0031 belongs to the
  stack-vs-bare claim, not to the gate.

## C2 — session-carryover arms (2026-07-25, MacBook) — NULL reward effect, contamination seen, marker arm SHORT

Hygiene measurement (spec: `docs/2026-07-25-gate-session-hygiene.md` §3), NOT an
adoption-gate verdict — gate.ts run in measurement mode, its REJECT line is
adoption semantics and does not apply.

- **Arms:** cancel-async (completion gate ON, active config) `--then`
  count-dataset-tokens, same session. Raw k=10 + marker k=10. No futility
  stopping (curtailment watches A's reward; C2's variable is B's).
- **B rewards (verdict variable):** B-alone baseline 3/3 (07-25 gate-ON cdt
  records, voids stripped) vs raw-B **10/10** (all turnsB=1, zero voids) vs
  marker-B **5/5 valid**. Fisher null both comparisons (p=1.0). Pre-registered
  "small-negative or null" **confirmed** — carryover does not damage B rewards
  at k=10.
- **Contamination (leading indicator):** vocabulary grep over B segments —
  raw 1/10 (a10: B read `/app/test.py`, task-A asyncio fixture, via filesystem
  channel; B still passed), marker 0/5. Detectable ✓; "marker halves it"
  directionally consistent but **underpowered** (1 event total).
- **Marker arm SHORT: 5/10 voided by OAuth revocation** mid-arm (a5/a7 B-side,
  a8–a10 both sides; `OAuth access token has been revoked` 401 then CC
  credentials-expired). Infra-noise class — standing rule: re-run, don't
  engineer. **TOP-UP RUN 07-26 (k=5, zero voids,
  `cancel-async-tasks-2026-07-26T00-49-22-598Z.json`): B 5/5 pass —
  marker-B pooled 10/10 valid, pre-registered k=10 reached, reward-null
  CONFIRMED. Vocab grep top-up: one hit = FALSE POSITIVE (`import asyncio`
  in a HuggingFace datasets stack trace, B's own tooling) — contamination
  stays raw 1/10 vs marker 0/10 valid.**
- **MARKER A-SIDE GUARD CHECK (the top-up's real question — plugin port
  ships marker default ON per hygiene doc §4):** pooled marker A 4/12 valid
  vs raw A 7/10, gate.ts Fisher **p=0.198 → null, not certified harmful —
  but direction depressed (33% vs 70%) and stayed depressed through the
  top-up (2/5).** All marker A fails = gate-accepted-grader-failed
  (false-accept class). By guard-less-forbidden discipline the port should
  ship **marker default OFF (opt-in via gate.json)** until daily sensor
  data certifies it harmless to the host task; hygiene benefit is anyway
  unmeasurable at bench scale (1 contamination event).
- **A-side flags (NOT verdict variable):** every A fail both arms =
  completion-gate ACCEPTED + grader failed (false-accept class, healthy
  rounds, no exhaustion). Raw A 7/10 vs R10's 10/10 same config — day drift
  or false-accept rate watch-item. Marker-valid A 2/7 — marker text touches
  A's session, possible A-side perturbation; underpowered, watch only.
- **Records:** `cancel-async-tasks-2026-07-25T10-17-29-752Z.json` (raw),
  `…T11-55-25-064Z.json` (marker); synthetic B-extractions job-local only.

## C1 — held-out completion-gate transfer arms (2026-07-25/26, MacBook) — HOLDS on rewards; grip SPLITS by artifact

Transfer measurement (A2's standing open), NOT an adoption verdict. Gate-ON
k=10 on two tasks the completion gate was never designed from, vs adopted-base
gate-OFF baselines. `--stop-futile 7/8` / `17/20` as playbook-prescribed was
REFUSED pre-spend by futility designCheck (even 10/10 can't certify lift vs
those baselines at k=10 — p=0.44/0.53): the pre-arm layer's first live
exercise caught an incoherent design, zero tokens spent. C1 is non-regression,
not lift — arms rerun without the flag. Mid-arm curtailment layer still
unexercised (needs a future lift-certifiable arm).

- **headless-terminal (CERTIFIED, same-host):** gate-ON 7/9 valid vs gate-OFF
  7/8 (07-23 T16-06), Fisher p=1.0 null — **non-regression holds.** But
  forensics: **7/9 valid trials EXHAUSTED the gate** (every round
  mutant-survived, never accepted; only a3/a8 accepted). Mutation probe does
  not grip `/app/headless_terminal.py` — grip-is-content-dependent, R9F-
  adjacent. Rewards unharmed (exhaustion doesn't block scoring) but **time
  tax severe: 1000–5000s/attempt vs baseline 110–180s.** Void: a7 0-turn
  (`Unexpected server error` after gate_reinject).
- **sparql-university (CERTIFIED, same-host after baseline top-up):** first
  attempt at certification was provenance-REFUSED by gate.ts — all adopted
  gate-OFF sparql baselines were office-box (`yoo-dev`), cand MacBook
  (loop-2 same-host rule, machine-enforced). Fresh MacBook gate-OFF baseline
  run 07-26: **10/10, all turns=1, 117–286s**
  (`sparql-university-2026-07-25T23-55-14-698Z.json`). Same-host verdict:
  gate-ON **8/9 valid vs 10/10, Fisher p=0.47 null — non-regression holds.**
  Gate shape HEALTHY: every valid trial = one mutant-survived fix round then
  accepted, zero exhaustion — probe grips `/app/solution.sparql`. Honest
  direction note: gate-ON lost one real trial (a4, gate-accepted-grader-
  failed = same false-accept class as C2) + ~2x time tax (340–1014s vs
  117–286s); a2 = 0-turn infra void.
- **Transfer picture:** the completion gate transfers as a no-harm mechanism
  (rewards hold both tasks) but its VALUE channel splits by artifact class:
  healthy verify-fix cycles on sparql, pure exhaustion tax on headless
  python-class artifact. Generalization language stays forbidden; next
  mechanism work should target probe grip (mutate.ts operators) before any
  claim.
- **Records:** `headless-terminal-2026-07-25T18-03-55-427Z.json`,
  `sparql-university-2026-07-25T20-54-25-477Z.json`.

## G1 — adequacy-probe grip-fix verification (2026-07-27, office `yoo-dev`) — MECHANISM PASS both tasks

C1's headless no-grip finding fixed same day it was queued
(`docs/2026-07-27-probe-grip-fix-design.md`, S1 coverage-guided sites via
`minimal/cover.ts` trace hook + S2 `__main__` exclusion + S3 ≥1-kill round
rule; commits `7db8081`..`3064893`). Pre-registered §6.1 BEFORE launch; arms
on OFFICE box (first office arms — no cross-host reward math, mechanism
claims only). Forensics clean (0 auth errors, 0 voids).

- **headless k=5: exhaustion 0/5 vs C1 7/9** (Fisher p≈0.02), accepted rounds
  killed 1–2/4, median 400s (C1 exhaustion class 1000–5000s). a1+a5 = first
  healthy verify-fix loops ever seen on this task; a1's reinject-driven
  rework passed the grader. Rewards 3/5 directional.
- **sparql k=3: 3/3 rewards, zero exhaustion, zero fix rounds** — each trial
  single accepted round killed 2/4. Honest shape note: old rule would have
  forced a fix round on the 2 survivors; ≥1-kill accepts immediately →
  strengthening pressure on the healthy class reduced by design (S3
  trade-off, calibration watch).
- **False-accept recurs** (headless a2+a5 accepted, grader failed) — fix
  directions researched + recorded in design note §5.1 (RTM spec-coverage
  probe, metamorphic-relation probes, §4.3 calibration-arm constraint).
- Coverage provenance field was dropped by the trial serializer (gap found
  in arm A, fixed `3064893`) — §6.1 criterion (b) formally unverifiable for
  these arms, recorded honestly.
- **Records:** `headless-terminal-2026-07-27T01-54-16-685Z.json`,
  `sparql-university-2026-07-27T03-01-09-245Z.json`.

## FA1 — false-accept probes: build + §6.3 arms (2026-07-27, office `yoo-dev` + MacBook) — CLOSED BY MATH: probe effect NULL + remaining arms futile

Attack on the false-accept class (every real fail across C2+C1+G1 =
completion-gate accepted, grader failed). Two new deterministic probe classes
added to the completion gate (plan
`docs/superpowers/plans/2026-07-27-false-accept-probes.md`, SDD 8 tasks +
final review + fix wave, commits `a61b08b..eb2ac11`, suites 1671+26 green):
**spec-coverage probe** (frozen per-task `requirements.json` from
instruction.md, RTM-style, matched against comment-stripped verify.sh;
`requirement-untested` outcome names the gap) and **relation probes**
(instruction-derived metamorphic/property scripts vs the artifact;
`relation-violated`). Desk-validated: all relations pass oracle solutions,
fail degraded artifacts (incl. the hardcoded-names sparql false-accept
class). Fail-open throughout; probes provenance in run headers.

- **§6.3 headless probes-ON k=10 (pooled office runs; auth-race voided 2,
  rule-covered top-up):** **10 valid = 9/10 reward, false-accepts 1/10
  (G1 reference 2/5), exhaustion 0/10 ✓, median 651s < 2x-G1 guard ✓.**
- **First live spec-probe save (top-up a2):** verify.sh covered ZERO
  requirements (wrapper-style watch-item, live) → two `requirement-untested`
  reinjects naming all 5 → agent rewrote verification → accepted with kill →
  grader PASS.
- **Residual false-accept (top-up a4):** probes passed (killed 3/4,
  coverage filtered), gate accepted, grader failed — the measured
  calibration point ("floor is not zero" as pre-registered).
- **§6.3 sparql k=5 probes-ON (2026-07-27 evening, MacBook — option-c
  single-arm shape check, NO cross-host math): 5/5 rewards, all turns=1,
  every trial round-0 gate-accept with kills (2–3/4), zero exhaustion,
  zero probe reinjects, zero false-accepts.** Wrapper-verify exhaustion
  watch-item did NOT fire; relation probes silent under load. Time
  208–487s (median 291s) vs same-host gate-OFF baseline 117–286s — mild
  ~1.2–2x tax, far below C1's 340–1014s. Provenance note: `coverage:
  "fallback-static"` all 5 — trace hook doesn't grip a .sparql artifact,
  static site fallback engaged as designed (first record where the
  serializer preserves the field on this task). Clock preflight corrected
  a −39190s VM skew at launch (Mac-sleep class, auto-recovered).
  S3 calibration watch stands: 3/5 trials accepted with survivors.
- **Headless control k=10 RUN 2026-07-27 evening on MACBOOK (user-directed
  over the same-host recommendation; provenance caveat standing):**
  `mh-control-headless-2026-07-27T09-31-48-897Z.json` — gate-ON, probes
  absent (header {requirements:0, relations:0} ✓ null). **9 valid = 8/9
  reward, false-accepts 1/9 (a2: accepted 2/4 kills, grader failed),
  exhaustion 0/9, all round-0 accepts, median 446s**; a1 = 0-turn SUSPECT
  void (3.81s, no-verify — infra class). Coverage `filtered` 8/9 (grip fix
  visibly tracing the python artifact), 1 fallback-static. **NO §6.3
  verdict math from this arm vs the OFFICE ON arm — cross-host, gate.ts
  class refusal. Paths to a verdict: MacBook probes-ON k=10 (completes
  option (b) same-host: ON vs this control) OR office control next office
  session (option (a) vs the office ON arm).** Honest directional read
  only: control false-accept 1/9 vs office ON 1/10 — both far below the
  G1 2/5 reference; suggests the grip fix (G1), not the FA probes, may
  carry most of the false-accept reduction on this task; underpowered +
  cross-host, hence the required same-host arm before any claim.
- **§6.3 CLOSED BY MATH (2026-07-27 late, user-directed "determine from
  the math"):** ON 1/10 vs control 1/9 Fisher p=1.0 (null, and equal rates
  are unrescuable by fixing host); rewards 9/10 vs 8/9 p=1.0 (no harm);
  G1's 2/5 reference NOT certified vs anything (vs ON p=0.24, vs pooled
  2/19 p=0.18 — likely k=5 noise around the same floor). **FUTILITY: a
  perfect same-host ON 0/10 vs control 1/9 gives p=0.47 (0/20 → 0.31);
  certification requires control ≥4/9 false-accepts vs the observed 1/9 —
  no feasible k certifies a probe effect against an ~11% base rate. Both
  remaining arms (b′ MacBook ON, a office control) refused as futile —
  designCheck-class catch, pre-spend.** VERDICT: probes = no measured
  false-accept reduction, no measured harm, real-but-rare qualitative
  saves (spec-probe a2); ship fail-open, claim nothing quantitative.
  **The ~10% false-accept residual (2/19 pooled) = the §4.3 calibration
  rate.** Grip fix remains the only certified mechanism change (G1
  exhaustion p≈0.02).
- **Records:** run-1 trajs `headless-terminal-2026-07-27T05-54-08-764Z-a*`
  + `...-run1-authrace.log` (6 valid, no results.json — killed run);
  top-up `headless-terminal-2026-07-27T06-53-49-506Z.json`; sparql
  `sparql-university-2026-07-27T08-55-31-719Z.json`.

## SM1 — gate-plugin live smoke-test (2026-07-27 night, MacBook) — PASS all criteria

The §4.1 queue item: first live exercise of the shipped opencode gate-plugin
on a REAL interactive session (scratch project, `gate.json`
`{"check":"test -f done.txt","rounds":2}`, opencode 1.17.20 TUI, ~$0.06).
Mechanism verification, zero bench trials, NOT an adoption verdict.

- **Sensor line (all fields correct, first live line ever):**
  `{check, accepted:true, gateExhausted:false, rounds:["verify-failed",
  "accepted"], interrupted:false, marker:false, durationMs:23195}` at
  `.meta-harness/gate-outcomes.ndjson` (pre-rename path; km- rename = CC
  plan node N).
- **The one test-faked assumption LIVE-VERIFIED:** `interrupted:false` on an
  uninterrupted run — the chat.message echo guard consumed the gate's own
  `client.session.prompt` self-inject exactly once; no false human-interrupt,
  no wedged composer (the failure class the assumption feared).
- **Reinject channel works end-to-end:** round-0 check fail → evidence
  injected → the agent diagnosed the failing check and created `done.txt`
  unprompted → round-1 accepted. A complete healthy verify-fix cycle in
  daily-use conditions, 23s.
- **Bonus (edit-tool set exactness, live):** the first prompt's file was
  created via bash `echo` — gate correctly did NOT arm (edited-set tracks
  write/edit/patch/multiedit only); second prompt forced the write tool →
  gate armed. Contract 4's live confirmation.
- **Meaning:** the daily deployment of the A2-adopted mechanism is now
  verified in situ — the §4.3 sensor stream's producer is trustworthy.
  Next: CC port (kkamak plugin, plan triple-architect-reviewed) → §4.3.

## SM2 — kkamak CC plugin v0.1: build + live smoke (2026-07-27/28, MacBook) — SHIPPED, all smoke criteria PASS

- **Built via 15-node parallel-DAG subagent waves** (plan
  `docs/superpowers/plans/2026-07-27-kkamak-cc-plugin-v0.1.md`, itself
  3-round architect-reviewed; branch feat/kkamak-cc → merge `6d443df`):
  frozen `types.ts` contract → 10 parallel Wave-2 nodes → Stop state
  machine → hook-cli adapter. Suites 120 (CC) + 26 (opencode) green, tsc
  clean. Wave reviews APPROVED; final whole-branch review found 2 blocking
  (.km gitignore; unconditional sweep littering ungated cwds) + post-kill
  pipe-hang → one fix wave → re-verified MERGE-READY.
- **Live smoke (3 headless CC sessions + 1 interactive tmux demo): the CC
  contract's one open uncertainty RESOLVED — `{"decision":"block","reason"}`
  evidence DOES reach the agent.** Self-describing check → agent received
  the block reason, fixed, rounds ["verify-failed","accepted"] in 4s;
  rounds bound exact (2 blocks → exhausted-allow, loud); marker via
  additionalContext ✓; no-edit turns silent ✓; bash-writes don't arm ✓;
  mkdir-recursive fresh-repo ✓; headless `-p` ✓. Shipped default stays
  block-json.
- **Naming shipped:** plugin name `kkamak` on every host; runtime prefix
  `.km/` (node N renamed the opencode sensor default in lockstep — both
  hosts write ONE app-tagged stream).
- **Dogfood begun 07-28:** `gate.json` committed at repo root (both plugin
  suites, ~4s, `659a712`); `~/z2/km-play` playground; README gains the
  "what kkamak can and cannot touch" trust section (`078d6dd`).
- **First interactive-dogfood finding (07-28 demo):** after a block, the
  agent re-ran the check itself via Bash → permission prompt stalled the
  fix loop (gate correct throughout; durationMs 282s inflated by human
  wait). Candidate mechanism delta: reinject wording "fix it; do not
  re-run the check — the gate re-checks automatically". **First
  §4.4-class candidate produced by daily usage.**

## GA1 — km-gauge shadow PoC + scorecard + reinject experiment (2026-07-28/29, office `yoo-dev`) — SHIPPED; v1 repaired `322f2c1`

Office day builds on the kkamak sensor stream (all mechanism-class, no
adoption verdicts). Pre-registrations written before data throughout.

- **km-gauge PoC (955fbec + guard f3be80d):** per-task derived acceptance
  checks, SHADOW ONLY. Task-shaped classifier (deterministic) → detached
  haiku refiner → pending file → next-Stop shadow eval → `gauge` field on
  the sensor line. Live smoke (4 real haiku calls): derivation quality 3/3
  excellent, latency 10.7–40.9s → one-shot headless = M0 miss; interactive
  next-turn consume works. Read-only guard: model-generated checks refused
  unrun unless plainly read-only (`gauge.refused`); all 4 live checks pass
  it. M0–M3 window OPEN (gate.json `gauge:true`, both repos; ≥30 task-shaped
  prompts then verdict). Install trap found+fixed (10e14c6): plugin install
  COPIES the dir — escaping `../../minimal/` imports died silently
  (fail-open = inert gate, zero data); `vendor/` byte-identical copies +
  drift-guard + INSTALL-SHAPE test.
- **kkamak scorecard (9ca8ad5):** sensor stream → M-catch / M-exhaust /
  M-interrupt / M-tax per (check,host); rates suppressed <20 cycles;
  kkamak-dev never pools with real work. Claimable without counterfactual:
  M-exhaust/M-interrupt fall at non-decreasing M-catch. M-catch alone =
  §4.3's problem.
- **§4.4 experiment #1 (fc7fa38):** SM2's stall root-caused to the kernel
  reinject text "…and re-run it." (correct where agent owns verify.sh;
  ownership inverted under kkamak). v0 kernel wording vs v1; arm =
  FNV-1a(sessionID), recorded per sensor line; within-workload
  randomisation so both arms share workload drift.
- **CORRECTION (user-caught):** v1 as shipped SELF-CONTRADICTS (appends
  "do not run it yourself" after "and re-run it") — my own test enshrined
  the append. Evidence honesty: stall = n=1 (artifact lost); "your script"
  falsity + gate-gaming invite = zero observations, hypothesis only. Audit
  659a712..HEAD: zero check/test weakening (+430 assertions) but ~1 block
  opportunity = no power. Plan: repair v1 (REPLACE next-action sentence),
  v0 byte-identical, run the pre-registered A/B. ~~v1 repair NOT DONE~~
  **DONE `322f2c1` (07-29): composed at the IO seam** — round.ts tees the
  raw check output, v1 built fresh (never reads kernel prose; collision
  edge-cases structurally gone), rawOut outcome-gated to verify-failed,
  fail-open without it; 2x adversarial architect plan review; §4b
  re-registered pre-data (zero v1-tagged block rows existed); live-proven
  both arms through the real hook binary.
  Process lesson memorised: no reason-drift without new observations.
- **Rename (872cef8):** runtime store `.meta-harness/`→`.kkamak/`,
  `~/.config/meta-harness`→`~/.config/kkamak`, KKAMAK_HOME; auto-migrating
  both roots with back-compat symlinks; repo dir/remote unchanged.
- **Escape hatch (5fe9ef4):** `scripts/km-panic.sh
  {status|gauge-off|off|restore|nuke}` — gate.json re-read every hook call
  (locked invariant), so all actions land next turn, no restart.
  KKAMAK_GAUGE=off is launch-time only, cannot stop a live session.

## GA2 — §4.3 pre-reg + gauge M0–M3 verdict + v2 extractor pre-reg (2026-07-29, office `yoo-dev`) — REGISTERED ×2, ONE LOCKED FAIL

Registration + measurement day; zero adoption verdicts, zero bench trials.

- **§4.3 trial-mode pre-registration REGISTERED**
  (`docs/superpowers/specs/2026-07-29-trial-mode-gate-outcomes-preregistration.md`,
  `fdd0055..59c4924`): SDD execution of a plan hardened by 3 adversarial
  architect-review iterations (24 findings: golden-window auto-start
  contradiction, crank single-target trial starvation, exposure
  dedupe/boundary leak, null-metric coercion, all resolved). Core:
  playbook-class v0; within-workload salted arms (unsalted = collinear with
  live reinject arms — caught in review); three-floor verdict (MIN_N=20
  gateCycles + ≥5 sessions/arm + E_MIN=5 block events); KEEP = "not
  measurably worse", never "better" (null-adopt ≈60% documented); auto
  keep/rollback with human-go start; golden-baseline anti-ratchet every 3
  KEEPs; A/A machinery falsification test before any real trial; activation
  precondition trailing-14d ≥10 real-work cycles/day. Satellites: scorecard
  §5 sole-adopter sentence scoped inline (three adopter domains),
  explicitly-not-now §7.7 (11 deferrals + reopen triggers), resume, INDEX.
- **Live tmux smoke (1 haiku session):** sensor line exact (durationMs
  4952, check string, host/app), reinject arm matches recomputed
  FNV-1a → **first v0-arm cycle ever** (arms were v1:19/v0:0); gauge full
  loop consumed SAME-line (23.5s refiner beat the Stop thanks to the
  permission wait).
- **Gauge M0–M3 window CLOSED (36 task-shaped prompts, user labels):**
  M0 91.7% PASS, M1 63.6% PASS (all 12 misses = honest `check:null`
  abstentions), **M2 FAIL — 9/10 would-blocks judged WRONG** (bar ≤20%),
  M3 PASS (the 1 RIGHT catch found the §4.3 spec's DRAFT status + stale
  anchors BEFORE the final whole-branch review flagged the same two
  must-fixes; fast-path floor-accept user-ruled counting). Per locked rule:
  **shadow indefinitely, no blocking pilot** (`a18b73d`). Root-cause
  analysis (user-forced, symptom framing rejected): three gaps — world
  (never sees repo), semantics ("done" = workflow outcome, not worktree
  predicate), timing (multi-turn graded mid-flight) — refiner INVENTS
  beyond its information bound; success signature = it was right exactly
  when it could EXTRACT (prompt contained path + property).
- **Shadow invariant test-locked (`af0a132`):** would-block gauge + passing
  floor through the real hook binary → exit 0, no block payload; 241 CC
  tests.
- **km-gauge v2 extractor pre-reg REGISTERED (fix-or-drop, user-directed;
  `63c94f2` + amendment `61f8d78`):** prompt classes A1/A2/B/C/D
  (user-ratified: no-eval-needed / not-shell-checkable / floor-covered /
  extractable-in-repo / not-extractable-or-out-of-scope; 5 classes,
  3 behaviors, 1 parameterized slot); extraction enforced DETERMINISTICALLY
  in code (path-in-prompt, repo-scope, B-keyword screen, downgrade
  records) — model never trusted with the information bound it violated;
  two-strike multi-turn eval; M1 redefined to class-C executable precision
  ≥90% (class-C rate reported, no bar); M5 A2-share sizes the future
  reply-quality judge-shadow case; fresh window post-deploy, v1 data
  discarded; **locked: a second M2 fail kills per-task derivation
  permanently.** Deploy trap pre-registered: installed-cache refresh
  mandatory or the window silently measures stale v1.

## GA3 — km-gauge v2 extractor: BUILD + DEPLOY + WINDOW OPEN + LIVE MEASURE (2026-07-29 late, office `yoo-dev`)

Implements the v2 extractor pre-registration (fix-or-drop). SDD: 3 tasks +
per-task reviews + final whole-branch review + one fix wave; commits
`a3638cb..ecf42f6`; 332 CC tests + 26 opencode, tsc clean.

- **Build:** types (GaugePromptClass/GaugeHorizon, sensor field ext) →
  refiner v2 (classify A1/A2/B/C/D + extract-only prompt, shape-only parse)
  → NEW validate.ts (the deterministic enforcement: path-in-prompt with
  word-boundary rule, repo-scope via path.resolve, cd-stripped B-screen with
  scoped-subset exception, no-path-reference vacuous-C rule, unconditional
  final check-nulling) → spawn req carries floorCheck → refiner-cli
  validates BEFORE persisting (pending file = already-validated artifact) →
  evaluate presence-conditional passthrough (v1 BASE literal untouched =
  acceptance proof) → shadow two-strike (floor-gated advancement; gauge-only
  Stops skip evaluation of open multi-turn-C entirely) → score re-scoped to
  class-carrying lines (class presence = v2-window filter) + byClass render.
- **Reviews earned their keep:** T1 reviewer's adversarial probing found 2
  real extraction holes BEYOND the 28-case matrix (bare `cd <dir>` target
  credited as B2'-scoping token; unbounded substring match — `a.ts` inside
  "thisisnota.tsfile") — both fixed + re-reviewed. T2 reviewer traced every
  persist path: no route for an unvalidated check to reach disk. T3 reviewer
  byte-diffed the af0a132 shadow-invariant lock test (untouched) and traced
  the two-strike table row-by-row. **Final review caught spec-code
  divergence PRE-deploy** (floor-gated two-strike, `strike` field,
  per-derivation M1v2/M5, class-presence filter — all sound engineering the
  registered text didn't describe) → pre-data amendment landed BEFORE the
  window opened; re-registration ceremony avoided.
- **Deploy (window cut):** cache refreshed; **verify-gotcha live: stale
  0.1.0 cache dir coexisted with 0.2.0 — `claude plugin list` is the
  authority, never cache-path picking** (stale dir removed; deleting a
  RUNNING session's plugin root kills its hooks fail-open — refresh between
  sessions only). Deploy commit + timestamp recorded in pre-reg §4
  (`1f4c0f6`); WINDOW OPEN (office; MacBook joins at its own refresh).
- **Live measure (reinstall + km-play 3-prompt haiku session):** A2
  (`not-shell-checkable`) and B (`floor-covered`) MODEL-CLASSIFIED exact,
  check null, no downgrade needed; C-attempt → haiku's `$()`-style check →
  D `no-path-reference` downgrade with full audit record (fromCheck
  preserved, check nulled — step-8 invariant live). **Second consecutive
  `$()` specimen: class-C 0/4 real derivations — starvation trend; the ≥5-C
  validity floor is the tripwire; the one permitted redesign round's lever =
  refiner-prompt nudge toward `grep -qxF 'line' file` style.** Scorecard
  byClass renders (`A1 0 · A2 1 · B 1 · C 0 · D 1 · downgraded 1`); v1-era
  lines correctly excluded. **Orphan mechanism observed live:** the A2
  pending was stranded by highest-n supersede (P3's derivation landed before
  the Stop that would have consumed P2's) — registered limitation; rapid
  prompting amplifies it, eats M5 data points. Daily cap fence verified
  (meta-harness 30/30 blocked spawns; fence, not bug).

## GA4 — §4.3 trial-mode prerequisite build TM1–TM8 (2026-07-29, office `yoo-dev` + MacBook) — BUILT + SEALED

- **What:** all ten §11 prerequisite items of the registered §4.3 spec
  (`docs/superpowers/specs/2026-07-29-trial-mode-gate-outcomes-preregistration.md`),
  plan `docs/superpowers/plans/2026-07-29-trial-mode-build.md`, SDD 8 tasks +
  per-task reviews + final whole-branch review + fix wave. Range
  `fc03f95..61e5c6b`. Suites at seal: opencode-plugin 1740/1 · cc-gate-plugin
  352 · km-crank 173 · gate-plugin 26 (baselines 1672/332/70/26).
- **Shipped:** TM1 SensorLine `forced`/`pluginVersion`; TM2 salted arm module +
  exposure log `.km/trial-arms.ndjson`; TM3 arm-aware compose (CC-only arms);
  TM4 `rewardMode` + stand-down + `resolveGateTrial` authority; TM5 calibration
  registry + path-scoped computed staleness; TM6 trial-verdict engine (§2
  exclusion matrix, three-floor §5 rule, 21-row truth table, A/A KEEP-by-tie,
  futility projection) + crank wiring before decideGate w/ all-REPOS scan +
  trial SitrepActions; TM7 scorecard §4.3 block (per-arm N_eff triplet, density,
  forced-rows, scoped to latest trialId); TM8 `km-sensors-sync.sh`
  (append-only union, refuse-on-shrink — reviewer reproduced safety on own
  fixture), `km-panic.sh trial-off`, SITREP snapshot-age from max sensor ts.
- **THREE PRE-DATA AMENDMENTS, all evidence-forced, sealed before any verdict
  existed:** `fc252c2` salt `%2` → `(fnv1a>>>16)&1` (bit-0 proven
  parity-linear with reinject axis); `bcbfdb3` 2/19 calibration rate =
  LOWER-BOUND PROXY (measured arms ran mutation probe, shipped daily gate is
  verify-only); `54238eb` calibration-stale refusal bounded by T_MAX → then
  abandon `"calibration-stale"` (unbounded refusal defeated §5 slot bound) +
  explicit abandon RESTORES BASELINE (clear-only abandon silently adopted the
  unvalidated candidate — false-keep-shaped, reviewer-caught).
- **Final review (whole branch, 4 Important all closed):** plan salt pin
  annotated; false sensor-side KKAMAK_TRIAL_ARM comments corrected (exposure
  record = sole authority per §2); **§7 two-host union WIRED INTO VERDICT
  INPUT** (`sensor-union.ts`, full-raw-line dedupe, snapshot rows subject to
  the same §2 exclusions by provenance erasure); **golden-window machinery
  ruled unbuilt → `runTrialScan` refuses `golden:true`, registered deferral
  `explicitly-not-now.md` §7.8** (latent §5 violation at T_MAX otherwise).
  Panic trial-off re-ruled abandon (spec §5 "manual command supersedes"),
  state-identical to rollback post-54238eb, ledger-semantics fix.
- **Not built (registered):** auto trial-start (human-go stays), golden-window
  rules (§7.8), cadence mechanization for calibration refresh, SPRT,
  cross-host auto-sync, opencode-session arms.
- **Next:** activation precondition still gates everything — trailing-14d
  real-work ≥10 cycles/day (stream near-empty). A/A machinery trial is the
  registered first live use.

## GA5 — first real-work dogfood + same-day instrument fix wave 0.2.1 (2026-07-30, office `yoo-dev`) — LOOP CLOSED LIVE

- **New repo `~/z2/kkamak` (github.com/th-yoo/kkamak, MIT):** fresh dogfood
  project — reimplementing kkamak as a harness-abstract plugin (pure kernel +
  adapter contract for CC AND opencode), gated by the INSTALLED kkamak from
  turn 1. (First push mistake — full meta-harness history copied over — caught
  by user, reverted `1a6b337`, repo deleted+recreated; fresh-start intent =
  "rename would have been the move".) `/kkamak:init` Step-4 no-test-command
  branch live-tested; **first-ever cycle = block→fix: the gate forced the
  scaffold into existence** (`bun test` unsatisfiable until the agent created
  it). **First real-work sensor stream in project history** (check ≠
  kkamak-dev group; ~10 cycles day 1 = activation-precondition rate, day 1/14).
- **Reimplementation state (Opus 5, SDD from adapters on):** kernel merged —
  pure state machine, zero non-relative imports, 3 events in / 2 decisions
  out, 165 tests; its review found 1 real fail-open bug (unpersistable block
  → stale round → unbounded blocking; fixed as invariant "never issue a block
  that cannot be recorded", mutation-tested). Session independently
  re-derived the opencode no-blocking-stop-hook asymmetry + self-prompt trap
  from source. Adapters plan executing (2 plan-conflict rulings by driver:
  byte-true evidence cap; import-closure install test); final review pending
  at day end (529 Overloaded hiccup, resumed).
- **Dogfood surfaced 3 instrument gaps → FIXED + DEPLOYED SAME DAY (0.2.1,
  range `72da841..a00519e` + `e1b1115`,`feb94e6`):** plan hardened by 3
  adversarial architect rounds (21 findings), SDD 4 tasks + 5 fix rounds,
  final whole-branch review READY-TO-PUSH (0 Critical/Important):
  1. **`skippedStop` sensor class** — queued prompt eats the Stop boundary
     (8-commit kernel build recorded ZERO cycles). Emitted at
     UserPromptSubmit on `edited && !gating`; classified BEFORE gauge-only;
     excluded from ALL metrics AND §4.3 density (**4th pre-data amendment**
     — own rationale: gate WAS armed, and per-queued-prompt multiplicity
     would false-void trials via the density guard); scan volume-contest
     discounts it; host stays visible in SITREP coverage.
  2. **`checkMs` per-round timing** — durationMs inflates with
     subagent/human wait. Array parallel to rounds; `isInitialState`
     hardened; M-check beside M-tax (pools clean+catch+exhausted,
     documented deliberate).
  3. **`init-cli.ts`** — token-free gate.json writer (13 tests).
  Plus 0.2.1 + **version-parity test** (GA4 lapse class closed) and
  calibration `coveredMechanismRev` advances (TM1-precedent telemetry-only
  class, noted pre-data). Suites 385 · 183 · 26 · 1741.
- **Deployed via `km-refresh.sh` (guard exercised live: refused on live
  claude, `--force` per plan; driving session SURVIVED the refresh — hooks
  re-exec per call). Same-day live validation of every fix:** 7+ skippedStop
  lines captured in the adapters run (the class that hid the kernel build);
  `checkMs [884,882]` inside a 34,877ms blocked cycle = wait-vs-check
  separation proven; scorecard digests mixed 0.2.0/0.2.1 lines; gauge v2
  live in dogfood (A1/A2/B/D, 0 refusals). Multiplicity prediction
  vindicated: 7 markers vs 10 cycles under subagent-driven work — density
  inclusion would have voided trials.
- **Wiring:** `~/z2/kkamak` added to km-crank REPOS + km-sensors-sync;
  snapshot carries the first 42 kkamak-repo lines. Proposer loop unblocked
  (supervised rounds need go; A/A trial earliest ~Aug 12-13 if rate holds).
- **Registered honesty:** improvement claim still OPEN — M-catch alone not
  claimable; gate-aware turn-holding observed (agent held a red tree open to
  avoid a block) = M-catch suppression invisible to the stream, the §4.3
  counterfactual argument made flesh. Main historical improvement channel =
  playbook bullets (A1/A2, bench-certified); §4.3 v0 = playbook-class
  trials scored by gate-outcome deltas precisely because real work has no
  grader; ~10% false-accept = the quantified blind spot; bench stays the
  sharp instrument.
- **Late-day (same session): adapters SEALED + first crank round + leak-rule
  amendment.** (1) Harness adapters MERGED + PUSHED in the kkamak repo (260
  tests; final review 3 Important all fixed pre-merge; both dogfood lessons
  implemented in the NEW kernel; import-closure packaging test). (2)
  **Pre-crank BASELINE sealed** (kkamak `docs/dogfood-log.md` top block +
  snapshot `ed95d71` + memory): 25 cycles / 5 catch all round-1 / 13
  skippedStop / checkMs median 898ms — descriptive anchor ONLY, never a
  control arm. (3) **km-crank round 1 vs kkamak evidence** (go received):
  proposer bullet → review gate REJECTED ("leak: path-like") → ledgered; no
  candidate, no trial — third lifetime rejection, machinery E2E on real
  dogfood data. Rejection trigger = false positive (prose slash in
  "filters/qualifies") → **leak rule amended** (`19196e2..605a407`): prose
  word/word passes; anchored/multi-segment/extension/non-word/PATH_WORDS
  still caught. The amendment itself went review → re-review → ruling: the
  controller's unsubstantiated "layer 2 catches it" claim was CAUGHT (layer
  2 has no leak check — now documented as layer 1 being the only leak
  guard), and three residual classes ruled + test-locked. Office Slack
  SITREP transport gap found, deprioritized by user.

## GA6 — Phase 1 check-output sidecar + proposer excerpt rendering (2026-07-30, MacBook) — BUILT + SEALED

- **What:** roadmap Phase 1 (`docs/2026-07-30-enhancement-roadmap.md`): the
  block branch discarded the failing check output after delivering it to the
  agent — proposer evidence was counts-plus-log only. Now:
  `cc-gate-plugin/src/sidecar.ts` appends `(sessionID, ts, round)`-keyed,
  8192-char-capped (head 2048 + tail 6144) excerpts to host-local
  `.km/check-output.ndjson` at the hook-cli seam (F1-safe by construction);
  `km-crank` joins them to notable sessions and renders ≤2 excerpts/session
  (head 300 + tail 900 render trim) in the proposer evidence markdown.
- **Governance:** NO 5th pre-data amendment needed — gate-outcomes stream
  untouched; sidecar registered evidence-only (spec
  `docs/superpowers/specs/2026-07-30-phase1-check-output-sidecar-design.md`).
  F2 guarded by FILES-list tripwire test; F1 verified `git log` empty over
  MECHANISM_PATHS for the whole phase.
- **Process:** SDD 4 tasks (`8fce9ae..4c0c06c`), per-task reviews all
  Approved zero Critical/Important; final whole-branch review (fable) found
  1 MUST-FIX (vacuous byte-identity test) + 1 Important cross-task drift
  (emitter preserves head for compile errors, renderer trimmed tail-only —
  the exact class task-scoped reviews cannot see) → ruled render split
  head 300/tail 900, fixed `4c0c06c`, re-verified READY TO CLOSE: YES.
  Reviewer also traced: excerpt-at-rest containment (all gitignored/
  host-local), write-path crossing impossible, downstream proposer parse
  index-only (tilde fences safe), torn-append worst case = 2 lost records.
- **Suites:** cc-gate-plugin 394 · km-crank 196. Live smoke: scratch-repo
  blocked round wrote exact record. **Deployed (go received) 2026-07-31
  MacBook:** `km-refresh.sh --force` OK, cache grep-verified (`sidecar.ts`
  shipped, `appendCheckOutput` ×2 in cached hook-cli, only `0.2.1/` — no
  stale-dir recurrence), smoke against INSTALLED copy wrote exact record;
  live tmux `kkamak` session picks it up per-call (hooks re-exec). Office
  host still pre-sidecar — refresh next office session.

| # | Date | Candidate | Arms (sparql k=10 unless noted) | p | Guards | Verdict |
|---|---|---|---|---|---|---|
| R1 | 2026-07-23 | machine bullet (script-verify) on bare | bare 4/10 vs 5/10 | 1.0 | — | REJECT null |
| SG | 2026-07-23 | system-v0 + seed-v0 vs bare | 6/20 vs 17/20 (pooled) | 0.00106 | deferred | certified, not adopted (zero guards) |
| A1 | 2026-07-23 | system-v0 + seed-v0 (guard arms) | (lift from SG) | 0.00106 | cdt 3/3, chess 3/3 | **ADOPT** — first in project history |
| HO | 2026-07-23 | adopted base, held-out tasks | cancel-async 3/10→5/10; headless 7/11→7/8 | 0.65 / 0.34 | re-held | directional, uncertified (context only) |
| R2 | 2026-07-24 | scope-leak bullet ON adopted base | 9/10 vs 10/10 | 1.0 | cdt 3/3, chess 3/3 | REJECT null |
| HO2 | 2026-07-24 | adopted base, cancel-async office pair | bare 2/10 vs adopted 6/10 (k=10) | 0.17 | — | directional, uncertified |
| R3 | 2026-07-24 | signal-verification bullet ON adopted base | cancel-async 6/10 vs 3/10 | 0.37 | cdt 3/3, chess 3/3, sparql-info 3/3 | REJECT null (negative direction) |
| R4 | 2026-07-24 | asyncio-cancellation bullet (iteration 1) | killed at ~6 attempts (4/4 pre-kill) | — | — | REJECT scope-veto, never gated (rule 3b born here) |
| R5 | 2026-07-24 | iteration 2 rerun (rule 3b + Reviewer live) | no arms — proposer ABSTAINED | — | — | **ABSTAIN: prose-bullet actuator exhausted on this residual** |
| R6 | 2026-07-24 | iteration-0 rerun, agent-translated vocabulary | no arms — Reviewer caught R3-duplicate, reviser conceded | — | — | ABSTAIN via review loop — **Reviewer seat's first live catch** |
| R7 | 2026-07-24 | R3 bullet in SYSTEM slot (placement) | killed at 8/10: 3/8 vs 6/10 base | — | — | channel hypothesis REFUTED (rule harmful in both channels) |
| R8 | 2026-07-24 | scenario-coverage bullet (from R7 trajs) | arm aborted by design judgment | — | — | staged, NOT gated — prose channel dead; escalate to binding actuator |
| R9 | 2026-07-24 | completion gate + adequacy probe (MECHANISM) | killed 5/10 by host shutdown: 4/5, all turns=3 | — | never ran | partial-directional; superseded by R9F+R10 |
| R9F | 2026-07-24 | (forensics, zero trials, MacBook) | office a1–a5 traj read | — | — | **GATE BUG root-caused: docstring mutant unkillable — every attempt exhausted both rounds; 4/5 was nudge-text effect, not mechanism. mutate.ts fixed (codeLineSet)** |
| R10 | 2026-07-24 | FIXED completion gate (cancel-async k=10, MacBook) | bare 3/10 vs gate 10/10 | **0.0031** | gate-ON guards PENDING | **lift-certified — first perfect arm on this task; adoption blocked on gate-ON guards + held-out** |
| **A2** | 2026-07-25 | completion gate ADOPTION (gate-ON guards) | (lift from R10) | 0.0031 | cdt 2/2 valid (2 skew-voids rerolled), chess 3/3 all turns=1 | **ADOPT — first MECHANISM-class adoption; gate joins active config; held-out transfer = standing open** |
| C2 | 2026-07-25 | session-carryover hygiene arms (cancel-async `--then` cdt, MacBook) | B: alone 3/3 vs raw 10/10 vs marker 5/5-valid | 1.0 | — (measurement) | **NULL reward effect (pre-registered ✓); contamination 1/10 raw vs 0/10 marker-valid (top-up 07-26 closed the arm); marker A-side depressed 4/12 vs 7/10 p=0.198 null — port recommendation: marker default OFF** |
| C1 | 2026-07-25/26 | held-out completion-gate transfer (headless + sparql gate-ON k=10, MacBook) | headless 7/9 vs 7/8 OFF; sparql 8/9 vs 10/10 OFF (same-host baseline rerun) | 1.0 / 0.47 | — (measurement) | **BOTH HOLD certified (null): headless 7/9 gate-EXHAUSTED (no grip, 6–30x time tax); sparql healthy gate shape, ~2x tax, 1 false-accept fail; designCheck killed --stop-futile pre-spend (correct); provenance refusal forced same-host baseline** |
| G1 | 2026-07-27 | adequacy-probe grip fix S1+S2+S3 (headless k=5 + sparql k=3, office) | headless exhaustion 0/5 vs C1 7/9; sparql 3/3 zero exhaustion | ≈0.02 (exhaustion) | — (mechanism) | **PASS pre-registered both arms: coverage-guided sites + ≥1-kill rule end headless exhaustion (median 400s vs 1000–5000s); first healthy verify-fix loops on headless; false-accept recurs (a2+a5) → §5.1 fix directions; serializer coverage-field gap found+fixed** |
| FA1 | 2026-07-27 | false-accept probes (spec-coverage + relations) — headless probes-ON k=10, office | pooled 9/10 reward, false-accept 1/10 vs G1 2/5, exhaustion 0/10 | — (control pending) | — (measurement) | **ON-ARM SEALED, verdict pending same-host control k=10: first live spec-probe save (a2: 0-coverage verify → named reinjects → rewrite → pass); residual false-accept a4 = calibration point; 2 auth-race voids rule-covered by top-up; sparql k=5 shape check (MacBook) 5/5 all round-0 accepts, zero exhaustion/false-accepts, ~1.2–2x tax. §6.3 CLOSED BY MATH 07-27 late: ON 1/10 vs control 1/9 p=1.0 null, remaining arms futile (cert needs control ≥4/9, observed 1/9) — probes ship fail-open with no quantitative claim; ~10% residual = §4.3 calibration rate** |
| SM1 | 2026-07-27 | gate-plugin live smoke-test (real opencode session, MacBook) | 1 live session, scratch repo, rounds ["verify-failed","accepted"] | — | — (mechanism) | **PASS all §4.1 criteria: sensor line correct, interrupted:false (echo-guard assumption live-verified), reinject evidence reached the agent → fixed check unprompted; bash-edit correctly did not arm the gate; daily sensor producer trustworthy → §4.3 unblocked** |
| CR1 | 2026-07-28 | km-crank v0.1 — scheduled half-automatic evolution crank (2.2a, MacBook) | 2 live rounds: accidental empty-evidence + supervised real-evidence (km-play, 4 lines) | — | — (mechanism) | **SHIPPED + E2E both paths: empty-evidence round → proposer junk → REVIEW GATE REJECTED (no candidate/trial, ledgered, SITREP) — the reviewer-loop thesis live; gate bug found+fixed (first-run age hole: zero evidence never runs, not even --force, +regression tests); real-evidence round → candidate v1 staged + trial started on km-play + Slack SITREP; launchd daily 10:00 installed; WATCH: legacy-mode proposals bypass review gate (playbook-adds only)** |
| SM2 | 2026-07-27 | kkamak CC plugin v0.1 BUILT + live smoke (2.1b, MacBook night) | 15-node parallel DAG, 3 live headless CC sessions | — | — (mechanism) | **SHIPPED + SMOKE PASS (merge 6d443df): 120+26 tests green; CC block-json evidence delivery VERIFIED live (self-describing check → agent fixed → rounds ["verify-failed","accepted"] in 4s); rounds bound exact (2 blocks → exhausted); marker + no-edit-silence + mkdir-recursive + headless -p all ✓; both hosts now write one .km/ sensor stream — §4.3 gets a two-host union producer** |
| GA1 | 2026-07-28/29 | km-gauge shadow PoC + scorecard + §4.4 reinject A/B (office) | 4 live haiku derivations; 240 tests; audit 659a712..HEAD | — | — (mechanism) | **SHIPPED: gauge M0–M3 window open (shadow-only, read-only guard); scorecard defines improvement (M-exhaust/M-interrupt fall at non-decreasing M-catch; MIN_N=20 locked = display floor, not certification); reinject v0/v1 within-workload randomised — v1 append self-contradiction user-caught, REPAIRED `322f2c1` (composed at IO seam, 2x adversarial plan review, §4b re-registered pre-data, live-proven both arms); audit found zero gate-gaming (no power, ~1 opportunity); plugin-install copy trap fixed (vendor/ + install-shape test); store renamed .kkamak/ auto-migrating. A/B LIVE + clean; bottleneck = block EVENTS, not instruments** |
| GA2 | 2026-07-29 | §4.3 trial-mode pre-reg + gauge M0–M3 verdict + km-gauge v2 extractor pre-reg (office) | 36-prompt gauge window (user-labeled 10 would-blocks); 1 live tmux smoke session; zero bench trials | — | — (registration + measurement) | **§4.3 REGISTERED (`fdd0055..59c4924`, SDD + 3 review iterations, 24 findings resolved; playbook v0, salted arms, three-floor verdict, auto keep/rollback + human-go, golden every 3 KEEPs, A/A first, activation ≥10 cycles/day). Gauge M0 91.7% ✓ M1 63.6% ✓ M3 ✓ (caught the spec's DRAFT defect pre-final-review) but M2 FAIL 9/10 false-block → SHADOW INDEFINITELY per locked rule; root cause = invention beyond information bound. Fix-or-drop → v2 EXTRACTOR REGISTERED (`63c94f2`+`61f8d78`: A1/A2/B/C/D classes, code-enforced extraction, two-strike eval, M5 A2-share; second M2 fail = derivation killed). Shadow invariant test-locked `af0a132`; first v0 reinject cycle (arms v0:1/v1:19)** |
| GA3 | 2026-07-29 | km-gauge v2 extractor BUILD + DEPLOY + LIVE MEASURE (office) | SDD 3 tasks + reviews + final review + fix wave; 1 reinstall + km-play 3-prompt haiku session; zero bench trials | — | — (mechanism + measurement) | **BUILT (`a3638cb..1cad4ba`, 332 tests; T1 review caught cd-target + substring-boundary extraction holes; final review caught spec-code divergence → pre-data amendment BEFORE deploy). DEPLOYED 0.2.0, WINDOW OPEN (`1f4c0f6`; stale-cache-dir gotcha: `claude plugin list` = authority). LIVE MEASURE: A2 + B model-classified exact; C→D $()-downgrade with audit ×2 (class-C 0/4 = starvation trend, ≥5-C floor watches); byClass renders, v1 lines excluded; orphan mechanism observed live (A2 stranded by highest-n supersede); cap fence verified** |
| GA4 | 2026-07-29 | §4.3 prerequisite build TM1–TM8 (office + MacBook) | SDD 8 tasks + per-task reviews + final whole-branch review + fix waves; zero bench trials | — | — (mechanism) | **BUILT + SEALED (`fc03f95..61e5c6b`; suites 1740/1 · 352 · 173 · 26). THREE pre-data amendments, all evidence-forced pre-verdict: `fc252c2` salt bit-16 (bit-0 parity-linear w/ reinject), `bcbfdb3` calibration 2/19 = lower-bound proxy, `54238eb` stale-refusal bounded by T_MAX → abandon + abandon-restores-baseline (clear-only abandon silently adopted candidate). Final review closed 4 Important: §7 union WIRED into verdict input (`sensor-union.ts`), golden trials REFUSED + §7.8 deferral, false sensor-side forced comments fixed, panic trial-off re-ruled abandon per §5. Human-go start preserved; activation precondition (≥10 real-work cycles/day trailing-14d) still gates first trial; A/A machinery trial = registered first live use** |
| GA5 | 2026-07-30 | First real-work dogfood (`~/z2/kkamak` reimplementation) + same-day 0.2.1 instrument fix wave (office) | live dogfood session (Opus 5) + SDD fix wave (4 tasks, 5 fix rounds, 3-round plan review); zero bench trials | — | — (mechanism + measurement) | **LOOP CLOSED LIVE: dogfood found 3 instrument gaps at breakfast (queued-prompt cycle loss — 8-commit build invisible; durationMs wait-inflation 420s/~1s; no token-free init), fixes shipped+deployed by lunch (0.2.1: skippedStop class w/ 4th pre-data amendment metrics+density-excluded, checkMs, init-cli, version-parity test), fixed instrument measured its own fix by afternoon (7 skippedStop captured; checkMs [884,882] in 34.9s cycle). First real-work sensor stream ever — day 1 at activation rate; first cycle = gate FORCED scaffold into existence. Reimplemented kernel merged (165 tests; review caught real fail-open bug, mutation-tested fix). Gate-aware turn-holding observed = live §4.3 counterfactual argument. REPOS + snapshot wired; proposer loop unblocked, A/A earliest ~08-12** |
| GA11 | 2026-08-01 night | kkamak 0.4.0 RELEASED + gauge fail-loud deployed + gauge-classifier measurement (MacBook) | SDD 3 tasks w/ per-task reviews + opus whole-branch review + 2 fix waves; 1 blind opus labeller (fresh context); ~60 haiku classification calls; podman container proof; zero bench trials | — | — (release + measurement) | **RELEASED `v0.4.0` (github.com/th-yoo/kkamak/releases/tag/v0.4.0, annotated tag on `586d476`, CI green first run, 311 tests). Shipped: marketplace.json (was UNINSTALLABLE — `plugin install` had no marketplace to resolve), `/kkamak:init` + token-free CLI ported w/ `--no-gitignore` (review caught the CLI silently writing a tracked file the command promised to ask about), version 0.4.0 across 4 sites + publisher metadata, README rewritten CC-first w/ TRUST MODEL section, 7 minor findings recorded in docs/known-issues.md rather than silently fixed. INSTALL PROVEN on pristine ubuntu:24.04 podman container (auth via keychain-export mount, agent-auth.ts darwin recipe): marketplace add + install from GitHub → cache at `plugins/cache/kkamak/kkamak/0.4.0/` → real CC turn BLOCKED twice then exhausted → sensor line `gateExhausted:true, rounds [verify-failed,verify-failed], pluginVersion 0.4.0`; the agent argued with the gate rather than ignoring it. THE RUNBOOK YIELDED 3 DEFECTS, ALL FOUND BY EXECUTING IT, NONE BY TWO PRIOR REVIEWS: (1) block proof produced no sensor line at all (in-budget blocks never call record()); (2) CLAUDE_CONFIG_DIR isolation strips keychain auth, so the host variant cannot finish step 3 on macOS; (3) missing permission flag meant no edit occurred, so the gate never armed. GAUGE FAIL-LOUD (§6b amendment, pre-data, user-approved) built + deployed: `gauge {present:false, offReason}` where the field was omitted, closing the ambiguity that let a DISARMED instrument look identical to a starved one — live incident same day, a correct review finding removed `gauge` from gate.json and silenced the corpus for 2 cycles with no error. `offReason` NOT `reason` (that key already carries the classification reason). BINDING metric-neutrality clause: present:false is not a gauge record, counts toward no numerator/denominator; both consumers proven by test. Deployed 17:05 KST, boundary ts 1785571509000 logged — behaviour changed while pluginVersion stayed 0.2.1. ALSO: emission-conformance suite ported to cc-gate-plugin (the MEASURED producer was the unproven one; kkamak already proved its own) + negative control pinning the guard bites; activation hermeticity fixed (activating KKAMAK_REINJECT_V2 broke this host's own suite for a day — an env-gated arm's ACTIVATED state is a configuration the suite must be proven under). GAUGE-CLASSIFIER MEASUREMENT (nothing shipped, see resume.md item 11): `claude -p` drags ~28k tokens of CC harness into every derivation; direct API SDK is 5-10x faster on identical prompts; structured outputs eliminate parse failures the CLI path cannot. BLIND opus labels on all 13 class-C corpus records: **stored C-precision 9/13 = 69%** — the class table's `C 13` is really ~9, C-rate 7.4% → ~5.1%, and the validity floor reads off that number. Transports TIE 9/13 with opposite error profiles (CLI 4 false-C/0 missed; SDK 1/3); an interim 'SDK more accurate' claim from a 6-record slice was RETRACTED. An anti-over-extraction patch drove false-C to ZERO on both (precision 69%→100%) at recall cost 100%→67%, overcorrecting one unambiguous case — NOT applied. USER INSIGHT → proposed third lane: run the proposer/reviewer/A-B loop on the gauge refiner prompt itself instead of hand-tuning; better instrumented than TB2 by every axis (3s trials vs 30-60min, 176 records vs 7-14 tasks). Limits to pre-register: labels are opus judgments (distillation, capped at opus accuracy — not 'correctness'), and it is a third lane needing its own bar.** |
| GA10 | 2026-08-01 | Gauntlet Loop adoption program — self-applying Gauntlet to evaluate 4 mechanism transplants (MacBook) | 3 builder branches in isolated worktrees; fresh-context critics per round (builder never self-graded); bars FROZEN pre-build; ≤2 gap-feedback rounds; replay + paired evals ≈24 opus-5 calls; zero bench trials | — | — (process experiment) | **0 MERGES, 2 DROPS, 1 OPEN, 2 DEFERRED (ledger docs/2026-08-01-gauntlet-adoption-ledger.md; plan + bars docs/superpowers/plans/2026-08-01-gauntlet-adoption-loop.md). Loop A reviewer null_precedent DROP: round-1 0/3 nulls (check unfailable by construction), round-2 headroom reword 1/3 (defect relocated — reviewer manufactures own headroom sentence); v9 false-positive side clean both rounds; E1 biggest-gap revise feedback salvage-eligible. Loop D proposer gap-targeting DROP-unproven: paired-on-same-evidence eval corpus-saturated (every qualifying record's dominant gap near-dups rejected ledger → both arms correctly abstain); reopen on fresh failure records. Loop F reinject v2 OPEN: 2-round code PASS (round-1 caught invisible v2 arm in score-cli render), env-gated, live §4.4 byte-identical test-pinned; merge awaits user amendment ruling + fixture/live evidence. Loop C deferred to Path A tournament verdict; P2 pre-registered in fleet spec. META-FINDING: opus-5 upgrade alone tightened existing rubric keys to catch 2/3 nulls that passed under old model — re-baseline pipeline after model upgrades BEFORE building discrimination mechanisms on pre-upgrade failure data. Gauntlet PRIMITIVES employed as process (fresh critics caught real defects both loops; single-gap feedback made fixes surgical); mechanism transplants rejected by their own bars. UPDATE same day: user APPROVED §4b v2 amendment (41a7411, v2 decision rule pre-registered before any v2 data) + Loop F branch MERGED env-gated (989630e; 568 tests + tsc on main post-merge, F1 calibration not staled); activation = separate logged decision. Same day: opus tier → claude-opus-5 live pins (3a40ee1) + Path A pre-data amendment (concurrent v7 screen arm)** |
| GA9 | 2026-07-31/08-01 | Gauge M1v2 corpus-replay tooling: amendment + full build T1-T5 (office T1-T2, MacBook T3-T5) — MERGED | amendment architect-reviewed 3 rounds (attestation script-tallied TWICE after two wrong counts: 1 class-C of 72 union); plan reviewed 3 rounds (14 findings); SDD 5 tasks, 3 fix waves, 2 fable reviews; zero bench trials, zero model spend | — | — (measurement tooling) | **BUILT + MERGED (`d869660..55c5b2a`, 12 commits, merge `27d1ed3`; 552 tests + tsc). AMENDMENT `d869660`: offline corpus replay may POOL into M1v2 (unchanged ≥90%/≥5 bars, ≥1 live, provenance split mandatory, live-governs+void+unwind, batch spend own go). Pipeline mine→derive→resolve→report: T1 corpus-store (TOCTOU fix) · T2 miner (no-hard-gate origin) · T3 cost-fenced deriver — review forced LIFECYCLE LOCK (spend only under lock; fence re-checked under lock) · T4 state resolver — 3 under-specified mechanics adjudicated SOUND + recorded as plan rulings (cycle = terminal non-skippedStop sensor line; joinKind nearest ⇔ skippedStop between; commit-join host = resolving hostname, cross-host starves descriptive); pipefail catch (bsdtar exit-0 empirically proven) + real 7d-cap test · T5 provenance-split report — point-4 "≥90%?" kept verbatim + yes/no/n-a (adjudicated SOUND), passthrough predicate proven against every fabricated-line producer, provenance pin hardening (bench can never pool) · final review FIX-1 drift footnote (Pinned-risks item invisible to scoped reviews). Standing decision surfaced: §3 over-refusal redesign round likely AVAILABLE (single-use, unconsumed). FIRST REAL BATCHES CONSUMED same day (sized goes 198 + 38, MacBook): mine 70 transcripts → 198 records; derive 176/198 total (22 parked, retry hit 42% vs 81% — diminishing returns); resolve 176/176 ALL descriptive-only (honest starvation — fixture-refs armed same day, zero organic blocks yet; commit lane starved by same-session-line requirement). First official reading: `live 0/0 · corpus 0/0 · pooled ≥90%? n/a` floor NOT MET; class table corpus-transcript A1 3 / A2 58 / B 0 / C 13 / D 102 — corpus C-rate ~7.4% vs live 1/72, replay lane can feed M1v2 once organic blocks land fixture-refs. Store canonical: repo-root `.km/gauge-corpus/`** |
| GA8 | 2026-07-31 | Phase 3 async prompt-check + mechanize-instead rubric key, ORGANIC PAIR LIVE-OBSERVED (office) | plan architect-reviewed to FLAWLESS pre-build (4 rounds, 17 findings); SDD 6 tasks ALL clean first-pass + fable final review + fix wave; 5 live-trigger attempts; zero bench trials | — | — (mechanism + measurement) | **BUILT + MERGED (`e79ea1b..2031575`; suites 438 · 228 · 1754/1). 5th pre-data amendment (`906d210`) implemented end-to-end: skippedStop-triggered detached prompt-check runner (seam extractions, atomic-takeover lockfile w/ cfg-derived staleness, frozen buildSensorLine call, env-only kill switch), exclusion ripple (classify order pin, rule 8, score-cli mirror BOTH filters, newLineCount discount), mechanize_instead 5th RUBRIC_KEYS (affirmative-fail-gated immediate abstain, revise seat locked out, command text preserved in rejected ledger). Fix wave: affirmative-fail gate (malformed reply must not abstain), spawn-throw lock release. LIVE PROOF in REAL dogfood stream (installed cache): skippedStop `14:04:14.679` + promptCheck `spawnTs`+1ms + resumed turn's normal accept — accompany + exact join + lock lifecycle organic. BEHAVIORAL FINDING (pre-data volume correction): trigger = INTERRUPT-shaped boundary loss only (Escape/abort/resume); queue-shaped loss extinct in current CC (3 clean disproofs: pre-queued 70s early, mid-Stop-window fire, mid-turn steering all delivered without boundary loss) — expected prompt-check volume LOWER than GA5's ~1/3 estimate; amendment validity unaffected (class excluded regardless). Dogfood day 2 totals: 6 reviewed-clean kkamak milestones (D1, marker, CC adapter `8e23103`, opencode adapter `9d2f6f6`, CHANGELOG `8552ed3`, delivery table)** |
| GA7 | 2026-07-31 | Phase 2 blocked-cycle → bench-fixture harvest, LIVE-PROVEN pre-merge (office) | SDD 5 tasks + per-task reviews (3 fix rounds, 10 Important findings fixed) + fable whole-branch review + fix wave; 1 live Sonnet clone session; 2 podman smokes; zero bench trials | — | — (mechanism) | **BUILT + LIVE-PROVEN + MERGED (`47bee8e..fdec2f7` + seal `6323779`; suites 404 · 225). Block-time dirty-tree snapshot (`fixture-ref.ts`: temp-index write-tree → `refs/kkamak/fixtures/<ts>-<sid8>-r<round>`, `.km/fixture-refs.ndjson`, exact shared blockTs = harvest join key) + km-crank harvest (transcript ask extraction, recursive secrets strip) + TB2 converter (`term-bench2/tasks/` via existing `--tb-root`; tamper-guarded fail-closed verifier). Reviews caught: stderr pipe-deadlock on Stop path, `;`-chain false-positive reward, missing pipefail, JSON.stringify-as-shell-quoting, vacuous `.km` test. LIVE PROOF (contamination-free kkamak clone, real Sonnet session): real 3-round exhausted cycle → 2 exact-ts sidecar pairs, tree ref carried untracked file, harvest → podman reward=0; T5 scratch proved fix→1. `FIXTURE_ALLOWED_REPOS=[]` = per-repo inclusion ruling point, no bypass. Office cache LIVE (capture armed); MacBook deployed + LIVE-PROVEN 08-01 (own clone test, real headless CC session: agent flipped ===/!== in clone's gate kernel, held no-fix → 3× block → exhausted; 2 sidecar records w/ real excerpts + 2 anchored fixture tree refs, blockTs exact join both sides; exhausted-final-round sidecar gap observed live = Phase 1 documented limitation; clone discarded, zero contamination). Parked w/ rulings: ref retention/prune, sid8 sanitize, .git-as-file probes, transcript skill-injection filter. Dogfood day 2 same day: D1 closed (`ad63d3b`) + real marker milestone (`65c9546`, 283 tests — session self-caught spec misreading in task prompt AND its own README, chose contract over instruction); ~4 clean cycles, zero organic blocks yet** |
| GA6 | 2026-07-30 | Phase 1 check-output sidecar + proposer excerpt rendering (MacBook) | SDD 4 tasks + per-task reviews + final whole-branch review + fix wave; zero bench trials | — | — (mechanism) | **BUILT + SEALED (`8fce9ae..4c0c06c`; suites 394 · 196). Block-round raw output captured to host-local `.km/check-output.ndjson` (8192-char head+tail cap) at hook-cli seam; km-crank renders ≤2 excerpts/notable session (head 300 + tail 900). NO 5th amendment — evidence-only, gate-outcomes untouched; F1 git-log empty, F2 FILES tripwire test. Final review caught cross-task drift (head-preserving emitter vs tail-only renderer) → split-trim ruling; excerpt-at-rest traced all-gitignored; exhausted-final-round capture documented out of reach (F1). DEPLOYED MacBook 07-31 (cache grep-verified + installed-copy smoke); office refresh pending** |
| GA13 | 2026-08-03 evening | §6d third derive transport (Agent SDK) — registered + built T1-T5 + measured; 7b process gate ARMED; verification-channel ladder + transport dedup + combine hard-gate merged (office `yoo-dev`) | 6 architect rounds on the plan (35 findings) then SDD 5 tasks w/ per-task reviews + 3 fix rounds; ALL measurement by local-stub wire capture (ZERO real model calls); 14-call channel-smoke built but never run (429) | — | — (transport + registration + measurement) | **NOTHING SPENT, EVERYTHING MEASURED. 429 ROOT-CAUSED as a PER-MODEL-TIER quota, not a path ban: same token, same second, `claude-haiku-4-5` OK / `claude-sonnet-5` 429 / `claude-opus-5` 429 — which falsified three of my own successive diagnoses (unsupported-path, Agent-SDK-credit-split, `claude -p` interim) and explains why MacBook 00:29 + office 10:13 SDK batches had succeeded hours earlier. §6d REGISTERED (`f3a36c9`) then AMENDED THREE TIMES pre-data as measurement contradicted design: (a) CONTEXT ISOLATION — wire capture caught `agentSdkCall` shipping this project's auto-memory (`MEMORY.md` + `claudeMd`) into every classification, 10,693 B requests / 9,627 B user turns; the classifier was reading our own class-C notes while judging class C, and a paired validation in that state would have reported contamination as transport disagreement. `settings:{autoMemoryEnabled:false}` + `persistSession:false` + `strictMcpConfig:true` → 1,563 B. (b) ENFORCEMENT ASYMMETRY DECLARED — dropped `outputFormat` (352 B forced StructuredOutput tool, redundant with the prompt's own JSON directive) + `thinking:{type:'disabled'}` → 1,349 B; API arm now PREVENTS non-conforming output via `output_config`, agent arm CATCHES it via the parser, so the arms can differ in PENDING COUNT as well as classification — recorded so a SPLIT verdict is not misread as a pure transport effect. (c) SELECTION IS PER-CALLER, no global default flip — the live path runs haiku, haiku is unwalled, so routing it through agent-sdk would tax every Stop hook ~1.25 s + ~423 B for zero benefit; Task 9's flip and its 6 default-path test updates deleted, live path PINNED IN CODE (`ab9e513`, env-independent, with a test that fails when the pin is reverted — the ruling had been convention-only for 20 min). STOP GATE PASSED: exactly 1 model call per query (my earlier '4 calls' was my own non-streaming stub triggering a fallback retry). MEASURED COST vs API SDK on a real refiner prompt: 995 vs 660 input tokens (+335/record, 1.51x — an earlier '31x' was measuring our own misconfiguration on a toy prompt) and +1.46 s/record of subprocess spawn (~25% end-to-end), split 260 ms spawn / 515 ms CLI init / 500 ms teardown. DAEMON INVESTIGATED, user-corrected: I asserted from a grep that no context reset existed and tested only `reinitialize()` (which does not reset); user asked about CC's `/clear` — it WORKS, handled CLI-side with no model call, `messages[]` stays 1 across cycles, 838 ms first record then ~20 ms after. Equivalence check found the residue: each post-`/clear` turn carries ~423 B of `<local-command-caveat>` + `<command-name>/clear</command-name>` echo, constant per record so it cannot bias one classification against another. `--bare` REJECTED after measurement: it removes the email reminder and shrinks attribution (1,124→1,001 B) but authenticates strictly by `ANTHROPIC_API_KEY` (confirmed on the wire, header switches to `x-api-key`) — which bills API rates, defeating the credit-pool rationale, at which point the incumbent API SDK dominates. Residuals ACCEPTED as the price of the OAuth lane: ~369 B email/date reminder (survives every documented option) + 212 B attribution (device_id/account_uuid/session_id — removable only under `--bare`; declined as attribution evasion for a rounding-error saving). ALSO MERGED TODAY: 7b process gate ARMED (`52cd8b4`, boundary ts 1785732646822) after all 7 rulings decided — enforcement via `scripts/merge-with-gate.sh` because a `pre-merge-commit` hook is PROVABLY UNSOUND (git 2.43.0 never materializes `MERGE_HEAD` before it on an automatic ort merge, so the hook fires blind and passes silently; caught by execute-proof, not review); 3 gated merges, §6 falsification window 3/10, 0 blocks. Verification-channel ladder C1-C4 (`9365551`) via DAG-parallel subagents. Transport dedup (`63bb15f`) — single exported `sdkCall`, 3 OAuth client copies gone. cls-combine provisional hard-gate (`4266089`) unblocking the MacBook cross-host combine. METHOD LESSON, recorded because it recurred all day: I wrote wrong verdicts into committed docs three times from search excerpts and one mis-configured probe before opening `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`; every correction came from the user pushing back (`tools:[]` vs `allowedTools:[]`, `title`, structured-outputs-exist, `/clear`). Read the dependency's own types FIRST, then measure, then assert.** |
| GA12 | 2026-08-02 night → 08-03 | §6c derive transport → direct API SDK: amendment APPROVED + built + reviewed + merged + DEPLOYED; first organic SDK gauge records; first poolEligible (office, concurrent) (MacBook) | 3 user rulings pre-build; TDD build (zero real model calls, stub API server); fresh-context reviewer FIX-FIRST → fix wave → re-verified MERGE-READY; installed-copy stub proof; 3 driven dogfood cycles (sonnet subject); zero bench trials | — | — (transport + measurement) | **§6c APPROVED `c22fbd0` — rulings replaced the draft's two invented numbers after both halves of its pooling bar proved DEGENERATE at the honest ~5.1% C-rate (±25% class-C band = sub-one-record at n=50; flat ≥90% agreement beatable by an all-not-C oracle at ~95%). New bar: stratified sample (ALL CLI class-C + equal not-C draw, PER HOST — stores host-bound, counts travel), positive agreement `|C_cli∩C_sdk|/|C_cli∪C_sdk| ≥ 0.80` AND missed-C `≤ ceil(0.10×|C_cli|)`; paired re-derivation on a SHADOW STORE copy (fenced deriver untouched, validation records never pooled); measured 13-record slice = 54% → bar EXPECTED TO FAIL → split readings is the designed outcome, bar set on principle not tuned to pass. Draft's §4 daily-cap conflict WITHDRAWN (GA9 §3 pt 6 already exempts corpus-replay batches). BUILT `761c42c`+`d15fc7f`, MERGED `de6e892` (594 tests + tsc): shared `transport.ts` (structured outputs json_schema, anyOf-never-union; keychain OAuth authToken + `apiKey:null` OAuth-only; maxRetries 0 = exactly-1-call; 60s timeout; fail-open) replaces BOTH `claude -p` paths (~28k harness tokens/15-33s → ~0.7-3k/2-6s); `transport:"cli"|"sdk"` provenance on GaugeFile AND GaugeSensorField (absent=cli, 586 pre-boundary records never rewritten). REVIEW CAUGHT 2 REAL DEFECTS pre-merge: SDK env-fallback would have sent stray `ANTHROPIC_API_KEY` alongside the OAuth bearer (bench hosts carry keys — silent SDK-record starvation, the §6b failure mode); transport provenance never reached the sensor stream `score.ts` reads, making the amendment's binding Split rule unsatisfiable. DEPLOYED yoo-mac 00:29 KST 08-03, boundary ts 1785684571765 (gauntlet ledger; pluginVersion stays 0.2.1 per amendment — partition by transport field/ts); cache grep-verified incl. `@anthropic-ai/sdk` in cache node_modules (install copies the dir — OFFICE MUST `bun install` BEFORE km-refresh); installed copy proven vs stub server (one request, resolved model `claude-haiku-4-5`, stray key suppressed, `transport:"sdk"` stamped). FIRST ORGANIC SDK RECORDS same night: 3 driven dogfood cycles (sonnet subject, session bcd70a2a), all rounds:["accepted"], derivations 5.2-6.5s, one refiner over-extraction (C w/ check `bun test`) correctly downgraded C→B by validate.ts; real work shipped on kkamak main `e8b9a38`/`bc1e882`/`c5f8600` (item 10(a) kkamak half + known-issues 1,3, each w/ pinning test). CONCURRENT OFFICE (00:50 KST, its own session): 410 CLI batch landed 298/410 (last CLI batch ever), FIRST 2 poolEligible pool-C records in project history — pooled 2/2 prints \"yes\" but floor NOT MET (n=2<5, zero live; permits nothing per d869660 pt 5); C-rate replicates cross-host (5.4% vs 7.4% nominal); 112 stayed mined = next retry sized go. OPERATIONAL LESSON: driving the live dogfood pane requires tmux allow rules in settings — the auto-mode classifier blocks Enter-injection into another session AND self-granted permissions regardless of chat approval (correct behavior; settings allowlist is the sanctioned channel)** |

## GA14 — ACP warm lane + send-prompt interface: BUILT, MERGED, WIRED-INACTIVE (2026-08-04/05, office `yoo-dev`) — INSTRUMENT BOUNDARY STAMPED

<!-- Renumbered from a mistaken "GA7" 2026-08-04 (MacBook): the id collided
     with the table's GA7 Phase-2 row (2026-07-31). No GA14 table row yet —
     next id after GA13. -->

- **What:** the design-time seats (Proposer/Reviewer/revision — the minimal
  loop's own actuator inputs) moved off CLI subprocess spawning onto a
  provider-agnostic `sendPrompt` interface
  (`docs/superpowers/specs/2026-08-04-send-prompt-interface.md`, user ruling:
  "sessions are keep-alive — callers never see an ACP session"). Two lanes:
  `anthropic-api` (Messages API, LIVE — explicit `REASONING_ISOLATION`
  closes the undeclared-harness finding; maxTokens 8192 with a hard
  truncation guard, `stop_reason` checked so a cut proposal throws instead
  of passing as complete) and `anthropic-cli-warm` (ACP daemon + SessionPool
  of warm CLI subprocesses, `/clear`-recycled — premium reach via the CC
  credential pool during raw-API 429 walls; WIRED but INACTIVE behind
  `KKAMAK_SEAT_PROVIDER`, no-call falls back to api in-call, call-consumed
  THROWS never falls back).
- **Instrument boundary:** ts **1785847012141** (merge `bbdabe1`,
  2026-08-05 KST) in `docs/2026-08-01-gauntlet-adoption-ledger.md` — seat
  outputs pre/post MUST NOT pool (transport + system prompt + isolation +
  output-cap all changed; NOT metric-neutral). `opencode` driver
  byte-untouched. Wiring merge `5ae2043` moved nothing (default-off,
  test-pinned); activation = env flip, own ledger entry when taken.
- **Governance/process:** 7b gate ×2 (artifacts
  `docs/reviews/95cfa82-acp-session-pool.md`, `9663129-wire-warm-lane.md`);
  ~11 review-gated nodes, 8 fix rounds each ending in a scoped re-review,
  whole-branch opus review 0 Critical over 36 commits. Loop catches worth
  the rigor: Bun 1.3.1 `net.listen` silently STEALS an owned unix socket
  (no EADDRINUSE — probe-first-under-lock replaced the plan's dead trigger);
  a partial-isolation payload would have silently restored the full CC
  harness (only the whole-branch view could see it — each scoped review saw
  a third); the pool rewire made two cancel tests racy (measured 1016/1,
  fixed by same-chunk frame writes with an independently traced synchronous
  chain); spec-claimed T4 RSS data never existed → measured fresh
  (~330 MB/warm session, cap 4 justified, `docs/2026-08-05-warm-session-rss.md`).
- **State:** main @ `5ae2043`; cc-gate-plugin 1043/0 + opencode-plugin
  1776/1 skip, tsc clean both. Warm-lane activation and any MacBook cap
  raise (needs its own RSS measurement — host-keyed) are open decisions.
- **2026-08-05 follow-ups (yoo-mac):** (a) darwin re-run found this arc's
  test sockets exceed darwin's 104B `sun_path` cap — 35 silent
  no-call-degraded failures, fixed via shared short-name helper w/ hard
  100B assert, gate-merged `8795db1`; both suites green on darwin incl.
  ACTIVATED-state proof. (b) MacBook RSS measured (~330 MB/session, same
  band as WSL2; cap STAYS 4 there, 8 ruled not permissible) and warm lane
  ACTIVATED on yoo-mac, boundary ts **1785856371528** — yoo-mac seat
  lines partition into three regimes by ts. (c) COST FINDING: this arc's
  tests (ACP daemon/warm 110s + agent-sdk CLI-spawn 24s of a ~160s suite)
  pushed every gated Stop from 26-31s to 151-183s on the dogfood gate —
  root-caused 2026-08-05, two-tier gate-check plan written
  (docs/superpowers/plans/2026-08-05-two-tier-gate-check.md, unexecuted;
  deploy will stamp its own instrument ts in the adoption ledger).
- **2026-08-05 follow-up (office `yoo-dev`):** gate.json check swapped to two-tier
  `scripts/gate-check.ts` — ACP-arc test growth had pushed every gated Stop
  to ~160s (was 26-31s pre-arc); blocking tier back to ~25-45s, full check
  unchanged as a background debt gate. Instrument note in the adoption
  ledger; durationMs never pools across the deploy ts.

## GA15 — P2 actuator-binding probe: BUILT + FULLY REVIEWED, spend pending (2026-08-06/07, yoo-mac) — first fully isolated-worktree SDD run

- **What:** the three-carrier rule-delivery experiment (plan
  `docs/superpowers/plans/2026-08-06-p2-actuator-binding.md`, spec
  `2026-08-05-p2-actuator-binding-design.md`): A1 prose harness bullet vs
  A3 in-container binding Stop-gate vs A4 host-side haiku review +
  bounded re-pass, same frozen `looks_done`-family rule, band 14 × k=2,
  mechanical compliance predicate, pre-registered routing bar
  (compliance ≥0.75 AND pass@k drop ≤0.15 vs A1). Built as `p2-run`
  subcommand + `p2-tally`, store-isolated (`docs/loop-probes/p2/`),
  cost-fenced (`--go` exact-count refusal).
- **Verdict:** NONE YET — build complete, ZERO bench spend; sized go
  pending (≤112 executions + ≤28 review calls, est 5.9-7.8h haiku,
  `docs/loop-probes/p2/READINESS.md`). Probe budget 3/4 consumed.
- **Two pre-data instrument saves, both by fresh-context review:**
  (a) Task-2 review reproduced the anti-gaming predicate self-satisfying
  via its own file-writing command (`echo prose > DONE-CHECK.txt`) —
  user-ruled AMENDMENT excludes DONE-CHECK-path commands from the match
  set; (b) **final whole-branch review C1 (Critical): the A3 Stop-gate
  shipped `exit 1`, which does NOT block a CC Stop — only exit 2 does**
  (in-repo `exit2-stderr` precedent was the tell). A3 was a silent no-op;
  28 executions would have measured a stock harness and returned a false
  mechanism-negative. Fixed + PROBE C live-proved blocking (num_turns 4
  vs 1-turn control, unprompted DONE-CHECK.txt). Three earlier reviews
  had each verified a different correct property of the same asset
  (prose fidelity, text drift, fence math) — only the whole-branch pass
  asked whether the mechanism was ever proven. Probe-the-consequence,
  not just the capability, joins the standing lessons.
- **Process firsts:** every implementer from Task 3 on ran in its OWN
  git worktree (ruling after the Stop-hook gate raced a shared-worktree
  implementer's RED-phase test — 4th instance of the global-state defect
  shape); per-task fresh reviews all Approved with 2 fix rounds, ~7
  triaged deferred minors, one unrequested implementer self-pause
  (resumed clean). Branch `worktree-p2-actuator-binding` @ `51f1327`
  pushed, UNMERGED (explicit-merge-go rule).

## R1 — round-1 machine bullet (2026-07-23, office) — REJECT

- **Evidence:** 1 failing traj (thin; proposer self-flagged low confidence).
- **Bullet:** compute qualifying sets with a script rather than eyeballing.
- **Arms (bare base):** 4/10 vs 5/10, Fisher p=1.0. Its own `falsify_if` fired —
  first calibration point for proposer predictions.
- **Mechanism:** winners already scripted logic in both arms; bullet mandated
  default behavior. Ledgered as `rejected.json` entry 1.

## SG — system gate (2026-07-23, office) — certified lift, adoption deferred

- **Candidate:** `system-v0.md` (72-line replacement system prompt; DoD as
  required emitted procedure) + `seed-v0.md` (2 DoD bullets). Composite —
  attribution = assembly, not either piece (decomposition still open).
- **Arms:** bare 6/20 (30%) vs candidate 17/20 (85%), pooled Fisher p=0.00106;
  unbiased replication batch alone 3/10 vs 9/10, p=0.0198. Largest lift in
  project history. NOT adopted at this point: zero guard tasks measured (v9 lesson).

## A1 — adoption-1 (2026-07-23, MacBook) — ADOPT (first in project history)

- **Decided by `gate.ts`** (built that session, TDD 17 tests; guard-less
  adoption structurally forbidden — hole found on first E2E run).
- **Guards:** count-dataset-tokens 3/3, chess-best-move 3/3, zero voids
  (`results/adoption-1-verdict.json`). Commit `4fc9d68`.
- **Forensics (free, pre-gate):** 17/20 candidate trials emit the DoD procedure
  vs 0/20 bare; verbatim mid-flight scope-leak catch (10-50 a2); the 3 candidate
  fails all complied → residual = held-out-only interpretation variants;
  anthropic.txt-removal hypothesis weakened.
- **Caveats standing:** n=1 target task; lift arms office-host, guard arms
  MacBook (each internally same-host).

## HO — held-out generalization (2026-07-23, MacBook) — directional, uncertified

- cancel-async-tasks bare 3/10 vs adopted 5/10 (p=0.65); headless-terminal
  bare 7/11 vs adopted 7/8 (p=0.34). Both positive, neither certified;
  informal cross-task pool 10/30 vs 13/18 p=0.016 — context only, gate.ts
  refuses cross-task pooling by design. Guards re-held. Commit `0119619`.
- Confidence "improves the agent, not just sparql": ~85%.

## R2 — round-2 scope-leak bullet on adopted base (2026-07-24, office) — REJECT

- **Evidence:** round-2 proposer (CC, 10-traj bare-arm evidence + ledger)
  diagnosed qualification-filter leak into output projection. Triple-confirmed:
  CC proposer, opencode proposer parity replay (`7517f72` — proposer seat now
  driver-configurable, opencode default `f12d515`), human desk-check.
- **First stacking test post-adoption.** Candidate `harness/candidate-r2-scope-leak.md`
  = seed-v0 + bullet, system-v0 unchanged. Fresh office arms.
- **Arms:** baseline (adopted base) 9/10 vs candidate 10/10, Fisher p=1.0 —
  null; regression ruled out. Guards cdt 3/3 + chess 3/3 hold (fresh office
  screens). Zero voids. `results/r2-gate-verdict.json`, commit `3367399`.
- **falsify_if fired as pre-registered** — second calibration point.
- **Mechanism (ledgered, entry 2):** diagnosis correct but the adopted base's
  DoD procedure already covers the class; baseline 9/10 = no headroom at k=10.
- **Process lesson:** the bullet's evidence was PRE-adoption bare-arm trials.
  Propose against the ACTIVE base's residual failures — stale evidence from a
  weaker base proposes fixes the base already has.
- **Side result:** adopted base re-confirmed 19/20 pooled on fresh office arms
  (third host-day replication).

## HO2 + R3 — cancel-async chain (2026-07-24, office) — directional + REJECT

One auto-chained run (user-approved single go): harvest → proposer → gate.

- **HO2 (certification leg):** fresh office pair, cancel-async bare 2/10 vs
  adopted 6/10, Fisher p=0.17 — directional, uncertified (needed 8/10).
  Second same-sign host-day for cancel-async (MacBook 3/10→5/10). Pass/fail
  duration signature strong: passes grind (up to 19 min), fails bail fast.
- **R3 (first ACTIVE-base-residual proposal — R2's process fix applied):**
  proposer (opencode driver, parser hardened `a642db1` after a pretty-printed
  JSON contract killed the first call post-spend) diagnosed: fails self-verify
  with in-process signal proxies unrepresentative of the grader's real
  signal-to-subprocess delivery, then dismiss the mismatch. Bullet: reproduce
  the grader's actual trigger before declaring done.
- **Arms:** adopted 6/10 vs +bullet 3/10, p=0.37 — REJECT null, negative
  direction. Guards cdt 3/3 + chess 3/3 hold; sparql informational 3/3.
  falsify_if fired (third calibration point). `results/r3-gate-verdict.json`.
- **Mechanism (ledgered, entry 3):** cancel-async residual now 2x
  proposer-resistant; the negative hint suggests "distrust your self-test"
  buys re-verification churn, not interpretation fixes. Next content must come
  from divergence forensics on the flipped trajectories (what the 6 baseline
  passes did at the signal step that the 4 fails did not), not another
  procedure bullet.

## R4 — iteration 1, asyncio bullet (2026-07-24, office) — REJECT scope-veto, never gated

- **Iteration 1 = R3's full result fed back:** evidence = adopted arm (6P/4F) +
  R3's rejected-bullet arm (3P/7F), ledger 3 entries. Proposer executed the
  divergence read and found the mechanism: failers truncate cleanup by
  re-cancelling children already unwinding — but emitted it as an asyncio
  solution recipe (shield/absorb during cancellation).
- **User design rule born here** (mid-arm, run killed at ~6 attempts, 4/4
  observed pre-kill): *the proposer guides systematic problem-solving and
  general SWE method, never domain knowledge or specific manuals.* Encoded as
  propose.ts rule 3b (`0e65a2a`), research-grounded rev (`1715c68`: process
  categories, hard-gate form, domain-swap litmus). Ledgered as entry 4
  (scope-veto; no gate verdict; partial arm not comparable).
- **Structural finding:** guards are domain-irrelevant, so they hold trivially
  under a domain bullet — the stats gate structurally cannot catch scope
  bloat. Scope control = proposer rule + Reviewer seat + human veto.
- **Reviewer seat built in response** (`b738624`, design `bfd0371`): layer-1
  deterministic checks + evidence-forced rubric, code-conjuncted verdict,
  bounded revise loop with frozen diagnosis. Retroactive: layer 1 kills R4's
  bullet for free (task-id fragment leak); R3's passes to the rubric.
- **Diagnosis stays live** — the 4/4 pre-kill hot start weakly corroborates
  that the residual is this mechanism and is context-reachable. Wanted next:
  behavior-level reform (verification-design / completion-criteria) or an
  honest domain-only ABSTAIN, which escalates toward a binding actuator.

## R5 — iteration 2 rerun under rule 3b + Reviewer (2026-07-24, office) — ABSTAIN

- **Setup:** same evidence as iteration 1 (adopted 6P/4F arm + R3-bullet 3P/7F
  arm, 1.19M-char prompt), ledger now 4 entries incl. R4's scope-veto with the
  live diagnosis. Reviewer seat armed (first live availability; never invoked —
  abstain produces no bullet to review). One 31s call, zero experiment spend.
- **Verdict (proposer's own words, ledger-cited):** the dominant failure is
  only addressable by the R3-rejected reproduce-the-trigger bullet (A/B
  negative) or the R4-vetoed asyncio mechanics (fails domain-swap); *"no new
  behavior-level domain-neutral lever remains."*
- **Meaning: the machine seat declared prose-bullet actuator exhaustion on
  this residual** — the same conclusion TB2 loop-1 reached by human forensics
  (lesson IGNORED 7/8 → binding actuator), now derived mechanically with
  rejection-ledger reasoning. Invariant 5 + rule 3b behaved exactly as
  designed: no re-derivation, no laundering, honest stop.
- **Escalation indicated:** this residual's fix class lives beyond context
  prose — binding actuator route (middleware/enforced procedure) per the
  loop-2 verdict, or park cancel-async and move the band to a task whose
  residual is still prose-reachable.

## R6 — iteration-0 rerun, agent-translated vocabulary (2026-07-24, office) — ABSTAIN via review loop

- **Setup:** iteration-0 evidence only (adopted arm 6P/4F), rule 3b in
  agent-translated form (`ee0708b`: 7 categories defined by LLM failure modes,
  new iteration-discipline), Reviewer + revise loop live. 76s, 3 small calls,
  zero experiment spend.
- **Full loop exercised end-to-end for the first time:** proposer PROPOSED
  (hard-gate rewording of the reproduction fix: "do not accept a passing
  self-test until it reproduces the grader's mechanism") → **Reviewer FAILED
  it on the duplicate check, quoting R3's ledger entry as the match** →
  reviser (diagnosis frozen) conceded: every behavior-level expression of
  this diagnosis is the reproduction class, certified null-negative on this
  task; rewording cannot lift a refuted class → abstain.
- **Reviewer seat's first live catch** (kill-criterion metric ticks): without
  it, a laundered duplicate of an A/B-refuted rule goes to a ~50-min
  experiment. Invariant 5 now has an automated enforcement point in front of
  spend, not only inside the proposer's own judgment.
- **Prose exhaustion on cancel-async now confirmed by two independent
  paths** (R5 self-abstain; R6 propose→catch→concede). Escalation stands:
  binding actuator (completion gate in run.ts — the industry's Stop Hook
  pattern) or move the band task.

## R7 — placement experiment + GROUND-TRUTH forensics (2026-07-24, office)

- **Experiment:** R3's bullet VERBATIM moved to the SYSTEM slot
  (`candidate-r7-system-slot.md`) — content constant, channel the one
  variable. Killed at 8/10: 3/8 vs 6/10 baseline — **channel hypothesis
  REFUTED**; the rule is harmful in both channels (AGENTS.md arm was 3/10).
- **Forensics (free, ground-truth):** extracted all 5 failing implementations
  from their trajectories and ran the grader's own shapes against them
  locally. All 5 pass everything EXCEPT one shape — SIGINT with a task queued
  above max_concurrent (grader T5, n3/m2): cleaned 0/2. a3's own
  `test_queued.py` covered that shape but with SYNCHRONOUS cleanup — so the
  defect fires only at the **CONJUNCTION queued-task × awaiting-cleanup**,
  and every fail tested each dimension separately, never jointly. a2 passed
  because its diagnostic test combined both. Classic pairwise-coverage
  failure, now verified, not inferred.
- **Bimodal signature:** rule-obeying deep grinds pass (a1 463s, a2 660s
  incl. an 11-min diagnose-bisect-fix session that independently found and
  fixed the double-cancel defect); compliant-but-gentle attempts fail fast.

## R8 — scenario-coverage bullet (2026-07-24, office) — staged, NOT gated

- Proposer (fed R7's 8 trajs via a synthesized partial record) independently
  derived the coverage diagnosis; Reviewer PASSED it (first live round-0
  pass). Arm launched, killed at 1 attempt by design judgment (user call,
  vindicated by forensics): the bullet prescribes per-variant checks — which
  a3 already did — not JOINT coverage; predictable null. Ledger-status:
  staged candidate `candidate-r8-20260724T141220.md`, never gated.
- Verdict distilled: prose channel dead on this residual regardless of
  wording; the fix class is mechanism-level.

## R9 — completion gate + mutation adequacy probe (2026-07-24, office) — KILLED 5/10, pending

- **The binding actuator built and A/B'd** (design
  `docs/2026-07-24-completion-gate-design.md`, impl `complete-gate.ts` +
  `mutate.ts` + run.ts `--complete-gate`, TDD, suite 1591 green): harness
  refuses "done" until /app/verify.sh exists, passes, and survives a crude
  mutation probe; failures reinject evidence into the same session (bounded
  2 rounds). Industry grounding: Stop-hook ~100% vs prompt 70–90% compliance;
  MutGen — test suites improve ONLY with mutation feedback (53%→89.5%).
- **Partial arm (host shutdown at 5/10):** 4/5 pass vs baseline 6/10 —
  best cancel-async arm rate yet; EVERY attempt turns=3 (both gate rounds
  consumed; healthy-fix vs gate-exhausted UNKNOWN — first resume job).
  `results/r9-gate-arm-partial.json` + trajs a1–a5. Guards, sparql info,
  adoption-gate verdict never ran.
- **Standing caveat (user-raised): overfitting** — the gate was designed FROM
  this task's forensics and measured ON it; `drop-cancel-call` operator is
  task-class-fitted; ~6 sequential interventions on one task = spent
  statistics. Any R9 verdict is "directional on the design task, transfer
  untested" — the real test is gate HELD-OUT arms on tasks the gate never saw.

## R9F — R9 forensics (2026-07-24, MacBook, zero trials) — GATE BUG FOUND + FIXED

- **turns=3-everywhere mystery solved:** office a1–a5 trajs show the mutation
  probe's `swap-and-or` first site landed in run.py's DOCSTRING ("and"→"or"
  in prose) — a semantic no-op NO verify.sh can catch. Probe unsatisfiable →
  every attempt burned both rounds regardless of suite quality (a1 verbatim:
  "genuinely a no-op for runtime behavior"). Also: `gate_reinject` traj
  events carried no payload (salvage lost stdout), but the per-trial `gate`
  field in run records was intact code — only the office salvage lacked it.
- **Implication:** R9's 4/5 was NOT the adequacy mechanism — it was the
  contract line + reinject NUDGE TEXT (which names combined-boundary
  scenarios) + forced extra grind. Mechanism had never actually functioned.
- **Fix (`84a244f`, TDD +3 tests):** `codeLineSet` — comment lines +
  triple-quote blocks excluded from every operator's sites; real code lines
  still mutated.
- **Session also shipped (user-ordered, same day):** scheduler reservation
  layer (`schedule.ts` `c493799`: clampParallel from podman-VM capacity — the
  measurement-only admission loop is commitment-blind at large --parallel;
  per-container `-m 2048m`; `pidAlive` replacing existsSync(/proc) whose
  darwin failure made the stale-reap kill concurrent LIVE runs' containers).
  Nudge-arm decomposition attempt launched then user-killed in favor of
  direct R10 (partial nudge arm abandoned unrecorded, ~3 attempts).

## R10 — FIXED gate arm (2026-07-24, MacBook) — 10/10, LIFT-CERTIFIED

- **Arms (same-host, gate.ts verdict):** bare baseline 3/10 (07-23) vs
  [adopted base + fixed completion gate] **10/10** — Fisher two-sided
  **p = 0.0031**, lift-certified. First perfect arm on cancel-async ever
  (prior best 6/10; five prose rounds R2–R8 could not move it).
- **Loop health — mechanism now demonstrably functioning:** all 10 attempts
  gate-ACCEPTED (5× round-0, 4× after one reinject, 1× after two; zero
  exhaustion give-ups — office pathology gone). Turn/gate fields recorded
  per-trial this time.
- **Specimen a6 (mechanism transmitting task knowledge):** probe's
  swap-and-or on a REAL code line reproduced the exact double-cancel defect
  class R7's ground-truth forensics identified (re-cancel mid-cleanup aborts
  async cleanup); agent's suite missed it; the diff-bearing reinject taught
  it; accepted round 1. A task-blind operator transmitted what five rounds of
  prose could not.
- **Placement validated externally (searched):** industry Stop-hook tier =
  deterministic gate vs probabilistic prompt; measured context-rot data
  (CLAUDE.md compliance degrades sharply past ~50% context) confirms
  contract-at-task + enforcement-in-code over system-prompt placement. CC's
  own Stop hook bounds at 8 consecutive blocks (ours: 2 — tuning knob noted).
- **NOT adopted yet — two opens:** (1) guards must re-run GATE-ON (prior
  guard holds were gate-OFF; the gate rides every task if adopted —
  spurious-refusal tax unmeasured; artifacts cdt=/app/answer.txt
  chess=/app/move.txt); (2) held-out transfer (user's standing overfit
  caveat) — gate arms on tasks the gate was never designed from.
- Committed: fix `84a244f`, scheduler `c493799`, results `b9c7e3f`.
  Port-to-plugin scheduled: resume queue item 4 (finish-hook via
  session.idle, store-versioned gate.json, interactive round-bound +
  human-preemption rules). **DONE 2026-07-26: `gate-plugin/` shipped
  (commits ec41938..6f39449) after C1/C2 verdicts — marker default OFF per
  C2, mutation probe deferred to v2, sensor ndjson = daily grader input.**

## Review-sensor ARMED (2026-08-06, yoo-dev) — the b2 pairing fix deployed

- **Why (loop-fix probe program verdict, merge `1649fe8`):** the loop's one
  VIABLE outcome signal — b2 review findings-count (sd/mean 1.41) — rode s3
  manual review cadence at 1.43/day = 245 days to a d=0.30 verdict vs the
  14-day bar. NO-CONFIG-PASSES; blocker = signal-source PAIRING, not rigor.
  Fix = move the signal onto gated-Stop cadence: auto-fired review passes.
- **Built (SDD, 8 tasks, merge `062baf0` + maxBuffer item `75a5305`):**
  `session/close` ACP wire verb (SessionPool.closeEntry + daemon handler +
  client closeSession — close-not-release so a sensor seat never pins the
  4-cap warm pool), sensor core (15-min debounce / 30-day cap / clock-skew
  guard / hunk-aligned byte-exact 128 KiB truncation / frozen prompt sha
  `a19f6f85…294c36` / F2 counts-only line builders), git-diff ladder
  (range/merge-base/fallback + merge-in-progress guard), detached runner
  (wx claim, zero-wait haiku warm seat, modelProvenBy gate, atomic state
  write), Stop-branch spawn gated on env + main-checkout cwd. Spec + plan
  both reviewed-to-FLAWLESS pre-build; 7 Important/Critical caught in
  SDD reviews (incl. a cap day-rollover permanent-wedge the green tests
  missed, and a spec-§3 line-schema drift the whole-branch review caught).
- **Armed (sized go, boundary ts `1785988568548`, ledger `e1d5d1c`):**
  `KKAMAK_REVIEW_SENSOR=1` in this repo's `.claude/settings.local.json`,
  yoo-dev ONLY (host-local file; yoo-mac arming = its own sized go).
  Stream `.km/review-findings.ndjson` — NEW instrument, never pools with
  the human-flow docs/reviews counts P0 measured.
- **Pre-registered checkpoint (due 2026-08-13):** realized events/day from
  the stream ≥25 → the 14-day bar is reachable (350 count-family events at
  d=0.30 ≈ 12-14 days); <25 → constants return to the user, new boundary
  ts. Nothing self-adjusts. If it holds: distance-to-verdict for any future
  actuator comparison drops 245 days → ~2 weeks — the loop's evidence
  channel problem, closed by construction pending cadence proof.
- **Same-day context:** B3 binarized D-vs-rest on measured basis (merge
  `8c53f46`, gauge-emission cadence 18.3/day ≠ s1's 62.6); P1 wall-clock
  test time bomb defused (`e63d920`, KKAMAK_PROBE_NOW_TS seam); sibling
  session's ACP promotion to `src/acp/` merged under it (`6417b7a`) — the
  sensor is that public surface's first non-gauge consumer.

## Gate tier-0 narrowed for kmcrank (2026-08-06, yoo-dev `side`) — D3 shipped, four sibling decisions withdrawn

Companion to the review-sensor entry above; both landed the same day on the
same host, 34 minutes apart, and their instrument boundaries must not be
conflated.

- **Shipped (merge `c6879f8`, boundary ts `1785990600996`, artifact
  `docs/reviews/4fbca97-gate-tier0-narrowing.md`).**
  `km-crank/test/gate-check-cli.test.ts` — 13.9 s of km-crank's 15.8 s, an
  end-to-end CLI drive with multi-second `until()` waits — leaves the
  BLOCKING tier, and is pulled back when `scripts/gate-check.ts` changes,
  when `gate-check-core.ts` changes (basename-anchored), or when the file
  itself changes. Measured: km-crank tier-0 **15.8 s → 1.20 s**; derived
  fallback selection ≈29.7 s → ≈14.4 s.
- **The durable rule, extracted the hard way:** narrowing a suite is
  admissible only if that suite runs in `table.full` — and that is
  **necessary, not sufficient**. Tier-1 rescue is spawn-conditional (no bg
  run on a live fresh `"running"` marker, which is the dominant fallback
  trigger), content-raced (`bgMain` runs the live worktree, writes green for
  a pre-computed tree), and absent on a session-final Stop.
- **Four decisions withdrawn across five architect rounds** (79 findings,
  `docs/reviews/2026-08-06-gate-tier0-narrowing-rounds-1-5.md`). Each died to
  something found in the code, not to taste: **D1** narrow opencode —
  `table.full` does not run it AND the green marker advances via tiers that
  never ran it, so exclusion deletes coverage rather than deferring it, and
  no pull-in can rescue it; **D2** map `scripts/` — priced at 0.02 s, and
  nobody priced it until round 5 (four rounds argued only its correctness);
  **D4** close the `src/acp/index.ts` gap — violates the basename-anchoring
  and one-hop policies written into the file it modifies, so it is the
  documented two-hop deferral, not a gap; **D8** opencode into `table.full` —
  that command is also the SYNCHRONOUS debt-repayment path, and the suite
  spawns `python3` at module scope plus `tmux` and needs host `rdflib`, so on
  any host lacking them the bg run goes red and can never go green: every
  Stop pays ~200 s forever. Multi-host repo ⇒ unclearable gate wedge.
- **Method note worth keeping.** Every fold introduced new defects: round 2
  killed round 1's fix, round 3 killed round 2's, round 4 caught residue that
  would have *reinstated* D1, round 5 found the unpriced decision. What
  converged was the decision set (5 → 1), not the prose. The plan shrank from
  7 tasks to 4 and shipped clean — 0 Critical, 0 Important at whole-branch
  review, which differentially tested the refactor across 1390 tracked paths
  and 5000 random subsets for zero behavioural mismatch.
- **A live defect fixed on the way:** the degraded-readdir path produced a
  bare `["bun","test"]` argv and then appended a pull-in to it, collapsing a
  whole suite into a single file. Partial scans are now discarded, so any
  scan anomaly degrades to "run everything for that package".
- **Accepted loss, recorded not discovered:** on the fallback path pull-ins
  do not fire (the deliberate 2026-08-05 ruling), so the excluded file does
  not run in the blocking tier there. The same trade already shipped for
  ccgate, where six exclusions are ~98 s of a 111.6 s suite; D3 adds one
  13.9 s file to that pattern.
- **Same-day context:** the ACP subsystem was promoted to
  `cc-gate-plugin/src/acp/` behind an explicit 5-export surface (merge
  `6417b7a`) — stage one of extraction to `@th-yoo/cc-api-daemon`; the
  review-sensor above is that surface's first non-gauge consumer. Production
  sibling `~/z2/kkamak` shipped 0.4.1 with all seven 0.4.0 known-issues
  resolved; its install-verification runbook stays unexecuted by ruling.

## Arming the sensor wedged the gate (2026-08-06 late, yoo-dev `side`) — two deployment lessons in one afternoon

Immediate sequel to the two entries above; both failures sat between "merged"
and "actually running", which is where this repo keeps getting caught.

- **The sensor was armed but could not fire.** Env gate, cwd gate and wiring
  were all correct; the gate runs the **installed** plugin, and
  `plugin.json` had stayed at `0.3.0`, so the version-keyed cache never
  refreshed and the executing copy predated the sensor merge entirely.
  Diagnosed by `ls`-ing the installed cache dir and grepping the installed
  `hook-cli.ts` — repo source looked correct throughout, which is exactly why
  reading it proved nothing. Fixed by the sibling session (`4d27981`, erratum
  `d78ab5e`); sensor now live-proven, effective boundary ts `1785996709580`.
  **The expensive part was never the outage.** That sensor carries a
  pre-registered 7-day cadence checkpoint; left alone it would have reported
  0 events/day and been read as "cadence bar unreachable" — a deployment bug
  laundered into a measurement result. Rule memorised: **merging is not
  deploying**; a plugin code merge needs the version bump in the same change.
- **Then arming it wedged the gate** (fixed `6121e53`). The sensor drives the
  ACP warm lane, so a real `acp-<fp>.sock` is routinely listening under
  `~/.config/kkamak` while tests run. Four assertions across
  `cc-gate-plugin/test/{acp-client,acp-daemon,anthropic-cli-warm}.test.ts`
  asserted that directory holds **no** `acp-*` files at all — a host-global
  claim. One pre-existing socket failed **72 tests** in the very suite
  `gate.json` runs, so every Stop in the main checkout blocked. Fixed by
  baselining at file load and asserting no NEW socket appears, which
  preserves the real guard (production ignoring `KKAMAK_ACP_SOCKET` and
  falling back to the default path) while dropping the false one.
- **The shape worth naming, three instances in one day.** An assertion about
  GLOBAL state that holds only while nothing else uses the resource; a
  legitimate second user falsifies it; and it fails loudly while pointing
  somewhere else entirely. (1) kkamak's "provider registry is empty", broken
  by another test file registering. (2) km-crank's `spanDays < 1`, broken by
  the clock passing midnight. (3) this one, "no ACP sockets on the host",
  broken by arming a consumer of the ACP lane. All three were written as
  hygiene invariants and were correct when written. The fix in each case was
  the same: assert a **delta** against observed baseline, not an absolute
  about shared state.
- **Consequence for the D3 acceptance measurement** (`0a03c00`): three
  instrument changes landed on this host inside ~100 minutes — the tier-0
  narrowing (`1785990600996`), the `0.3.0 → 0.4.0` plugin deploy which shifts
  `pluginVersion` mid-window, and the sensor going live (`1785996709580`).
  Any D3 effect claimed from this window without segmenting on all three is
  uninterpretable. Recorded before anyone reads a clean before/after out of it.

## P2 bench: two launches, two burns, zero data (2026-08-09/10, yoo-mac) — the "silent done" shape, twice

First-ever live P2 spend attempt (arms a1/a3/a4, ≤112 container executions,
haiku). Both launches produced structurally valid results files full of
garbage; both root causes were invisible to every test because every suite
fakes the exec seam, and both were caught only by reading the LIVE run.

- **Launch 0 (the no-op that almost wasn't caught).** READINESS's invocation
  lines called `bun opencode-plugin/src/bench/cli.ts` — a LIBRARY whose
  `main()` is exported but never self-invoked. All three arms "completed" in
  4 seconds, rc=0, zero containers; `p2-tally` then happily wrote an
  all-zero verdict, because it does not die on missing results files.
  Corrected pre-data (`10baf37`): the entry point is
  `bun term-bench2/runner.ts`. Proven with a deliberate wrong `--go 1`
  (fence refused pre-container, zero effect). **Rule: tally only when all
  three results files exist; an rc=0 sized-go that returns in seconds is a
  no-op, not a fast win.**
- **Launch 1: container auth never wired.** `runOneP2Attempt` created
  containers with `mounts: []` — dropping the oauth credential mount, the
  onboarding claude.json, and `IS_SANDBOX=1`. Without that env var the CC
  CLI refuses `--dangerously-skip-permissions` as root: rc=1, message on
  STDERR only, stdout EMPTY — and `classifyAttempt` reads stdout only, so
  empty classifies **"done"**, turns=0, `agent_no_output`, no retry, no loud
  anything. The whole a1 arm burned as no-ops (zero token spend — the CLI
  never reached the API). Fixed by mirroring cmd-run.ts's auth lifecycle
  (merge `59fa76d`, artifact `05e3d1d-p2-container-auth-fix.md`), validated
  live (turns=27, compliant). cmd-p2 had mirrored cmd-run's create SHAPE but
  not its auth LIFECYCLE — the seam every test fakes is exactly where the
  two diverged.
- **Launch 2: the host oauth token expired mid-run** (00:57 KST, ~2.2h in).
  a1 ran real until then (turns~29, rewards landing); the a1 tail + ALL of
  a3/a4 burned as auth refusals — 69 "NOT retrying" lines, again zero token
  spend. The per-attempt keychain export means every attempt AFTER expiry
  fails identically; serial arms turn one expiry into two dead arms. The
  monitor tripwire (`turns=0`) never fired because the auth path prints no
  `turns=` line at all — **the failure mode changed its log signature and
  the tripwire was pattern-matched to the previous failure**. Results
  deleted, rerun held by user (standing rule: re-run infra noise, don't
  engineer expiry prevention).
- **The shape worth naming (rhymes with 08-06's delta-vs-absolute entry):**
  a classifier that reads one channel (stdout) treats "process failed before
  producing anything" as "process finished having done nothing" — and every
  downstream layer (results schema, tally, monitor) faithfully launders the
  silence into well-formed zeros. Both burns are the same defect class at
  different layers. Recorded hardening candidates (deferred, in the 05e3d1d
  artifact): rc!=0 + empty stdout should classify transient or a distinct
  `agent_hard_fail`, never "done"; a4's re-pass ignores rc entirely; and on
  linux hosts prepareClaudeCodeAuth mounts the operator's real `~/.claude`
  (including memory that NAMES P2) rw into agent containers — needs a ruling
  before any WSL-host P2 run.
- **Net cost:** ~150 container executions, ~3.5h wall clock, ~30 real haiku
  calls' worth of a1 work (the only genuine model spend, and the only real
  data — discarded with the rest for a clean rerun). Machinery is now
  live-proven end-to-end: staging, agent, verifier, review daemon pre-start,
  results plumbing all worked in launch 2's clean window.
- **HARDENING SHIPPED (2026-08-10, yoo-dev, `ff8dbb8` — closes the deferred
  candidates above):** (1) both drivers' `classifyAttempt` now treat rc!=0 +
  no-activity + EMPTY stdout by consulting STDERR — AUTH_ERROR_RE match
  classifies `auth` (fail-fast; launch 2's expiry class), anything else
  `transient` (bounded retries, visible marks; launch 1's IS_SANDBOX class)
  — never `done`; pinned as a cross-driver contract test so future drivers
  inherit it. (2) a4's re-pass exec is classified like any attempt (timeout
  included); a dead re-pass records `rePassHardFail:true` in the results
  annotation + judge sidecar with a loud log line — compliance still reads
  final container state, so it degrades to the pass-1 verdict instead of
  silently pretending the re-pass ran. (3) `p2-tally` refuses (exit 1,
  names the missing files, writes no verdict) unless ALL THREE arm results
  files exist — the launch-0 rule codified; malformed-content reads stay
  tolerant, existence is the hard bar. NOT covered (needs its own ruling,
  blocks WSL-host P2): linux `prepareClaudeCodeAuth` rw-mounts the
  operator's real `~/.claude` (including memory that NAMES P2) into agent
  containers.

## Sensor cadence checkpoint: rulings + reader (2026-08-11, yoo-mac) — the 08-13 reading locked before the number exists

Instrument-governance entry, zero spend, zero trials. The 2749fd5 arming
review's two caveats — open since 08-06 — were both resolved by user ruling
and the resolution was machined, not just recorded.

- **Ruling 1 (what counts):** one event toward the ≥25/day bar = one pass
  line with a DISTINCT `(baseSha, headSha)` pair within its calendar day;
  repeat reviews of an unchanged main diff collapse to one per day; skip
  lines never count. Reader-side only — stream/constants untouched, no
  boundary ts. Ruled and committed (`2c51d07`) explicitly BEFORE either
  counting method was evaluated against the collected data, so the 08-13
  reading cannot be definition-shopped after the fact.
- **Ruling 2 (env reach):** the worktree gap (armed env never reaches
  fresh worktree sessions) is deliberately NOT fixed mid-window; it folds
  into the 08-13 constants amendment — at ~3/day realized the bar fails
  and constants return to the user anyway, so reach + debounce/cap + the
  new boundary ts land as ONE instrument change instead of two.
- **Reader shipped (merge `5bdb88c`, artifact
  `7a2fec8-sensor-checkpoint-reader.md`, 0 findings, TDD 10 tests):**
  `bun scripts/sensor-checkpoint.ts` = the whole checkpoint. Defaults
  pinned to the pre-registration (boundary ts `1785996709580`, bar 25)
  and echoed in output; day semantics byte-match the sensor's own
  `getDayKey`; malformed/torn lines surfaced, never silently dropped or
  counted; `computeB2Shadow` untouched (different pre-registration).
- **Same session:** p2-tally aggregation gap closed (merge `18f584e` —
  a4 verdict carries `reviewTruncatedCount`/`rePassHardFailCount`;
  legacy annotations keep their compliant bit); A/A union finding —
  yoo-dev snapshot stale since Jul 31, ALL trial-arms rows host-local
  there; yoo-mac side exported (`c160461`, 132 lines). Process: the 7b
  gate blocked a hand-typed-SHA artifact exactly as designed, and a
  blanket `add -A` after a worktree install swept a stray bun.lock line
  into a reviewed range — add named files only.
- **RERUN #3 (2026-08-11, yoo-mac, user go) — the machinery finally paid
  out, then user-paused.** Launched 00:24 KST on `ef7f422` (hardened
  classifiers + tally refusal live). Zero auth burns, zero silent-dones
  across the whole night — both prior failure classes stayed extinct under
  the `ff8dbb8` contract test. **a1 = the first clean P2 arm ever:** 28/28
  real attempts, pass 7/14 (0.500), compliance 25/28 (0.893), one honest
  timeout, committed as data (`dac0d14`). a3 reached 21/28 (12 passes —
  running AHEAD of a1's pass rate) before the user paused at 06:47 KST:
  SIGSTOP on the runner + exec client, `podman pause` on the container —
  caught in staging, so no model call was severed. a4 never started; the
  keychain token (expires 08:10 KST) would have crossed mid-a4, and the
  pause converts that from a burn into a scheduling choice. Resume/abort/
  restart procedures + frozen pids live in resume.md's LIVE STATE block.
  Lesson banked from the night as a whole: the burns were never the
  benchmark's noise — they were the harness's own silent-done shape, and
  once that shape was closed the very next run produced arm-grade data on
  the first try.

## 429 is per-TRANSPORT (2026-08-11, `yoo-dev`) — a gate that reported WALLED for a lane that was wide open

The question was "is opus-5 quota-blocked?" The honest answer turned out to
depend on a word nobody was saying: *through what*.

- **The measurement.** Same minute, one account, one oauth token, two lanes:
  bare-SDK (`@anthropic-ai/sdk` `messages.create`, what `scripts/probe-models.sh`
  drives) returned `sonnet-5=ERR429  opus-5=ERR429`; the CLI-shaped lane
  (`@anthropic-ai/claude-agent-sdk` `query()`, what the warm lane drives)
  returned **OK for all three**. Two confounds were ruled out before the claim
  was allowed to stand: bare-SDK was re-probed *concurrently* and still 429ed
  (so not time-scoped), and model identity was taken from
  `modelUsage`/`canonicalModel` rather than inferred from a success (so not a
  silent fallback to a cheaper model). **Quotas are per tier AND per transport.
  A 429 verdict is never an account fact.**
- **The defect it exposed.** `docs/resume.md` prescribed the bare-SDK probe as
  *the* gate before a TB2 batch — but TB2 runs `--driver claude-code`, which is
  CLI-shaped. The gate would have reported WALLED and blocked an opus-5 batch
  that could have run. `probe-models.sh:11-14` had documented only the
  *false-CLEAR* direction (a CLI probe wrongly clearing a bare-SDK batch); the
  **false-WALLED inverse was undocumented, and it is the one that fired.** The
  chain check that followed matters as much: the channel chain is genuinely
  walled, because `channel-run.ts callChannelModel` is bare-SDK end-to-end —
  swapping *its* probe to the agent lane would have been the false-CLEAR
  failure, firing 315 opus calls into a 429ing lane.
- **ACP end to end, not just the transport.** A `query()` probe proves the lane,
  not the subsystem. A real `ensureDaemon` + `daemonCall` run confirmed opus-5
  through the daemon (haiku 781ms, opus-5 3111ms) with `setModel()` exercised on
  the haiku→opus switch and model proven over the wire each time. Worth noting
  the daemon reports the **dated** id (`claude-haiku-4-5-20251001`) where raw
  `query()` reports the undated alias — exactly why `modelProvenBy` is a prefix
  match and not equality.
- **A surface that cannot answer the question asked of it.** `daemonCall` reads
  `api_retry.error_status` as a *diagnostic* and then collapses every failure to
  `call-consumed`/`no-call`. A 429, a turn-budget expiry and a `setModel` failure
  are indistinguishable there. Any probe that needs the status must read the
  frame itself.
- **The isolation trap, measured rather than reasoned.** `KKAMAK_ACP_SOCKET` is
  IN `ACP_ENV_DENYLIST`, so binding a private socket does **not** fork the daemon
  fingerprint: socket-only kept the host fp `5d99637bd3db` while
  `KKAMAK_ACP_TEST_MARKER` forked it to `9dfa3abacb95`. A socket-isolated probe
  would have shared the **host's** `~/.config/acpd/` discovery file and deleted
  it on stop. The package's own `tempEnv()` is the wrong template for a *live*
  probe for the opposite reason — it overrides `HOME`, which hides the real
  credentials. Marker-only forks identity while keeping auth.
- **Shipped:** `scripts/probe-acp.sh` (`9745db6`, local, unpushed) — both lanes,
  live-verified, bound to the package's stable exports. Its first revision
  imported `GAUGE_ISOLATION` by plugin-internal path and **broke outright** when
  the ACP subsystem was extracted to `@th-yoo/cc-api-daemon`; the lesson is
  bound into the file. ACP line numbers now live at `~/z2/cc-api-daemon`
  (HEAD `33f74db` == the pin), never in this repo.
- **Not a bug, recorded so nobody waits on it:** a probe daemon self-exits but
  leaves its discovery entry behind — `acp-daemon` has no unlink, `readDiscovery`
  is documented structural-only, and `ensureDaemon` takes over a dead entry.

**The meta-lesson, and this session was the victim of it.** The session opened
on `e44d059` (2026-08-06) and ran across a five-day gap; sibling sessions in the
same checkout advanced main **147 commits** and added **734 lines** to
`resume.md` underneath it. It carried that stale HEAD as "current" for its whole
length and framed every recommendation against a state that no longer existed —
the same defect shape logged three times on 2026-08-06 (registry-is-empty,
spanDays<1, no-ACP-sockets), now in its slowest and least visible form: not a
resource a second user touched, but a *baseline* a second user moved. The
countermeasure is unchanged and was applied at the end: assert a delta against a
re-read baseline, never a remembered one.

## The gate caught nothing; review caught two (2026-08-11/12, `yoo-dev`) — dogfooding kkamak on kkamak, and what a green streak is evidence of

The public plugin had never emitted a sensor line. Every number in kkamak's
own dogfood log — 71 lines across three version regimes — came from the
private `cc-gate-plugin` research build, and the log itself said so. Closing
that gap needed a session where the released plugin was the only gate
present, which is harder than it sounds: both implementations resolve `root`
from the same hook-payload `cwd` and both default to
`.km/gate-outcomes.ndjson`, so installing them side by side means two Stop
hooks appending to one file. The answer was an isolated `CLAUDE_CONFIG_DIR`
holding `kkamak@kkamak` and nothing else, pointed at a throwaway worktree.
Thirteen cycles later the gap was closed and the interesting result was not
the one being looked for.

**The scoreboard.** Across 13 cycles the gate caught **zero real defects and
one false positive**. Three independent architect reviews found **two genuine
defects**, both in code the gate had already accepted with a fully green
suite. The second is the one that matters: the fix for the first defect
closed the A-slow/B-fast interleaving and left A-fast/B-slow unguarded,
reproducing the *identical* headline symptom — a later unrelated turn
exhausting with zero blocks issued. Its author had written a genuine,
non-circular test for the ordering they thought of. No test existed for the
mirror image, because nobody thought of it.

**Why the suite could not have caught it.** For both concurrency changes the
implementation and its tests were authored in the same turn, and a test
written to match an implementation passes by construction. The check proves
"nothing already pinned broke" — which it genuinely did, a breaking
`StateStore` port signature rippled through kernel and both adapters against
319 pre-existing tests that could have failed. It cannot prove "the new code
is right", and it cannot pin what nobody considered. Same shape as the
2026-08-07 finding that a check cannot observe the environment it runs in.

**The one block, and what it actually was.** Cycle 9 produced
`["verify-failed","accepted"]` — the first block-then-accept ever observed on
the rewritten kernel, unmanufactured, arising from the fix for the
review-found defects. But the failing check was a **false positive**:
`test/imports.test.ts` scans raw source with a regex and is not
comment-aware, so the prose `from "old and merely / slow"` inside a doc
comment read as an import. It was resolved by **rewording the comment**, not
by fixing the scanner. That is gate-avoidance pressure in the shape the
`cc-api-daemon` entry documented — except operator-produced, under the very
gate being measured, and it would have gone unrecorded had the commit body
not said so plainly. Filed in kkamak's known-issues; only the comment moved.

**Two runbook premises died on contact with execution.** `install-verification.md`
had never been run. Running it for 0.4.1 found five defects, three of which
would each independently produce a false "the release is broken" reading —
including that an isolated config re-roots *credential* lookup on Linux too
(the file claimed otherwise), and that headless `claude -p` needs
`--permission-mode acceptEdits` or the write is auto-denied, the gate never
arms, and no sensor line is written at all. Two more were the operator's own
overclaims, corrected the next morning: a credential **symlink** does not
survive a token refresh (CC unlinks and rewrites; measured overnight, the
isolated copy expired while the real one moved on seven hours later), and
`claude auth status` reports **presence, not validity** — a nine-hours-expired
credential still read `loggedIn: true`, exit 0.

**And the premise underneath all of them.** The file described itself as "the
procedure a maintainer runs after pushing the tag, to prove the release is
installable." It does not test a tag. `claude plugin marketplace add` clones
the **default branch**, and the cache directory is named from `plugin.json`'s
`version` field. A clone taken while `main` sat five commits past `v0.4.1`
checked out `main` — and still produced a `.../0.4.1/` path. So the 0.4.1
verification proved `main@aec746a` installable, not the tagged tree; it held
only because those five commits were docs-only. 0.4.2 was therefore verified
first and the *verified commit* tagged. The user asked the question that
surfaced it — "isn't it good tag after test?" — against a plan that had the
order backwards.

**The meta-lesson.** Every substantive correction this session came from
*executing* a procedure or *reviewing* code. Not one came from a check
passing, and the single time a check failed it was wrong. A green gate is a
real but narrow claim, and the failure mode is treating its silence as
coverage — which is exactly how a concurrency fix shipped twice while
reproducing the bug it existed to eliminate. Raw evidence preserved at
`evidence/kkamak-sensors/yoo-dev/kkamak-selfgate-0.4.1-dogfood.gate-outcomes.ndjson`;
`pluginVersion` alone cannot attribute it, since the two implementations'
version spaces overlap on `0.4.0` and `0.4.1` — only the single-emitter
isolation can.

## Loop crank #1: minted, gated, explained (2026-08-11→12, `yoo-dev`) — the first full cycle, and the instrument was the finding

The production loop (TB2, account-global layer) completed its first
end-to-end crank: store-writing band diet (14 tasks × k=5, 70 attempts, 0
auth errors) → proposer → review gate → candidate v18 (one bullet, b7:
"budget stated + below quality threshold → switch approach") → paired ab on
an 8-task interior split → verdict → post-mortem. Every stage fired in
production for the first time. The headline is not the candidate — it's what
minting one forced the loop to reveal about itself.

**Getting a candidate out took four propose cycles and three live defect
fixes** (f913b30). The review gate free-failed EVERY layer-1 violation with
no revision round — including form, the one class fixable by pure
rephrasing, while harder rubric violations got a revision shot. The
duplicate check compared candidates against the entire rejected ledger, so
the rephrase the prompt itself invited was killed as a duplicate of its own
form-rejected ancestor. And staging was all-or-nothing: cycle 3 passed 1 of
2 bullets and threw the survivor away. Each defect was invisible until the
loop was actually cranked — the machinery had passed every test it had ever
been given.

**The ab verdict said "reject: held-out regression." The post-mortem says
the verdict text carried its own refutation.** delta −0.10 at
p_active=0.377 — the reject fired on a fixed point-estimate margin
(`delta < −0.05`), not on evidence; one discordant pair of 20 erased it.
Underneath: v17's own test-retest drift across one day (band run vs ab
arm-A) equals the entire claimed effect profile, so k=5 on a
by-construction-borderline band measures noise. Two of the operator's own
confident intermediate claims — "within-arm time bimodality proves b7's
semantics," "the reshuffle's structure proves a real effect" — died against
v17's own data on iteration 2 of a 3-iteration analysis loop. The
code-architect audit (63 calls, every artifact at source) then found what
self-review had missed: the deciding fold's regression was carried by ONE
task; and two measurement-noise sources were living inside the ab itself —
prove-plus-comm graded 3 of 4 clean, recompiling, admit-free proofs as
failed because the runner hardcoded /app as verifier cwd while the task's
Dockerfile seeds /workspace (a grading lottery, both arms); kv-store
failures were process-lifecycle bugs, one agent wrapping its own server in
`timeout 20` and declaring victory.

**Fixes shipped (3483f14):** reject now demands significance — the margin
became an accept-veto yielding inconclusive, because a reject is permanent
(it feeds the do-not-re-derive ledger) and must not be minted from noise;
`taskWorkdir()` honors the task Dockerfile's WORKDIR for agent, solve.sh,
and verifier in both run and oracle paths; v18's verdict was re-derived
under the corrected rule (reject → inconclusive, original preserved). The
overnight OAuth death mid-ab produced its own recipe: uniform ~900.1s
bilateral zeros = expired-credential signature; /login + strip the poisoned
task from the partial + `--resume` recovered cleanly.

**Crank #2 closed the arc (v20, staged 13:37):** with the ledger feeds
mended and v18's honest status restored, the proposer — unprompted — pruned
b5 on its own harmful:5 counter, rephrased the form-rejected fabrication
bullet into a run-state trigger ("about to report a count/size/state → run
one command scoped to that question"), and derived b8 as the old lesson's
correct inversion ("do not abandon a measurably-matching lead until
implemented and measured"). Both bullets condition on the agent's own run
state, not task vocabulary — the exact defect class the v18 post-mortem
identified, fixed by the loop's own next iteration rather than by operator
injection. Whether they survive a gate is crank #2's ab (pending sized go:
9 tasks — interior-8 + write-compressor, the diagnosis-source task v18's
band never re-tested — k=5, --save-all-traj).

**The meta-lesson mirrors the kkamak entry above:** the gate's green (and
red) are narrow claims. A reject verdict read as "candidate is bad" was
actually "instrument under-powered + margin rule too eager + two grading
bugs" — and the only way that surfaced was refusing to spend on the next
experiment before the last one was explained. Analysis of owned data beat
the planned A/A control run to the answer, at zero token cost.
