# Gauntlet adoption ledger

Verdicts of the Gauntlet adoption loop
(`docs/superpowers/plans/2026-08-01-gauntlet-adoption-loop.md`). One row
per application; bar frozen in the plan before build; builder never graded
itself (fresh-context critics).

| Loop | Application | Branch | Verdict | Why (evidence) |
|---|---|---|---|---|
| A | reviewer null-precedent bar + biggest-gap revise (`minimal/review.ts`) | `gauntlet-sa-review-bar` @ `5bb1063`+`9dd12fb` (unmerged, kept for audit) | **DROP** | Retrospective replay vs recorded bench fates, 2 rounds, 18 opus-5 calls total. Round 1: null_precedent flagged 0/3 nulls — check satisfiable by construction ("write a distinguishing sentence"). Round 2 (headroom reword anchored on recorded null mechanism): flagged 1/3 (N0 2/2 correct; N1/N2 0/2 — reviewer manufactures its own plausible "non-default behavior" sentence, same defect relocated into `headroom_evidence`); v9 known-good never flagged either round (false-positive side clean, k=2, 0 parse failures round 2). Bar required ≥2/3; terminal. **Salvage note (not merged):** E1 `buildReviseFeedback` (biggest-gap-first revise feedback) reviewed correct both rounds and is independent of the failed check — eligible for its own future proposal with its own bar. |
| C | gauntlet-shaped seed content (Path A Stage 0) | (rides tournament) | DEFERRED — decision at tournament verdict | bar = screen w/ concurrent v7 arm → k=5 McNemar → guards; employ iff gauntlet-shaped seed is certified winner |
| D | proposer ranked-gap targeting (`minimal/propose.ts`) | `gauntlet-sd-proposer-gap` @ `125ef47` (unmerged, kept for reopen) | **DROP — unproven within frozen bar** | Paired-on-same-evidence eval (2 records, 6 completed opus-5 calls): bar clause "passes review" never engaged — every qualifying record's dominant gap is saturated by a rejected-ledger near-dup (sparql→scope-leak, headless→reproduction), so both arms correctly abstained; repeat-pair remedy has no qualifying record to run on. Code itself reviewed clean (0 merge-blocking findings, tests independently verified 33+89). Directional positives recorded, NOT verdict evidence: new arm reached correct abstains with attempt-id-traceable ranked gap analysis (critic independently verified 5/6 cited attempts) at fewer calls than old (0 vs 2 on pair 2). **Reopen trigger:** fresh failure records from future bench runs (post-plateau) re-arm the paired eval; branch kept unmerged. **Merge state (checked 2026-08-08, main `17d164c`):** no longer conflict-free — `git merge-tree main gauntlet-sd-proposer-gap` conflicts in `minimal/propose.ts`. Main made `llmCall` async after the branch point (`ac2cfa0`), so both sides edit the same `revise` closure. Resolve with care: keeping this branch's un-awaited `const reply = llmCall(...)` fails **silently**, not loudly — `extractJsonObject` runs `RegExp.exec` on the Promise, which coerces to `"[object Promise]"`, matches nothing, and returns `undefined`, so every revision degrades to `{action:"abstain",reason:"revision reply unparseable"}` (verified by direct call, 2026-08-08). No static net catches it: the repo has no root `tsconfig.json`, and the gate's full check runs suites + doc-check, never `tsc` over `minimal/`. **Paired-eval artifacts** (committed 2026-08-08; until then untracked and split across two worktrees, so half would have died with `git worktree remove`) — old arm: `minimal/proposals/headless-terminal-2026-08-01T04-07-29-945Z.json`, `sparql-university-2026-08-01T04-12-09-123Z.json`; new arm (ran in `agent-ad36b28d26859138a`): `headless-terminal-2026-08-01T04-09-31-808Z.json`, `sparql-university-2026-08-01T04-11-13-130Z.json`. All four `action: abstain`, matching this row's verdict. |
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

## Warm-lane (`anthropic-cli-warm`) activation log

- **2026-08-05 00:12:51 KST (boundary ts 1785856371528), yoo-mac.local
  (user-directed: "2 then 1" — RSS measurement first, then activation).**
  `KKAMAK_SEAT_PROVIDER=anthropic-cli-warm` set in `~/.claude/settings.json`
  env (all CC sessions on this host — same mechanism as the v2 activation
  above; grep-verified, JSON validated). From this point the design-time
  seats (proposer/reviewer/revision via `minimal/llm-acp.ts` `seatCall`)
  route through the warm lane: ACP daemon + `/clear`-recycled CC CLI
  subprocesses, CC credential pool. Semantics unchanged from the wiring
  merge `5ae2043`: warm no-call → one anthropic-api attempt in-call;
  call-consumed → THROW, never falls back. `opencode` driver untouched.
- **Precondition evidence, in order:** (1) MacBook RSS measured same
  session (`docs/2026-08-05-warm-session-rss.md` MacBook section, merged
  `1a11046`): ~330 MB/warm session marginal, recycle flat; **cap stays 4
  on this host** — 8 explicitly NOT permissible here (16 GB, ~6 GB
  reclaimable). No `KKAMAK_ACP_MAX_SESSIONS` override set. (2) Both suites
  proven in the ACTIVATED state per this ledger's 2026-08-01 standing rule
  (`KKAMAK_SEAT_PROVIDER=anthropic-cli-warm` set for the run): cc-gate-plugin
  1043/0, opencode-plugin 1776/1 skip — the exact gap that bit v2
  activation, closed ahead of the flip this time.
