# km-gauge PoC — pre-registration (2026-07-28)

**Status:** APPROVED 2026-07-28 (user) — metrics M0–M3 + decision rule locked.
**User reservation:** `.km/gauge/<sessionID>-<n>.json` file layout disliked —
accepted for PoC only; revisit storage shape before any blocking pilot.
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

## 5b. Live smoke 2026-07-28 (office, tmux, 4 real haiku calls) — LOOP CLOSED

- **Full pipeline proven live**: task prompt → classifier → detached haiku
  refiner → pending file → next-Stop shadow eval → sensor line with `gauge`
  field (`pass:true, agreesWithFloor:true, executable:true, conf 0.95`) →
  `.done.json` audit. Derived checks 3/3 correct + executable (round 3's ran
  and PASSED against work it had never seen: doc-comment regex matched).
- **Derivation latency 10.7s / 40.9s / 15.8s** (haiku, high variance).
  One-shot headless turns finish first → 0/2 consumed at own Stop (M0 misses
  by design of the run shape); interactive next-turn consumption worked 1/1 —
  the dogfood shape the PoC targets.
- Ops gotchas: tmux send-keys needs text and Enter as SEPARATE sends
  (bracketed-paste swallows combined submit); first-run trust dialog stalls
  scripted interactive sessions (pre-trust the dir once).
- Noted semantics: deferred consumption evaluates prompt-N's gauge after
  prompt-N+1's work started — acceptable shadow noise, revisit at blocking
  pilot alongside the storage-shape reservation.

## 5c. Safety guard + window OPEN (2026-07-28)

Before arming a real repo, `src/gauge/guard.ts` was added (TDD, 9 tests):
derived checks are refused unrun unless plainly read-only — writes, `sudo`,
network, state-changing git/package commands, in-place editors, file
redirection, shell-escape, process control. Refusals record
`gauge.refused: "<reason>"` with `executable: false` (counts as an M1 miss,
never a repo risk). Validation: all 4 checks haiku produced in the live
smoke pass the guard unchanged; patterns are word-anchored (`formula` does
not trip `rm`, `sudoku` does not trip `sudo`).

**WINDOW OPEN:** `gauge: true` committed in this repo's `gate.json` — every
kkamak-loaded session here (both hosts after pull) contributes to the M0–M3
window. km-play (office) also armed. Analysis when ≥30 task-shaped prompts
have accumulated in the two-host union stream.

**Arming is not enough — the plugin must be INSTALLED (2026-07-28).** An
armed `gate.json` collects nothing unless kkamak's hooks are loaded, and
`--plugin-dir` only loads it for that one launch. Installed locally on the
office box via a `.claude-plugin/marketplace.json` + `claude plugin
marketplace add <plugin-dir>` + `claude plugin install kkamak@kkamak-local`;
auto-load then VERIFIED with a plain `claude` run (no flag): sensor line,
gate state, and gauge refiner all fired. MacBook needs the same two commands
after pulling — arming travels via git, installation does not.

**Install bug found and fixed the same hour (silent-failure class).** The
install COPIES the plugin dir out of the monorepo, so the three imports that
escaped the plugin root (`../../minimal/…`) died with "Cannot find module" —
and the hook's fail-open contract turned that into SILENCE: exit 0, gate
inert, zero sensor data, no visible error. The first install was broken this
way and only surfaced because the cached copy was executed directly. Fix:
`vendor/` holds byte-identical copies of the four kernel modules
(complete-gate, session2, mutate, spec-probe) and `test/self-contained.test.ts`
enforces (a) no `src/` import escapes the plugin root, (b) vendored files
match their `minimal/` originals, (c) an INSTALL-SHAPE test that copies the
plugin to a temp dir and drives a real gated Stop through it.

## 6. Known risks

- Fast turns beat the async refiner → M0 measures it; mitigation candidates
  (evaluate-next-turn, lazy eval) deferred unless M0 fails.
- Weak-check risk moved up a level (refiner grades the grader) — M2 measures
  exactly this; refiner ≠ worker by construction (fresh context).
- Sensor `durationMs` human-wait inflation (SM2 finding) applies to gauge
  review timing too — interpret with care.

## 7. M0–M3 ANALYSIS 2026-07-29 (window closed, office union stream) — VERDICT: SHADOW INDEFINITELY

Window: 36 task-shaped spawns (meta-harness 32 + km-play 4), ≥30 criterion
met; office host only (MacBook uninstalled — union buys N only, absence
unbiased). User review session held 2026-07-29; labels below are the user's.

- **M0 coverage: PASS — 33/36 = 91.7%** (bar ≥70%). 3 misses = km-play
  derivations stranded pending by session end (the known one-shot shape;
  §6 risk confirmed benign at this rate).
- **M1 executable: PASS — 21/33 = 63.6%** (bar ≥60%, thin margin).
  Forensics on all 12 non-executables: every one is `check: null` — the
  refiner honestly declined on review/audit/plan-shaped goals. Zero
  malformed commands, zero guard refusals, zero 126/127. The miss-mode is
  honest abstention, not derivation failure.
- **M2 false-block: FAIL — 9/10 would-have-blocked lines judged WRONG**
  (bar ≤20%). False-block taxonomy (not random): (a) stale-context
  evaluation — checks graded before the commits they test landed
  (deferred-consumption semantics, §5b noted); (b) wrong-path assumptions
  (work in the plan file outside docs/, one hallucinated filename);
  (c) scope-too-broad greps (repo-wide match on strings that legitimately
  exist in source); (d) one inherited-false-premise case — the derived
  check absorbed a refuted claim present in the prompt text. Common root:
  the refiner derives from the prompt alone with no repo-state grounding.
- **M3 value existence: PASS — 1 RIGHT catch** (sid 27ad1b0b n=17): derived
  check `! grep -E '(Status.*DRAFT|resume\.md:(175-177|178))'` caught the
  §4.3 spec's DRAFT status + stale resume.md anchors while the completion
  gate's fast-path accepted the turn — the SAME two defects the final
  whole-branch review later flagged as must-fix, found independently and
  earlier. Floor-accepted status of the fast-path Stop: user-ruled COUNTS
  (2026-07-29).

**Decision (per the locked rule):** M2 fail → the per-task blocking layer
stays SHADOW indefinitely; no blocking-pilot design will be written from
this window. The sensor dimension alone must justify the cost (≤1 haiku
call per task-shaped prompt, daily cap 30) — keep-shadow vs kill is an open
user decision with no deadline. Any future blocking ambition requires a
redesigned refiner with repo-state grounding (the M2 taxonomy is the
requirements list) and a fresh pre-registered window; this window's data
cannot be reused for that decision.
