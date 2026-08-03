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
- **Deployed 2026-08-03 08:00:30 KST (ts 1785711630125), office `yoo-dev`.**
  Pull to `b57b187` + `bun install` (suite was RED without it — resume 08-02
  block (2e)) → 594/594 + tsc clean + kkamak 315/315 → `km-refresh.sh
  --force` → cache grep-verified per GA3: single `0.2.1/`,
  `src/gauge/transport.ts` present w/ `@anthropic-ai/sdk` import, SDK in
  cache `node_modules/`. Stub-drive proof not repeated on this host (MacBook
  proved the installed artifact; office cache is byte-copied from the same
  commit) — first organic office cycle's `transport:"sdk"` stamp is the
  live confirmation. Office lines between the two boundary ts values
  (00:29–08:00 KST) are CLI-produced if any exist; sensor-line transport
  field is authoritative either way.
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

## Doc-linter floor deploy boundary (7a, 2026-08-03)

- **What changed in `gate.json`:** the `check` command gained a fourth
  stage. Before:
  `cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test && cd ../km-crank && bun test`.
  After:
  `cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test && cd ../km-crank && bun test && cd .. && bun scripts/doc-check.ts`.
  Existing semantics preserved exactly (`&&`-chained, same three test
  suites, same failure-short-circuits-early behavior); `doc-check.ts` runs
  last, after the repo working directory is restored to root.
- **New instrument:** `scripts/doc-check.ts` — zero-dependency, zero-network
  deterministic linter over git-tracked `*.md` files
  (`git ls-files '*.md'`, so untracked scratch never blocks the gate).
  Checks relative-link integrity (target must resolve to an existing file,
  `#fragment` stripped before checking; `http(s):`/`mailto:`/anchor-only
  links skipped) and fenced-code-block balance per file. Measured runtime
  on this repo: ~25-70ms for 155 tracked docs, well under the ~3s budget.
  Verified green on HEAD before deploy; proof executed (scratch tracked doc
  with a broken relative link → FAIL naming file:line → removed → PASS
  again, no residue left in the tree).
- **Boundary ts: `1785727963349`** (`date +%s%3N`, captured at commit time,
  yoo-dev host). Cycles with a `check-output` sidecar record timestamped
  before this ts ran the three-suite check only; cycles after ran the
  three-suite check **and** the doc floor. As queue item 7a anticipated:
  this is a gate.json check change, so it shifts the floor-check
  population — the floorCheckMinedAt drift footnote already anticipates
  exactly this shape of change, and this entry is the logged instance of
  it. Not metric-neutral for doc-shaped turns: a doc turn that previously
  could only ever read `rounds:["accepted"]` (§6a/10(b) gate-floor-boundary
  finding — the floor could not see prose errors) can now fail on a
  mechanical link/fence regression, closing a sliver of the measured gap
  in `docs/2026-08-01-gate-floor-boundary.md` without adding any judgment
  to the gate.