- **Instrument boundary:** seat outputs pre/post ts **1785856371528** on
  this host MUST NOT pool (transport changed api → warm CLI; system-prompt
  isolation nominally same `REASONING_ISOLATION`, but provider asymmetry is
  declared in the merged artifacts — `thinking:enabled` runs on warm, is
  no-called on api). This compounds with the 08-05 office boundary
  1785847012141 (CLI-spawn → api): this host's seat lines now partition
  into three regimes by ts. Office host: NOT activated — its own logged
  decision if taken.
- **No live seat spend at activation.** Verification was suite-level only;
  premium models were 429-walled at flip (haiku=OK, sonnet/opus=429, probed
  this session). First live warm seat call will occur whenever the loop
  next runs a seat on this host; its outcome belongs to normal loop
  telemetry, not this entry.

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

## meta-harness gate-outcomes plugin-version boundaries, yoo-mac (2026-08-06)

- **Recorded per the deploy rule ("merging is not deploying") and the 08-06
  resume duty:** this repo's `.km/gate-outcomes.ndjson` on yoo-mac.local now
  partitions into three `pluginVersion` regimes, measured from the lines
  themselves:
  `0.2.1` n=52, ts ≤ 1785880160767 · **`0.3.0` first line ts 1785941618740**
  (2026-08-05 23:53 KST; the 08-05 23:52 cache update) · **`0.4.0` first
  line ts 1786009358289** (2026-08-06 18:42 KST; cache updated same day,
  session restarted — 0.2.1 and 0.3.0 dirs both `.orphaned_at`).
- Partition by `pluginVersion` stamp (it moved this time — unlike the
  08-01 boundary above, no ts-only partitioning needed). The 0.3.0 regime
  is n=2 on this repo/host and spans the two-tier-gate era already marked
  by the check-string change; treat it as too thin to read alone.
- The D3-confound segmentation rule (0a03c00) applies unchanged: segment
  on pluginVersion AND marker state AND sensor-live, never selection alone.

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
  (e.g. GitHub) would also mis-render it. An initial fix widened those
  files' outer delimiters — OVERRULED (297b5d4): store artifacts are
  experiment DATA with load-bearing bytes (sha-pinned harness slots,
  candidate-lineage byte-compare) and must never be edited to satisfy a
  lint. The three files were byte-restored (blob-sha verified against
  their pre-wave state) and `term-bench2/store/**` is EXCLUDED from
  doc-check's scope via an explicit constant, with a pinning test that a
  violating store .md never blocks.
- **FIX 4 — `git ls-files` anchored to repo root.** Was a bare `git
  ls-files '*.md'`, which git interprets relative to CWD — an invocation
  from a subdirectory would silently narrow scope. Now resolves the repo
  root via `git rev-parse --show-toplevel` and runs `git -C <root>
  ls-files '*.md'`; all paths (read, link-resolution, printed violations)
  are repo-root-relative regardless of invocation CWD. New test: running
  from a subdirectory still catches a broken link in a file outside that
  subdirectory.
- **Verification after the fix waves (final state, 297b5d4):**
  `bun test scripts/doc-check.test.ts` 17 pass; km-crank 230 pass;
  cc-gate-plugin 783 pass; `tsc --noEmit` clean both packages;
  `doc-check.ts` green on HEAD — 155 tracked .md, 20 store-excluded,
  **135 scanned, 0 violations** (~27-70ms); full `gate.json` check chain
  end-to-end exit 0 (~10.1s total, doc-check <30ms of that).
- **Rollback:** revert the `gate.json` `check` line to the three-suite form
  above to fully back out the floor gating. `KKAMAK_DEV_CHECKS` keeps ALL
  entries regardless of rollback direction — that is the point of making it
  append-only, so reverting gate.json never needs a matching revert on the
  km-crank side. `scripts/doc-check.ts` and its test file can stay in the
  tree inert. The 3 `term-bench2/store/roles/mh-designer/**/system.md`
  fence-delimiter fixes are independent of the gate.json wiring (they fix a
  real rendering defect either way) and are not part of the gate rollback.

## Process-gate arming boundary (7b, 2026-08-03)

- **Boundary ts: `1785732646822`** (office `yoo-dev`, 2026-08-03 ~13:50 KST).
  The 7b review-artifact floor is ARMED on meta-harness from this instant
  (rollout ruling 6: meta-harness only, staged). Merges of branches into
  this repo now go through `scripts/merge-with-gate.sh <branch> [-m ...]`,
  which refuses unless `scripts/check-review-artifact.ts` passes for
  `merge-base..branch`, then merges `--no-ff`.
- **Effective-tip amendment ACKED by user** (go, 2026-08-03 evening): the
  spec's literal §1 was unsatisfiable (artifact commit moves HEAD).
  Binding form: trailing `docs/reviews/**`-only commits exempt; effective
  reviewed tip = newest non-exempt commit; merge commits ALWAYS non-exempt
  (evil-merge sneak, review F1); ambiguous artifact matches fail closed
  (decoy shadowing, review F2).
