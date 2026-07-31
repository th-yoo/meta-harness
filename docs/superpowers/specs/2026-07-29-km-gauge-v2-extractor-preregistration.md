# km-gauge v2 — extractor — pre-registration (2026-07-29)

**Status:** REGISTERED (pre-data, 2026-07-29) — classes, mechanisms, metrics,
and decision rule locked before any v2 data exists. Build not yet deployed;
the window opens at the deploy commit (recorded below when it lands).
**Supersedes:** the v1 derivation design whose M0–M3 window CLOSED 2026-07-29
with **M2 FAIL (9/10 false-block)** — analysis in
`2026-07-28-km-gauge-poc-preregistration.md` §7. v1 window data is NOT reused
here; it motivated the design and is cited as evidence only.
**Mode:** SHADOW ONLY, unchanged. The gauge never blocks, never changes any
completion-gate decision (invariant test-locked, `af0a132`).

## 0. Root cause this design answers

v1 asked one prompt-time haiku call to invent both the meaning of "done" and
its observable test, from an input that provably lacks the required
information (paths, conventions, workflow, timing). It guessed; guesses were
90% wrong when they would have blocked. Three gaps, measured: the world gap
(never saw the repo — hallucinated paths, adopted a false premise from prompt
text), the semantics gap ("done" is a workflow outcome, not a worktree
predicate — dirty-tree proxies, repo-wide greps for template-scoped intents),
the timing gap (multi-turn tasks graded at first Stop, mid-flight).

The measured success signature: gauge was right exactly when the prompt
itself contained the operationalization (explicit path + observable
property) — it EXTRACTED. It was wrong when it INVENTED. v2 makes that
boundary structural: **extraction only, enforced in code, never trusted to
the model.**

## 1. Prompt classes (ratified by user 2026-07-29)

Test for a proper class: distinct action, decidable at classification time,
mutually exclusive. One decision axis, one scheduling axis:

| Class | The completion criterion lives... | Action |
|---|---|---|
| **A1** | nowhere — no evaluation needed (greeting / chat / trivial) | no check, reason `no-eval-needed` |
| **A2** | in reply/behavior QUALITY — real criterion, not shell-checkable (research / review / judgment / plan goals) | no check, reason `not-shell-checkable` |
| **B** | in the repo-owned check already ("fix the failing tests", "make the build green") | no check, reason `floor-covered` |
| **C** | **in the prompt text, artifact inside the repo** | extract check; schedule by horizon |
| **D** | exists, but requires invention or out-of-repo observation | no check, reason `not-extractable` or `out-of-scope` |

*Amendment lineage (pre-data, 2026-07-29):* the original registration had a
single class A (`no-criterion`), conflating "nothing to evaluate" with
"evaluation needed but not shell-checkable" — user-identified the same day,
before any v2 data existed. A2 is deliberately NOT served by gauge: deriving
reply-quality judgment would repeat v1's invention mistake one level up with
no deterministic enforcement possible (L4: LLM detectors ≈63%). The sound A2
instruments are the calibrated judge-shadow path (opencode
`SessionRecord.judge` precedent, agreement-vs-human-labels) and human
`/mh-score` — out of gauge's scope. What v2 DOES take on: measuring the A2
share of daily work (measurement before instrument) — if the window shows A2
is a large share, that number is the case for investing in judge-shadow
calibration; if small, learned cheap. Behavior (as opposed to reply content)
is already objectively graded by the sensor stream itself (§4.3's reward
channel); A2's gap is reply content only.

Horizon (C only): `single-turn` (evaluate at next Stop) vs `multi-turn`
(two-strike deferred confirmation, §3). "Task-shaped" (v1 classifier)
survives only as the cost prefilter deciding whether to spend the haiku
call; it is no longer a semantic boundary.

v1's failure restated in these terms: it collapsed B, C, D into one
"derive" class; D is where the 90% lived.

## 2. Mechanisms

1. **Prefilter (unchanged):** deterministic `isTaskShaped`; not task-shaped →
   no spawn, no class.
2. **Refiner v2 = classifier + extractor (one haiku call, unchanged cost):**
   output schema
   `{goalSummary, class: "A1"|"A2"|"B"|"C"|"D", reason, criteria[], check: string|null,
   horizon: "single-turn"|"multi-turn"|null, confidence}`.
   `check` non-null iff class C. The check may reference ONLY paths that
   appear literally in the prompt text, and must test a property the prompt
   states.