- **Side effect discovered, fixed same commit:** `km-crank`'s §2
  kkamak-dev-check drift guard
  (`km-crank/src/trial-verdict.ts` `KKAMAK_DEV_CHECK`,
  asserted equal to the live `gate.json` `check` string by
  `km-crank/test/trial-verdict.test.ts`) failed the moment `gate.json`
  changed — by design, per its own docstring ("must be revisited
  deliberately, never silently"). Updated `KKAMAK_DEV_CHECK` to the new
  four-stage string in the same commit; this is a deliberate, documented
  revisit, not a silent drift-guard bypass. Full three-suite + doc-check
  chain reverified green after the update (783 + 26 + 229 tests pass +
  doc-check OK).

## Fix wave on the doc-linter floor deploy (7a, same day, review verdict FIX-FIRST)

- **FIX 1 — `KKAMAK_DEV_CHECK` scalar → `KKAMAK_DEV_CHECKS` append-only set.**
  The in-place scalar swap above was itself a bug: the §2 exclusion rule
  compared by equality against only the CURRENT check string, so every
  historical sensor line carrying an older check string (55 lines on the
  2-stage string, 209 on the 3-stage string, per `jq -r '.check'
  .km/gate-outcomes.ndjson | sort | uniq -c` at fix time) would have leaked
  into any future trial window as un-excluded meta-harness dev noise.
  `km-crank/src/trial-verdict.ts` now exports `KKAMAK_DEV_CHECKS: readonly
  string[]`, containing all three check strings ever run by this repo's
  gate; exclusion is `KKAMAK_DEV_CHECKS.includes(l.check)`. Entries are
  never removed or edited — a future `gate.json` check change appends a
  new entry, which is the deliberate revisit the drift guard exists to
  force. `km-crank/test/trial-verdict.test.ts`'s drift guard now asserts
  (a) the live `gate.json` check equals the LAST array entry and (b) both
  historical entries are still present (a removed entry fails the test);
  a new regression test pins that lines carrying either historical string
  stay excluded. km-crank suite: 230 pass (was 229 pre-fix-wave, +1 net
  after replacing 2 tests with 3).
- **FIX 2 — repo-root-relative links.** `scripts/doc-check.ts` previously
  treated a leading `/` in a link target as OS-filesystem-absolute (untested
  behavior). Now resolved against the repo root (`path.join(repoRoot,
  targetPath)`), matching how such links are actually meant in this corpus.
  Two new tests (resolves when present, still caught when missing).
- **FIX 3 — CommonMark fence-close rule.** The prior fence check counted
  ANY ``` /~~~ -looking line and required an even total — a false positive
  on legitimately nested fences (a shorter same-char fence-like line inside
  a longer one). Rewritten to track the opening marker's character + length
  and require a same-char, same-or-longer-length, marker-only line to
  close, per CommonMark. New tests: a 4-backtick outer fence containing a
  3-backtick fence-like line passes; the same shape with no real closer
  still fails. **This surfaced 3 genuine pre-existing corpus defects**
  (`term-bench2/store/roles/mh-designer/{active,candidates/v1,candidates/v2}/system.md`)
  — a template used identically across all three files wraps illustrative
  `mermaid` example fences in an OUTER fence of the SAME delimiter length
  (3 backticks both), which is not nested under CommonMark: the outer fence
  actually closes at the first inner closer, exactly as a real renderer
  (e.g. GitHub) would also mis-render it. Fixed by widening only the outer
  wrapper's delimiter to 4 backticks in all three files (8/8/4 lines
  changed respectively) — a pure escaping-length change, zero prompt-text
  content touched; diffs are two-character-per-line delimiter swaps only,
  trivially revertible per file if this scope is later judged
  inappropriate for a doc-floor fix wave.
- **FIX 4 — `git ls-files` anchored to repo root.** Was a bare `git
  ls-files '*.md'`, which git interprets relative to CWD — an invocation
  from a subdirectory would silently narrow scope. Now resolves the repo
  root via `git rev-parse --show-toplevel` and runs `git -C <root>
  ls-files '*.md'`; all paths (read, link-resolution, printed violations)
  are repo-root-relative regardless of invocation CWD. New test: running
  from a subdirectory still catches a broken link in a file outside that
  subdirectory.
- **Verification after the fix wave:** `bun test scripts/doc-check.test.ts`
  15 pass (was 10); km-crank 230 pass; cc-gate-plugin 783 pass; `tsc
  --noEmit` clean in both `cc-gate-plugin/` and `km-crank/`; `doc-check.ts`
  green on HEAD (155 tracked docs, 0 violations, ~27-70ms) after the 3
  corpus fixes; full `gate.json` check chain re-run end-to-end, exit 0
  (~10.1s total, doc-check itself <30ms of that).
- **Rollback:** revert the `gate.json` `check` line to the three-suite form
  above to fully back out the floor gating. `KKAMAK_DEV_CHECKS` keeps ALL
  entries regardless of rollback direction — that is the point of making it
  append-only, so reverting gate.json never needs a matching revert on the
  km-crank side. `scripts/doc-check.ts` and its test file can stay in the
  tree inert. The 3 `term-bench2/store/roles/mh-designer/**/system.md`
  fence-delimiter fixes are independent of the gate.json wiring (they fix a
  real rendering defect either way) and are not part of the gate rollback.