- **Placement discovery (recorded, closes a design avenue):** a git
  `pre-merge-commit` hook CANNOT implement this gate — modern git's
  automatic ort merge never materializes `MERGE_HEAD` before that hook
  runs (only `AUTO_MERGE`; measured git 2.43.0, GIT_TRACE-verified the
  hook fires but cannot identify the merged tip). A hook version passes
  silently = false security. Workflow-level wrapper is the sound
  placement and matches the spec's own §1 recommendation.
- **Execute-proof:** negative in-repo (probe branch without artifact →
  BLOCK, exit 1, main untouched) + positive and negative in a throwaway
  repo (compliant artifact → merge lands; sneak branch → BLOCK).
- **Falsification window OPEN (§6, ruling 5):** first N=10 merge attempts
  through the armed gate; spurious-block bar <= 0.20; failing the bar caps
  rollout, never loosens the gate. Attempt/disposition rows recorded in
  the spec's §6 ledger as they occur. Attempt count at arming: 0.
- **Rollback:** stop using the wrapper (plain `git merge --no-ff`) — the
  checker and wrapper stay in the tree inert; no gate.json or hook state
  to unwind. First 7b-format artifact remains valid history.

## Proposer send-prompt deploy boundary (2026-08-05 KST)

- **Boundary ts: 1785847012141** (2026-08-04T12:36:52Z UTC) — merge of
  `acp-session-pool` into main @ `bbdabe1` (review artifact
  `docs/reviews/95cfa82-acp-session-pool.md`).
- **Instrument change:** the design-time seats (proposer / reviewer /
  revision, `minimal/propose.ts` + `minimal/review.ts`) `claude-code` driver
  no longer spawns the CLI. `llmCall` → `seatCall` (`minimal/llm-acp.ts`) →
  `sendPrompt` with provider `anthropic-api` (Messages API), **explicit
  `REASONING_ISOLATION`** (closes the undeclared-harness finding: no CC
  system prompt, no tools, no CLAUDE.md, no auto-memory), `maxTokens` 8192
  with a hard truncation guard (`stop_reason === "max_tokens"` ⇒ throw,
  never a silently cut proposal), 300 s timeout. The `opencode` driver is
  byte-untouched.
- **NOT metric-neutral** (like §6c, unlike §6b): transport, system prompt,
  isolation, and output-cap semantics all change. Partition any
  seat-produced data (proposals, reviews, revisions) by this ts; pre- and
  post-boundary seat outputs must not pool.
- **NOT activated:** the `anthropic-cli-warm` lane (ACP daemon/pool) merged
  in the same range but is UNWIRED — no caller registers it. Wiring it is a
  future explicit decision with its own boundary entry.

## Gate check two-tier deploy (2026-08-05, office `yoo-dev`)

- **Deployed 09:09 KST (ts 1785888548054), office `yoo-dev`.** `gate.json`
  check swapped from the inline 3-suite string to `bun scripts/gate-check.ts`
  (design: docs/superpowers/plans/2026-08-05-two-tier-gate-check.md). Blocking
  tier = package-TIA-scoped fast suites (spawn-heavy cc-gate files excluded,
  policy regex `SLOW_CCGATE_TEST_RE` in km-crank/src/gate-check-core.ts;
  changed slow-covered sources pull their matching slow test files back into
  the blocking tier); conservative fallback runs the incumbent-scope suite
  set (opencode excluded from fallback — it runs only when TIA selects it);
  a wedged background run (running marker >15 min old with a live pid) is
  pid-kill respawned; incumbent full check runs VERBATIM as a detached
  background run; a red background result blocks the next gated Stop with a
  synchronous full-run repayment. `KKAMAK_GATE_FULL=1` restores the
  incumbent behavior exactly.
- **INSTRUMENT BOUNDARY: gate-outcomes `durationMs`/`checkMs` distributions
  shift at this ts** (~160s gated Stops drop to ~25-45s typical — including
  conservative-fallback Stops, whose suite set matches the incumbent scope;
  Stops whose TIA picks opencode or a slow pull-in add roughly the cost of
  those suites/files, e.g. opencode ~47s; debt-repayment Stops run ~3min).
  The `check` field string also changes, so lines partition cleanly by it.
  Do not pool duration metrics across the boundary. Rounds semantics, block
  semantics, and the sensor-line schema are unchanged.
- **Merge gate scope:** scripts/merge-with-gate.sh enforces the review-artifact
  gate only (check-review-artifact.ts + `git merge --no-ff`) — it never ran
  full suites. Full-suite proof at merge time comes from the manual pre-merge
  sanity chain (plan Task 3 Step 5), which keeps its cost.
- **Office host:** deployed here (`yoo-dev`); `gate.json` is committed so the
  swap travels with git pull — the other host's (`yoo-mac`) first pulled
  session inherits it. Same-repo semantics, no per-host activation needed
  (config, not env).

## Warm-lane activation (2026-08-05, office `yoo-dev`)

