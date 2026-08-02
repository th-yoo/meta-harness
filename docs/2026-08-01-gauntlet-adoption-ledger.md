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

## v2 activation log

- **2026-08-01, yoo-mac.local (user-directed):** installed cache refreshed
  from merged main + grep-verified (v2 ×3, biggestGapLine ×2, score split,
  env-gate; single 0.2.1). `KKAMAK_REINJECT_V2=1` set in
  `~/.claude/settings.json` env (all CC sessions on this host). Dogfood
  tmux session restarted 13:44 KST on the refreshed cache. From this point
  this host's blocked cycles randomize v0/v1/v2 (hash%3); v2 clock for the
  §4b decision rule starts here. Office host: NOT activated (pull + refresh
  + env there would be its own logged decision).

- **2026-08-01 (same day, later): activation broke this host's own suite —
  found by the gate, not by us.** With `KKAMAK_REINJECT_V2=1` live in the
  session environment, two pre-v2 tests in `cc-gate-plugin/test/reinject.test.ts`
  failed: both called `pickReinjectVariant(id)` with no env argument, so they
  inherited the host's activation and exercised the three-arm rotation while
  asserting the two-arm split (even-split saw v1≈125/400 instead of ~200; the
  escape-hatch test compared a three-arm `natural` against a two-arm override
  call). Product code is correct — the `process.env` default is the mechanism
  activation *depends* on. Fix was hermeticity: both tests now pass an explicit
  `{}`, matching what every v2-era test in that file already did. Verified 573
  pass with the flag set AND unset, identical expect() counts.
  **Why it went unseen:** Loop F was verified with the flag unset
  ("byte-identical live behavior without `KKAMAK_REINJECT_V2=1`"), then
  `4fec674` set it globally, and nobody re-ran the suite in the activated
  state. **Standing rule:** an env-gated arm's ACTIVATED state is a
  configuration the suite must be proven under — proving it only in the
  unactivated state leaves every activating host silently red until someone
  trips over it. Applies to the office host if v2 is ever activated there.

- **Related, same session:** `cc-gate-plugin` had no emission-conformance test
  at all, while the standalone kernel (`~/z2/kkamak`) proves every line it
  emits against the frozen SensorLine contract. The unproven emitter was the
  *measured* one — this producer's lines feed the gauge corpus and the §4.3
  stream. Closed by porting the scenario set (clean accept, block-then-fix,
  exhausted, skippedStop) as driven `hook-cli` runs, plus a negative control
  pinning that the check rejects the drifts it exists to catch. No gap found:
  emission already conformed. Tests only — F1 untouched.

## Gauge fail-loud deploy boundary (2026-08-01)

- **Deployed 2026-08-01 17:05 KST (ts 1785571509000), yoo-mac.local.**
  `km-refresh.sh --force` from merged main (`0c2482c`); cache grep-verified
  per GA3 — single `0.2.1/` dir, `offReason` present in `hook-cli.ts` and
  `types.ts`, `GaugeOffReason` type landed. Verified by driving the INSTALLED
  copy against a scratch repo, not by trusting the refresh script: emitted
  `gauge {present:false, offReason:"disabled"}`.
- **No restart was required.** Hook commands re-read `hook-cli.ts` per
  invocation and the reinstall wrote to the same path and version, so live
  sessions resumed gating with the new code. The documented gotcha still
  applies to the deletion window itself, during which live hooks fail open.
- **BOUNDARY MATTERS — the version did not move.** This changed emitted
  behaviour while `pluginVersion` stayed `0.2.1`, so sensor lines before and
  after are indistinguishable by stamp. Lines from this host before ts
  1785571509000 may omit the gauge field on an un-instrumented cycle; lines
  after must carry either a real record or `present:false` + `offReason`.
  Partition by `ts` at that boundary, not by version. Same defect the queue's
  producer-identity item exists to close; recorded here because it is the
  second time today a shared artifact could not say which code produced it.

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

## Gauge SDK-transport deploy boundary (§6c, 2026-08-03)

- **Deployed 2026-08-03 00:29 KST (ts 1785684571765), yoo-mac.local.**
  `km-refresh.sh --force` from merged main (`de6e892`, branch
  `gauge-sdk-transport` reviewed MERGE-READY after one fix wave); cache
  grep-verified per GA3 — single `0.2.1/` dir, `src/gauge/transport.ts`
  present, `@anthropic-ai/sdk` in the cache's `node_modules/` (the install
  copies the whole dir, so the runtime dep travels), `apiKey: null` in
  transport.ts, `callModelSdk` wired in both `refiner-cli.ts` and
  `corpus-replay.ts`, zero non-comment `claude -p` references. Verified by
  driving the INSTALLED copy against a scratch repo + stub API server (zero
  real calls): one request carrying resolved model `claude-haiku-4-5` +
  `output_config` json_schema, stray `ANTHROPIC_API_KEY` suppressed (no
  x-api-key header), gauge file stamped `transport:"sdk"`.
- **No restart required** — same path + version, hooks re-read per
  invocation (per the 2026-08-01 precedent above; same deletion-window
  caveat).
- **BOUNDARY MATTERS — version again did not move (`0.2.1`), but this
  boundary is NOT metric-neutral** (unlike §6b): the transport changes
  classifications. Records/lines after this ts carry `transport:"sdk"` on
  gauge fields and derivation blobs; absent = pre-boundary CLI. Every
  M1v2 / class-table / C-rate reading spanning this ts MUST split per
  transport (§6c Split rule); pooling only after the paired-validation bar
  (positive agreement ≥0.80 AND missed-C ≤ ceil(0.10×|C_cli|)) passes —
  measured 13-record slice sits at 54%, so expect SPLIT, not pooled.
- **Model field note:** SDK records carry `model:"claude-haiku-4-5"`
  (resolved API id) where CLI records carried `"haiku"` — do NOT use the
  model string to infer transport; use the `transport` field, which also
  reaches the sensor line (`GaugeSensorField.transport`, review finding 2).
- **Office host:** pulls and switches at the same commit next session;
  MUST run `bun install` in `cc-gate-plugin/` before its `km-refresh` (git
  does not carry `node_modules`). MacBook runs no further CLI derive
  batches; all future derive work is SDK, post-boundary, own sized go.
