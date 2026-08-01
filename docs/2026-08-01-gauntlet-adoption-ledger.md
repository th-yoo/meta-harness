# Gauntlet adoption ledger

Verdicts of the Gauntlet adoption loop
(`docs/superpowers/plans/2026-08-01-gauntlet-adoption-loop.md`). One row
per application; bar frozen in the plan before build; builder never graded
itself (fresh-context critics).

| Loop | Application | Branch | Verdict | Why (evidence) |
|---|---|---|---|---|
| A | reviewer null-precedent bar + biggest-gap revise (`minimal/review.ts`) | `gauntlet-sa-review-bar` @ `5bb1063`+`9dd12fb` (unmerged, kept for audit) | **DROP** | Retrospective replay vs recorded bench fates, 2 rounds, 18 opus-5 calls total. Round 1: null_precedent flagged 0/3 nulls — check satisfiable by construction ("write a distinguishing sentence"). Round 2 (headroom reword anchored on recorded null mechanism): flagged 1/3 (N0 2/2 correct; N1/N2 0/2 — reviewer manufactures its own plausible "non-default behavior" sentence, same defect relocated into `headroom_evidence`); v9 known-good never flagged either round (false-positive side clean, k=2, 0 parse failures round 2). Bar required ≥2/3; terminal. **Salvage note (not merged):** E1 `buildReviseFeedback` (biggest-gap-first revise feedback) reviewed correct both rounds and is independent of the failed check — eligible for its own future proposal with its own bar. |
| C | gauntlet-shaped seed content (Path A Stage 0) | (rides tournament) | DEFERRED — decision at tournament verdict | bar = screen w/ concurrent v7 arm → k=5 McNemar → guards; employ iff gauntlet-shaped seed is certified winner |
| D | proposer ranked-gap targeting (`minimal/propose.ts`) | `gauntlet-sd-proposer-gap` @ `125ef47` (unmerged, kept for reopen) | **DROP — unproven within frozen bar** | Paired-on-same-evidence eval (2 records, 6 completed opus-5 calls): bar clause "passes review" never engaged — every qualifying record's dominant gap is saturated by a rejected-ledger near-dup (sparql→scope-leak, headless→reproduction), so both arms correctly abstained; repeat-pair remedy has no qualifying record to run on. Code itself reviewed clean (0 merge-blocking findings, tests independently verified 33+89). Directional positives recorded, NOT verdict evidence: new arm reached correct abstains with attempt-id-traceable ranked gap analysis (critic independently verified 5/6 cited attempts) at fewer calls than old (0 vs 2 on pair 2). **Reopen trigger:** fresh failure records from future bench runs (post-plateau) re-arm the paired eval; branch kept unmerged. |
| F | reinject v2 biggest-gap-first wording (`cc-gate-plugin/src/reinject.ts`) | `gauntlet-sf-reinject-v2` @ `e2ad44b`+`47af5f7` — **MERGED `989630e`** (user-approved §4b amendment `41a7411`, 2026-08-01) | **MERGED ENV-GATED — employ/drop verdict still OPEN pending evidence** | Round 1 FAIL (score-cli render dropped v2 arm) → fixed + render/e2e tests; round 2 PASS: byte-identical live behavior without `KKAMAK_REINJECT_V2=1` (test-pinned), F1 verified byte-level clean, 568 tests + tsc. Suite run independently by orchestrator. Employ/drop BLOCKED on evidence: fixtures=0, live blocked-cycle flow ≈8/2.5wk. **Two user gates before merge/activation:** (1) §4.4 amendment ruling for the 3rd arm (merge ≠ activation; env-gated); (2) final bar = fixture-replay k=5 paired McNemar on ≥3 fixtures OR live n≥20 blocked cycles. Sub-threshold note for amendment author: 3-arm underpowered guard couples v0/v1 verdict availability to v2's N during ramp-up. |
| P2 | agent-node Gauntlet Evaluator (fleet spec) | (spec edit on main) | PRE-REGISTERED — experiment written into fleet spec; decision deferred to fleet existence | spec §"Pre-registered future experiment" |

## Program seal (2026-08-01)

Method: self-applying Gauntlet Loop — orchestrator lead, builder subagents
(isolated worktrees), fresh-context critics per round, frozen bars, ≤2
gap-feedback rounds, builder never graded itself. ~24 opus-5 eval calls +
subagent orchestration. Outcome: **0 merges, 2 drops, 1 open, 2 deferred**
— the bars did their job.

**Meta-finding (the program's real yield):** in round-1 replay the
EXISTING rubric keys under opus-5 caught 2 of the 3 null bullets
(N0 via mechanize_instead 2/2, N1 via behavior_level 2/2) that had
historically passed review under the older model. The model upgrade alone
delivered most of what the Gauntlet mechanism change was designed for;
the added check's marginal value shrank to N0-only — already covered.
Lesson recorded: re-baseline the existing pipeline after a model upgrade
BEFORE building discrimination mechanisms on pre-upgrade failure data.

**Second meta-finding:** both DROP verdicts trace to evidence-side limits
(unfailable-by-construction prompt checks; ledger-saturated proposer
corpus), not to Gauntlet primitives being wrong. The primitives that DID
survive contact: fresh-context critics caught real defects both rounds
(unfailable check, invisible v2 arm), and biggest-gap single-issue
feedback made both round-2 fixes surgical. The loop process is employed
(this program ran on it); the specific mechanism transplants are not.

## Program retrospective — was the Gauntlet Loop useful as OUR process? (2026-08-01, user-reviewed)

**Verdict: EMPLOYED as standing practice for mechanism/adoption decisions.**
Scope rule: full loop (isolated builder subagents — sonnet; fresh-context
critics per round — opus; ≤2 gap-feedback rounds; bars frozen pre-build)
ONLY for adoption-grade decisions with recorded ground truth to judge
against. Routine edits keep ordinary per-task review — the loop is too
heavy for them (~600k subagent tokens + ~24 opus-5 eval calls + ~4 manual
orchestrator interventions for this 3-loop day).

**What earned the verdict (concrete counterfactuals):**
1. Fresh-context critics caught two defects green tests would have
   shipped: the unfailable-by-construction null_precedent check (replay vs
   recorded fates killed in one round what self-review had approved) and
   the invisible v2 arm in the scorecard render (deliverable-vs-intent
   gap, invisible to the builder's own passing tests). Two prevented
   merges of plausible, tested, useless mechanisms = the program's value.
2. Single-biggest-gap feedback: both round-2 fixes surgical, zero scope
   creep — cheaper than SDD fix-waves at this change size.
3. Frozen bars + terminal rounds resisted, in real time, (a) iterating
   Loop A's check to fit 3 data points and (b) merging Loop D on
   "directionally favorable" — DROP stayed the path of least resistance.

**Honest attribution:** the judgment standard (replay vs recorded
outcomes, pre-registration, paired arms) was already this project's own;
Gauntlet's marginal contribution is the ORCHESTRATION choreography —
parallel isolated builders, per-round fresh critics, one-gap iteration —
which we preached for the product but had not been running on our own dev
work.

**Defect the process did NOT catch (orchestrator's, now a rule):** Loop
D's bar was unrunnable from the start — corpus saturation was knowable
before the build; a full build+eval was spent discovering it. Gauntlet
critiques artifacts; nothing critiqued the bars. **New standing step:
bar-feasibility pre-check** — before any builder launches, a critic (or
the orchestrator with data in hand) must show the bar's EMPLOY condition
CAN fire on existing evidence; a bar that cannot fire is returned to
design, not built against.

Caveat: n=3 loops, one day — provisional, revisit after the next program.