- **2026-08-05 10:07:02 KST (boundary ts 1785892022908), yoo-dev
  (user-directed: "activate warm lane on office").**
  `KKAMAK_SEAT_PROVIDER=anthropic-cli-warm` set in `~/.claude/settings.json`
  env (all CC sessions on this host — same mechanism as the yoo-mac
  activation above; grep-verified, JSON validated). Design-time seats
  (proposer/reviewer/revision via `minimal/llm-acp.ts` `seatCall`) now route
  through the warm lane: ACP daemon + `/clear`-recycled CC CLI subprocesses,
  CC credential pool. Semantics unchanged from the wiring merge `5ae2043`:
  warm no-call → one anthropic-api attempt in-call; call-consumed → THROW,
  never falls back. `opencode` driver untouched.
- **Precondition evidence, in order:** (1) WSL2 RSS measured 2026-08-04
  (`docs/2026-08-05-warm-session-rss.md`): ~330 MB/warm session band,
  recycle flat; **cap stays 4 (default), no `KKAMAK_ACP_MAX_SESSIONS`
  override** — opt-up is env-only by that doc's ruling. (2) Both suites
  proven in the ACTIVATED state per the 2026-08-01 standing rule
  (`KKAMAK_SEAT_PROVIDER=anthropic-cli-warm` exported for the run):
  cc-gate-plugin 1043/0, opencode-plugin 1777/1 skip/0 fail.
- **Instrument boundary:** seat outputs pre/post ts **1785892022908** on
  this host MUST NOT pool (transport changed api → warm CLI; provider
  asymmetry as declared in the merged artifacts — `thinking:enabled` runs
  on warm, is no-called on api). Compounds with this host's 08-05 boundary
  1785847012141 (CLI-spawn → api): yoo-dev seat lines now partition into
  THREE regimes by ts, same shape as yoo-mac. Both hosts are now
  warm-active; their regimes remain host-split as ever (F-rules).
- **No live seat spend at activation.** Verification was suite-level only
  (hermetic). Premium 429-walled at flip (haiku=OK, sonnet=429, opus=429,
  probed this session — same wall as the yoo-mac flip). First live warm
  seat call occurs whenever the loop next runs a seat here; its outcome
  belongs to normal loop accounting, not this entry.

- **2026-08-06 12:56:08 KST (boundary ts 1785988568548), yoo-dev
  (user sized go: "go" — arms host yoo-dev ONLY, this repo's main
  checkout).** Review-loop-as-sensor ARMED: `KKAMAK_REVIEW_SENSOR=1` set
  in this repo's `.claude/settings.local.json` env (gitignored →
  host-local; per-host arming preserved — yoo-mac stays OFF, arming it is
  its own sized go). Mechanism merged 062baf0 + 75a5305 (artifacts
  docs/reviews/f8e3b46-review-sensor.md,
  docs/reviews/6815e90-fix-sensor-maxbuffer.md; spec
  docs/superpowers/specs/2026-08-05-review-sensor-synthesis-design.md,
  FLAWLESS).
- **Instrument identity:** NEW instrument, stream
  `.km/review-findings.ndjson` (spec §3 nested schema). Reviewer =
  claude-haiku-4-5 on the ACP warm lane (zero-wait, close-not-release
  via the new `session/close` verb). Frozen prompt sha256
  `a19f6f85d69250520b9e33d7a8fd82353a5106e7762ba2798e5c837498294c36`.
  Constants: 15-min debounce, 30/day cap (per this host-checkout; total
  spend = 30/day × armed checkouts = 30/day today), 128 KiB hunk-aligned
  diff ceiling, side-file keep-500.
- **Pooling prohibitions:** this stream NEVER pools with the human-flow
  `docs/reviews/` findings-counts P0 measured (different reviewer tier +
  unit); pluginVersion-only bumps are NOT live boundaries for this
  stream (spec §4 carve-out); sensor prompt/constant/tier changes ARE
  (each stamps a new ts here). Any two-arm comparison over this stream
  must randomize or declare the quasi-experiment confound (spec §4).
- **Cadence checkpoint (pre-registered):** after 7 calendar days armed,
  realized events/day is read from the stream; ≥25/day → 14-day d=0.30
  bar reachable, proceed; <25/day → constants return to the user for
  amendment (new boundary ts). Nothing self-adjusts.
- **No spend at flip.** Sensor dispatches only on gated Stops in the
  main checkout of sessions STARTED after this entry (settings env reads
  at session start); worktree Stops never dispatch. First line lands on
  the first post-restart gated Stop; its ts opens the stream's first
  regime.

## 2026-08-06 — INSTRUMENT: tier-0 narrowed for `kmcrank` (D3), boundary ts 1785990600996

Plan `docs/superpowers/plans/2026-08-06-gate-tier0-narrowing.md` (revision 6),
spec `docs/superpowers/specs/2026-08-06-gate-tier0-narrowing-design.md`,
five architect rounds recorded in
`docs/reviews/2026-08-06-gate-tier0-narrowing-rounds-1-5.md`.

- **What changed.** `km-crank/test/gate-check-cli.test.ts` is excluded from
  the blocking tier and pulled back when its covered sources
  (`^scripts/gate-check\.ts$`, basename-anchored `(^|/)gate-check-core\.ts$`)
  or the file itself change. The ccgate-shaped policy became a per-suite
  table (`SUITE_POLICY`, `PKG_DIR`, per-rule optional guards, suite-keyed
  `pullInsFor`), and `scripts/gate-check.ts` computes fast lists and appends
  pull-ins per suite. `gate.json`'s `check` string is UNCHANGED
  (`bun scripts/gate-check.ts`), so no `KKAMAK_DEV_CHECKS` append — the
  drift guard at `trial-verdict.test.ts:199` stays green untouched.
  `table.full` is UNCHANGED, so tier 1 still runs the incumbent chain.
