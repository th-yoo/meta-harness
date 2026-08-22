# Debt-instrument census — raw evidence table

Collected 2026-08-22. Census only: no judgments, no severity labels, no fix
recommendations. Rows are quotations and citations; classification against
rules happens downstream of this file.

**Corpus (read in full unless noted):**
1. `/Users/yoo/z2/kkamak/docs/known-issues.md`
2. `/Users/yoo/z2/kkamak/docs/superpowers/plans/2026-07-30-kernel-review-remediation.md`
3. `/Users/yoo/z2/kkamak/docs/superpowers/plans/2026-08-05-kkamak-0.4.1-review-debt.md`
4. `/Users/yoo/z2/kkamak/docs/dogfood-log.md` (skimmed for deferral/residual language only)
5. `/Users/yoo/z2/meta-harness/docs/resume.md` (top 700 lines / 2026-08 dated blocks only; run-results and fully-completed work excluded per instructions)

**Repo commits at collection time:**
- `kkamak` HEAD: `cb6d429af7ef495f48613042991a7d6e5de97bf5`
- `meta-harness` HEAD: `7e9f65afc61b7a3c7a39928b528231d31af7fa31`

All corpus files were readable in full; none were skipped.

---

## Section 1 — Evidence table

| ID | Repo + file:line | Status today (as doc states) | Verbatim deferral/residual sentence | Stated revisit condition (verbatim or "none stated") | Concrete satisfying event (literal reading) |
|----|---|---|---|---|---|
| KI-1 | kkamak `docs/known-issues.md:7-20` | resolved | "Judged minor because the marketplace still works without either... Resolved: both fields added." | none stated | n/a |
| KI-2 | kkamak `docs/known-issues.md:22-36` | resolved | "Judged minor because the content under each entry is accurate regardless of which heading it sits under... Resolved: the two change-shaped 0.4.0 entries moved..." | none stated | n/a |
| KI-3 | kkamak `docs/known-issues.md:38-49` | resolved | "`package.json`'s description uses 'an agent' instead of 'Claude Code'... Resolved: `package.json` now reads 'Claude Code cannot say done…'" | none stated | n/a |
| KI-4 | kkamak `docs/known-issues.md:51-79` | resolved | "README's gate.json placement instructions describe the wrong directory... Launch Claude Code from a subdirectory and the gate silently no-ops." | none stated | n/a |
| KI-5 | kkamak `docs/known-issues.md:81-90` | resolved | "README's Docs section doesn't link `docs/install-verification.md`... Resolved: README's Docs section now links [it]." | none stated | n/a |
| KI-6 | kkamak `docs/known-issues.md:92-103` | resolved | "`docs/dogfood-log.md` is opaque to readers outside the private meta-harness repo... Resolved: [it] opens with a preamble declaring its audience." | none stated | n/a |
| KI-7 | kkamak `docs/known-issues.md:105-116` | resolved | "A stray `hello` line leaks to stderr during the test run... Resolved: [the] logger test now spies on `process.stderr.write`." | none stated | n/a |
| KI-8 | kkamak `docs/known-issues.md:118-324` | resolved (multi-stage: flagged → partially → fully resolved → 2 more gaps closed) | "This exact gap was flagged and deliberately deferred in `docs/superpowers/plans/2026-07-30-kernel-review-remediation.md`, on the stated condition that it be revisited 'once the adapters exist and the real invocation model is known.'" | "once the adapters exist and the real invocation model is known" | both harness adapters (Claude Code + opencode) exist and ship |
| KI-9 | kkamak `docs/known-issues.md:326-392` | open | "**Judgement: recorded, not fixed.** A real fix needs either an actual parser... or, at minimum, stripping comments from the source before the regex runs." | none stated | n/a |
| KI-10 | kkamak `docs/known-issues.md:418-454` | open | "**Judgement: recorded, not fixed.** The consequence is bounded and one-directional... That is a design change to the decision type, not a small fix." | none stated | n/a |
| KI-11 | kkamak `docs/known-issues.md:456-502` | resolved | "Not 'left as-is' by a documented judgement... simply missed... **Resolved**, alongside a third, adjacent gap..." | none stated | n/a |
| KI-12 | kkamak `docs/known-issues.md:504-588` | resolved | "Judged minors, not gates... recorded so the judgement is visible rather than silently deferred... **Resolved**, all four, by dogfooding `oneshot` on itself." | none stated | n/a |
| KI-13 | kkamak `docs/known-issues.md:590-661` | open | "Not fixed here — beyond the four minors reviewed at checkpoint-3, needs its own review before any change." | "needs its own review before any change" | a dedicated review of `oneshot`'s Source-2 marker-count mechanism is conducted |
| KI-14 | kkamak `docs/known-issues.md:663-692` | open/conditional (standing hazard) | "**Judgement: not a defect today**... It becomes one automatically the moment a second extension is added to `EXTENSIONS`." | "the moment a second extension is added to `EXTENSIONS`" | a second extension is registered in `src/extensions/registry.ts`'s `EXTENSIONS` list |
| KI-GAUGE | kkamak `docs/known-issues.md:394-416` | resolved (field restored); recorded as a standing prohibition | "**Do not remove `gauge` from this repo's `gate.json` again** on the grounds that the public kernel doesn't read it. It is intentionally present for a consumer outside this repo's own kernel." | none stated (permanent rule, not conditioned on a future event) | n/a |
| REM-1 | kkamak `docs/superpowers/plans/2026-07-30-kernel-review-remediation.md:363` | open at time of writing (later resolved — see KI-8) | "That is left alone on purpose: whether concurrent events for a single session id can occur depends entirely on the harness adapters' invocation model, which is not yet written. ... Revisit once the adapters exist and the real invocation model is known." | "Revisit once the adapters exist and the real invocation model is known" | both harness adapters exist (same condition as KI-8; this is the original deferral record KI-8 later cites) |
| REM-2 | kkamak `docs/superpowers/plans/2026-07-30-kernel-review-remediation.md:363` | open, unaddressed | "The reviewer's other unscored note, that the no-I/O token scan would not catch `new Date()`, is speculative with no current instance; ... it is not required." | none stated | n/a |
| DEBT-1 | kkamak `docs/superpowers/plans/2026-08-05-kkamak-0.4.1-review-debt.md:620-626`; also `docs/dogfood-log.md:701-705` ("Runbook status... has **not** happened as of this entry. Installability is unproven") | resolved | "This step is a human action, not an agent action... reporting: ... installability **unproven** — a green suite is not evidence of it, and no agent action in this plan can produce that evidence." | a human executes `docs/install-verification.md` on a real machine | the runbook is run end-to-end against a real install on real hardware |
| DEBT-2 | kkamak `docs/superpowers/plans/2026-08-05-kkamak-0.4.1-review-debt.md:781` | open/unknown | "Whether `~/.claude/plugins/cache/` holds one or two version directories after an upgrade from 0.4.0. Flagged in Task 6 Step 8 as a possible runbook gap rather than guessed at." | none stated | n/a |
| DEBT-3 | kkamak `docs/superpowers/plans/2026-08-05-kkamak-0.4.1-review-debt.md:781` | unverified/undatable | "The Global Constraints' citations into the private `cc-gate-plugin` (`src/config.ts:18`, `src/gauge/spawn.ts:36`). That plugin is not present under `~/.claude/plugins/` in this workspace, so those line numbers cannot be checked from here." | none stated | n/a |
| DOG-1a | kkamak `docs/dogfood-log.md:504-512` (subject repo: `cc-api-daemon`, not `kkamak`/`meta-harness`) | open as recorded | "nothing enforced the re-enablement, so a later plan step now requires all skips removed and `grep -rn \"\\.skip\\|skipIf\" test/` to return nothing." | "a later plan step now requires all skips removed" | that later plan step runs and the grep returns nothing |
| DOG-1b | kkamak `docs/dogfood-log.md:513-522` (subject repo: `cc-api-daemon`) | open, ambiguous whether ever revisited | "A later task was supposed to delete three functions... It did not happen... The repo therefore carried two complete implementations of the same three names... through four consecutive green commits." | none stated | n/a |
| DOG-2 | kkamak `docs/dogfood-log.md:83-88` | open (per this entry) | "the second reword-to-pass-the-scanner event on record after cycle 9. Right call here... but #9's cost is now recurring, not hypothetical." | none stated (cross-references KI-9, already open) | n/a |
| MH-1 | meta-harness `docs/resume.md:33-36` | open | "STANDING HAZARD, prior to this branch: any project-GLOBAL transition still wipes both tables." | none stated | n/a |
| MH-2 | meta-harness `docs/resume.md:62-77` | open | "SHARED CHECKOUT — `git add <path>` STAGES THE OTHER LANE'S UNCOMMITTED WORK TOO... The failure is SILENT at commit time and visible only to the person whose work was absorbed." | none stated (detection/prevention only) | n/a |
| MH-3 | meta-harness `docs/resume.md:79-93` | open | "BEFORE RUNNING ANY BENCH ARM — `--layers none` SILENTLY DISCARDS YOUR TRAJECTORIES, even with `--save-all-traj`... You get a pass/fail number with NO mechanism evidence and no way to recover it." | none stated (workaround documented, defect not fixed) | n/a |
| MH-4 | meta-harness `docs/resume.md:127` | open (partial: #5 resolved, see MH-5) | "ecde549 #5/#6/#7/#8 + F8 hardening remain recorded-open on main." | none stated beyond the queue items below | n/a |
| MH-5 | meta-harness `docs/resume.md:140-144` (deferral); `docs/resume.md:109-113` (resolution) | resolved | "OPEN: **stdin-transport REDO** as its own change with fail-capable tests — main still carries the 8k judge-window bug until branch merges (user decision)." | "as its own change with fail-capable tests" then merge | stdin-transport is redone as its own reviewed change and merged to main |
| MH-6 | meta-harness `docs/resume.md:119-124` | open, own go | "**NEXT (each own go): (a) BACK-PORT cc-gate-plugin onto kkamak 0.8.0** (lab transports re-register as SendPromptProviders; reconcile deliberate type divergences... entry gate = kkamak known-issue #14 multi-extension flush ordering)." | none stated (queued task, "own go") | n/a |
| MH-7 | meta-harness `docs/resume.md:124-125` | open, own go | "(b) driver-argv prompt paths + `podman exec -i` (queued own change, out of judge-window range)." | none stated | n/a |
| MH-8 | meta-harness `docs/resume.md:125` | open, own go | "(c) kkamak #13 marker-indirection." | cross-references KI-13 ("needs its own review before any change") | same as KI-13 |
| MH-9 | meta-harness `docs/resume.md:126, 155-156` | open, standing | "(d) extract-elf-card still untracked/unowned." / "Also standing: extract-elf-card/ untracked+unowned." | none stated | n/a |
| MH-10 | meta-harness `docs/resume.md:151-154` | partial (migrate phase done, backport open — same as MH-6) | "**STRATEGY (user-ruled, own go): migrate proven instruments INTO kkamak config-gated, then BACK-PORT kkamak → cc-gate-plugin; NEVER retire the lab plugin**." | none stated (phased plan; backport half still queued) | n/a |
| MH-11 | meta-harness `docs/resume.md:203-205` | open | "Contamination hypothesis (prompt taught the 1e7 fixation the probe measured) recorded there, undecided — deciding it needs a clean-prompt re-probe, own go." | "needs a clean-prompt re-probe" | a clean-prompt re-probe is run and the contamination hypothesis is decided |
| MH-12 | meta-harness `docs/resume.md:220-222` | open/withheld | "Residual-pattern diagnostic WITHHELD (blind to two bad list entries: 0.63 vs a wrong transform's 0.65)." | none stated | n/a |
| MH-13 | meta-harness `docs/resume.md:248-249` (open item); `docs/resume.md:271-277` (partial resolution); `docs/resume.md:403` (still-open remainder); `docs/resume.md:611-627` (duplicate framing) | partial | "**Open item, both lanes: A SECOND FIXTURE** — one agreement is not transfer." → "**SECOND FIXTURE TRANSFER: ALL ARMS HELD**... one held transfer is evidence, not proof; queue item (4) above stays open in spirit, a third fixture is the actual generality claim." | "A SECOND FIXTURE" (then, after that was run, "a third fixture is the actual generality claim") | a second fixture's transfer run is registered and scored (met); a third fixture is registered and scored (not yet met) |
| MH-14 | meta-harness `docs/resume.md:276-277` | open, own go | "**Arming and the L1-ab wiring remain their own go** — nothing in this paragraph changes what ships live." | none stated | n/a |
| MH-15 | meta-harness `docs/resume.md:336-337` (queue); `docs/resume.md:96-97` (resolution) | resolved | "**QUEUE, each its own go, NOTHING authorized:** (a) MERGE `fix/judge-window` (2 commits, suite green)." | none stated beyond "own go" approval | the branch is merged to main |
| MH-16 | meta-harness `docs/resume.md:337` (queue); `docs/resume.md:96-97,` (resolution: "ALL PUSHED") | resolved | "(b) PUSH (11 ahead)." | none stated beyond "own go" approval | the branch is pushed to origin |
| MH-17 | meta-harness `docs/resume.md:337-339` | open, own go | "(c) taxonomy paired-render re-run — score at CLAIM level with dereference, NOT label-flip, since verdicts can null while reasons are 2/3 false." | none stated | n/a |
| MH-18 | meta-harness `docs/resume.md:339-340` | open, own go | "(d) judge-vs-verifier strictness probe (dna-assembly/sanitize-git failed NEW on substantive grounds — a separate defect class)." | none stated | n/a |
| MH-19 | meta-harness `docs/resume.md:340-342` | open, own go | "(e) silent-fallback inventory (`?? \"\"`, `: \"\"`, bare caps in judge/proposer/audit paths)." | none stated | n/a |
| MH-20 | meta-harness `docs/resume.md:426-430` | open, own go | "**NOTHING IS PUSHED** — origin/main = `52c1106` (third/fleet lane); local main is 21 ahead, 0 behind; push needs its own go and is a plain fast-forward." | "needs its own go" | the push is explicitly authorized and executed |
| MH-21 | meta-harness `docs/resume.md:458-464` | open, own go | "**F3** block SHAPE adherence was 4/4 but 0/4 PARSED — cells carry units and derivations... the prompt's own toolless fix ... contradicts the parser's demand for bare numeric cells." | none stated ("each its own go" umbrella) | n/a |
| MH-22 | meta-harness `docs/resume.md:462-465` | open, own go | "**F4** all 4 cells found the right physics... which `applyTransform`'s single-op whitelist cannot express, so a CORRECT audit can never pass the gate on this trap class." | none stated | n/a |
| MH-23 | meta-harness `docs/resume.md:465-469` | open, own go | "**F5** 3/4 landing inputs are ABSENT from the sample... the sampler's derived-stats/calibration block is now LOAD-BEARING, not banked." | none stated | n/a |
| MH-24 | meta-harness `docs/resume.md:469-472` | open, own go (decision reached: implement) | "**F6** those fabricated inputs pass the range guard but are not in head/tail, so the un-built head/tail near-match would have caught 3/4 — the spec §10 'implement or accept' choice **resolves to implement**." | "resolves to implement" | the head/tail near-match check is built |
| MH-25 | meta-harness `docs/resume.md:515-518` | superseded/partial (probe was run; produced F3-F6 above) | "STANDING (each own go): the **adherence probe** ... is a PRE-ARM gate — imposed pipe-table schema adherence is UNMEASURED." | none stated | n/a |
| MH-26 | meta-harness `docs/resume.md:518-521` | open (decision on head/tail reached; MISREADINGS cross-check status unstated) | "**pre-arm hardening** — the as-built anti-fabrication bound is range + one-fixed-constant + degenerate/identity guards ONLY (head/tail near-match + MISREADINGS cross-check NOT built; spec §3/§10 corrected honest)." | none stated | n/a |
| MH-27 | meta-harness `docs/resume.md:523-524` | open/banked | "Increment-3 = compute transport + sampler calibration-sweeps (banked from sibling's B2 finding)." | none stated | n/a |
| MH-28 | meta-harness `docs/resume.md:554` | open/parked (deliberate) | "**NOT ARMED** (user ruling — no arm)." | none stated | n/a |
| MH-29 | meta-harness `docs/resume.md:554-557` | open, own go | "**BANKED LIMITATION:** shipped toolless daemon auditor is weaker than the compute-CLI setup that validated raman-class (compute-heavy) traps; fine for elf-class (criteria) traps; a compute transport = increment-2 (own go)." | none stated | n/a |
| MH-30 | meta-harness `docs/resume.md:557-559` | resolved same day (no stated condition) | "Increment-2 also owes the mechanical propose-verify revalidator (reject gen4-r1-class confident-wrong cards before injection)." | none stated | n/a (built same day per `docs/resume.md:499-501`, "LANE-A INCREMENT-2 **REVALIDATOR BUILT**"; not dated in Section 2 — no stated conditional trigger) |
| MH-31 | meta-harness `docs/resume.md:577-578` | open, own go (ownership standing) | "Sibling meta-harness-1e owns the gcode lane (rung-4 enforced-hook + rung-5 harness-render, its own gos)." | none stated | n/a |
| MH-32 | meta-harness `docs/resume.md:679-685` | open | "NEXT GATE, FREE, BEFORE ANY BUILD SPEND: does the agent physically receive an image it can SEE?... PIN THE MODEL ID in that check's pre-registration." | "BEFORE ANY BUILD SPEND" | the vision-perception gate is run and pre-registered with the correct model id |
| MH-33 | meta-harness `docs/resume.md:415-422` (also restated `docs/resume.md:636-640`) | open (consistent across both mentions) | "Perception is **NOT MEASURED**: ... What would decide it: render N single glyphs from the real fixture's own alphabet, one tile per call, score PER GLYPH — the arm's task shape, which neither probe has asked. **Own go.**" | "render N single glyphs... score PER GLYPH" | that per-glyph perception measurement is run |
| MH-34 | meta-harness `docs/resume.md:396-398` (blockers recorded); `docs/resume.md:347-348` (spec closed) | resolved at spec level; implementation still open (see MH-35) | "**ARMING BLOCKERS, recorded:** (i) §8.2 derived threshold, (ii) its out-of-family validation (F1), (iii) §8.8 value-truth mechanism — with (i)+(ii) possibly one derivation." | none stated as an explicit conditional trigger — closure is implicit in "derive and validate the threshold" | the derived-threshold predicate is designed and validated (see Section 2 dating) |
| MH-35 | meta-harness `docs/resume.md:373-374` | open, own go | "(a) ARMING INCREMENT — implementation-only vs closed spec (§8.2 clauses a-c, §8.8 rules i-v, T-matrix as regression set)." | none stated | n/a |
| MH-36 | meta-harness `docs/resume.md:375` | open, own go (ambiguous whether resolved — see note) | "(b) PUSH (19 ahead, one WSL2 host)." | none stated | n/a — could not confidently match to a later "pushed" confirmation within the 700-line window; flagged ambiguous |
| MH-37 | meta-harness `docs/resume.md:376` | open (duplicate of MH-11) | "(c) clean-prompt re-probe (spend, L-B prereq)." | same as MH-11 | same as MH-11 |
| MH-38 | meta-harness `docs/resume.md:376-377` | open, own go | "(d) pass-traj persistence." | none stated | n/a |
| MH-39 | meta-harness `docs/resume.md:377` | open, own go | "(e) L1 ladder bullets ride next proposer crank." | none stated | n/a |
| MH-40 | meta-harness `docs/resume.md:371-373` | open, go-board item | "**MEASUREMENT DEBT, go-board item: pass-traj coverage 16/250=6.4% vs fail 70%** (`store-traj-census-20260821`)." | none stated | n/a |

---

## Section 2 — Git dating

Applies only to items carrying BOTH a stated revisit condition AND a status of resolved/partial: KI-8 (= REM-1), DEBT-1, MH-5 (= part of MH-4/MH-15/MH-16), MH-13, MH-34.

### KI-8 / REM-1 — FileStateStore CAS/lock, deferred "once the adapters exist"
Repo: `kkamak`.

- **(a) Condition's event — adapters exist.** First adapter commits, all same day the deferral itself was written:
  - `dd4588c` 2026-07-30 13:13:40 +0900 "feat(adapters): shared block-message framing"
  - `df47c01` 2026-07-30 13:38:48 +0900 "feat(adapters): Claude Code hook adapter"
  - `a79ebc8` 2026-07-30 13:48:55 +0900 "feat(adapters): opencode plugin adapter"
  - (the deferral doc itself: `858ea68` 2026-07-30 09:54:49 +0900 "docs: remediation plan for the kernel review findings" — written ~3.5h BEFORE the adapters landed the same day)
- **(b) Actually revisited.** Not until 12 days later:
  - `4e6e11b` 2026-08-11 20:40:41 +0900 "docs(known-issues): record FileStateStore concurrency gap"
  - `1589ae1` 2026-08-11 21:24:25 +0900 "fix(kernel): compare-and-swap in FileStateStore.save()"
  - `93b7986` 2026-08-11 22:40:20 +0900 "fix(runtime): advisory lock closes save()'s last race window"
  - `c2a48e3` 2026-08-12 09:24:31 +0900 "fix(kernel): retry lost preemption reset, verify lock liveness"
  - `9e410f5` 2026-08-12 09:48:01 +0900 "docs(known-issues): correct fail-open label, note pid reuse"
- Gap between condition being met and revisit: ~12 days (2026-07-30 13:48 → 2026-08-11 20:40).

### DEBT-1 — 0.4.1 install-verification runbook, human execution required
Repo: `kkamak`.

- **(a) Condition's event — release cut / tag exists to verify.**
  - `ec0dd25` 2026-08-05 20:53:18 +0900 "chore(release): 0.4.1 — review-debt paydown"
  - `ea5f97d` 2026-08-05 20:53:04 +0900 "docs(install): re-point the runbook at 0.4.1" (runbook re-pointed just before the release commit, per the plan's own ordering rule)
- **(b) Actually revisited (human runs the runbook).**
  - `89a455b` 2026-08-11 19:50:50 +0900 "fix(docs): correct five install-verification defects" — dogfood-log's own account: "The runbook had never been executed end to end before today; it was executed today against the 0.4.1 tag, which passed, and the GitHub Release for `v0.4.1` was cut on that basis."
- Gap: ~6 days (2026-08-05 20:53 → 2026-08-11 19:50).

### MH-5 (ecde549 #5) / MH-15 / MH-16 — stdin-transport redo + merge + push
Repo: `meta-harness`.

- **(a) Condition's event — stdin-transport redone as its own change with fail-capable tests.**
  - `9218f0f` 2026-08-21 16:34:34 +0900 "fix(judge): trusted-frame notice + stdin transport — two ceilings removed" (first attempt)
  - `5e26c21` 2026-08-21 18:03:49 +0900 "revert(judge): transport half of 9218f0f — keep disclosure, drop the hang" (reverted per review `ecde549`, 2026-08-21 16:55:25)
  - `5412f4c` 2026-08-21 20:45:18 +0900 "fix(judge): review wave — 8 findings from two fresh-context reviews" (the actual redo satisfying the condition)
- **(b) Actually revisited/merged.**
  - `b7d4c6e` 2026-08-21 20:54:52 +0900 "merge: fix/judge-window — stdin judge transport (983fe2d..5412f4c, gate artifact 5412f4c-stdin-transport-redo.md)"
- Gap: same day, ~9 minutes (2026-08-21 20:45 → 20:54).

### MH-13 — second fixture (partial: second fixture done, third still open)
Repo: `meta-harness`.

- **(a) Condition's event (second fixture) — registered and run.**
  - `2d5bd4b` 2026-08-20 16:51:23 +0900 "probe(lane-a): second-fixture registration — fixture, truth, runner committed before any transfer run (spec §8.1)"
  - `8645c00` 2026-08-20 16:52:33 +0900 "probe(lane-a): second fixture transfer verdict — machinery frozen at registration (spec §8.1)"
- **(b) "Revisit" for this item is the registration/verdict pair itself** — same commits as (a); there is no separate later commit closing it further within the corpus read, because the doc explicitly states the item remains open in spirit pending a third fixture (no third-fixture commit found in the window read).
- Gap: n/a (condition and its recording commit are the same event, 1 minute apart).

### MH-34 — arming blockers (i)/(ii)/(iii), §8.2 derived threshold
Repo: `meta-harness`.

- **(a) Condition's event — blocker named/recorded as binding.**
  - `32625b1` 2026-08-20 16:45:27 +0900 "probe(lane-a): noise sweep of the conditioning check — §8.2 acceptance rule applied as registered" (this is the run resume.md cites as making "§8.2's DERIVED-THRESHOLD branch... the binding arming blocker")
- **(b) Actually revisited/closed.**
  - `e780d24` 2026-08-21 08:23:14 +0900 "probe(lane-a): derived thresholds — one noise-floor predicate replaces R + delta_fit; 11/11 validated, F1 closed, blockers 3->1"
- Gap: ~16 hours (2026-08-20 16:45 → 2026-08-21 08:23). Note: this item carried no explicit "revisit once X" sentence — the "condition" is inferred from the doc calling it "the binding arming blocker" that a later validation run closes. Flagged as an inferred rather than verbatim-stated condition.

### Not dated
- MH-30 (revalidator "owed", built same day per `docs/resume.md:499-501`): no stated conditional trigger, so it does not meet the "BOTH" gate for this section even though it appears resolved same-day.
- MH-36 (push 19 ahead): could not confidently locate a corresponding "pushed" confirmation inside the 700-line window; left undated as ambiguous rather than guessed.
- DOG-1a, DOG-1b: subject repo is `cc-api-daemon`, not one of the two repos available for git-log dating here. **Undatable — repo not present in the working environment (`~/z2/cc-api-daemon` was not checked out for this collection).**