3. **Deterministic extraction enforcement (the key mechanism — model output
   is distrusted, code enforces the information bound):** post-parse
   validation in plugin code, not the model:
   - every path token in `check` must appear verbatim in the prompt text,
     else the derivation is downgraded to D `not-extractable`;
   - any referenced path resolving outside the repo root (absolute paths,
     `~/…`) downgrades to D `out-of-scope` (v1's plan-file failure class);
   - class B keyword screen (conservative list: the armed check command's
     own tokens, "test(s) pass", "build green") may override C→B;
   - the read-only guard (v1, unchanged) still refuses non-read-only checks.
   A downgraded derivation is recorded with both the model's claim and the
   downgrade reason — misclassification becomes measurable.
4. **Eval scheduling (timing gap):** class C `single-turn` → evaluate at the
   next Stop (v1 behavior; the measured success class). Class C
   `multi-turn` → **two-strike rule:** a failing evaluation does not record
   `wouldBlock` — the pending file is kept with a first-strike marker;
   `wouldBlock` is recorded only on a second consecutive failing evaluation
   at a later Stop. A pass at either evaluation records a pass. Bounds
   mid-flight grading; does not claim to solve the completion-detection
   circularity (recorded limitation).
5. **Sensor:** the `gauge` field gains `class`, `reason?`, `horizon?`,
   `downgraded?`. `wouldBlock` is only possible for class C. The null-reason
   distribution (A/B/D counts) becomes a first-class measurable instead of
   an autopsy artifact.

*Amendment lineage (pre-data, 2026-07-29, build-review):* build review
sharpened §2.4/§2.5 beyond the original registration, still before any v2
data exists. (a) Two-strike (§2.4) refinement as built: strike advancement
requires a real floor-gate cycle — an edited turn whose completion-gate
cycle ran. At a Stop with no floor cycle (fast-path/planning turns), an OPEN
multi-turn-C pending is NOT evaluated at all: the check does not execute,
the pending is left untouched, and the sensor line carries a
passthrough-only gauge field (class/horizon/strike passthrough,
`executable:false`, no `pass`/`wouldBlock`). Without this, planning turns
could burn both strikes pre-work — mid-flight grading, the exact failure
§2.4 exists to damp — or re-execute the check unboundedly. Single-turn C is
unchanged: it still evaluates at any Stop. (b) Sensor (§2.5): the gauge
field also records `strike: 1|2` — a first-strike marker or terminal second
strike. (c) §3's metrics computation rule: M1v2 and M5 are computed PER
DERIVATION, not per line — dedupe by `(sessionID, n)` using the terminal
line (or the `.done.json` audit) so one derivation is one M1v2/M5 unit;
passthrough-only lines (`horizon === "multi-turn" && rounds.length === 0`,
no `pass` field) are excluded from M1v2's denominator. (d) Footnote: the
operational v2-window filter (score.ts) is class-presence on the gauge
field — only v2 lines carry `class` — a strict subset of the registered
deploy-timestamp cut; a stale pre-deploy refiner writing a v:1 pending
after the deploy commit self-excludes.

## 3. Pre-registered metrics + decision rule (fresh window)

Window: ≥30 task-shaped prompts accumulated AFTER the v2 deploy commit,
union stream (armed repos, both hosts welcome), no calendar deadline.
**Validity floor: ≥5 class-C derivations in the window** — below that at 60
task-shaped prompts, the extractor is over-refusing: one redesign round
allowed, then re-run. v1 lines never mix into v2 metrics (deploy-commit
timestamp is the cut).

- **M0 coverage (unchanged bar):** derivation present at some Stop for ≥70%
  of task-shaped prompts.
- **M1v2 executable precision (redefined — v1's M1 rewarded volume):** of
  class-C derivations, ≥90% run to a clean 0/1 exit (guard refusals and
  126/127 count as misses). Class-C RATE is reported but carries NO bar —
  coverage loss is the accepted price of extraction discipline; measure the
  trade, don't hide it.
- **M2 false-block (unchanged bar — the metric that killed v1):** of
  would-have-blocked lines, ≤20% judged WRONG at the user's end-of-window
  review.
- **M3 value existence (unchanged):** ≥1 would-have-blocked line judged
  RIGHT where the completion-gate floor accepted (fast-path accepts count,
  per the 2026-07-29 user ruling).
- **M4 classification honesty (descriptive, no bar):** user labels a sample
  of ≤10 null-check lines at review — how many were actually extractable C.
  Feeds the next design round; deliberately not a pass/fail criterion
  (small-N honesty).
- **M5 A2 share (descriptive, no bar — amendment 2026-07-29):** fraction of
  task-shaped prompts classified A2 (`not-shell-checkable`) over the window.
  This is the sizing number for whether a calibrated reply-quality
  judge-shadow instrument is worth building; it decides investment, never a
  gauge verdict.

**Decision rule (locked):** all of M0/M1v2/M2/M3 pass → a blocking-pilot
design may be written (folded into the §4.3 trial machinery, per the v1
intent). **M2 fails again → per-task check derivation is KILLED — two
designs, two M2 failures, no third window without a fundamentally new
information channel (tool-using refiner class, out of scope here).** M0 or
M1v2 fail → one redesign round, then re-run. No p-values; counts and user
labels only.

This is the user's 2026-07-29 "fix or drop" directive made operational:
v2 is the fix; v2's failure is the drop.

**PRE-VERDICT AMENDMENT (2026-07-31, corpus-replay amplification; no §3 verdict
has been read — the live window's class-C validity floor is unmet, recomputed
2026-07-31 by direct script tally across all three armed streams' gauge fields:
1 class-C of 72 gauge-classified lines UNION (kkamak 30: A1×1 · A2×11 · B×11 ·
C×1 · D×6; meta-harness 40: A1×12 · A2×14 · B×6 · D×8; km-play 2: B×1 · D×1) —
so every bar amended here is still unconsumed. Since gauge-classified lines are
a lower bound on task-shaped prompts, the window has plausibly already crossed
§3's 60-prompt over-refusal checkpoint with class-C still at 1 — meaning §3's
own remedy (one extractor redesign round) may already be AVAILABLE on live
grounds alone; this amendment is registered alongside, not instead of, that
reading, and consuming the redesign round remains a separate §3 decision. Lineage note: styled as its own block rather than the italic
*Amendment lineage* convention above, deliberately — those were pre-data
amendments to unmeasured definitions; this is a pre-verdict amendment to an
open, partially-accumulated window, a distinct class):** the class-C starvation
risk is an event-rate problem of exactly the shape Phases 2-3 solved for other
rare classes (GA7/GA8): the measurement is fine, the live event supply is thin.
This amendment registers an **offline corpus-replay evaluation channel** that
raises the event count feeding the M1v2 bar (and its validity floor) — no
threshold, class definition, or shadow-invariant changes anywhere in this
block; the two places it touches §3's decision-rule MECHANICS are stated
explicitly in point 5, not left implicit.

1. **Instrument.** The v2 deriver (same prompt, same model, same extraction and
   validation path) may be run OFFLINE over two captured-prompt corpora:
   (a) real task-shaped prompts mined from Claude Code session transcripts
   (the JSONLs CC keeps under `~/.claude/projects/<slug>/`, joinable to sensor
   cycles by sessionID + ts; Phase 2's `transcriptPath` capture where a
   block-cycle fixture-ref exists); (b) TB2 bench task instructions, executed
   against the task's containered state. Each corpus derivation is one
   M1v2-unit with a mandatory `provenance` field:
   `live` | `corpus-transcript` | `corpus-bench`.
   **Prompt inputs may predate the v2 window — a stated departure from the
   fresh-window framing, justified narrowly:** the fresh-window rule (§1)
   bars v1-era MEASUREMENTS from v2 metrics; corpus replay produces fresh v2
   OUTPUTS on old prompt INPUTS, and no v1 derivation output ever enters any
   corpus number.
2. **Execution-state resolution (pool eligibility).** A corpus-transcript
   class-C derivation enters the M1v2 pool ONLY if its check executed against
   a well-defined state, resolved in this order: (i) the same-cycle Phase 2
   fixture-ref tree, where one exists (block cycles only — `fixture-ref.ts`
   captures nothing on accepts); (ii) otherwise the first commit in that
   repo whose committer timestamp is ≥ the prompt's cycle `ts`, same host as
   the cycle's sensor-line `host` field, within 7 days — the post-turn commit approximates the state the turn
   produced, adequate for M1v2's MECHANICAL property (command parses,
   resolves its binaries/paths, exits 0/1) though never for correctness
   judgments, which this pool does not feed; (iii) no resolvable state → the
   derivation is DESCRIPTIVE only (class-C rate, extraction shape), never
   pooled.
3. **What pools and what does not.** M1v2 (executable precision) may be
   computed over POOLED live + pool-eligible corpus-transcript class-C
   derivations at the unchanged ≥90% bar, with the unchanged ≥5-event floor
   satisfiable by the pool **provided ≥1 event is live** (an all-corpus M1v2
   is reportable but cannot alone satisfy §3's M1v2 leg). Corpus-bench M1v2
   is DESCRIPTIVE only (distribution shift: bench prompts are not dogfood
   prompts). M0, M2, M3, M4, M5 are UNCHANGED and live-window-only — M2's
   wrongness judgment stays a user-labeled live review; corpus-derived
   would-block/wrongness evidence may be shown to the user AT that review as
   context, never counted in M2's denominator.
4. **Provenance split is mandatory in any verdict text** — pooled M1v2 must be
   reported as `live a/b · corpus c/d · pooled ≥90%?`, never as one number.
5. **§3 interaction rules (consumption ordering + unwind, explicit):**
   (a) a pooled M1v2 pass permits the blocking-pilot design to be WRITTEN
   (cheap, reversible doc work) but NOT registered or deployed — §3
   decision-rule CONSUMPTION requires live-only class-C n≥5 confirming ≥90%
   first; (b) a redesign round triggered SOLELY by a pooled M1v2 fail is
   provisional: if live-only data at n≥5 later passes, the spent
   redesign-round allowance is restored; (c) if live-only precision at n≥5
   contradicts a pooled pass, the live reading GOVERNS, the pooled pass is
   void, and any design written under (a) is shelved un-actioned. All three
   recorded before data exists on either side.
6. **Cost fence:** corpus replay is batch haiku spend outside §4's daily cap —
   each batch needs its own explicit go, sized in the go (prompts × 1 call).
7. **What this cannot do (restated to prevent drift):** it cannot unshadow the
   gauge, cannot substitute for M2/M3, cannot lower any bar, cannot count
   toward the §3 window's ≥30-prompt accumulation NOR toward the 60-prompt
   over-refusal checkpoint (both live-only), and does not extend the
   two-strike kill rule — a second M2-class failure still kills the
   derivation regardless of any corpus result.
8. **Build items (addendum to §6, each gated on its own explicit go):**
   (i) transcript miner (session JSONLs → task-shaped prompt corpus,
   sessionID/ts join); (ii) offline replay runner (deriver batch mode +
   `provenance` stamping); (iii) execution-state resolver implementing
   point 2's order.

## 4. Cost fencing (unchanged) + deploy

Haiku, exactly 1 call per task-shaped prompt, daily cap 30
(`.km/gauge/daily-count`), opt-in `"gauge": true`, kill switches
`KKAMAK_GAUGE=off` + `scripts/km-panic.sh gauge-off`. Deploy REQUIRES the
installed-plugin cache refresh (marketplace update + uninstall + install) —
the standing watch-item; a stale cache silently runs v1 and poisons the
window. **Deploy: build head `1cad4ba` (v0.2.0), installed-cache refreshed
2026-07-29T16:00+09:00 (office `yoo-dev`); active cache verified 0.2.0 with
v2 code (validate.ts present, two-strike in shadow.ts, vendor intact); a
stale leftover 0.1.0 cache dir was found beside it and removed — the
version-dir enumeration gotcha is real, verify via `claude plugin list`,
not by picking a cache path. THE WINDOW OPENS HERE (office; MacBook joins
at its own refresh after pull).**

## 5. Non-goals (v2)

No blocking. No invention (structurally enforced, not prompted away). No
tool-using or multi-call refiner. No out-of-repo observation. No completion
-detection oracle (two-strike is a damper, not a solution). No §4.3
integration before a blocking-pilot design exists. No opencode port.

## 6. Build items (separate go)

(1) refiner.ts: v2 prompt + schema + parse (class/reason/horizon fields);
(2) NEW validate.ts: path-in-prompt enforcement, repo-scope check, B-keyword
screen, downgrade records; (3) shadow.ts: two-strike pending state for
multi-turn C; (4) types.ts: gauge sensor field extension; (5) score-cli
gauge block: class/reason/downgrade counts; (6) tests per mechanism incl.
downgrade matrix + two-strike sequences + invariant lock untouched;
(7) cache refresh + deploy-commit recording in §4.

## 7. Known risks

- Extraction discipline may over-refuse (class-C starvation) — the validity
  floor measures it and routes to redesign, not silent death.
- B-keyword screen is heuristic; a wrong B eats a legitimate C — M4 sample
  catches the rate.
- Two-strike halves the false-block class it targets only if mid-flight
  failures are transient; persistent mid-flight states (long multi-turn
  tasks) can still double-strike — recorded limitation, M2 measures it.
- Prompt-quoted false premises (v1 case #8) survive when the false premise
  names a real repo path — extraction enforcement narrows but does not
  close this channel.