- **Measured, same method both sides** (JUnit reporter, `yoo-dev`, n=1):

  | | pre (repo `487d104`) | post (repo `440b232`) |
  |---|---|---|
  | km-crank full suite | 15.8 s | 20.03 s |
  | `gate-check-cli.test.ts` | 13.9 s (88 %) | 18.82 s |
  | **km-crank tier-0** | **15.8 s** | **1.20 s** |

  The full suite and the excluded file both GREW because this work added 15
  tests, most of them CLI tests inside the excluded file. That inflates the
  apparent saving; the honest statement is that tier-0 km-crank is now
  1.20 s, and the excluded file is whatever it is at the time it runs.
  Derived fallback selection: ccgate 13.1 + gateplugin 0.02 + kmcrank 1.20 +
  doccheck 0.05 ≈ **14.4 s**, against ≈29.7 s pre. **This sum mixes Pass A**
  (ccgate/gateplugin/doccheck, whole-suite wall clock) **with Pass C**
  (kmcrank, per-file JUnit reporter) **— the spec's §1 declares the passes
  not interchangeable and never pooled, so 14.4 s is directional, not a
  clean single-basis measurement** (same mixing defect the spec's §3 flags
  for its D7 table).
- **Instrument boundary: ts 1785990600996. SECOND boundary on this host
  today** — the review-sensor arming above stamped **1785988568548** at
  12:56, 34 minutes earlier. The two are independent and must both be
  honoured when reading this host's gated-Stop stream:
  - *theirs* changes what a Stop DOES (dispatches a detached review
    runner), and by its own entry applies only to **main-checkout** Stops
    in sessions started after 12:56 — "worktree Stops never dispatch";
  - *mine* changes what a Stop RUNS (tier-0 selection cost), wherever
    `scripts/gate-check.ts` is the code executing — this worktree
    immediately, `main` at merge.
  So main-checkout `durationMs` after merge carries BOTH changes, and a
  before/after attributed to either alone is a confound. This entry's
  Pass C measurements are unaffected: they are `bun test` suite timings
  taken in a worktree, where their sensor does not dispatch.
- Gated-Stop `durationMs` MUST NOT pool across it — tier-0 selection cost changed for every Stop that
  selects `kmcrank`, and for every fallback Stop. This host only, for now:
  the change is live wherever `scripts/gate-check.ts` is the code being run,
  which was the worktree immediately and `main` from merge **`c6879f8`**
  (2026-08-06). Main-checkout Stops run the narrowed tier-0 from that commit
  onward; suite on merged main 3298 pass / 1 skip / 0 fail.
- **ACCEPTANCE IS CONFOUNDED — three instrument changes inside ~100 minutes
  on this host.** Recorded now so nobody later reads a clean before/after out
  of this window:
  1. `1785990600996` (~13:30) — this entry, tier-0 narrowed.
  2. plugin `0.3.0 → 0.4.0` deployed (`4d27981`, ~15:0x) — a version-keyed
     cache refresh, so gated-Stop lines change `pluginVersion` mid-window.
  3. `1785996709580` (~15:11) — review-sensor effective boundary, adding a
     second detached child to every qualifying main-checkout Stop.

  The post-D3 gate cycles available at time of writing are **n=4**, and they
  straddle #2: `33374 ms` at `pv 0.3.0`, then `13744 / 16068 / 225 ms` at
  `pv 0.4.0`. The three `0.4.0` values are consistent with the narrowing
  (~13.7 s ccgate, 0.2 s doc-only); the `33374 ms` outlier is unexplained by
  selection — neither `ccgate` alone (~13 s) nor the post-narrowing fallback
  (~14.4 s) predicts it — and the leading hypothesis is CPU contention with a
  concurrent tier-1 background run, which every measurement in Passes A/B/C
  was taken without. **One sample, so a hypothesis, not a finding.**

  Consequence for the acceptance step: correlating `durationMs` against the
  per-Stop suite log is necessary but NOT sufficient here. It must also
  segment on `pluginVersion`, on marker state (a `"running"` marker means a
  concurrent bg run competing for CPU), and on whether the sensor was live.
  Any D3 effect claimed from this window without those splits is
  uninterpretable.
- **Accepted coverage loss, stated rather than discovered later.** On the
  fallback path pull-ins do not fire (`gate-check.ts`, `changed === undefined`
  ⇒ empty pull-in list — the deliberate ruling at
  `2026-08-05-two-tier-gate-check.md:919`), so `gate-check-cli.test.ts` does
  not run in the blocking tier there. Rescue is the background tier-1 run,
  which is spawn-conditional, content-raced, and absent on a session-final
  Stop. This is the same trade already shipped for `ccgate` on 2026-08-05,
  where the six excluded files are ~98 s of a 111.6 s suite; D3 applies it to
  one 13.9 s file.
- **Withdrawn during review, recorded so they are not re-proposed:** D1
  (narrow `opencode` — tier 1 does not run it, so exclusion deletes coverage
  rather than deferring it), D2 (map `scripts/` in `TIA_MAP` — priced at
  0.02 s), D4 (close the `src/acp/index.ts` gap — violates the
  basename-anchoring and one-hop policies at `gate-check-core.ts:138-149`),
  D8 (`opencode` into `table.full` — puts a module-scope `python3` + `tmux` +
  `rdflib` dependency on the synchronous debt-repayment path, an unclearable
  wedge on any host lacking them).
- **One live defect fixed on the way:** the degraded-readdir path previously
  produced a bare `["bun","test"]` argv and then appended a pull-in to it,
  collapsing a whole suite to one file. Partial scans are now discarded, so
  any scan anomaly degrades to "run everything for that package".

- **ERRATUM (2026-08-06, caught by the side session): boundary ts
  1785988568548 marks an arming that NEVER TOOK EFFECT.** The gate runs
  the INSTALLED plugin; the version-keyed cache held the 0.3.0 snapshot
  (gitCommitSha ffb8d00), an ancestor of the sensor merge 062baf0 — env,
  cwd, and restarts were all correct, but review-sensor-spawn.ts did not
  exist in the executing code. Zero dispatches occurred; the 2026-08-13
  cadence checkpoint dated from that ts is VOID (it would have misread a
  deployment bug as a failed measurement). Fix deployed: cc-gate-plugin
  0.3.0 → 0.4.0 (commit 4d27981, both jsons), `claude plugin update
  kkamak@kkamak-local` run, installed 0.4.0 verified to carry the sensor.
  **The instrument's REAL first regime opens at the first gated Stop of a
  session restarted after this update** — that line's ts supersedes
  1785988568548 as the effective boundary; the 7-day cadence checkpoint
  re-dates from it. Standing lesson (memory hardened): MERGING IS NOT
  DEPLOYING — any cc-gate-plugin code merge needs a version bump in the
  same change; verify via the installed cache dir, never repo source.

- **EFFECTIVE BOUNDARY CONFIRMED (2026-08-06 15:11 KST): the sensor's
  real first regime opens at ts 1785996709580** (first stream line,
  pluginVersion 0.4.0). Live-proven same minute with two manual runner
  dispatches against a real 2-line working-tree diff: (1) cold start →
  correct "warm-lane-busy" skip (zero-wait seat, daemon not yet up);
  (2) warm → FULL PASS — findingsCount 0, exact diffStat, haiku
  3399 ms, atomic state write, side file, and `closeSession →
  {closed:true}` proving the session/close verb end-to-end. The 7-day
  cadence checkpoint dates from 1785996709580 → due 2026-08-13.

- **cc-api-daemon PIN BUMP 0.5.0 → 0.7.0 (2026-08-10, yoo-dev, boundary ts
  1786327038587):** both consumers (`cc-gate-plugin`, `opencode-plugin`)
  re-pinned `baee1c4` → `ca41bd7`; cc-gate-plugin 0.4.0 → 0.4.1 in the same
  change (merging-is-not-deploying rule). What 0.7.0 carries: elastic pool
  floor/ceil (`ACP_MIN_SESSIONS`, retention-only, default 0), one-per-tick
  reap throttle (UNCONDITIONAL — this is the one behavior delta reaching
  floor-0 consumers: idle warm entries now drain one per reaper tick instead
  of all at once; worst case (max−1)×tick longer residency), acquire-miss
  reclaim (closes the pool-exhausted window the throttle opens), and
  `ACP_SESSION_IDLE_MS` entry-TTL wiring (default unchanged 900s). With both
  knobs unset — this host's state — turn-level outcomes, sensor line
  semantics, checkMs, and every metric stream are unaffected: no stream
  reads pool size or drain timing. Boundary recorded for residency-profile
  honesty, not metric partitioning. Full gate green post-bump (1892 tests +
  doc-check). Effective on the installed plugin at the first session
  started after `claude plugin update` picks up 0.4.1 — verify via the
  installed cache dir, never repo source.

- **§4.3 A/A MACHINERY TRIAL STARTED (2026-08-10, yoo-dev — first trial
  enrollment in project history):** `trialId v16-2026-08-10T03:11:17.510Z`,
  store `meta-harness/.kkamak/global` (project-global), baseline v7,
  candidate v16 BYTE-IDENTICAL (A/A per spec §9 design falsification;
  verified system===baseline and playbook===baseline at start). rewardMode
  gate-outcomes, minSessions 5, T_MAX 28d. Expected verdict: KEEP-by-tie
  once the three floors fill (MIN_N=20 cycles, ≥5 sessions/arm, E_MIN=5
  block events/arm — blocks ≈1/day here are the pacing floor). Any other
  outcome = machinery broken, no real trial until fixed + rerun clean.
  Resolution fires on km-crank scheduled runs. Metric-neutral by
  construction (identical content), no instrument boundary.

- **FIXTURE_ALLOWED_REPOS += meta-harness (2026-08-10, user ruling "go with
  1 and 3"):** first harvest executed same commit — newest organic ref
  (this host's own gate-check module-not-found block, 2026-08-09 23:36 UTC)
  → `term-bench2/tasks/harvested-meta-harness-20260809-233612` (task dir
  47M — repo-tree snapshot; COMMIT DECISION HELD, see resume). 18 more
  eligible refs; batch harvesting awaits the size ruling.

- **A/A CATCH + RULING (a) ENACTED (2026-08-10, yoo-dev, boundary ts
  1786332446406):** the v16 A/A (above) caught a wiring gap within the
  hour — exposure rows are written ONLY by the CC adapter's SessionStart
  seam, which was (1) not wired as a hook in this repo and (2) role-gated
  with no role configured, so organic sessions could NEVER enroll: floors
  structurally unfillable, guaranteed T_MAX rollback. §9's design
  falsification working as designed — machinery gap found before any real
  candidate's 28-day slot burned. v16 ABANDONED (km-panic trial-off,
  baseline v7 restored). User ruled (a): wire organic enrollment. Enacted:
  `install.ts --role mh-build` → SessionStart/UserPromptSubmit/PreToolUse/
  PostToolUse/Stop hooks in `.claude/settings.json` (paths rewritten to
  `${CLAUDE_PROJECT_DIR}` — committed, host-portable; yoo-mac inherits on
  pull, no per-host step) + `env.MH_ROLE=mh-build` + command stubs. Fresh
  A/A STARTED post-wiring: `trialId v17-2026-08-10T03:27:07.982Z`,
  baseline v7, byte-identical arms. Enrollment PROVEN hermetically (fake
  SessionStart → exposure row with v17 trialId + arm, compose injected;
  probe row deleted before any real data). INSTRUMENT BOUNDARY: from the
  first post-wiring session, every new CC session here receives injected
  harness context (project-global system 366 chars + role system) and an
  arm assignment — sessions before this ts never carried either. Sensor
  readings pool across this boundary only for metrics the injection cannot
  touch; anything behavior-shaped partitions here.

- **cc-api-daemon PIN BUMP 0.7.0 → 0.8.0 (2026-08-10, yoo-dev, boundary ts
  1786345076047):** both consumers re-pinned `ca41bd7` → `33f74db`;
  cc-gate-plugin 0.4.1 → 0.4.2 same change. 0.8.0 = lane parity: agent-lane
  `stopReason` (from the terminal result message), wire
  `_meta.kkamak.schema` enforced STRUCTURALLY on both lanes (api
  output_config / agent outputFormat via the injected StructuredOutput
  tool; never prompt-text emulation — the cls-ab wrong-verdict mechanism,
  banned at the wire), schema folded into the pool acquire key (review
  amendment 6b — mixed schema/no-schema workloads segregate instead of
  permanently refusing), maxTokens loud-reject pinned honest (env knob
  declared-but-unconsumed in readable source), A4 context residue measured
  at 226 B on this package's own DEFAULT_ISOLATION. Consumers here send
  neither schema nor rely on agent-lane stopReason → turn-level behavior
  and every metric stream unaffected; boundary recorded for provenance.
  Full gate green post-bump (1892 tests + doc-check). Deploy effective at
  first session after the cache picks up 0.4.2.

- **a3 LIVE ADAPTER + SensorLine ruleChecks CONTRACT REV (2026-08-14,
  yoo-mac, boundary ts 1786634418937):** merge `911ae49` (7b artifact
  `2604da8-a3-live-adapter.md`), cc-gate-plugin 0.4.5 → 0.4.6 deployed
  yoo-mac (km-refresh --force, cache grep-verified; prior roots retained,
  no fail-open occurred). Instrument change: sensor lines gain OPTIONAL
  `ruleChecks` outcomes (`{id, pass, ms} | {id, skipped} | {id,
  refused}`, F2 — never cmd text) emitted by the new shadow evaluator
  (caps RULE_CHECKS_MAX=8, RULE_CHECKS_BUDGET_MS=5000; raising either is
  its own future boundary). SHADOW-only: never blocks, never alters the
  Stop decision — behavior-shaped metrics unaffected; the field is
  additive telemetry (calibration coveredMechanismRev advanced over the
  telemetry-only core edit, TM1 precedent, 4th instance). Producer side:
  every playbook-mutating store transition now writes
  `.km/rule-checks.json` (liveEligible checks only; inert until a
  checked-rule candidate exists). Contract rev landed BOTH repos in one
  window (kkamak `5efa3ab`: 5th golden vector + conformance shape
  check); km-crank parity hard-fail verified green from the main
  checkout against the real ~/z2/kkamak fixture. Lines with
  `pluginVersion >= 0.4.6` may carry the field; earlier lines never do.
  Suites at deploy: opencode 1985/0 · cc-gate 1063/0 · km-crank 400/0 ·
  kkamak 418/0.

- **DAEMON CARRIER MIGRATION — PROPOSER-ENVIRONMENT + JUDGE-TRANSPORT
  CHANGE (2026-08-14 17:37 KST, yoo-mac, boundary ts 1786696678012):**
  merge range `3716ea8..77288bc` on main (7b artifact
  `77288bc-daemon-carrier-migration.md`). BOTH production seat carriers
  changed in one window, per user ruling (spec `13b9938`):
  - **Proposer/promoter/curator:** detached `claude -p` child (repo cwd,
    hooks, CLAUDE.md, plugin surface live — the PROVEN contamination
    carrier) replaced by a detached bun worker: deterministic prompt
    assembly (json-reply outputMode), ONE toolless cc-api-daemon call
    with our per-seat system prompt, harness-validated JSON reply,
    harness-written staging files, provenance json + persisted prompt.md
    per cycle. Proposal DISTRIBUTION shifts across this boundary:
    pre-boundary proposals were authored under CC's harness (caveman
    style, superpowers, repo CLAUDE.md all injected); post-boundary
    proposals see ONLY the assembled prompt. Pre/post proposal
    comparisons are invalid across this ts.
  - **Judge/review seat:** one-shot `claude -p --system-prompt` child
    replaced by toolless daemon call (seat isolation, settingSources [],
    auto-memory off). Same verdict-relevant inputs; carrier hygiene +
    explicit DEFAULT_JUDGE_MODEL fallback (previously CC CLI default —
    judge-model provenance is now recorded, not ambient). Judge-verdict
    streams comparable in substance but carrier-attributable variance
    partitions at this ts.
  - `claude -p` survives ONLY in bench measurement context (TB2 driver
    specimen + p2 probe arms), user-ruled. cc-api-daemon pin unchanged
    `33f74db` (0.8.0), toolless guard untouched.
  - Suites at merge: opencode 2025/0 post-sweep (2031/0 pre-sweep
    combined).
  - **FRESH-BOUNDARY MARKER — first post-migration crank (M4 smoke,
    2026-08-14 ~17:58 KST, user-approved spend):** two project-global
    propose cycles through the production hook path. Crank 1 exposed a
    REAL race (stale pre-migration staging files applied as candidate v1
    two seconds after spawn — hijacked cycle); remediated (trial
    reverted from `.trial` baseline snapshot, bogus candidate deleted)
    and FIXED on main `6f3fde6` (staging pre-clean in all three
    triggers + regression test; suite 2026/0; scoped review approved).
    Crank 2 clean end-to-end: worker → cold-daemon spawn → opus-5 warm
    lane (model proof passed, live repair-retry recovered) → staged
    artifacts + provenance → apply → review gate REJECTED 1/1 added
    bullet → rejected ledger (F2-conformant). Judge authenticity
    proven: per-key parsed verdicts (category/domain_swap/duplicate
    failed; behavior_level/mechanize_instead passed) — fail-closed
    would read "rubric: no parseable checks object". CONTAMINATION
    ACCEPTANCE PASSED: persisted prompt + worker system prompt contain
    zero CC-harness markers (no CAVEMAN, no superpowers, no heredocs).
    Store net effect: zero (rejection; candidates = v0 only). Known
    residual (non-blocking, follow-up): hook-crash-before-lock-write
    zombie-worker edge noted in the fix review.

- **HOOK-RULE P0–P2 + SensorLine hookRules CONTRACT REV (2026-08-15,
  yoo-mac, boundary ts 1786771179498):** hook-rule evolution program
  phases P0–P2 landed (spec `docs/superpowers/specs/
  2026-08-14-hook-rule-evolution-design.md`; P0 evidence
  `docs/loop-probes/hook-rule-p0/PROBE.md` — deny binds under one-shot
  `claude -p`, additionalContext warn channel works, composition
  confirmed, latency 90× under budget). cc-gate-plugin 0.4.6 → 0.4.7.
  Instrument change: sensor lines gain OPTIONAL `hookRules` outcomes
  (`{id, matched, mode, ms}`, F2 — never input text or patterns),
  aggregated at Stop from the dispatch-side per-session accumulator
  `.km/hook-rule-outcomes-<sessionID>.ndjson` (cap 200, consumed on
  read, crash-safe). SHADOW-only fleet-wide: every rule is born shadow,
  no ramp machinery exists (P3), the deny/warn evaluator paths are
  built but unreachable until transitions exist — behavior-shaped
  metrics unaffected; the field is additive telemetry. Producer side:
  `.km/hook-rules.json` compiled table exported at the same five
  transition sites as rule-checks (caps 16 total / 4 deny at export;
  inert until a hookRule bullet exists — none do at this boundary).
  Contract rev landed BOTH repos in one window (kkamak `bf73adc`: 6th
  golden vector CLEAN_ACCEPT_WITH_HOOK_RULES + count/name-list update,
  byte-equal to km-crank's embedded normative line); km-crank parity
  hard-fail PROVEN LIVE mid-window (fired against the real half-updated
  ~/z2/kkamak fixture, cleared byte-green after `bf73adc`). Lines with
  `pluginVersion >= 0.4.7` may carry the field; earlier lines never do.
  P3 gate item standing: bench-side sed input-extraction holes (spec §8)
  must close before any bench deny arm. Suites at deploy: opencode
  2109/0 · cc-gate 1071/0 · km-crank 403/0 · kkamak 418/0.
  - **0.4.7 DEPLOY (2026-08-15, yoo-mac):** `km-refresh.sh --force` from
    main (post-P3), cache grep-verified (`0.4.7/src/hook-rule-outcomes.ts`
    present). hookRules sensor field live from the next session. §5
    sidecar RULED APPROVED (bench-only input capture); bench
    sed-extraction gate item CLOSED (awk scanner, `9baeffb`); proposer
    prompt now teaches the hookRule op contract (`9a90681`) — first
    organic hookRule proposals possible from the next crank. Stale cache
    dirs 0.4.3–0.4.6 remain pending the session-restart cleanup batch.
