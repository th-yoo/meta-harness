# RESUME — start here

**New session / new host: read this first.** (Personal memory is host-local and
does NOT transfer; this file + the repo are the source of truth.)

## ✅ SESSION END 2026-08-06 (`yoo-mac`) — cc-host PATH FIX MERGED (87d4937) · techs.md RE-AUDIT ON BRANCH (merge go given, fact-check in flight) · NEW STANDING RULE: merges to main need explicit user go

**RESUME PROMPT (either host — git-only):**
```
Resume kkamak (meta-harness), post-2026-08-06 yoo-mac session. git pull
FIRST. Main @ 87d4937; branch worktree-fix-cc-host-claude-path pushed
with 4 docs commits pending merge (see below).

NEW STANDING RULE (user, 2026-08-06): merges to main require the user's
EXPLICIT go, every time — a granted fix request is NOT a merge go. Build
on a branch (worktree when parallel sessions live), review, report, wait.
7b gate still binds when the go comes.

MERGED (before the rule, kept by user ruling): 87d4937 cc-host PATH fix —
the daily km-crank sweep (launchd minimal PATH) had failed EVERY detached
proposer spawn on yoo-mac 4/4 days ('Executable not found in $PATH:
"claude"', ~/.config/kkamak/runtime/cc/hook.log). Bun resolves argv[0]
from process-start PATH. Fix: exported resolveClaudeArgv (KKAMAK_CLAUDE_BIN
-> Bun.which -> ~/.local/bin,/usr/local/bin,/opt/homebrew/bin -> bare) in
BOTH default spawn seams; injected test spawns unaffected; execute-proven
under a minimal PATH. Review docs/reviews/42d6199-fix-cc-host-claude-path.md
(0C/0I). CONSEQUENCE: the warm lane's evidence supply line (daily proposer
spawns) is unblocked — warm-lane value verdict now actually collectible.
Deferred note from review: bench/drivers/claude-code.ts also spawns bare
"claude" (podman context, no failure evidence — untouched).

PENDING MERGE (go GIVEN, awaiting fact-check review verdict): branch
worktree-fix-cc-host-claude-path = 4 docs commits re-auditing
docs/techs.md (was frozen at 07-27, missed the whole GA6-GA14 arc):
2d071d3 Part-1 §L inventory + Part-2 third delta; 19e014e Part-3
effectiveness ranking; 47b3684 evidence pointers (paths grep-verified);
dbad121 proven-ineffective table. FACT-CHECK VERDICT (landed 08-06, session end): NOT clean —
2 findings, both citation/scope errors, ALL quantitative claims verified
exact against sources. Fix round owed BEFORE merge:
 (1) techs.md:271 + :357 — "/clear third result frame" is cited to GA13
     but is a GA14-era find (T4-1a probe, resume 08-04 block); re-cite.
 (2) techs.md:381 — R1 folded into "post-A1 residual, 8 straight": R1
     ran on BARE pre-A1; post-A1 streak = R2-R8 (matches the 07-27
     section's own R5-R8 framing). Retitle/rescope the row.
Then: artifact docs/reviews/<sha>-techs-reaudit.md on the branch,
scripts/merge-with-gate.sh from main (merge go already given), push,
delete branch + worktree fix-cc-host-claude-path.

SESSION FINDINGS (from a 3-agent repo+host evidence sweep, yoo-mac):
 - Warm lane on yoo-mac: armed in settings, ZERO runtime exercise (no
   daemon artifacts, all gauge records transport=sdk). Not a defect —
   seats only fire during loop runs — but the PATH bug above was ALSO
   silently killing the daily spawns that feed it.
 - Plugin cache updated 0.2.1 -> 0.3.0 on yoo-mac per the committed
   recipe (grep-verified). Two 0.3.0-stamped gate-outcomes lines have
   landed in THIS repo's .km (first at ~ts 1785941813542-1785942297240
   range) — if the 0.3.0 instrument-boundary ledger duty applies to
   meta-harness (not just the kkamak dogfood repo), that ts is now
   determinable and the ledger entry is OWED. Check and stamp.
 - Two-tier gate on yoo-mac: n=2 fires so far (65.5s then 0s), bg.log
   0 bytes, marker green — working, barely exercised.
 - techs.md Part 3 has the effectiveness ranking + proven-ineffective
   table; the era's named failure shape = evidence-consuming machinery
   built ahead of its supply; blocker = signal-source PAIRING
   (review-sensor synthesis is the fix candidate, spec SOUND, unbuilt).

OPEN USER DECISIONS (unchanged from office block below): review-sensor
synthesis build go · P2 actuator-binding go · C4 sized go after base
rate (office chain). Premium was 429-walled (haiku OK) — probe first.

Rules: sized go before spend · spec-is-law, pre-data amendments only ·
merge-with-gate.sh + artifact AND explicit user merge-go · boundary ts
on instrument changes · F1/F2 · per-task reviews · grep-verify · SITREP.
```

## ✅ SESSION END 2026-08-05 evening (`yoo-dev`) — FULL-DAY ARC MERGED; CHAIN ARMED POST-REBOOT; 3 USER DECISIONS OPEN

**RESUME PROMPT (either host — git-only transfer):**
```
Resume kkamak (meta-harness), post-2026-08-05 evening session. git pull
FIRST, then this block. Main >= 198184e, tree clean.

MERGED TODAY (all pushed, 7b-gated where code):
 - Two-tier gate DEPLOYED (merge 8224748, instrument ts 1785888548054):
   gate.json check = bun scripts/gate-check.ts + checkTimeoutMs 600000.
   Live-proven; S4 erratum later CONFIRMED ~22x faster Stops (durationMs
   mean 108733 -> 4943). KKAMAK_DEV_CHECKS drift guard must append on any
   future check-string change.
 - Warm lane ACTIVATED office (765dd62, ts 1785892022908) — both hosts
   now warm; three seat regimes per host, never pool across ts.
 - cc-gate-plugin 0.2.1 -> 0.3.0 (ffb8d00) + cache recipe: version bump
   in BOTH jsons + `claude plugin update kkamak@kkamak-local` + restart,
   in that order. Dogfood session now runs 0.3.0; its FIRST 0.3.0-stamped
   gate-outcomes line = that repo's instrument boundary (not yet emitted
   at session end — their ledger duty when it lands).
 - agent-sdk-transport plan CLOSED (796a103 — Task 8 §6d had already run
   08-04: POOLING-PERMITTED at exact edge; second stale-resume incident:
   always check SDD ledger + committed artifacts before dispatching).
 - C4 nudge-vs-reject experiment PRE-REGISTERED (bfa0572, all 5 rulings
   closed + architect fixes: response-domain check gate +6 opus, prepend
   surrogate declared, disobedience metric, manifest subset draw). Budget
   6x|C4|+66, sized go AFTER base rate lands.
 - Loop-fix probe program: spec reviewed-to-SOUND 3 rounds (b6f8730),
   EXECUTED via SDD (merge 1649fe8): P0/P1/E + cause mapping in-spec.
   VERDICT NO-CONFIG-PASSES — blocker is signal-source PAIRING, not
   rigor: b2 review-findings viable (sd/mean 1.41) but rides s3
   1.43/day (245 days); at s1 62.6/day or s2 55.4/day it passes in
   6-7 days. S4 denominator fix + erratum merged 198184e (found by the
   kkamak-repo session's independent review — credit recorded).

ARMED ON THIS HOST (re-arm after any reboot):
 - tmux gaugeverify: bash scripts/channel-chain.sh (probes opus every
   10min -> channel-smoke --go 14 -> mechanical bar -> channel --go 301;
   gos granted; durable log .km/channel-chain.log; markers /tmp/kkamak).
   On completion: report |C4| base rate + exact experiment size, get
   sized go, then build c4-arms.ts per pre-reg §7.
 - Watchers (session-local, re-arm if wanted): dogfood pane, first-0.3.0
   sensor line, chain log.

OPEN USER DECISIONS (nothing self-adopts):
 1. Review-loop-as-sensor synthesis design go — numerically motivated
    (capacity rows 6-7d) + manually demonstrated (other session: ~29
    findings on demand). Brainstorm -> spec -> plan on go.
 2. P2 actuator-binding probe spec + sized go (outcome signal = B2).
 3. B3 binarization ruling (one sentence; admits gauge classes as signal).

Premium: opus/sonnet 429-walled all day (haiku OK) — chain self-probes;
probe before any manual spend:
source scripts/probe-models.sh && probe_models claude-haiku-4-5 claude-sonnet-5 claude-opus-5

Rules: sized go before spend · spec-is-law, pre-data amendments only ·
merge-with-gate.sh + docs/reviews artifact · boundary ts on instrument
changes · F1/F2 · per-task reviews · grep-verify · SITREP.
```

## ✅ SESSION 2026-08-05 cont. (`yoo-dev`) — LOOP-FIX PROBE PROGRAM SHIPPED (merge 1649fe8): VERDICT NO-CONFIG-PASSES · CAUSE MAPPING RECORDED · §5 DECISION OWED TO USER

```
Probe program (spec docs/superpowers/specs/2026-08-05-loop-fix-probe-
program-design.md, reviewed-to-SOUND 3 rounds; results + cause mapping
appended in-spec; artifact docs/reviews/6fb1c64-loop-probes.md):
 - P0: viable signals = B2 review findings (n=10, sd/mean 1.41) + B4 TB2
   trials (22/34, capacity-only). B1 gate-outcomes UNKNOWN (latest regime
   n=5 post-0.3.0-stamp 1785899174570); B3 needs binarization ruling.
 - P1: S1 62.57 Stops/day, S2 55.43/10.57 commits/day, S3 1.43
   review-adds/day — starvation diagnosis STALE; density exists.
 - E: NO-CONFIG-PASSES — meaningful b2×s3 = 245 days vs 14-day bar;
   capacity b2×s1/s2 ≈ 6-7 days WOULD pass. Blocker = pairing, not rigor.
OPEN DECISIONS (user rules, nothing self-adopts):
 1. Review-loop-as-sensor synthesis design (auto-fired review passes at
    commit/Stop cadence — numerically motivated now) — needs design go.
 2. P2 actuator-binding probe spec (outcome signal = B2) — needs spec+go.
 3. B3 binarization ruling (cheap, admits gauge classes as a signal).
Also this session: two-tier gate deployed (ts 1785888548054), warm lane
activated office (ts 1785892022908), plugin 0.3.0 cache recipe, C4
nudge-vs-reject pre-reg registered (chain still opus-walled in tmux
gaugeverify), agent-sdk plan closed (stale-resume caught).
```

## ✅ SESSION END 2026-08-05 latest (`yoo-dev` office) — TWO-TIER GATE SHIPPED: amended→reviewed-to-flawless→SDD-executed→merged 8224748→DEPLOYED (instrument ts 1785888548054)

**RESUME PROMPT (either host — git-only transfer):**
```
Resume kkamak (meta-harness), post-2026-08-05 two-tier-gate deploy. git pull
FIRST (main >= 8224748), then this block.

SHIPPED THIS SESSION (full chain, 7b-gated):
 - Plan amended (a-c + minors) then ralph-looped feature-dev:code-architect
   to FLAWLESS (2 rounds, ffa1fc8), then SDD-executed: Task 1 core
   (1906d5a, km-crank/src/gate-check-core.ts), Task 2 CLI (d9ad412,
   scripts/gate-check.ts), Task 3 deploy (e9fcbf6), final-review hardening
   (9e3b062: bgMain marker ownership guard, ps pid-identity kill guard,
   checkTimeoutMs 600000, ledger merge-gate wording fix, tsconfig include).
   Merge 8224748 via merge-with-gate.sh; artifact
   docs/reviews/9e3b062-two-tier-gate-check.md (verdict approved,
   findings-count 9 — 4 Important all fixed, 5 minors deferred, listed there).
 - gate.json check is NOW `bun scripts/gate-check.ts` (+checkTimeoutMs
   600000, rounds/gauge unchanged). LIVE-PROVEN yoo-dev: tier0 0.215s
   (doc-only TIA) / 23s (no-baseline fallback); bg full run lands green
   ~170s; forced-red debt repayment surfaces stored tail, exits 0, restores
   green. KKAMAK_GATE_FULL=1 restores incumbent exactly;
   KKAMAK_GATE_NO_BG=1 suppresses bg spawn.
 - INSTRUMENT BOUNDARY ts 1785888548054 (2026-08-05 09:09 KST, yoo-dev):
   gate-outcomes durationMs/checkMs distributions shift + check string
   changes — NEVER pool across (entry in
   docs/2026-08-01-gauntlet-adoption-ledger.md). yoo-mac inherits ON PULL
   (config, not env): its first pulled Stop = fallback (~25-45s) + bg
   spawn, then doc-only Stops sub-second.
 - FOUR reality-forced deviations from plan-verbatim code, all reviewed +
   recorded in the review artifact (git add ':!.km' hard-errors on
   gitignored paths; runGate KKAMAK_GATE_* env strip; args.txt rmSync x2;
   KKAMAK_DEV_CHECKS drift-guard append in km-crank/src/trial-verdict.ts —
   that array must gain the new check string whenever gate.json changes).

OPEN DUTIES: Task 8 is DONE — STALE-RESUME CORRECTION 2026-08-05: the §6d
pv run ALREADY RAN 2026-08-04 at office (counts committed
docs/gauge-pv/yoo-dev-sdk-vs-agent-sdk-pv-counts.json; spec outcome
65ac26c: agreement 4/5=0.800, missedC 1<=cap 1, wrongTransport 0 —
POOLING-PERMITTED at exact bar edge). Task 9 verdict recorded in spec;
remainder is per-batch opt-in only (boundary ts logged when the first
batch caller opts in — no action until then). agent-sdk-transport plan
CLOSED. Second stale-resume incident on that plan — always check the SDD
ledger + committed artifacts before dispatching plan tasks.
Office warm-lane activation optional (own logged decision; re-prove
suites in activated state first). Premium was 429-walled — probe before
any spend:
source scripts/probe-models.sh && probe_models claude-haiku-4-5 claude-sonnet-5 claude-opus-5

Rules: sized go before spend · spec-is-law, pre-data amendments only ·
merge-with-gate.sh + docs/reviews artifact · boundary ts on instrument
changes · F1/F2 · per-task reviews · grep-verify · SITREP.
```

## ✅ SESSION END 2026-08-05 later (`yoo-dev` office) — TWO-TIER GATE PLAN ASSESSED: EXECUTE WITH 3 AMENDMENTS (awaiting go) · GATE STALL CONFIRMED BOTH HOSTS

**RESUME PROMPT (either host — git-only transfer):**
```
Resume kkamak (meta-harness), post-2026-08-05 office session. git pull
FIRST, then this block. Main >= 5926817, tree clean. No code changed this
session — it was read + assess only.

STATE: the full 08-04/05 arc is merged and recorded (minimal/HISTORY.md
GA14 + the two blocks below this one): seats on sendPrompt/anthropic-api
(boundary ts 1785847012141), warm lane wired everywhere + ACTIVATED ON
YOO-MAC ONLY (ts 1785856371528, three regimes on that host — never pool
seat data across ts). Office NOT activated (own logged decision; re-prove
suites in activated state first).

THIS SESSION ESTABLISHED:
 1. The ~155s gated-Stop stall happens on BOTH hosts (yoo-dev
    .km/gate-outcomes.ndjson: durationMs 151-158s, host=yoo-dev). The
    user only FEELS it on the MacBook because dogfood sessions are
    interactive there; on yoo-dev it burns agent-session Stop hooks.
 2. docs/superpowers/plans/2026-08-05-two-tier-gate-check.md ASSESSED:
    core is sound (mechanism untouched, tier-1 verbatim, debt
    self-clearing, spawn race structurally prevented). EXECUTE VIA SDD
    ONLY AFTER 3 pre-execution amendments:
    a. Wedged-bg liveness bound — "running" marker with startedTs older
       than ~15min => treat dead, pid-scoped kill, respawn (hung ACP
       daemon test = alive pid forever = full-check coverage silently
       stops; no bound exists in the plan).
    b. Slow-source blind spot — editing acp-daemon.ts etc. gets ZERO
       blocking coverage (TIA picks ccgate, tier0 excludes exactly the
       matching tests). Amendment: changed slow-source basenames pull in
       their matching slow test file(s), targeted not whole-110s.
    c. Fallback-cost accuracy — ALL_SUITES includes opencode (~47s) which
       the incumbent check NEVER ran; fallback tier0 is ~80-90s not the
       claimed 25-45s. Either drop opencode from the fallback set (match
       incumbent scope) or fix the ledger-note numbers.
    Minor: runSync dead code; minimal/*.md edits trigger full opencode
    suite via ^minimal/ TIA rule.
 3. NOTHING DISPATCHED — amendments not yet written into the plan, no go
    given. Next action on "go": write amendments a-c into the plan
    (pre-execution, it is unexecuted so freely amendable), then SDD
    3 tasks (full code is in-plan => cheap-tier implementers), deploy
    Task 3 stamps the instrument note (durationMs never pools across
    deploy ts; office inherits via pull — config, not env).

OTHER OPEN DUTIES (unchanged from the MacBook block below):
 - TASK 8 §6d pv run (office store has the sdk stratum; REAL SPEND):
   size token-free first — bun cc-gate-plugin/src/gauge/replay-cli.ts
   pv-sample --pair sdk:agent-sdk — report size+tier, get sized go.
   Task 9 chains token-free; default-flip DELETED (per-batch opt-in only).
 - Office warm-lane activation: optional, own logged decision.
 - Premium: 429-walled at last probe (haiku OK) — probe before ANY spend:
   source scripts/probe-models.sh && probe_models claude-haiku-4-5 claude-sonnet-5 claude-opus-5

Rules: sized go before spend · spec-is-law, pre-data amendments only ·
merge-with-gate.sh + docs/reviews artifact · boundary ts on instrument
changes · F1/F2 · per-task reviews · grep-verify · SITREP.
```

## ✅ SESSION END 2026-08-05 (`yoo-mac` MacBook) — DARWIN SUITES GREEN (sun_path fix) · WARM LANE ACTIVATED ts 1785856371528 · TASK 8 RETARGETED TO OFFICE · GATE STALL ROOT-CAUSED + TWO-TIER PLAN WRITTEN (unexecuted)

**RESUME PROMPT (office `yoo-dev` — cross-host: git-only transfer):**
```
Resume kkamak (meta-harness) at office, post-2026-08-05 MacBook session.
git pull FIRST (main >= 6e16bba), then this block.

WHAT MACBOOK SHIPPED (all merged+pushed, 7b-gated where code):
 - 8795db1 darwin sun_path fix: AF_UNIX socket paths cap at 104B on
   darwin; ACP test sockets hit ~121B, 35 tests silently degraded to
   no-call/fallback. Shared test/sock-path.ts helper, hard 100B assert.
   Suites now green BOTH hosts (cc-gate 1043/0, opencode 1776/1skip).
 - probe-models.sh exit-127 fix (stock darwin has no `timeout`).
 - 1a11046 RSS probe darwin port + MacBook measurement:
   ~330MB/warm-session (same band as WSL2), recycle flat; MacBook cap
   STAYS 4, 8 ruled NOT permissible there (16GB host).
 - WARM LANE ACTIVATED on yoo-mac: KKAMAK_SEAT_PROVIDER=anthropic-cli-warm
   in ~/.claude/settings.json env, boundary ts 1785856371528 (2026-08-05
   00:12:51 KST), ledger entry in 2026-08-01-gauntlet-adoption-ledger.md.
   yoo-mac seat lines now partition into THREE regimes by ts — never pool
   across. Office NOT activated — its own logged decision; if taken,
   re-prove suites in the ACTIVATED state first (standing rule).
 - GA7→GA14 renumber in HISTORY.md (aaa6f16).
 - DISCOVERY: plan Tasks 6-7 (pv pairing + --pair flag) were ALREADY done
   at office 08-04 (d576d12, 0d44aab, cbac62b) — 08-03 resume block was
   stale. Verified green on darwin; refusal path execute-proven.
 - GATE STALL ROOT-CAUSED (user report "always stuck with stop hooks"):
   NOT a hang, NOT warm activation, NOT the agent-sdk transport (live
   derive stays API SDK, pinned). It is gate.json's check running the
   FULL 3-suite chain on every cycle-ending Stop, and the ACP arc's tests
   made that ~6x slower: gate-outcomes durationMs 26-31s through 08-02 ->
   151-183s from 08-04 (first slow entry PRE-activation, so activation
   exonerated). Measured split: ACP daemon/warm test files 110s +
   agent-sdk CLI-spawn tests 24s = ~134s of a ~160s suite; remaining
   ~880 tests ~25s. Best-practice sweep (Fowler pre/post-integrate split,
   TIA w/ fallback-to-full, seconds-scale blocking budgets) matches.
 - FIX PLAN WRITTEN, NOT EXECUTED:
   docs/superpowers/plans/2026-08-05-two-tier-gate-check.md — 3 tasks:
   pure decision core in km-crank (marker state machine, package-TIA,
   slow-file policy regex), scripts/gate-check.ts CLI (dirty-tree hash
   via temp-index write-tree, detached bg full run, red-marker ->
   sync full-run debt repayment, KKAMAK_GATE_FULL/NO_BG/COMMANDS seams),
   deploy (gate.json swap + adoption-ledger INSTRUMENT entry — gated-Stop
   durationMs never pools across deploy ts). Tier 1 = incumbent check
   VERBATIM; core/ mechanism untouched; gate.json is committed so the
   swap reaches office via pull once deployed. Execution choice
   (SDD vs inline) still owed.

OFFICE DUTY — TASK 8 (§6d pv run, REAL SPEND, needs explicit sized go):
MacBook is structurally blocked: its store is 198 records ALL
transport-absent (CLI-era), zero sdk-derived class-C; F2 means corpus
never travels. The sdk-derived stratum lives in YOUR store (§6c ran
there). Steps (plan Task 8, docs/superpowers/plans/2026-08-03-agent-sdk-
transport.md):
 1. Size token-free:
    bun cc-gate-plugin/src/gauge/replay-cli.ts pv-sample --pair sdk:agent-sdk
 2. Report size + model tier (haiku default) to user, get sized go.
 3. KKAMAK_GAUGE_TRANSPORT=agent-sdk ... derive <shadow-dir> --go <n>
    then pv-compare --pair sdk:agent-sdk; wrongTransport MUST be 0.
 4. Commit counts to docs/gauge-pv/<hostname>-sdk-vs-agent-sdk-pv-counts.json
 5. Task 9 chains immediately, token-free: script-tally verdict vs §6d bar
    (agreement >= 0.80, missed-C <= ceil(0.10*|C_sdk|)). Task 9's
    default-flip is DELETED (GA13 amendment c) — pass means per-BATCH-
    caller opt-in only, live path stays pinned "sdk". Bar-fail is a
    complete outcome: record split-readings, stop.
SDD ledger: .superpowers/sdd/2026-08-03-agent-sdk-transport/progress.md
(MacBook copy; office's own ledger is its local record).

STANDING: premium was 429-walled (haiku OK) at MacBook session end —
probe before spend: source scripts/probe-models.sh && probe_models
claude-haiku-4-5 claude-sonnet-5 claude-opus-5 (now darwin-safe too).
Rules unchanged: sized go before spend · spec-is-law, pre-data amendments
only · merge-with-gate.sh + docs/reviews artifact · boundary ts on
instrument changes · F1/F2 · per-task reviews · grep-verify · SITREP.
```

## ✅ SESSION END 2026-08-03 late (`yoo-dev` office) — §6d AGENT-SDK TRANSPORT BUILT (T1-T5, pushed, UNMERGED) · 429 ROOT-CAUSED = PER-MODEL-TIER QUOTA · 7b GATE ARMED (3 gated merges) · CHANNEL LADDER + TRANSPORT DEDUP + COMBINE HARD-GATE MERGED — main @ `ef3627d` pushed · branch `agent-sdk-transport` @ `ab9e513` pushed, 13 commits

**RESUME PROMPT (office `yoo-dev`):**
```
Resume kkamak (meta-harness), 2026-08-04. Read docs/resume.md FIRST (this
top block), then minimal/HISTORY.md GA13 for the full 08-03 evening.

STATE: main @ ef3627d pushed. Branch `agent-sdk-transport` @ ab9e513
PUSHED but UNMERGED — 833 tests + tsc green, tree clean. NO SPEND has
occurred on it. Tasks 1-5 of docs/superpowers/plans/2026-08-03-agent-sdk-
transport.md are done with per-task reviews; Tasks 6-9 untouched.

429 IS NOT OVER AND IS NOT A WALL-CLOCK WAIT: it is a PER-MODEL-TIER
quota. Re-probed at session end — haiku OK, sonnet 429, opus 429
(unchanged for ~19h). Probe before assuming anything:
    source scripts/probe-models.sh && probe_models claude-haiku-4-5       claude-sonnet-5 claude-opus-5
Anything haiku runs today. All premium work stays blocked.

4 tmux launchers are still armed and correctly gated (clsab2 →
gaugeverify → retry112 → stage1wait, markers /mnt/d/tmp/kkamak-markers/,
none fired). They need premium and will fire unattended when it returns;
each has a model-free tally duty listed further down this file. Leave
them unless you want to re-scope them.

FIRST DECISION (mine to make, not the session's): the agent-sdk branch is
built and measured but its VALUE is unproven — Task 8's paired validation
is the only thing that would prove it, and it is real spend needing its
own sized go. Measured cost vs the incumbent API SDK: +335 input tokens
per record (1.51x) and +1.46s subprocess spawn (~25% end-to-end). Its
ONLY benefit is reaching premium models via the Agent-SDK credit pool
while premium OAuth is walled. If premium comes back, the branch may not
be worth merging at all — decide that before spending on Task 8.

NEXT ACTIONS IF THE ANSWER IS "KEEP GOING" (all token-free):
 1. Tasks 6-7 — parameterize the pv machinery to pair ANY two transports
    (4 hardcoded cli-vs-sdk sites incl. runPvCompare, the actual CLI entry
    point) + a `--pair sdk:agent-sdk` flag. Plan has full code.
 2. Batch-only in-process daemon: /clear between records is PROVEN to
    reset the transcript (838ms first record then ~20ms; residue = ~423B
    constant /clear echo). Agreed shape = in-process singleton for BATCH
    only, auto-create, 15-min idle self-kill. Live path must NOT use it.
 3. 2 deferred minors (stale comments in agent-transport.ts) — see
    .superpowers/sdd/2026-08-03-agent-sdk-transport/progress.md.

RULES THAT BIT ME YESTERDAY, IN PRIORITY ORDER:
 · READ THE DEPENDENCY'S OWN TYPES/DOCS BEFORE ASSERTING. I committed
   three wrong verdicts about the Agent SDK from search excerpts and one
   mis-configured probe before opening sdk.d.ts. Every correction came
   from the user pushing back. Reference first, then measure, then assert.
 · MEASURE ON THE WIRE. A local stub + ANTHROPIC_BASE_URL answers "what
   does this actually send" in ~5 min at zero spend, and settled every
   Agent-SDK question that docs alone got wrong.
 · Merges to main go through scripts/merge-with-gate.sh with a committed
   docs/reviews/<short-sha>-<slug>.md (7b gate ARMED; window 3/10, 0
   blocks). Direct commits to main bypass it BY DESIGN — see 7b §6b.
 · Explicit sized go before spend · spec-is-law, pre-data amendments only
   · F1/F2 · sonnet=subject, opus=judgment · boundary ts on instrument
   changes · per-task reviews · grep-verify · script-tally · SITREP.
```

## ✅ SESSION END 2026-08-05 (`yoo-dev` office) — ACP LANE COMPLETE + MERGED (`bbdabe1`) · WARM LANE WIRED-INACTIVE (`5ae2043`) · PROPOSER BOUNDARY STAMPED (ts 1785847012141)

**RESUME PROMPT (MacBook — cross-host: git is the ONLY transfer; nothing
host-local from `yoo-dev` exists on this machine):**
```
Resume kkamak (meta-harness) on the MacBook, post-2026-08-05. git pull
FIRST, then read docs/resume.md (this top block) and minimal/HISTORY.md
GA14 (the full 08-04/05 arc; renumbered from a colliding "GA7" 2026-08-04).

STATE after pull: main @ 5ae2043. Two gated merges landed 08-05:
 - bbdabe1 acp-session-pool (review docs/reviews/95cfa82-acp-session-pool.md,
   opus whole-branch, 0 Critical) — the seats' claude-code driver now runs
   sendPrompt -> anthropic-api (Messages API) with EXPLICIT
   REASONING_ISOLATION + maxTokens 8192 + truncation guard.
 - 5ae2043 wire-warm-lane (docs/reviews/9663129-wire-warm-lane.md) —
   KKAMAK_SEAT_PROVIDER env gate, DEFAULT OFF, byte-identical default
   test-pinned. no-call => api fallback in-call; call-consumed => THROW,
   never fallback.
Suites at merge: cc-gate-plugin 1043/0, opencode-plugin 1776/1skip, tsc
clean both. Re-run both on this host before building anything (darwin
differences are real: the seat no-call test needed a platform seam —
authDeps in SeatCallOptions — precisely because HOME tricks don't reach
the keychain branch).

INSTRUMENT: boundary ts 1785847012141
(docs/2026-08-01-gauntlet-adoption-ledger.md) — proposer/reviewer/revision
outputs pre/post MUST NOT pool. opencode driver untouched.

MACBOOK-SPECIFIC CAUTIONS:
 1. Warm-lane activation on THIS host needs its own RSS measurement first
    (cap is host-class-keyed; WSL2 measured ~330MB/warm session, cap 4 —
    docs/2026-08-05-warm-session-rss.md; script:
    cc-gate-plugin/test/warm-session-rss-measure.ts, token-free, stub-only).
 2. Activation itself (setting KKAMAK_SEAT_PROVIDER=anthropic-cli-warm
    anywhere live) is a logged decision: adoption-ledger activation-log
    entry, §4b precedent. Do not flip casually.
 3. The daemon writes under ~/.config/kkamak/ (socket, locks) — host-local,
    fine, but darwin keychain is the auth source for readAuthToken's
    darwin branch; the warm lane spawns the CC CLI which needs the 3-piece
    container-free auth this host already has.
 4. The yoo-dev tmux launchers / 429 probes / markers do NOT exist here.
    Premium-quota state is per-account not per-host — probe before spend:
    source scripts/probe-models.sh && probe_models claude-haiku-4-5 claude-sonnet-5 claude-opus-5

OPEN DECISIONS (all need explicit go): warm-lane activation (per host);
MacBook RSS measurement (token-free, can run without go per
distance-to-verdict? NO — it spawns the real CLI; ask); next loop work.

DEFERRED (in the merged artifacts): ~25 triaged-OK minors; thinking:enabled
provider asymmetry (api no-calls it, warm would run it); session/cancel has
no production client; --stdio daemon mode untested; compiler-enforced
fallback exhaustiveness in llm-acp.ts.

Rules unchanged: explicit sized go before spend · spec-is-law, pre-data
amendments only · merges through scripts/merge-with-gate.sh with a
committed docs/reviews artifact · boundary ts on instrument changes ·
per-task reviews · grep-verify · SITREP.
```

## ✅ SESSION END 2026-08-04 (`yoo-dev` office) — §6d MERGED · §6e REGISTERED + GATE MEASURED · ACP LANE HALF-BUILT on branch `acp-session-pool` (13 commits, 936 tests green, UNPUSHED) · SEND-PROMPT REDESIGN RULED

**RESUME PROMPT (office `yoo-dev`):**
```
Resume kkamak (meta-harness), 2026-08-05. Read docs/resume.md FIRST (this
top block), then the SDD ledger at
.superpowers/sdd/2026-08-04-acp-session-pool/progress.md — it is the
authoritative node-by-node record and it names two owed reviews.

STATE: main @ 6c0f1c8 pushed. Branch `acp-session-pool` @ e899efb,
13 commits, 936 tests + tsc green, tree clean, **NOT PUSHED** — push it
first, it is the only copy and nothing on it travels until you do.

TWO REVIEWS ARE OWED before any new node. Both nodes are BUILT and GREEN
but UNREVIEWED, which is the one state the SDD loop forbids carrying
forward:
 (a) T2n fix re-review — scoped range `261621c..e899efb` (one test-file
     commit, cheap tier). The fix added type-level OnlyKkamak guards and
     the implementer VERIFIED them by injecting an optional `_meta` key
     and confirming tsc fails while bun test stays green.
 (b) N1 task review — range `2ecf6d5..261621c` (sendPrompt + registry).
Use scripts/review-package + task-reviewer-prompt from the
subagent-driven-development skill; briefs and reports are in
.superpowers/sdd/2026-08-04-acp-warm-daemon/.

THE DESIGN CHANGED MID-SESSION, on a user ruling: "session ideas for
proposer, reviewer, judge, refiner ... is just keep-alive." So callers
must NEVER see an ACP session. docs/superpowers/specs/2026-08-04-send-
prompt-interface.md is the governing note (~200 lines, deliberately
short) and it SUPERSEDES Tasks S1-S4/P0-P2 of the session-pool plan with
nodes N1-N5. N1 is built. N2 (anthropic-api provider wrapping today's
sdkCall) is next and unblocks N5 with no warm-process machinery.

THE GATE FIRED AND IT PAID FOR ITSELF. T4·1a (token-free probe) measured
`/clear` on a streaming-input Query: conversation_reset arrives ~10ms
after the push, costs ZERO HTTP requests, transcript really resets — but
`/clear` ALSO emits its OWN synthetic local result (num_turns 0,
modelUsage {}), so three result frames per recycle, not two. Left
unfixed that settles a live record from an empty-evidence frame on every
recycle. §6e now carries a BINDING sequencing rule (awaitClear consumes
BOTH signals); field-sniffing was explicitly rejected. Also measured:
modelUsage keys UNDATED on this path, so the dated-key assumption from
round-4 review does NOT hold here — constants split into
STUB_DECLARED_MODEL / HAIKU_OBSERVED_KEY.

UNRESOLVED, and the first one blocks N5:
 1. **Packaging.** cc-gate-plugin/src/ may not import outside its own
    root (live test self-contained.test.ts; the plugin is copied out of
    the monorepo on install). The only precedent runs the other way —
    cc-gate-plugin VENDORS byte-copies of minimal/. minimal/ has no
    package.json/tsconfig and no workspace link. N1 is reachable (zero
    deps) but N5 breaks the moment it needs N2's @anthropic-ai/sdk.
 2. Pool cap KKAMAK_ACP_MAX_SESSIONS is still an asserted 4; T4's Step-4
    report now has the RSS data to size it.
 3. Which doc owns the proposer's boundary ts (old P0 never resolved it).
 4. N4 (OpenAI provider) bills real money — own sized go.

RULES THAT EARNED THEIR KEEP TODAY:
 · A token-free probe before building beats any amount of plan review.
   Four architect rounds (31/29/30/26 findings) never found what one
   5-minute probe did, and each round's fixes generated the next round's
   criticals.
 · Reviews of a task's own tests catch tautologies: T4's retargeted test
   would have passed for a request-ECHOING implementation, the exact
   thing §6e's provenance rule exists to forbid.
 · Verify a guard by breaking it deliberately, then reverting.
 · I ran one unintended real model call today — faked a CLI via
   process.env.PATH, but Bun resolves argv[0] from the PATH captured at
   PROCESS START, so it hit the real binary. Inject the path instead.
 · Explicit sized go before spend · spec-is-law, pre-data amendments
   only · merges via scripts/merge-with-gate.sh with a committed
   docs/reviews/<sha>-<slug>.md (7b ARMED).
```

## 📡 RELAY → MacBook (`yoo-mac`), handed off 2026-08-03 ~16:50 KST from office

**PASTE THIS ON THE MACBOOK:**
```
Resume kkamak (meta-harness) on yoo-mac, 2026-08-03 evening. Office handed
off. FIRST: `git pull` (office pushed a lot today), then read docs/resume.md
top block (this RELAY block + the office SESSION END block under it).

FIRST ACTION, before any spend — the decisive open experiment:
    source scripts/probe-models.sh
    probe_models claude-haiku-4-5 claude-sonnet-5 claude-opus-5
Office measured (16:45 KST): haiku=OK, sonnet=429, opus=429 — quotas are
PER MODEL TIER, and office premium has been walled since ~12:37 (>4h,
survived a token refresh ⇒ suspect the WEEKLY premium cap, not a 5h
window). MacBook result decides the next move:
 · premium OK here  ⇒ the wall is HOST/IP-scoped, not account-scoped.
   MacBook can run its own premium lanes now; record the counter-evidence
   in resume (it falsifies the account-wide reading).
 · premium 429 here ⇒ account-scoped premium cap. Then the only premium
   paths are: wait for reset (/usage names it), or ANTHROPIC_API_KEY
   (instrument-NEUTRAL: same transport/schema/speed, only the credential
   changes; costs real money). Option (d) impersonation stays PROHIBITED.
Either way, `derive` is haiku (claude-haiku-4-5, KKAMAK_GAUGE_MODEL unset)
and is LIVE even under a premium wall.

WHAT CHANGED TODAY THAT AFFECTS HOW YOU WORK HERE (pull first!):
 1. **7b process gate is ARMED on this repo.** Merges to main now go
    through `bash scripts/merge-with-gate.sh <branch> -m "..."`, and the
    branch must carry a committed `docs/reviews/<short-sha>-<slug>.md`
    with 5 fields (reviewed-range/reviewed-commit, reviewer,
    fresh-context, verdict ∈ approved|fix-first|blocked, findings-count).
    Plain `git merge` bypasses the floor — don't. Each merge appends a row
    to the §6 ledger in docs/superpowers/specs/2026-08-03-process-gate-7b-draft.md
    (window at 3/10 attempts, 0 blocks). Reviewed tip = newest non-
    docs/reviews commit; merges are always non-exempt.
 2. **7a doc-linter floor is armed** — `gate.json` check now runs
    `bun scripts/doc-check.ts` (link integrity + CommonMark fences;
    term-bench2/store/** excluded). Run it before every docs commit.
 3. **Combine hard-gate merged** — `cls-score --combine` now REQUIRES a
    boolean `provisional` on the other host's file (fail-closed) and marks
    the combined verdict provisional if either side is provisional or any
    registered arm is absent. The parked residual is CLOSED: a real
    cross-host combine is now safe once both hosts' docs exist.
 4. New in-tree tools: `scripts/probe-models.sh` (above),
    `scripts/check-review-artifact.ts`, `scripts/channel-smoke.ts`
    (fenced `--go 14` gauge-instrument verification, opus — blocked here
    while premium is capped).

MACBOOK LANE (unchanged gos, all still granted):
 · `pv-sample` then `derive <shadow> --go <n>` (~13 C + 13 not-C) — HAIKU,
   so it runs even under a premium wall. Then copy pv-counts.json to
   docs/gauge-pv/yoo-mac.local-pv-counts.json and commit (shadow dir is
   gitignored; only counts travel).
 · Own classifier lane: cls-sample → cls-label (opus, premium) → 4 arms
   (2 haiku + 2 sonnet) → cls-score --emit-doc
   docs/gauge-cls-ab/yoo-mac.local-cls-score.json. Needs premium; gate it
   on the probe above. Runbook: docs/superpowers/plans/2026-08-03-cls-ab-runbook.md.
 · Cross-host combine ONLY after both hosts' cls-score docs are committed.

CHAIN TOOLING NOW TRAVELS (16:55 — the per-host launcher gap is CLOSED):
the one-off `/mnt/d/tmp/*-autolaunch.sh` family is replaced by repo
scripts you can use on MacBook verbatim —
 · `scripts/probe-models.sh` — `probe_models <models...>` / `all_ok ...`
   (probe-fidelity rule + the per-model-quota finding documented inside)
 · `scripts/gated-run.sh --name X --models a,b --after m1 --marker m2
   -- <cmd>` — wait on prerequisite markers, poll until every REQUIRED
   TIER is available, run, touch a completion marker. All four gate paths
   live-tested 16:52 (runs-and-marks / holds-on-429-with-no-marker /
   passes-on-live-tier / holds-on-missing-dep).
 · `scripts/stage1-screen.sh` — runbook §4 launch + §3H N-watchdog
   (host knobs KKAMAK_HOME / TB_ROOT / SCREEN_SESSION via env).
Markers are runtime state and stay host-local (office:
/mnt/d/tmp/kkamak-markers/).

OFFICE STATE LEFT BEHIND (host-local, does NOT transfer — informational):
4 tmux launchers re-armed 16:53 ON THE REPO SCRIPTS (single implementation,
no host drift): `clsab2` (needs ALL THREE tiers — the granted go was the
complete 4-arm chain, so it will not fire a provisional 2-arm run),
`gaugeverify` (opus, channel-smoke --go 14), `retry112` (HAIKU probe —
the earlier opus probe was gating haiku work behind a premium quota it
never calls; still ordered behind gauge-verify.done for the SUBSTANTIVE
reason that a patched-prompt classifier verdict changes what we
re-derive), `stage1wait` (sonnet, then scripts/stage1-screen.sh).
Office `.kkamak` store holds seed aliases v13=s1 v14=s2 v15=s3 (delete
after Stage-1 tally, or nextVersion() mints v16).

ALREADY DONE 2026-08-03 — DO NOT REDO (all merged to main + pushed):
 7a doc-linter floor (armed) · 7b process gate: 7 rulings decided +
 checker built + ARMED, window 3/10 attempts 0 blocks · verification-
 channel ladder C1-C4 (pre-reg spec + channel.ts + cost-fenced
 `replay-cli.ts channel --go <n>` + INERT C4 nudge) · transport dedup
 (single exported `sdkCall`) · cls-combine provisional hard-gate ·
 `scripts/channel-smoke.ts` (fenced gauge-instrument verification) ·
 429 root cause settled (per-model-tier quota) · chain tooling moved
 into the repo.

REMAINING WORK — WHOLE PROGRAM (owner · blocker · authorization):
 1. Chain link tallies, office, AUTO-FIRING once tiers clear — each
    completion owes a model-free duty: clsab2 → script-tally +
    commit yoo-dev-cls-score.json + PROVISIONAL per-host verdict;
    gauge-verify → read smoke verdict (bar >=9/12 + nudge proof) +
    commit docs/gauge-channel json; retry112 → derive hit-rate +
    report line; stage1 → §5 R2 audit BEFORE tally, then §6 decision
    (kill below v7, <=2 advance), then §9 archive + delete v13/v14/v15
    aliases. Gos already granted; blocked only by premium quota.
 2. MacBook lane (this host) — see MACBOOK LANE above. pv/derive is
    haiku so it runs under a premium wall; classifier lane is premium.
 3. Cross-host combine — needs BOTH hosts' cls-score docs committed.
    Hard-gate now enforces the provisional marking.
 4. Channel ladder next gos (NOT YET GIVEN): (a) `channel --go
    <pending>` over the corpus A2/D records (opus → premium-blocked)
    to measure the C4 base rate; (b) nudge ARMING decision, which
    needs that rate + the cls-ab verdict + spec §6 rulings 1-4.
    Falsification pre-registered: C4 rate <5% parks arming.
 5. Stage-2 (paired k=5 + v7 store-writing control) — own go, after
    the Stage-1 tally.
 6. Premium-quota decision (user): wait for reset vs ANTHROPIC_API_KEY
    lane. `/usage` names the cap. API key = instrument-neutral but
    real money; any auth/transport swap = pre-data amendment +
    boundary ts, and the cls-ab amendment window closes at its FIRST
    label.
 7. RE-OPENED 17:20 (was: is the Agent SDK ~equivalent to the API SDK
    with the system prompt zeroed?). After reading sdk.d.ts and fixing
    MY misconfiguration (`tools: []` not `allowedTools: []`; supply
    `title`), the answer is CLOSER TO YES than my earlier entries said:
    tools 29→1 (the survivor is `StructuredOutput`, so the schema IS
    enforced), title side-calls 2→0, and the "4 calls" claim is
    withdrawn as a probable artifact of my stub. Residual, measured:
    2 harness system blocks survive `systemPrompt: ""`, and the user
    turn is wrapped with ~200 chars of `<system-reminder>` (account
    email + date) around our verbatim prompt. REMAINING WORK to settle
    it: a clean real-API run to count calls per query, then a paired
    validation to see whether the residual context shifts
    classifications. Premium board: (a) wait · (b) API key (simplest,
    instrument-neutral) · (c) Agent SDK (included credit; residuals
    now look small enough to be worth measuring).
 8. Dogfood daily BOTH hosts — organic blocks are the only M1v2-floor
    input; A/A checkpoint ~Aug 12.
 9. Repo-visibility decision (user): `th-yoo/meta-harness` is a PUBLIC
    fork of stanford-iris-lab/meta-harness-tbench2-artifact, so it
    cannot be flipped private in place — it needs a mirror into a new
    private repo + remote repoint on BOTH hosts. `kkamak` and `squad`
    are public non-forks and can be flipped with one command each.
    Note: commits already pushed to a public fork stay reachable via
    the upstream network even after deletion.
10. Parked (unchanged): §3 over-refusal round · GA5 · per-repo fixture
    inclusion · office reinject v2 · consistency 10b · queue 7c/7d.

RULES unchanged (see the RULES line at the end of the office block below),
including: no CC-identity impersonation on non-CC transports.
```

## ✅ SESSION END 2026-08-03 (`yoo-dev` office, all-day) — §6c OFFICE DEPLOY · PATH A SONNET AMENDMENT + STAGE 0 + STAGE-1 RUNBOOK MERGED · PAIRED-VALIDATION TOOLING MERGED + OFFICE VERDICT **SPLIT** · CLASSIFIER 2×2 REGISTERED + TOOLED + MERGED (label/arm gos GRANTED, blocked by 429, auto-launcher armed) · 7a DOC-LINTER FLOOR **MERGED 08-03 evening (user go)** — main @ `3617774` pushed, doc floor ARMED (this repo now, other hosts on pull); branch `gate-floor-7a7b` deleted locally, remote left per convention

**RESUME PROMPT (either host):**
```
Resume kkamak (meta-harness), 2026-08-03 evening+. Read docs/resume.md
FIRST (this top block), then the 08-02→08-03 MacBook block below it.

WHERE WE ARE: main has — §6c both hosts deployed (office boundary ts
1785711630125); Path A sonnet-arms amendment + Stage 0 seeds s1/s2/s3
INACTIVE + Stage-1 runbook (pin-based arms, seeds alias v13/v14/v15);
paired-validation tooling; classifier 2×2 A/B: pre-reg spec (constants
0.10-F1-margin etc., FROZEN at first label; rubric REWRITTEN independent
of both arms) + cls-sample|cls-run|cls-label|cls-score(+--combine)
tooling + runbook (2026-08-03-cls-ab-runbook.md). MEASURED: office pv
verdict SPLIT (agreement 0.625 < 0.80, missed-C 6 > cap 2; SDK misses C,
never over-extracts) — counts committed docs/gauge-pv/yoo-dev-pv-counts.json.

429 SETTLED — SEE OPERATIONAL LESSONS BELOW. The four tmux launchers
(`clsab2` / `gaugeverify` / `retry112` / `stage1wait`, repo scripts
scripts/gated-run.sh + probe-models.sh, markers /mnt/d/tmp/kkamak-markers/)
remain armed and correctly gated; premium (sonnet/opus) was still walled at
session end, haiku open. Their per-link tally duties are unchanged.
ORIGINAL CHAIN NOTES: (1) tmux `clsab2` —
probes 429 every 5min then runs GRANTED chain: cls-label --go 32 (opus) →
4× cls-run --go 32 → cls-score --emit-doc
docs/gauge-cls-ab/yoo-dev-cls-score.json; log /mnt/d/tmp/clsab-run2.log.
When DONE: script-tally, commit emitted doc, record per-host verdict
(PROVISIONAL scope). (1b) tmux `gaugeverify` — "Verify gauge" GO 08-03
(~14 opus calls): waits clsab2 DONE → probe → `bun scripts/
channel-smoke.ts --go 14` (12 known-answer synthetic prompts, bar
pre-registered ≥9/12, underCatch/overRefusal reported separately + 2-call
live nudge proof in throwaway repo) → writes docs/gauge-channel/
<host>-channel-smoke.json (COMMIT it) + marker gauge-verify.done; log
/mnt/d/tmp/channel-smoke-*.log. Serial position 2 — retry112 re-gated on
its marker. GOTCHA re-proven 14:46: editing a RUNNING launcher script
kills its tmux session silently (bash re-reads file at stale offset) —
kill session FIRST, edit, relaunch. (2) tmux `retry112` — retry derive --go 112 GO GIVEN
08-03 evening; launcher /mnt/d/tmp/retry112-autolaunch.sh waits clsab2
"=== DONE" → opus probe OK → derive --go 112 (SDK transport, ~12min; ONE
writeCorpus at batch end, never kill mid-run) → resolve + report
(model-free) → marker /mnt/d/tmp/retry112.done; log
/mnt/d/tmp/retry112-*.log. After: script-tally derive hit rate + report
line, record here. (3) tmux `stage1wait` — Stage-1 screen GO EXECUTED
08-03 evening (pre-flight all green, aliases v13=s1/v14=s2/v15=s3
installed, sonnet-5 model id confirmed in opencode listing); launcher
/mnt/d/tmp/stage1-autolaunch.sh waits retry112.done marker (serial order
clsab2 → retry112 → stage1, one rate pool) → sonnet probe OK → launches
tmux `stage1screen` (runbook §4, run from ~/z2/meta-harness — worktree
wt-path-a-stage0 GONE, main is superset) with §3H N-watchdog
(394/2689/3233/2991). Log /mnt/d/tmp/stage1-autolaunch.log. After screen:
§5 R2 audit BEFORE tally → §6 script-tally (kill below v7, ≤2 advance) →
§9 archive + alias hygiene (nextVersion mints v16 while v13-15 live).

MERGED 08-03 evening (user go "1"): `gate-floor-7a7b` → main `3617774`,
pushed. 7a doc-linter floor ARMED — scripts/doc-check.ts (link integrity
+ CommonMark fences, term-bench2/store/** EXCLUDED, 135 scanned 0
violations post-merge) in gate.json check; KKAMAK_DEV_CHECKS grow-only
allowlist; boundary ts 1785727963349 in gauntlet ledger. Merged-result
green: 783+26+230 tests + doc-check + tsc. Other hosts arm on pull.
7b process-gate DRAFT spec in tree (docs/superpowers/specs/
2026-08-03-process-gate-7b-draft.md), 7 user rulings still open.

AGENT-SDK TRANSPORT (§6d) — TASKS 1-7 DONE, MERGED TO MAIN 2026-08-04
(7b-gated, artifact docs/reviews/65626ba-agent-sdk-transport.md).
**PREMISE MEASURED TRUE 2026-08-04:** agent-sdk lane reaches sonnet AND
opus while the raw-API OAuth lane 429s them in the same minute — the
separate-credit claim in §6d is now evidence, not assertion (spec note in
§6d). Tasks 1-7 of docs/superpowers/plans/2026-08-03-agent-sdk-transport.md
done w/ per-task reviews + fix rounds; whole-branch opus review (0
Critical / 5 Important / 7 Minor) → single fix wave, all addressed:
cls-ab pinned like refiner-cli (provenance can't silently flip), api_retry
abort guard (CLI 5xx auto-retry measured; exactly-one-call preserved),
lazy SDK import (hooks no longer pay ~84ms), credential skip-guard
(credential-less hosts skip loud, not fail), de-CLI'd pv operator surface,
arms provenance on counts/manifest/combined files. 857 tests + tsc green.
Tasks 8-9 remain: Task 8 = the real-spend paired validation, NEEDS ITS OWN
SIZED GO; Task 9 = verdict + per-caller opt-in only if earned. §6d
amended pre-data (context isolation / enforcement asymmetry incl. retry +
output-cap notes / selection is PER-CALLER) — spec file is source of
truth. Live path stays PINNED to "sdk" (unwalled haiku; pin test-locked).
Measured cost vs API SDK: +335 input tokens/record (1.51x), +1.46s spawn.
Daemon via `/clear` PROVEN viable but NOT BUILT — **HARD RULE 2026-08-04:
ask the user before ANY daemon implementation work.**
Deferred (ruling: fails loud, diagnostic-only): `--pair=x:y` equals form
unrecognized. SDD ledger:
.superpowers/sdd/2026-08-03-agent-sdk-transport/progress.md.

QUEUE (GO/ruling before spend): (1) DONE — 7a7b merged (above). (2)
MacBook lane: pv-sample + counts commit; own classifier lane (sample →
label go → arm gos). COMBINE HARD-GATE DONE 08-03 evening on office
(merged main, 7b ledger row 3; 821 tests): other-host provisional read
fail-closed, combined verdict self-marks provisional (local || other ||
absent-arms) + WARNING — real cls-score --combine now unblocked once
both host docs exist (MacBook pulls main first). (3) Stage-1
screen go (~28 sonnet trials, office; runbook pre-flight incl. token-free
claude-sonnet-5 model-id check). (4) GO GIVEN 08-03 evening — retry112 armed in the serial chain (IN
FLIGHT item 2 above); tally on completion. (5) Dogfood daily both hosts — office needs tmux allow rules
pasted (Bash(tmux send-keys:*) etc. in .claude/settings.local.json);
organic blocks are the ONLY M1v2-floor input; A/A ~Aug 12. (6) DONE 08-03
evening — 7b's 7 rulings ALL DECIDED (each = draft's recommended option;
spec §7 now REGISTERED constants: pre-merge placement, docs/reviews/
<sha>-<slug>.md, 5 fields, approved/fix-first/blocked, N=10 bar ≤0.20,
meta-harness-only staged rollout, string-inequality self-review check).
BUILT + MERGED 08-03 late evening (`05e3b49`, user "do this in this box"):
scripts/check-review-artifact.ts + 15 tests (TDD; 2-round fresh-context
review: fix-first F1 evil-merge sneak / F2 ambiguity fail-open → fix wave
→ approved 0 residual); first 7b-format artifact
docs/reviews/bac9b28-gate-7b-build.md; execute-proof OK on own branch.
EFFECTIVE-TIP AMENDMENT ACKED + GATE **ARMED** (user "go" 08-03 late
evening, boundary ts 1785732646822 in gauntlet ledger): merges into
meta-harness now via `scripts/merge-with-gate.sh <branch> [-m ...]`
(refuses without compliant artifact, then --no-ff; execute-proven both
directions). Git pre-merge-commit hook = provably unsound (auto ort merge
never writes MERGE_HEAD before the hook; measured git 2.43.0) — recorded
in ledger. N=10 falsification window OPEN (attempts ledger in spec §6,
count 0). Also DONE: office tmux allow rules pasted into
.claude/settings.local.json (8 Bash(tmux ...) rules, live next session).
(8) NEW 08-03 late evening — VERIFICATION-CHANNEL LADDER BUILT + MERGED
(`9365551`, first armed 7b-gate merge = §6 ledger row 1, checker OK):
user direction "gauge should reject prompts unverifiable with gate"
refined to ladder C1 programmatic / C2 LLM / C3 human / C4 no-criterion —
reject/nudge ONLY C4. Pre-reg spec
2026-08-03-gauge-verification-channel-ladder-preregistration.md (DRAFT,
constants freeze at first channel datum; 5 open rulings; falsification:
C4 rate <5% parks arming). Shipped via DAG-parallel subagent build
(3 waves, driver commits): channel.ts taxonomy+refinement (blind-
isolated), cost-fenced `replay-cli.ts channel [cwd] --go <n>` (stamps
derivation.channel; A2/D = model work, rest deterministic), inert
soft-only C4 nudge (gate.json channelNudge flag, absent everywhere =
byte-identical; 8s timeout fail-open). NEXT OWN GOS: (a) `channel --go
<pending>` on office corpus (~250 A2/D) → C4 base rate → docs/
gauge-channel/<host>-channel-counts.json; (b) arming decision w/ measured
rate + cls-ab verdict; (c) DONE 08-03 evening — transport dedup MERGED
(sdkCall exported, 3 OAuth copies gone, byte-for-byte reviewed, 813
tests; 7b §6 ledger row 2 = pass).
(9) Parked: §3 over-refusal round · GA5 · per-repo fixtures · office
reinject v2 · consistency 10b · queue 7c/7d.

OPERATIONAL LESSONS (08-03): spend batches and subagent fleets draw the
same account allowance PER MODEL TIER (the "one pool" phrasing from this
morning is superseded by the 16:15 finding below — pools are model-tier
scoped, so haiku work never competes with opus work) — 429s cost nothing:
maxRetries 0 + fail-open left everything retryable, fences intact. **429 SETTLED 2026-08-03 16:15 — PER-MODEL QUOTA, not a path
ban, not a credit pool, not a transport problem.** Decisive test, one
token, one client, same second: `claude-haiku-4-5` **OK** ·
`claude-sonnet-5` **429** · `claude-opus-5` **429**. Bare
`@anthropic-ai/sdk` + subscription OAuth is a WORKING path — the premium
(sonnet/opus) allowance is what ran out. Explains everything observed:
MacBook 00:29 + office 10:13 SDK batches succeeded because premium
headroom existed then; nothing about the code, auth, host, or transport
changed. RETRACTED en route (recorded so the wrong turns stay visible):
(i) "bare-SDK OAuth is an unsupported path" — falsified by our own two
successful batches, and by haiku working on the walled host; I read past
the tell (the community report I cited said haiku worked while sonnet
429'd); (ii) "June-15 Agent-SDK credit split is the mechanism" — a
monthly credit pool would not discriminate by model tier; (iii) "use
`claude -p` as a zero-setup interim" — that IS the CLI transport §6c
retired, and this host's paired verdict is already SPLIT (0.625 < 0.80,
missed-C 6 > cap 2), so reverting breaks comparability, not just
billing. WHAT IS STILL TRUE from the earlier observation: the block is a
hard pin (100% ERR on premium, zero transient OKs), OPAQUE (no
retry-after, no anthropic-ratelimit-* headers, message just "Error" —
polling is the only detection), survived a token refresh (per-token
window theory dead), and interactive CC keeps working throughout.
Duration >3.5h and outliving a token refresh points at the WEEKLY
premium cap rather than a 5h window ⇒ possibly days, not hours;
`/usage` names it. WORK SPLIT BY MODEL — blocked: cls-label (opus),
sonnet arms, channel-smoke (opus), stage1 (sonnet subject). LIVE NOW:
anything haiku — `derive`/retry-112 resolves `claude-haiku-4-5`
(callModelSdk default, KKAMAK_GAUGE_MODEL unset — verified OK 16:14) and
the two haiku classifier arms. **MY CHAIN DESIGN FLAW, unfixed:** all
four tmux launchers probe with OPUS, so haiku-capable work is gated
behind premium availability — violates the probe-fidelity rule stated
one paragraph earlier (probe with the model the batch uses). Fix before
relying on the chain: per-link probe model = that link's own model (and
kill the tmux session BEFORE editing its script). ORDERING NOT CHANGED
UNILATERALLY: queue item 4 puts retry-112 after the classifier verdict
for a substantive reason (a patched-prompt verdict would change what we
re-derive), so haiku work waits on a user ruling, not on the quota.
OPTIONS IF THE PREMIUM CAP HOLDS: (a) wait for reset (`/usage` says
when); (b) **ANTHROPIC_API_KEY** — instrument-NEUTRAL (same transport,
same schema, same speed; only the credential changes — `sdkCall`
hardcodes apiKey:null + oauth beta header, so it needs an auth-mode
branch + tests) but real money at list rates; (c)
**@anthropic-ai/claude-agent-sdk — VIABLE, but needs its own paired
validation (corrected TWICE 17:0x; two of my three objections were
wrong).** What is TRUE: it IS Claude Code — bundles the `claude` binary
and drives it as a SUBPROCESS (Python bundles the CLI, TS ships it as a
native optional dep, providers expose `path_to_claude_code_executable` /
`spawn_claude_code_process`), so it is CLI-FAMILY transport, and §6c
retired that family after the paired verdict came back SPLIT for the
CLI-spawn variant (0.625 / missed-C 6>2). What I got WRONG and hereby
withdraw: (i) "no structured outputs" — FALSE, the SDK supports
`outputFormat: {type:"json_schema", schema}` (TS) /
`output_format` (Python) returning a validated `structured_output`
(the upstream issue I cited was 2025-09 and is resolved); (ii) "loads
CLAUDE.md/settings, so worse contamination" — FALSE as a fixed property,
`systemPrompt` is settable (default is already minimal, CC preset is
opt-in), `settingSources: []` disables settings/CLAUDE.md, and tools and
turns can be clamped. **RE-MEASURED 17:20 AFTER ACTUALLY READING THE SDK TYPE DEFS — three of
my five objections were MY MISCONFIGURATION, not SDK behaviour.** The
first capture used `allowedTools: []` (a PERMISSION filter) instead of
`tools: []` (the knob that drops built-in tool DEFINITIONS — sdk.d.ts
:1431 "`[]` (empty array) - Disable all built-in tools"), and omitted
`title` (sdk.d.ts:2024 — supplying it stops the auto-title generation
that was making the extra calls). Corrected run:
 · tools 29 → **1**, and the survivor is `StructuredOutput` — i.e. the
   schema IS enforced, via a forced tool rather than `output_config`.
   `output_config: null` is the expected shape, NOT a missing guarantee.
   My "no schema enforcement" claim is withdrawn.
 · unrequested title calls 2 → **0**.
 · call count: my stub answers every request with the same canned text,
   so the retries + `error_max_turns` are probably MY artifact. The
   earlier "4 calls per query, breaks §4 exactly-1-call" claim is
   NOT PROVEN and is withdrawn pending a clean test against the real API.
WHAT SURVIVED the corrected run (measured, still real):
 · 2 system blocks that `systemPrompt: ""` does not remove — an
   `x-anthropic-billing-header: cc_version=...; cc_entrypoint=sdk-cli;`
   line and "You are a Claude agent, built on Anthropic's Claude Agent
   SDK." (the sdk-cli stamp also explains the separate credit pool: this
   is the honest lane, not a disguise).
 · the user turn carries our prompt VERBATIM but wrapped with 2
   `<system-reminder>` blocks (~200 chars incl. the account email and
   today's date). For an instrument that is real contamination — the
   model is not classifying only our text — and it is also a quiet
   PII-into-every-call detail worth knowing.
STATUS: option (c) is more viable than my earlier entries said. The open
questions are narrow and empirical: (1) does a clean real-API run make
exactly one call per query? (2) do the 2 system blocks + ~200 chars of
reminder change classification outcomes vs our bare-SDK path — which is
precisely what a paired validation would measure. LESSON (mine): I wrote
three wrong verdicts into this file from search excerpts and one
mis-configured probe before reading `node_modules/@anthropic-ai/
claude-agent-sdk/sdk.d.ts`. Read the type defs FIRST next time.

**FIRST CAPTURE 17:10, superseded above but kept for the method.** Zero
model spend, reproducible in ~5 min: `npm i @anthropic-ai/claude-agent-sdk`
in a scratch dir, start a local http server, set `ANTHROPIC_BASE_URL` to
it, call `query()` and dump the intercepted request bodies. Config used
was the maximally-minimal one: `systemPrompt: ""`, `settingSources: []`,
`allowedTools: []`, `maxTurns: 1`, plus `outputFormat` json_schema.
WHAT ACTUALLY WENT OUT vs what was asked for:
 · empty system → TWO system blocks survive: an
   `x-anthropic-billing-header: cc_version=...; cc_entrypoint=sdk-cli;`
   line (so SDK traffic is LABELLED as sdk-cli, not interactive CC — it
   is the honest lane, and it explains the separate credit pool) and
   "You are a Claude agent, built on Anthropic's Claude Agent SDK."
 · `allowedTools: []` → **29 tool definitions still attached** to the
   request (the option gates execution, not the definitions).
 · our schema → `output_config: null` ON THE MEASURED TURN. The API-level
   grammar constraint we rely on is NOT applied; validation happens at
   the SDK layer by re-prompting.
 · our prompt verbatim → the user turn is WRAPPED and prefixed with
   injected `<system-reminder>` blocks (local agent-type listings), so
   the model is not classifying our prompt, it is classifying our prompt
   inside a harness context.
 · one call → **FOUR** model calls: 2 for the query (a retry) + 2
   UNREQUESTED session-title generations.
DECISIVE for us: the call count. Spec §4 is exactly-1-call-per-record
(`maxRetries: 0`) and the cost fence is built on it — `--go N` is
authorized because N records = N calls. Under the Agent SDK a sized go
stops meaning what it says. Behind that: no API-level schema
enforcement on the measured turn, and 29 tool defs + reminders in
context. VERDICT: not usable as an instrument transport without
neutralizing all of the above (and re-validating), which is more work
than the API-key branch. NET premium board: (a) wait, (b) **API key**
(simplest, instrument-neutral, pay-as-you-go), (c) Agent SDK — only if
someone first proves the call-count and schema gaps can be closed.
(d) **KNOWN AND
DELIBERATELY NOT IMPLEMENTED — FYI so nobody re-derives it as a
"discovery":** the widely-circulated trick of setting `system: "You are
Claude Code, Anthropic's official CLI for Claude."` on bare-SDK calls to
make premium traffic route as interactive-CC traffic. Reported to work.
We do not use it: it defeats a billing/quota separation Anthropic drew
deliberately, i.e. circumvention rather than engineering, and our
transport must not claim an identity it does not have. Standing ruling —
holds regardless of which diagnosis of any given 429 turns out correct
(it survived the 16:15 retraction of the credit-split theory that
originally prompted it). Legitimate premium-quota answers are (a)-(c)
above. Any transport or
auth swap = pre-data amendment + boundary ts; cls-ab is at 0 labels so
that window is OPEN and closes at the first label.
SDD TDD mid-states turn the gate red mid-turn — foreground
until-green waits ride it out. Store artifacts (term-bench2/store/**) are
DATA with load-bearing bytes: never lint, never edit for lint.

RULES unchanged: explicit go before spend (sized) · spec-is-law,
pre-data amendments only · F1 (core/, vendor/, 4 minimal/; gauge/
editable) · F2 (no prompt text in committed artifacts) · sonnet=subject,
opus=judgment · boundary ts on instrument changes · per-task reviews
mandatory · grep-verify deploys · script-tally counts · SITREP style ·
no CC-identity impersonation on non-CC transports (see option (d) above).
```

## ✅ SESSION END 2026-08-02 night → 08-03 (`yoo-mac.local`) — §6c APPROVED + SDK TRANSPORT SHIPPED END-TO-END (build/review/merge/deploy, boundary ts 1785684571765) · 3 dogfood cycles = FIRST ORGANIC SDK GAUGE RECORDS · concurrent office batch: FIRST 2 poolEligible — meta-harness pushed (tip incl. `de6e892` merge + `6bb48f6`) · kkamak @ `c5f8600` pushed · squad @ `7c167f8`

**RESUME PROMPT (either host):**
```
Resume kkamak (meta-harness), 2026-08-03+. Read docs/resume.md FIRST (this
top block) + HISTORY.md GA12 + the "Gauge SDK-transport deploy boundary"
entry in docs/2026-08-01-gauntlet-adoption-ledger.md.

WHERE WE ARE: §6c derive-transport amendment APPROVED (c22fbd0 — three
rulings replaced the draft's degenerate bar: stratified C-enriched sample,
positive agreement >=0.80 AND missed-C <= ceil(0.10x|C_cli|), shadow-store
paired re-derivation; measured slice 54% so expect SPLIT, that is the
designed outcome). SDK transport BUILT (TDD, zero real calls; transport.ts,
both derive paths, transport:"cli"|"sdk" on records AND sensor lines),
REVIEWED (FIX-FIRST -> fix wave d15fc7f: apiKey:null OAuth-only, transport
onto sensor line, keychain exec timeout), MERGED de6e892, DEPLOYED yoo-mac
00:29 KST 08-03, boundary ts 1785684571765 (gauntlet ledger), installed
copy PROVEN vs stub. First ORGANIC SDK gauge records live: 3 dogfood cycles
on the sonnet subject, derivations 5.2-6.5s (CLI was 15-33s), one C->B
validate downgrade caught. Office (concurrent, 00:50 KST): 410 batch landed
298/410 derived, FIRST 2 poolEligible pool-C records (pooled 2/2 prints
"yes" but floor NOT MET, n=2<5 + zero live — permits NOTHING per d869660
pt 5); C-rate replicates cross-host (5.4% vs 7.4% nominal, 69%-precision
caveat both); 112 stayed mined = next retry sized go 112.

QUEUE (GO before spend): (1) DONE 08-03 08:00 KST (office): pull b57b187 +
bun install → 594/594 + tsc + kkamak 315/315 → km-refresh --force +
grep-verify (transport.ts + SDK in cache node_modules) → office boundary
ts 1785711630125 logged in gauntlet ledger. MacBook/office CLI derive =
OVER, SDK-only now. First organic office cycle's transport:"sdk" stamp =
live confirmation.
(2) DONE 08-03 (office): paired-validation tooling BUILT + MERGED
(`0bbb60d`, plan 2026-08-03-paired-validation-script.md w/ post-build
annotations; 2 per-task reviews + final whole-branch READY-TO-MERGE;
644 tests + tsc). `pv-sample` (stratified all-CLI-C + equal not-C shadow
store, unmodified fenced deriver runs against it) · `pv-compare`
(+`--combine`): bar spec-verbatim, undecided/missing/wrongTransport block
evaluation, pv-combined.json durable verdict. COUNTS TRAVEL: copy
pv-counts.json / pv-combined.json to docs/gauge-pv/<hostname>-*.json and
commit (shadow dir is gitignored). NEXT (own sized go per host): office
`pv-sample` then `derive <shadow> --go 32` (16C+16, SDK, ~2min);
MacBook ~13C+13 after its own pv-sample count.
(2e) DONE 08-03 (office): CLASSIFIER 2×2 A/B BUILT + MERGED — pre-reg spec
    (2026-08-03-gauge-classifier-ab-preregistration.md, constants frozen at
    first label; rubric REWRITTEN INDEPENDENT of both arms per user ruling,
    pre-data) + full tooling cls-sample|cls-run|cls-label|cls-score
    (+--combine) via SDD: 4 tasks × (review+fix), final opus review
    FIX-FIRST → 17-finding fix wave (float-margin gate, F1-zero fix,
    combine port, lock refresh/ownership, manifest-first write,
    --discard-spend guard, provenance hashes, transport strata) → re-review
    READY-TO-MERGE. 783 tests + tsc. Runbook:
    docs/superpowers/plans/2026-08-03-cls-ab-runbook.md. HARD GATE before
    first real --combine: add provisional flag to combined verdict + read
    other-host provisional (parked residual, registered-verdict path).
    NEXT (own goes per host): label go ~32 opus + 4 arm gos ~32 each cheap;
    verdict in minutes. Office pv verdict 08-03: SPLIT (agreement 0.625,
    missed-C 6>cap 2) — counts committed docs/gauge-pv/.
(2d) DONE 08-03 (office): Path A STAGE 0 MERGED (`7972584`) — seeds
s1/s2/s3 committed INACTIVE (term-bench2/store/global/candidates/,
2662/3224/2988 bytes), authored by 3 parallel fresh-context agents,
reviewed zero-Critical + fix-waved (S2 probe-beats-literal tie-break, S3
observable budget triggers); provenance + overlap register + Stage-1
RUNBOOK (2026-08-03-path-a-stage1-runbook.md): screen runs arms via
candidate PIN (no activation flip, ab-trap N/A, noStore by construction);
seeds must alias v13/v14/v15 (name gate ^v\d+$, v12 reserved for winner);
5 OPEN items incl. pre-go token-free check that installed opencode
accepts anthropic/claude-sonnet-5 (silent default sonnet-4-6 = R1-class
trap). Stage-1 screen = next bench go (~28 trials + <=9 re-rolls). (3) Sustain dogfood daily (cycle
mechanics: one task/turn, edit+check+commit inside the turn; tmux driving
needs the allow rules in .claude/settings.local.json — auto-mode classifier
blocks Enter-injection otherwise). (4) Office retry go 112 only with cause.
(5) Path A model conflict ADJUDICATED 08-03 (user): SONNET ARMS — pre-data
amendment written into the plan doc (all trial arms = subject model
claude-sonnet-5; concurrent v7 sonnet arm = only baseline; judgment seats
stay opus; verdict semantics unchanged). Stage 0 authoring = next go. (6) Parked: §3 over-refusal round (now per-transport
attribution first, §6c), GA5 gate-editing ruling, per-repo fixtures. Item 12
third lane: NO LONGER PARKED — REGISTERED + TOOLED (Tasks 0-3 shipped +
fix-waved, this session): bar = docs/superpowers/specs/2026-08-03-gauge-
classifier-ab-preregistration.md; execution procedure = docs/superpowers/
plans/2026-08-03-cls-ab-runbook.md. Running the experiment itself (label go
+ 4 arm gos, per host) is still its own go, not yet spent. A/A ~Aug 12.
(7) NON-PROGRAMMATICALLY-GATABLE WORK — queued ladder (researched 08-03,
industry synthesis: deterministic-first → calibrated closed-ended judges
w/ N-run aggregation + regression baselines → human sign-off w/ audit
trail; our 0.80 agreement bar independently matches industry consensus
calibration number). Each rung own go/ruling, cheapest first:
(7a) DOC-LINTER FLOOR (cheap, near-term): add deterministic doc checks
    (markdownlint-style structure, lychee-style link resolution) to
    doc-heavy repos' gate.json check alongside the test suite. No LLM, no
    amendment machinery — BUT a gate.json check change shifts the
    floor-check population: log it with a ts (floorCheckMinedAt drift
    footnote already anticipates this). Instant partial floor for doc
    turns that today produce guaranteed-silent cycles.
(7b) PROCESS GATE (design + registration): mechanically check "a
    fresh-context review artifact exists naming HEAD" — converts the
    mandatory-per-task-review discipline from convention into floor
    without judgment in the gate. Needs its own short registration
    (artifact format, staleness rule, no-self-review rule).
(7c) REGRESSION-VS-BASELINE for class D: gate the DELTA of mechanical doc
    metrics against the last-commit baseline (link count, anchor
    integrity, structure), not prose truth. Programmatic even where truth
    is not.
(7d) MODEL-AS-CHECKER pre-registration (LAST, only after 7a-7c + §4.3
    evidence): if ever registered, MUST carry — N-run aggregation
    predicate (≥k of N, repeatable in distribution), pre-registered
    spurious-block-rate bar (flaky gate worse than no gate), pairwise/
    regression framing over absolute truth scores, provenance marking
    (model-gated cycles = separate population on sensor line), human
    sign-off + ledger trail. Falsification clause per gate-floor doc:
    wrong blocks > right blocks → gate stays narrow, judgment stays in
    the review layer.

RULES unchanged (explicit go / spec-is-law / F1-F2 / grep-verify /
per-task reviews / sonnet=subject, opus=judgment).
```

## ⏸ SUPERSEDED (2026-08-03) — SESSION END 2026-07-30 night → 08-01 (`yoo-mac.local`) — GA6 PHASE 1 + GA9 CORPUS-REPLAY BUILT/SEALED/MERGED · MacBook FULLY DEPLOYED + CLONE-PROVEN · first batches consumed · Path A tournament drafted — meta-harness @ `bcc9f08` · kkamak @ `a71206e` · squad @ `7c167f8`, all pushed

**RESUME PROMPT (either host):**
```
Resume kkamak (meta-harness), 2026-08-01+. Read docs/resume.md FIRST (top
block "SESSION END 2026-07-30 night → 08-01") + minimal/HISTORY.md GA6-GA11
rows + docs/2026-08-01-gate-floor-boundary.md (what the gate does and does
NOT catch, measured on a real dogfood day — read before interpreting any
zero-block stretch as the gate working or failing).
meta-harness pushed through de6e892; kkamak main 586d476 + tag v0.4.0
RELEASED; squad 7c167f8. Office host synced + verified 2026-08-02 (read-only
session, nothing built there). MacBook 2026-08-02→03 night: §6c APPROVED
(c22fbd0, three user rulings) + SDK transport BUILT/REVIEWED/MERGED
(de6e892) + DEPLOYED (boundary ts 1785684571765, 00:29 KST 08-03 — see
queue 2c + gauntlet ledger; office switches at same commit, `bun install`
in cc-gate-plugin FIRST). All roadmap phases 0-3 + GA9 corpus-replay tooling
MERGED to main; both hosts' installed plugin carries Phases 1+2+3; MacBook
also carries gauge fail-loud (deployed 08-01 17:05 KST, boundary ts
1785571509000).

WHERE WE ARE: gauge corpus-replay pipeline live (mine|derive|resolve|report,
store = repo-root .km/gauge-corpus/, run from meta-harness root). First
batches consumed (198+38 sized goes): 176 derived, 22 parked
(malformed-prone), resolve 176/176 all descriptive-only — pool 0/0 by
honest starvation (fixture-refs armed 08-01, zero organic blocks yet).
First reading: pooled n/a floor NOT MET; corpus class table A1 3 / A2 58 /
B 0 / C 13 / D 102 (C-rate ~7.4% vs live 1/72). Pool grows as dogfood
produces organic blocks (Phase 2 fixture-refs both hosts). MacBook deploy
LIVE-PROVEN 08-01 via clone test (all Phase 1+2 instruments fired, blockTs
join exact; Phase 3 promptCheck = office-organic-proven only — needs a real
Escape-interrupt, next organic one on MacBook proves it free). kkamak
dogfood repo pulled to a71206e, 291/291 on this host. Activation
precondition ticking; A/A earliest ~Aug 12.

QUEUE (GO before spend, in order):
(1) Sustain dogfood daily both hosts (tmux `kkamak`) — organic blocks feed
    fixture-refs AND the activation rate.
    CYCLE-HARVEST MECHANICS (learned live 2026-08-01, cost 2 tasks for 1
    cycle): (a) the Stop hook fires at TURN end, not at commit — N tasks in
    one turn = ONE cycle; (b) the gate only arms on EDIT-TOOL use in that
    turn (PostToolUse matches Edit|MultiEdit|Write|NotebookEdit), so a turn
    that only runs `git commit` via Bash produces NO cycle at all. When
    routing work to a dogfood session: ONE task per turn, and edit + check +
    commit must all fall INSIDE that turn. Drafting in one turn and
    committing in the next yields one cycle for two turns of work. Cycle
    count is bounded by turn boundaries and edit-tool use, never by work
    done.
(2) Office host: git pull only (cache already Phases 2+3). Optional:
    model-free mine of office transcripts into its own store; any derive
    there = own sized go.
(3) Re-run resolve+report (model-free, no go needed) after organic blocks
    accumulate — watch for first poolEligible record.
(4) Path A seed tournament (office, own goes per stage): DRAFT plan
    docs/superpowers/plans/2026-08-01-path-a-seed-tournament.md — 3
    seed-scale rewrites (S1 verification-first / S2 interpretation-policy /
    S3 workflow-scaffold) vs v7 (394-char baseline); screen k=1 held-in
    band 7 → confirm k=5 McNemar → ace guards k=3 + held-out directional.
    Stage 0 (authoring, cheap) first go.
(5) Parked decisions: §3 over-refusal redesign round (single-use, likely
    available) · kkamak gate-editing workload ruling (GA5) · per-repo
    fixture inclusion on first organic block · 22 parked mined records
    (retry only with cause + sized go 22) · §4.4 v2 reinject: amendment
    APPROVED + branch MERGED env-gated 989630e (GA10 + ledger); ACTIVATED on
    yoo-mac 2026-08-01 (4fec674, ledger v2-activation log) — office host NOT
    activated, that stays its own logged decision; v2 decision rule
    pre-registered in §4b amendment 41a7411. NOTE: activating an env-gated
    arm is a state the SUITE must be proven under — activation broke two
    pre-v2 tests on yoo-mac and sat red for a day (fixed 10e885d).
(6) sensors export after dogfood: scripts/km-sensors-sync.sh export.
(7) MODEL ROLE POLICY (user, 2026-08-01): sonnet = the SUBJECT under
    evolution (kkamak dogfood session's main LLM); opus = judgment roles
    (critics/judges/reviewers/design) + default tier. Supervisor is never
    the subject. Dogfood model changes must be LOGGED with an exact
    timestamp in the gauntlet ledger — SensorLine has no model field, so a
    silent switch merges two populations unrecoverably (R1 class).
    OPEN: Path A is pre-registered all-arms opus-5 while sonnet is the
    subject — a seed certified on opus-5 measures the supervisor. Adjudicate
    BEFORE Stage 1 spend.
(8) DONE 2026-08-01 17:05 KST: gauge fail-loud DEPLOYED (merged 0c2482c,
    §6b amendment). km-refresh --force, cache grep-verified (single 0.2.1,
    offReason in hook-cli + types, GaugeOffReason type), proven by driving
    the INSTALLED copy → {present:false, offReason:"disabled"}. No restart
    needed (same path+version, hooks re-read per invocation). Live-confirmed
    17:20 cycle carried {present:false, offReason:"no-record"} — first line
    in project history that STATES the instrument had nothing instead of
    going silent. BOUNDARY ts 1785571509000 logged in the gauntlet ledger:
    behaviour changed while pluginVersion stayed 0.2.1, so lines either side
    are indistinguishable by stamp — partition by ts, not version.
(9) kkamak 0.4.0 — SHIPPED 2026-08-01 evening. Released at
    https://github.com/th-yoo/kkamak/releases/tag/v0.4.0 (annotated tag
    v0.4.0 on 586d476, CI green, 311 tests). Repo description + topics fixed
    and byte-matched to the manifests. PROVEN, not assumed: on a pristine
    ubuntu:24.04 podman container — marketplace add + install from
    th-yoo/kkamak (works logged-OUT), cache at
    plugins/cache/kkamak/kkamak/0.4.0/, then a real CC turn BLOCKED twice and
    exhausted; sensor line gateExhausted:true, rounds
    ["verify-failed","verify-failed"], pluginVersion "0.4.0". Container,
    scratch repos and the keychain credential export all cleaned/shredded.
    Seven Minor findings live in that repo's docs/known-issues.md — recorded,
    deliberately NOT fixed.
    LESSON WORTH KEEPING: docs/install-verification.md yielded THREE defects,
    every one found by EXECUTING it, none visible to two prior reviews — (a) a
    block proof that produced no sensor line at all (in-budget blocks never
    call record()), (b) CLAUDE_CONFIG_DIR isolation strips keychain auth so
    the host variant cannot finish step 3 on macOS, (c) a missing permission
    flag meant the agent never edited, so the gate never armed. The runbook
    now encodes the bench's proven recipe (opencode-plugin/src/bench/
    agent-auth.ts prepareClaudeCodeAuth + drivers/claude-code.ts): /root/.claude
    mounted RW as a whole dir, /root/.claude.json ro containing exactly
    {"hasCompletedOnboarding":true}, and --dangerously-skip-permissions with
    IS_SANDBOX=1.
(10) CONSISTENCY between ~/z2/kkamak and cc-gate-plugin (two implementations,
    zero shared code, coupled only by the frozen SensorLine contract). Item 1
    DONE 2026-08-01 (emission conformance suite + negative control, 10e885d).
    Remaining: (a) both parity guards skip silently when the counterpart is
    missing or unparseable — kkamak's scrapes km-crank's test SOURCE with a
    regex, so a reformat disarms it while still reporting green; make
    "counterpart present but unreadable" a FAILURE and have both read the one
    committed fixture; (b) producer identity on the sensor line — pluginVersion
    does double duty as version AND provenance, and 0.4.0 vs 0.2.1 are
    different codebases, not newer/older (fold MODEL provenance in, see item
    7); (c) consolidate research instrumentation as layers over kkamak's
    kernel AFTER A/A + activation — blocked now by F1 and by mid-stream
    producer change (R1 class). Two live instances already: the gate.json
    `gauge` removal (64ff902) and pluginVersion ambiguity.
(10b) GATE FLOOR BOUNDARY — measured, written up in
    docs/2026-08-01-gate-floor-boundary.md. Dogfood day: 7 cycles, ZERO
    blocks; the gate never caught the sonnet session once. Not a defect —
    the check was `bun test`, the work was docs, and every real error was
    prose the suite cannot see (all caught by the opus review layer). The
    day's one real catch went the OTHER way: the meta-harness gate blocked
    the ORCHESTRATOR's turn on a reinject test failure. kkamak enforces
    "your check passed", not "your work is correct" — a floor whose value
    scales with what the configured check detects. The failure was routing
    work whose success condition the floor could not express, then reading
    silence as approval. Doc referenced from item 11/12 work below.
(11) GAUGE CLASSIFIER — measured 2026-08-01 night, NOTHING SHIPPED, decisions
    open. All evidence-backed, none acted on:
    (a) TRANSPORT. The refiner spawns `claude -p`, dragging Claude Code's
        whole system prompt + tools into every derivation (~28k tokens:
        input_tokens 9, cache_creation 10481, cache_read 17536). A direct
        Anthropic API SDK call sends only the refiner prompt. On real corpus
        prompts: CLI median 15.6-33.0s vs SDK 2.3-3.1s (5-10x), ~700-3000
        prompt tokens vs ~28k. AUTH: the API SDK does NOT inherit CC
        credentials (zero-arg client → "Could not resolve authentication
        method"); the keychain OAuth token DOES work passed as authToken
        (proven). Agent SDK inherits credentials by being CC.
    (b) STRUCTURED OUTPUTS are a win the CLI path cannot have —
        output_config.format + json_schema eliminated every markdown-fence
        and truncation parse failure by construction. Caveat: union type
        arrays ["string","null"] are REJECTED; use anyOf.
    (c) BLIND LABELS (opus, fresh context, saw only rubric + 13 prompts, not
        any transport's output): stored corpus C-precision is 9/13 = 69%,
        NOT the 13/13 the class table implies. So `C 13` is really ~9 and
        the C-rate drops 7.4% → ~5.1%. validate.ts caught some
        over-extraction, not these four. THE VALIDITY FLOOR READS OFF THIS.
    (d) The transports TIE at 9/13 on C-vs-not-C with opposite error
        profiles: CLI 4 false-C / 0 missed; SDK 1 false-C / 3 missed. An
        earlier "SDK is more accurate" claim came from a 6-record slice and
        is RETRACTED.
    (e) An anti-over-extraction prompt patch (four named traps: path with no
        stated property; path-like non-paths e.g. git refs; bare filename
        with no directory; "fill it" with no stated content) drove false-C
        to ZERO on both transports — CLI 10/13, precision 69%→100% — but
        cost recall (100%→67%) and overcorrected one unambiguous case
        ("notes.txt containing one line: demo" → D). PATCH TEXT + THE 13
        BLIND LABELS ARE COMMITTED: docs/2026-08-01-gauge-classifier-labels.md
        + docs/2026-08-01-gauge-class-c-blind-labels.json. NOT applied
        to source.
    OPEN: any transport or prompt change alters the instrument → pre-data
    amendment + logged boundary required, same discipline as (8).
(12) PROPOSED NEW LANE (user insight 2026-08-01, undecided): apply the
    proposer/reviewer/A-B loop to the GAUGE REFINER PROMPT itself rather
    than hand-tuning it. Better instrumented than the TB2 lane on every
    axis — trials ~3s + one haiku call vs 30-60min containers, 176 corpus
    records vs 7-14 band tasks, verdicts in minutes vs nights. Overfitting
    (13 records, tuned and scored on the same set) is precisely what the
    loop's held-out split + pre-registered bar exist to prevent. TWO LIMITS
    TO PRE-REGISTER: labels are OPUS JUDGMENTS, not ground truth — this is
    distillation capped at opus accuracy, never report agreement as
    "correctness"; and it is a THIRD lane (not TB2, not §4.3) needing its
    own bar and boundary.

DEADLINE ITEMS: calibration-refresh tooling before 2nd consumed KEEP;
golden-window machinery before 3rd KEEP.

RULES: explicit go before spend (derive batches: sized go = pending count)
· spec-is-law, pre-data amendments only (5 landed + corpus-replay d869660)
· F1: core/, vendor/, 4 minimal/ files untouchable (gauge/ editable) ·
F2: code-bearing text never enters gate-outcomes.ndjson; .km/gauge-corpus +
check-output + fixture-refs never in km-sensors-sync FILES (test-locked) ·
no bare "gate" in new docs · SITREP style · per-task reviews mandatory ·
grep-verify deploys (GA3 rule).
```

**Resumed the office handoff below; both steps done:**
- **MacBook deploy (Phases 2+3):** `km-refresh.sh --force` OK; cache grep-verified (`fixture-ref.ts` + `captureFixtureRef` ×2 + `prompt-check` ×2, single `0.2.1/`). Both hosts now run Phases 1+2+3 live.
  **LIVE-PROVEN on this host 08-01 (clone test, GA7 precedent):** disposable
  kkamak clone + real headless CC session; agent flipped `===`/`!==` in the
  clone's own gate kernel, held a no-fix instruction → installed plugin
  blocked 3× → exhausted. All instruments fired: exhausted gate-outcomes
  line · 2 check-output records w/ real bun-test excerpts (exhausted round
  3 absent = Phase 1 documented limitation observed live) · 2 fixture-refs
  + 2 anchored `refs/kkamak/fixtures/` tree refs · blockTs EXACT join-key
  match fixture↔sidecar. Clone discarded, zero stream contamination.
- **Corpus-replay T3-T5 built + sealed (SDD, per-task reviews):** T3 deriver `43c4ef3`+`02ed9b8` (review forced lifecycle lock — model spend only under lock, fence re-checked under lock after acquire); T4 resolver `e69de78`+`0d81bb2` (3 under-specified mechanics adjudicated SOUND, recorded as plan annotations; pipefail bsdtar catch; real 7d-cap test); T5 report `34ef861`+`419a507`+`55c5b2a` (point-4 `≥90%?` verbatim + yes/no/n-a ruled SOUND; provenance pin so corpus-bench can never pool; FIX-1 drift footnote). Fable final whole-branch review: READY TO CLOSE YES. **MERGED `27d1ed3`, branch deleted.** Suites: cc-gate-plugin 552 + tsc clean. Full ruling record: HISTORY.md GA9 row + plan's Task-4 "Post-review rulings" + SDD ledger.
- **FIRST REAL BATCH CONSUMED (sized go 198, 08-01):** mine 70 transcripts →
  198 records · `derive --go 198` → **160 derived / 38 stayed mined**
  (retryable; re-spend = new sized go 38) · resolve 160/160 → ALL
  `kind:"none"`, 0 poolEligible — honest starvation: fixture-refs armed only
  today (zero organic blocks yet), commit lane needs same-session cycle
  lines that predate this host's streams. **First report reading:
  `live 0/0 · corpus 0/0 · pooled ≥90%? n/a`, floor NOT MET; class table
  corpus-transcript A1 2 / A2 49 / B 0 / C 12 / D 97 (160)** — corpus
  C-rate ~7.5% vs live 1/72. Pool builds forward from organic blocks
  (Phase 2 capture live both hosts). **Store canonical location =
  `meta-harness/.km/gauge-corpus/`** (moved out of cc-gate-plugin/.km —
  run mine/derive/resolve/report from the meta-harness root).

**NEXT (GO before spend, in order):**
(1) DONE 08-01: retry go 38 → 16 derived, 22 stayed mined (42% vs 81% hit — diminishing returns, park unless cause found). Corpus resolved 176: A1 3 / A2 58 / B 0 / C 13 / D 102; pool still 0/0 (starvation by design). Next retry only with new sized go
    (`derive --go 22`).
(2) DONE 2026-08-02 (office, read-only session): main pulled + verified in
    sync, kkamak already at 586d476 + v0.4.0 tag, cache already carries
    Phases 2+3 — no action needed. Also committed `7108f71`: the GA7 phase-2
    plan doc had lived UNTRACKED since 07-31 while resume.md cited it — it
    never reached the MacBook. Still open (model-free, no go needed): mine
    office transcripts into a second corpus lane.
(2b) 2026-08-02 evening (office): OFFICE CORPUS LANE OPENED. mine → 410
    records (197 transcripts, store .km/gauge-corpus/ this host). derive
    --go 410 GRANTED + IN FLIGHT (tmux `derive410`, launched 21:01 KST,
    ~30s/record CLI transport, ETA ~00:30; log /mnt/d/tmp/derive-410-*.log).
    NOTE: runDerive writes ONE writeCorpus at batch end (corpus-replay.ts
    209-215) — kill/reboot mid-run loses all spend, records stay `mined`.
    Auto-chain armed (tmux `resolve-chain`): on derive exit runs resolve +
    report model-free, log /mnt/d/tmp/resolve-chain-0802.log.
    ✅ BATCH LANDED 2026-08-03 00:50 KST (3h49m, ~33s/rec): derive 298/410
    (72.7% vs MacBook 81% first-batch), 112 stayed mined = next retry sized
    go 112. resolve 298/298 (31s). REPORT (script output, chain log):
    `live 0/0 · corpus 2/2 · pooled ≥90%? yes — floor NOT MET (pooled n=2
    < 5; live n=0)`. Class table corpus-transcript A1 22 / A2 110 / B 10 /
    C 16 / D 140 (298). FINDINGS: (a) FIRST poolEligible records in project
    history — 46 poolEligible total, 2 pool-C, both checks ran + passed
    (smoke-v2.txt content check @ meta-harness; CHANGELOG anchor check @
    kkamak). Pooled 2/2=100% prints "yes" but floor stays NOT MET — n=2<5
    and zero live; permits nothing (d869660 point 5). (b) C-RATE REPLICATES
    CROSS-HOST: office 16/298 = 5.4% nominal vs MacBook 7.4% nominal —
    same ballpark; blind-label 69% precision caveat applies to both
    (~3.7% corrected here). (c) first nonzero corpus B (10). (d) office
    live lane grew 41→50 lines during the evening (this orchestrator
    session's own cycles). (e) POST-§6c CROSS-HOST GOTCHA: pulling the SDK
    merge leaves the suite RED (10 fail — detached refiner dies importing
    @anthropic-ai/sdk) until `bun install` in cc-gate-plugin; office hit
    this live 00:55, install → 594/594 + tsc clean. Any host pulling §6c:
    bun install FIRST. Corpus store is
    host-bound by design (.km/ gitignored, F2 excludes from km-sensors-sync;
    resolve is hostname-bound per GA9) — only READINGS travel via git.
    Office live-lane class table (report 08-02, pre-derive): A1 12 / A2 15 /
    B 6 / C 0 / D 8 (41 lines).
(2c) USER RULING 2026-08-02 ~21:45 KST: gauge derive transport moves to
    direct API SDK (time/token efficiency; GA11 measurements: 5-10x faster,
    ~700-3000 vs ~28k prompt tokens, structured outputs kill parse
    failures). CLI has no intrinsic meaning — only comparability with the
    586 already-derived records. EXECUTION PATH (not yet done): pre-data
    amendment + logged boundary ts FIRST (§6b discipline) — must add a
    transport provenance field to derive records (avoid pluginVersion-style
    double-duty), state the known error-profile delta (CLI over-extracts /
    SDK misses, 9/13 tie), schema rule anyOf-never-union, auth = keychain
    OAuth as authToken. Then implement in spawn.ts + stubbed tests +
    per-task review; BOTH hosts switch at same commit. Tonight's 410 batch
    finishes on CLI (sunk, comparable with MacBook's 176) — LAST CLI batch
    ever.
    → MACBOOK SESSION DIRECTIVE (user, 2026-08-02 ~21:55 KST): MacBook does
    the SDK work — draft the pre-data amendment, implement the SDK
    transport (spawn.ts + stubbed tests, zero real calls in suite), per-task
    review, merge; log the boundary ts at deploy. MacBook runs NO further
    CLI derive batches; all its future derive work = SDK post-boundary.
    Build authorized by this directive; any real derive batch still needs
    its own sized go. Office pulls + switches at the same commit next
    session.
    → DONE 2026-08-02→03 night (MacBook). Full chain executed:
      (a) §6c APPROVED c22fbd0 — three user rulings replaced the draft's two
          invented numbers: pooling bar → stratified C-enriched (sample =
          ALL CLI class-C + equal not-C draw, PER HOST — stores host-bound,
          only counts travel; bar = positive agreement |C_cli∩C_sdk|/|C_cli∪
          C_sdk| ≥ 0.80 AND missed-C ≤ ceil(0.10×|C_cli|)); paired
          re-derivation runs on a SHADOW STORE copy (fenced/locked deriver
          untouched, validation records never pooled); draft's ±25% band
          (sub-one-record at ~5.1% C-rate) and flat ≥90% agreement (beatable
          by an all-not-C oracle at ~95%) both DROPPED as degenerate; the
          claimed §4 daily-cap conflict WITHDRAWN (§3 pt 6 already exempts
          corpus-replay batches — own sized go; MacBook sample ≈ 13C+13,
          office sized after its 410 class table is read). Measured
          13-record slice = 54% positive agreement → bar expected to FAIL →
          readings stay SPLIT; that is the designed outcome, bar set on
          principle not tuned to pass.
      (b) BUILT (TDD, zero real calls): new src/gauge/transport.ts
          (callModelSdk, structured outputs json_schema anyOf-never-union,
          keychain-OAuth authToken w/ apiKey:null, maxRetries 0, 60s
          timeout, fail-open); refiner-cli + corpus-replay both switched to
          the ONE shared transport (mirrored CLI callModel deleted);
          GaugeFile + GaugeSensorField gain transport:"cli"|"sdk" (absent =
          cli, sensor line carries it — Split rule reads off the stream);
          model field now records resolved id claude-haiku-4-5 (do NOT infer
          transport from model string). Test seams KKAMAK_GAUGE_SDK_BASE_URL
          + KKAMAK_GAUGE_AUTH_TOKEN (stub Bun.serve API server, suite makes
          zero real calls). 594 tests + tsc clean.
      (c) REVIEWED: fresh-context reviewer, FIX-FIRST → fix wave d15fc7f
          (OAuth-only apiKey:null + regression test; transport onto sensor
          line; 10s keychain exec timeout; dead extractResultText removed;
          schema emptiness documented — API rejects minLength/minItems;
          README) → re-verified MERGE-READY. MERGED de6e892, branch deleted.
      (d) DEPLOYED 00:29 KST 08-03, boundary ts 1785684571765 in the
          gauntlet ledger (docs/2026-08-01-gauntlet-adoption-ledger.md,
          "Gauge SDK-transport deploy boundary"). Cache grep-verified incl.
          @anthropic-ai/sdk in cache node_modules; INSTALLED copy proven
          against stub server (transport:"sdk", stray ANTHROPIC_API_KEY
          suppressed). pluginVersion still 0.2.1 per amendment — partition
          by transport field / boundary ts.
      REMAINING: office pulls + switches at de6e892 next session — MUST
      `bun install` in cc-gate-plugin BEFORE km-refresh (node_modules not in
      git). Paired validation = its own sized go per host on the shadow
      store (machinery for shadow-store copy/reset/compare NOT yet built —
      small model-free script + sized-go derive, build when validation is
      go'd). Any real derive batch still needs its own sized go.
    → USER RULING (2026-08-02 ~22:00 KST): the CLI-derived corpus (MacBook
    176 + office 410 = 586 records) IS the transport baseline — the paired
    anchor for SDK validation (re-derive same records on SDK, compare
    classifications) and the reference population for anything pre-boundary.
    Descriptive anchor, not verdict authority: transport-effect claims still
    need the paired comparison under a pre-registered bar in the amendment
    (same discipline as the dogfood baseline rule — anchors never
    self-certify).
(3) DONE 2026-08-03 ~06:30-06:50 KST (MacBook): 3 dogfood cycles driven on
    the sonnet subject (session bcd70a2a, tmux `kkamak`), all
    rounds:["accepted"], all three sensor lines carry the FIRST ORGANIC
    SDK-transport gauge records (transport:"sdk", derivations 5.2-6.5s vs
    CLI 15-33s; all classed B/floor-covered — one was refiner-C with check
    "bun test" that validate.ts correctly downgraded C→B). Work was real
    queue items, committed+pushed on kkamak main (e8b9a38 parity-guard
    fail-loud = item 10(a) kkamak half; bc1e882 known-issue 1 marketplace
    $schema+description; c5f8600 known-issue 3 manifest-description parity
    — each with a pinning test, suite 314+). Sensors exported (2ae1e99).
    NOTE for drivers: injecting into the live pane needs the tmux allow
    rules in .claude/settings.local.json (auto-mode classifier blocks
    Enter-submission + self-granted permissions otherwise). Zero blocks
    again — doc'd gate-floor boundary holds; still sustain daily both hosts:
    feed fixture-refs → future corpus records become poolEligible.
(4) Parked user decisions: §3 over-refusal redesign round (likely available,
    single-use); kkamak gate-editing workload ruling (GA5); per-repo fixture
    inclusion on first organic block. A/A ~Aug 12.
DEADLINE ITEMS + RULES unchanged (blocks below).

## ⏸ SUPERSEDED (handoff executed 2026-08-01, see block above) — 2026-07-31 (`yoo-dev`) — gauge corpus-replay build, T1+T2 of 5 COMPLETE — branch `gauge-corpus-replay` @ `27d0a03`, PUSHED

**HANDOFF PROMPT (MacBook, 2026-07-31+):**
```
Resume kkamak (meta-harness) on yoo-mac, 2026-07-31+. git pull main AND
git fetch && git checkout gauge-corpus-replay (27d0a03). Read
docs/resume.md top block + docs/superpowers/plans/2026-07-31-gauge-corpus-replay.md.

FIRST (standing queue, no model spend): deploy Phases 2+3 to this host's
installed plugin — scripts/km-refresh.sh --force from MAIN checkout state
is fine (branch only adds gauge/ files), then grep-verify the cache:
fixture-ref.ts present + captureFixtureRef ×2 in hook-cli + prompt-check
×2 in src listing. Restart any dogfood tmux session afterward if hooks
look stale.

THEN (build go already granted for the SDD): continue subagent-driven
development of the corpus-replay plan at T3. SDD workspace is host-local
and ABSENT here — recreate: run the skill's sdd-workspace script on the
plan path, write a fresh ledger stating "T1+T2 complete (57ad9b2..27d0a03,
both reviewed clean; T1 had 1 fix round: atomic wx lock TOCTOU + NUL-byte
key + undefined-stripping upsert; provenance literal = corpus-transcript
per amendment d869660), resume at T3". Briefs regenerate via task-brief
script. Remaining: T3 batch deriver + derive --go <n> (cost fence: refuses
unless n == pending count; stub KKAMAK_GAUGE_CLAUDE_BIN in tests — ZERO
real model calls), T4 state resolver (30_000ms check budget pinned =
GAUGE_CHECK_TIMEOUT_MS hook-cli.ts:36; sensor-stream-bounded fixture-ref
join; raw bash pipe for git archive, never GitRunner), T5 report
(provenance-split M1v2, live dedup by (sessionID, gauge.n) terminal line,
passthrough-only excluded), fable final whole-branch review + fix wave,
merge to main via finishing-a-development-branch, GA9 HISTORY row + resume
seal. First REAL derive batch afterward = separate sized go (haiku spend,
report corpus size from a model-free mine first).

RULES unchanged: explicit go before spend · F1 (core/, vendor/, 4 minimal/
files untouchable; gauge/ editable) · F2 (gauge-corpus never in
km-sensors-sync FILES) · per-task reviews mandatory · grep-verify deploys ·
no bare "gate" in new docs · script-tally gauge counts, never quote notes ·
SITREP style. Open user decisions parked: §3 extractor redesign round
(single-use, likely available — 72 classified, C=1); kkamak gate-editing
workload ruling (GA5); per-repo fixture inclusion when first organic block
lands. A/A ~Aug 12.
```

Corpus-replay amendment (`d869660`) build via SDD. Plan (architect-reviewed 3
rounds, 14 findings): `docs/superpowers/plans/2026-07-31-gauge-corpus-replay.md`.
DONE: T1 corpus-store (atomic wx lock, diff-safe keys, undefined-stripping
upsert; 1 fix round — lock TOCTOU + NUL-byte-binary-file catches) · T2 transcript
miner + `mine` subcommand (origin no-hard-gate, dedupe-earliest order-independent,
provenance literal corrected to registered `corpus-transcript`; clean first pass).
RESUME: SDD ledger `.superpowers/sdd/2026-07-31-gauge-corpus-replay/progress.md`
(host-local — re-create from this note if absent: T1+T2 complete, resume at T3);
next = T3 batch deriver + `derive --go <n>` (cost-fenced), then T4 state resolver,
T5 report, fable final review, merge. First real `derive` batch = separate sized
go. Suites at seal: cc-gate-plugin 476 · tsc clean.

## ✅ SESSION 2026-07-31 (`yoo-dev` office, continued) — PHASE 3 COMPLETE + ORGANIC PAIR LIVE-OBSERVED (GA8) — main merged, pushed

**Phase 3 (async prompt-check + mechanize-instead) merged to main same day** (GA8
row in HISTORY: `e79ea1b..2031575` + fix wave; plan reviewed-to-FLAWLESS 4 rounds
pre-build; all 6 SDD tasks clean first-pass). **ORGANIC PAIR OBSERVED in the real
kkamak stream on the installed cache**: skippedStop 14:04:14.679 + promptCheck
spawnTs+1ms + resumed turn's normal accept — accompany, exact join, lock lifecycle
all live. **BEHAVIORAL FINDING (volume correction, pre-data):** the skippedStop /
prompt-check trigger is INTERRUPT-shaped boundary loss only (Escape mid-turn with
unmeasured edits, aborts, resumes); queue-shaped loss is extinct in current Claude
Code — three clean disproofs. Expect prompt-check volume well below GA5's ~1/3
estimate; amendment validity unaffected. Office cache carries Phases 2+3 live.
MacBook: pull + km-refresh --force + grep-verify (`prompt-check` ×2 in cache src +
`captureFixtureRef` ×2). Dogfood day 2 final: 6 reviewed-clean kkamak milestones
incl. CHANGELOG (packaging precursor) + adapter marker delivery both adapters.

## ✅ SESSION 2026-07-31 (`yoo-dev` office) — PHASE 2 COMPLETE + LIVE-PROVEN + MERGED (GA7) + DOGFOOD DAY 2 — meta-harness main pushed; kkamak @ `65c9546`

**Phase 3 COMPLETE (sealing task, this session):** async prompt-check
class live-smoked in a scratch repo (skippedStop accompany + single-flight
+ env kill switch all live-proven), 5th amendment conformance read-back
ticked file:line against built code, F1/F2 both verified clean
(`18b5472..31c4662`; suites cc-gate-plugin 437 · km-crank 228 ·
opencode-plugin 1753/1). Doc-only commit; deploy still a separate go.

**Dogfood day 2 (same session):** D1 closed (`ad63d3b`: kernel emits
pluginVersion/forced) + real `marker` milestone (`65c9546`, 283 tests) —
both independently reviewed clean pre-commit. Notable: the dogfood session
SELF-CAUGHT a spec misreading present in both my task prompt and its own
README ("session-carryover" marker never existed in the frozen contract),
paused on a decision menu, and built the contract-true semantics after the
ruling. ~4 real-work clean cycles today, ZERO organic blocks — capture
armed and waiting; do NOT manufacture blocks in the real repo (F2 snapshot
one-way door; livetest clone pattern exists for pipeline demos). Next
natural kkamak task: wire `cfg.marker` through the CC adapter (session
noted adapters don't wire it yet).

**RESUME PROMPT (either host):**
```
Resume kkamak (meta-harness), 2026-08-01+. Read docs/resume.md FIRST (top
block) + docs/2026-07-30-enhancement-roadmap.md +
docs/2026-07-31-phase2-fixture-registration.md. HISTORY GA7 = Phase 2.

WHERE WE ARE: Phase 0+1+2 COMPLETE. Phase 2 (blocked-cycle → bench-fixture
harvest) built via SDD (plan docs/superpowers/plans/2026-07-31-phase2-bench-fixture-harvest.md,
5 tasks, per-task reviews, fable whole-branch review + fix wave), then
LIVE-PROVEN pre-merge on a real Sonnet session in a contamination-free
kkamak clone (registration note "Live dogfood test" section: exact-ts
sidecar pair, tree ref carries untracked file, harvest + podman reward=0),
then fast-forward merged to main. Suites: cc-gate-plugin 404 · km-crank 225.
OFFICE CACHE ALREADY CARRIES THE MERGED BUILD (km-refresh --force during
live test, grep-verified). MacBook deploy PENDING: pull + km-refresh.sh
--force there, grep-verify (fixture-ref.ts + captureFixtureRef ×2).
Capture is LIVE on office: every real block event now writes fixture-refs.
FIXTURE_ALLOWED_REPOS = [] — first real harvest needs per-repo inclusion
ruling (a reviewed commit adding the repo). kkamak repo D1 CLOSED
(ad63d3b: kernel emits pluginVersion/forced).

QUEUE (GO before spend, in order): (1) MacBook pull + refresh (user-side);
(2) sustain dogfood daily both hosts; (3) Phase 3 async promptCheck
PRE-DATA AMENDMENT draft + mechanize-instead rubric key (window closes as
trial nears ~Aug 12); (4) per-repo fixture inclusion ruling when first
organic block lands; (5) sensors export + commit; (6) open ruling: does
kkamak repo gate-editing workload feed §4.3 as real work (GA5, still
unresolved). Later hardening (parked with rulings in final review):
fixture-ref retention/prune, sid8 refname sanitize, .git-as-file worktree
probes, transcript skill-injection filter for extractPromptContext.

DEADLINE ITEMS + RULES unchanged (calibration-refresh before 2nd consumed
KEEP; golden-window before 3rd; F1/F2; explicit go; grep-verify deploys;
no bare "gate" in new docs; SITREP; per-task reviews).
```

## ✅ SESSION 2026-07-30/31 (`yoo-mac.local`) — PHASE 1 COMPLETE + SEALED (GA6) + DEPLOYED (MacBook) — meta-harness through `3f92b9f`, pushed

**RESUME PROMPT (either host; office-current as of 2026-07-31 midday):**
```
Resume kkamak (meta-harness), 2026-07-31+. Read docs/resume.md FIRST (top
block) + docs/2026-07-30-enhancement-roadmap.md. All repos pushed:
meta-harness (sidecar office-deployed note), kkamak ead09d5, squad
7c167f8.

WHERE WE ARE: Phase 0 + Phase 1 COMPLETE (GA6) and the sidecar is
DEPLOYED ON BOTH HOSTS (office 07-31: --force with live sessions
survived 2nd time, grep-verified, stale 0.2.0 cache dir deleted). Office
dogfood tmux session `kkamak` was RESTARTED FRESH on the new cache
(Sonnet 5, idle, no task yet) — its next milestone per that repo:
packaging/marketplace (incl. D1 deferral: port pluginVersion/forced).
First block event on office writes its first sidecar record. Activation
precondition day ~2/14 (trailing-14d ≥10 real-work cycles/day; A/A
earliest ~Aug 12).

QUEUE (GO before spend, in order): (1) sustain dogfood daily both hosts
— drive the tmux `kkamak` session (re-arm watchers: pane-state monitor +
notable-cycle tail on .km/gate-outcomes.ndjson); (2) kkamak
packaging/marketplace step; (3) Phase 2 bench-fixture harvest (~3-5d,
own plan; per-repo private-fixture decision); (4) Phase 3 async
promptCheck (PRE-DATA AMENDMENT, skippedStop template) +
mechanize-instead rubric key; (5) sensors export after dogfood
(scripts/km-sensors-sync.sh export + commit); (6) still-open PRE-DATA
RULING: does the kkamak repo's gate-editing workload class feed §4.3
verdicts as real work? (flagged GA5, unresolved).

DEADLINE ITEMS: calibration-refresh tooling before 2nd consumed KEEP;
golden-window machinery before 3rd KEEP.

RULES: explicit go before spend · spec-is-law, pre-data amendments only
(4 landed) · F1: never touch cc-gate-plugin/src/core|vendor without
recalibration intent · F2: code-bearing text never enters
gate-outcomes.ndjson (sidecar stays out of km-sensors-sync FILES —
test-locked) · verify plugin deploys by GREP not version · no bare
"gate" in new docs · SITREP style · per-task reviews mandatory.
```

**Phase 1 (check-output sidecar + proposer excerpt rendering) BUILT + SEALED
same night as go.** Spec `docs/superpowers/specs/2026-07-30-phase1-check-output-sidecar-design.md`
(`f3bb362`) · plan `docs/superpowers/plans/2026-07-30-phase1-check-output-sidecar.md`
(`8fce9ae`) · SDD 4 tasks, per-task reviews all Approved zero
Critical/Important:
- T1 `e207ae2`: `cc-gate-plugin/src/sidecar.ts` + hook-cli wiring — block
  rounds append `(sessionID, ts, round)`-keyed records, 8192-char cap
  (head 2048 + tail 6144), fail-open like appendSensor, PRE-reinject rawOut.
- T2 `339c5f5`: km-crank pure parser + `joinBySession` (local re-declared
  type, standalone-package rule).
- T3 `a9df656`: evidence render (≤2 excerpts/notable session, tilde fences)
  + crank.ts whole-file sidecar read + F2 FILES-list tripwire test.
- T4 inline: F1 `git log` EMPTY over MECHANISM_PATHS whole phase; F2 sync
  script untouched; suites cc-gate-plugin 394 · km-crank 196; scratch-repo
  live smoke wrote exact record.
- Final whole-branch review (fable): caught cross-task drift I-1
  (head-preserving emitter vs tail-only renderer) → ruling: render split
  head 300 + tail 900; + vacuous byte-identity test MUST-FIX; both fixed
  `4c0c06c`, re-verified **READY TO CLOSE: YES**. Full HISTORY.md GA6.

**DEPLOYED (MacBook, 2026-07-31 go):** `km-refresh.sh --force` OK; cache
grep-verified (`sidecar.ts` shipped, `appendCheckOutput` ×2 in cached
hook-cli, only `0.2.1/` dir — no stale-dir recurrence); scratch-repo smoke
against the INSTALLED copy wrote the exact record. **✅ OFFICE DEPLOYED
2026-07-31 (go): `km-refresh.sh --force` with two live sessions (survived,
2nd time), grep-verified (`sidecar.ts` + `appendCheckOutput` ×2 in cache),
stale `0.2.0/` dir deleted. BOTH HOSTS now carry the sidecar; first office
block event will write the first live sidecar record here.**

**QUEUE (GO before spend, in order):** (1) office-host km-refresh (above);
(2) sustain dogfood daily (tmux `kkamak`); (3)
Phase 2 bench-fixture harvest (~3-5d, own plan; per-repo private-fixture
decision); (4) Phase 3 async promptCheck (PRE-DATA AMENDMENT) +
mechanize-instead rubric key; (5) sensors export after dogfood
(`scripts/km-sensors-sync.sh export`). DEADLINE ITEMS + RULES unchanged
(block below).

## ✅ SESSION END 2026-07-30 night (`yoo-mac.local`) — ENHANCEMENT ROADMAP + PHASE 0 COMPLETE (same day) — meta-harness @ `90bc301` · kkamak @ `ead09d5` · squad @ `7c167f8`, all pushed

**This session (after the MacBook-setup block below):** strategic review
(field-practice search + code-architect verification) → roadmap documented
(`docs/2026-07-30-enhancement-roadmap.md`: phases 0-3, F1 calibration-path
tripwire + F2 snapshot one-way door as binding constraints, rejected list)
→ **Phase 0 EXECUTED + SEALED** (plan
`docs/superpowers/plans/2026-07-30-phase0-contract-events.md`, SDD,
per-task reviews all Approved):
- T1 kkamak `ead09d5`: ALL 3 contract drift axes (sessionID casing, marker
  field, rounds vocab `accepted`/`verify-failed`), golden-vector fixture,
  driven-emission conformance test; 268 tests.
- T2 `e76cd74`: 4 canonical vectors + drift-rejection tests in km-crank.
- T3 `7d89b74`+`1caeb27`+`b4ae92f`: REPOS drift guard + **BONUS CATCH:
  crank.ts top-level `main()` was unguarded — every km-crank `bun test`
  started a REAL crank round (killed mid-flight at exit; state verified
  undamaged) — now `import.meta.main`-guarded, import chain traced clean.
- T4 squad `7c167f8`: gate armed (`bun test`, rounds 2) — third repo feeds
  the event stream.
- Cross-repo parity LIVE: kernel lines parse in km-crank; either side
  drifting alone fails tests loudly in both repos.

**Suites at end:** kkamak 268 · km-crank 189 · cc-gate-plugin 385 ·
opencode-plugin 1748/1 · gate-plugin 26 · squad 156.
**Also this session:** caveman statusline configured (`~/.claude/settings.json`,
cache-hash-pinned path — breaks silently on caveman plugin update); stale
kkamak 0.2.0 cache dir deleted; Parallel Search MCP verified working on
MacBook (memory corrected); tmux dogfood session `kkamak` opened.

**RESUME PROMPT (either host):**
```
Resume kkamak (meta-harness), 2026-07-30+. Read docs/resume.md FIRST (top
block "SESSION END 2026-07-30 night") + docs/2026-07-30-enhancement-roadmap.md.
meta-harness pushed through 90bc301; ~/z2/kkamak through ead09d5; squad
through 7c167f8.

WHERE WE ARE: §4.3 machinery sealed (GA4) + first dogfood day (GA5) +
enhancement roadmap documented + Phase 0 COMPLETE (sensor-contract
conformance, live cross-repo parity guards, REPOS guard, squad gate armed,
crank entrypoint guard). Event stream: 3 repos armed (kkamak, squad,
km-play) + meta-harness kkamak-dev; activation precondition day 1/14
(trailing-14d ≥10 real-work cycles/day; A/A trial earliest ~Aug 12).

QUEUE (GO before spend, in order):
(1) Phase 1 — block-output sidecar at hook-cli seam + proposer evidence
    enrichment (~1.5-2d, NO spec amendment; roadmap has full scope +
    constraints F1/F2). Needs its own short plan first.
(2) Sustain dogfood daily both hosts (tmux `kkamak` session on MacBook;
    kkamak-repo next milestone = packaging/marketplace — pluginVersion/
    forced porting deferral D1 lands there).
(3) Phase 2 — bench-fixture harvest (~3-5d, own plan; private-repo fixture
    inclusion decision per repo).
(4) Phase 3 — async promptCheck (PRE-DATA AMENDMENT, skippedStop template)
    + mechanize-instead rubric key.
(5) sensors export after dogfood: scripts/km-sensors-sync.sh export.

DEADLINE ITEMS (not next, not never): calibration-refresh tooling before
2nd consumed KEEP; golden-window machinery before 3rd KEEP.

RULES: explicit go before spend · spec-is-law, pre-data amendments only
(4 landed) · F1: never touch cc-gate-plugin/src/core|vendor without
recalibration intent · F2: code-bearing text never enters
gate-outcomes.ndjson · no bare "gate" in new docs · SITREP style ·
per-task reviews mandatory.
```

## ✅ MACBOOK SETUP 2026-07-30 evening (`yoo-mac.local`) — 0.2.1 DEPLOYED + kkamak DOGFOOD OPEN — queue item 5 DONE

- **GA5 pull verified token-free:** suites green on MacBook — cc-gate-plugin
  385 (one first-run fail+error, 3 consecutive reruns green; flake unnamed,
  cold-start class, watch for recurrence) · km-crank 183 · gate-plugin 26 ·
  opencode-plugin 1748/1 (1749 ran = +8 leak-rule tests post-GA5-count).
- **Plugin 0.2.1 deployed** via `km-refresh.sh --force` (second live-session
  survival; hooks re-exec per call). Cache verified by GREP not version:
  `pluginVersion` ×2 + `skippedStop` ×2 in cached `types.ts`. Stale `0.2.0/`
  dir (recreated beside the install, GA3 gotcha shape) deleted on user order
  — the setup session itself was its only consumer (possible fail-open for
  its remainder; kkamak-dev stream, metrics-excluded, accepted).
- **`~/z2/kkamak` cloned** (tip `22c146c`): `gate.json` committed (`bun
  test`, rounds 2, gauge on) — gated from turn 1, no init. Check verified on
  this host: 260/260. `.km/` starts empty; repo already in km-crank REPOS +
  sensors-sync (`e1b1115`) — after dogfood sessions run
  `scripts/km-sensors-sync.sh export` to add `yoo-mac.local/` to the
  snapshot.
- **Dogfood session LIVE:** tmux session `kkamak` (interactive claude,
  folder trusted, idle at prompt) — `tmux attach -t kkamak`. MacBook cycles
  now feed the activation-precondition rate alongside office.
- **ENHANCEMENT ROADMAP documented** (strategic review + code-architect
  verification): `docs/2026-07-30-enhancement-roadmap.md`. Phases 0-3 (contract fix
  + multipliers → evidence sidecar → bench-fixture harvest → promptCheck
  amendment + mechanize rubric), two binding constraints (calibration-path
  tripwire F1, snapshot one-way door F2), rejected list. NO phase started —
  each needs go + its own plan doc.

## ✅ SESSION 2026-07-30 (`yoo-dev`) — GA5: FIRST REAL-WORK DOGFOOD + SAME-DAY 0.2.1 FIX WAVE — full record: `minimal/HISTORY.md` GA5

**The loop closed live in one day:** dogfood found 3 instrument gaps at
breakfast → 0.2.1 shipped+deployed by lunch → the fixed instrument measured
its own fix by afternoon.

**Dogfood repo `~/z2/kkamak`** (github.com/th-yoo/kkamak, MIT, fresh history —
first-push mistake reverted, repo recreated): reimplementing kkamak as
harness-abstract plugin (pure kernel + CC/opencode adapter contract), gated
by installed kkamak from turn 1. Kernel MERGED (165 tests; review caught a
real fail-open bug — unpersistable block → unbounded blocking — fixed as
mutation-tested invariant). Adapters plan
(`docs/superpowers/plans/2026-07-30-harness-adapters.md` in that repo)
executing SDD; 2 plan-conflict rulings made (byte-true evidence cap,
import-closure install test); **final whole-branch review + merge = where it
stopped** (529 Overloaded turbulence; resume by nudging the tmux `kkamak`
session or relaunching `claude` in `~/z2/kkamak`).

**0.2.1 fix wave (meta-harness, `72da841..a00519e` + `e1b1115` REPOS +
`feb94e6` snapshot, all pushed):** skippedStop sensor class (queued prompt
eats Stop boundary; **4th pre-data amendment** — excluded from metrics AND
density, own rationale) · checkMs per-round timing (`[884,882]` in a 34.9s
cycle proven live) · init-cli.ts token-free init · version-parity test.
3-round adversarial plan review (21 findings), SDD 4 tasks + 5 fix rounds,
final review READY-TO-PUSH. Suites 385 · 183 · 26 · 1741. Deferred minors:
`.superpowers/sdd/plan-to-fix-them-serialized-teacup/progress.md` (host-local).

**Milestone: first real-work sensor stream ever** — ~10 cycles day 1 =
activation-precondition rate (needs trailing-14d ≥10/day; day 1/14, earliest
A/A ~08-12). `~/z2/kkamak` wired into km-crank REPOS + sensors-sync;
snapshot carries its first 42 lines. Proposer loop UNBLOCKED (supervised
rounds need explicit go). Gate-aware turn-holding observed live = the §4.3
counterfactual argument made flesh.

**RESUME PROMPT (office):**
```
Resume kkamak (meta-harness), 2026-07-30+. Read docs/resume.md FIRST (top
block GA5) + minimal/HISTORY.md GA5.

WHERE WE ARE: 0.2.1 deployed office, all fixes live-validated.
~/z2/kkamak reimplementation: kernel + BOTH harness adapters MERGED +
PUSHED (260 tests; dogfood lessons in the new kernel too); next milestone
there = packaging/marketplace. Pre-crank BASELINE sealed (kkamak
dogfood-log top block; anchor only, never a control arm). km-crank round
1 vs kkamak evidence RAN: review-gate REJECT, no candidate — machinery
E2E-proven on real data; its false-positive trigger fixed + ruled
(leak rule 19196e2..605a407, review->re-review->ruling chain). First
real-work stream at activation rate day 1/14.

QUEUE (GO before spend): (1) sustain dogfood daily ≥10 cycles / ≥2
sessions → A/A trial ~08-12 (pre-data ruling on gate-editing-workload
class still NEEDED before kkamak cycles feed a verdict); (2) kkamak-repo
packaging/marketplace step; (3) next supervised crank round after a
fatter stream; (4) squad dogfood multiplier (never started); (5) MacBook:
pull + scripts/km-refresh.sh (no live claude) → 0.2.1, then clone
~/z2/kkamak + dogfood there (sensors export via meta-harness snapshot).

GOTCHAS: km-refresh --force with live sessions survived once (hooks
re-exec per call) but stays a documented risk; kkamak-dev exclusion is
check-string-based — the kkamak repo's "bun test" group counts as REAL
work; queued tmux messages eat turn boundaries (now measured as
skippedStop, no longer silent).

RULES: explicit go before spend · no bare "gate" · spec-is-law (pre-data
amendments only until data exists; 4 landed) · forensics before verdict
math · SITREP style.
```

## ✅ TM8 SYNC LIVE-TEST 2026-07-30 (`yoo-dev`, token-free, go received) — km-sensors-sync + snapshot-age + sensor-union FIRST REAL DATA

First-ever run of `scripts/km-sensors-sync.sh`: export wrote
`evidence/kkamak-sensors/yoo-dev/` (meta-harness 56 lines + km-play 7;
squad + all trial-arms correctly skipped, no local data), `diff` in-sync,
`import` report-only clean, re-export idempotent (0 adds). Live-exercised
`readSnapshotAges` + `unionRawLines` on the real snapshot:
**age computed from max sensor `ts` proven live** (km-play 0.65d despite
seconds-old file mtime — the mtime lie the module guards), union dedupe
exact (live 56 + identical snapshot 56 → 56), snapshot-only 56, absent
kind 0, no-snapshot repo []. **Still never live:** refuse-on-shrink
(fixture-only), `km-panic trial-off` (needs a trial), SITREP snapshot-age
line render (trial-detail-only — blocked until first trial, registered).
Sensor note: first TM1 `pluginVersion:0.2.0` line observed live on office
(07:47, gauge-only line); `forced` correctly absent. MacBook cache
freshness post-TM1 still unverified.

## ✅ OFFICE VERIFY 2026-07-30 (`yoo-dev`, token-free) — GA4 pull CONFIRMED + cache refreshed

Repo at `e90a598` pulled; all four suites green on office (cc-gate-plugin
352 · km-crank 173 · gate-plugin 26 · opencode-plugin 1741) — GA4 seal
cross-host-verified. **Office installed cache was STALE post-pull** (TM1
changed plugin source, version stayed 0.2.0 → `claude plugin list` blind;
caught by `grep pluginVersion <cache>/src/types.ts` = 0) → refreshed, cache
now carries TM1. **Flags:** (a) version-bump discipline lapsed in GA4 —
bump on next plugin-source change; field-grep = stopgap staleness detector;
(b) MacBook cache freshness after TM1 unverified — its sensor lines carry
`pluginVersion` presence as the tell.

**RESUME PROMPT (either host):**
```
Resume kkamak (meta-harness), 2026-07-30+. Read docs/resume.md FIRST (top
blocks: OFFICE VERIFY 2026-07-30 + GA4) + minimal/HISTORY.md GA4 as needed.

WHERE WE ARE: §4.3 trial machinery BUILT+SEALED (GA4, 3 pre-data
amendments; suites 352/173/26/1741 green both hosts). Gauge v2 deployed,
window open (class-C starvation watch, ≥5-C floor). Both instruments wait
on EVENTS: activation precondition = trailing-14d real-work ≥10 cycles/day,
stream near-empty.

QUEUE (GO before any spend): (1) A/A machinery trial — §4.3's registered
first live use (human-go; blocked on activation precondition); (2) squad
dogfood multiplier (.km/ into squad .gitignore + /kkamak:init) — attacks
the event bottleneck, never started; (3) gauge v2 window watch.

GOTCHAS: plugin-source change ⇒ cache refresh BOTH hosts (version stayed
0.2.0 — grep pluginVersion in cached types.ts to detect); never delete a
running session's cache dir; `claude plugin list` = install authority.

RULES: explicit go before spend · no bare "gate" · spec-is-law (pre-data
amendments only until data exists) · forensics before verdict math ·
SITREP style.
```

## ✅ SESSION 2026-07-29 (MacBook, background) — §4.3 PREREQUISITE BUILD TM1–TM8 SEALED · 3rd PRE-DATA AMENDMENT · FINAL REVIEW CLOSED (GA4)

**The build is DONE and closed** — full record: `minimal/HISTORY.md` GA4
(row + section). Range `fc03f95..61e5c6b`, all pushed. Suites at seal:
opencode-plugin 1740/1 · cc-gate-plugin 352 · km-crank 173 · gate-plugin 26.

**This session (continuing the library block below):**
- **TM6 reviewed** (was committed-unreviewed): Approved; 2 Important findings
  → **3rd PRE-DATA AMENDMENT `54238eb`**: (1) calibration-stale REFUSE-vs-ABANDON
  ambiguity RULED — refuse while `now−startedAt < T_MAX`, abandon
  `"calibration-stale"` at `≥ T_MAX` (unbounded refusal defeated §5's slot
  bound; immediate abandon would nuke healthy trials on any mechanism-path
  commit); (2) explicit abandon RESTORES BASELINE (clear-only abandon left the
  unvalidated candidate active — false-keep-shaped). Fix `d762277`, re-review
  clean.
- **TM7** `3128e54` + fix waves `91f4a9c`,`14abb84` (forced count per exposure
  ROW; §4.3 block scoped to latest trialId; truthful label). Approved.
- **TM8** `dbd7ee3`,`6e2ac1f`,`47a5976`: km-sensors-sync.sh (refuse-on-shrink
  reproduced by reviewer on own fixture), km-panic trial-off, SITREP
  snapshot-age (deferred TM6 item, from max sensor ts not mtime). Approved.
- **Final whole-branch review (fc03f95 base): "With fixes" → fix wave
  `a72cf1e`+`61e5c6b` → re-verified "Ready to close: YES".** Rulings: §7
  two-host union WIRED INTO VERDICT INPUT (`km-crank/src/sensor-union.ts`,
  full-raw-line dedupe, §2 exclusions apply post-union); golden-window
  machinery unbuilt → `runTrialScan` REFUSES `golden:true` + registered
  deferral `docs/explicitly-not-now.md` §7.8; sensor-side KKAMAK_TRIAL_ARM
  `forced` comments corrected (exposure record = sole authority, no sensor
  stamp); `km-panic.sh trial-off` re-ruled ABANDON not rollback (spec §5
  "manual command supersedes"; state-identical post-54238eb, ledger semantics
  only) + plan annotations for fc252c2 and the trial-off mapping.
- ACCEPT-tier minors + 2 optional hardening notes recorded in the final-review
  output and `.superpowers/sdd/progress.md` (host-local, MacBook).

**NEXT (unchanged queue, all need explicit go):**
1. §4.3 first live use = **A/A machinery trial** (human-go start; blocked on
   activation precondition: trailing-14d real-work ≥10 cycles/day — stream
   near-empty, watch scorecard).
2. Event-rate multipliers: squad dogfood (`.km/` into squad .gitignore +
   `/kkamak:init`) — GA2 queue item, never started.
3. Gauge v2 window: class-C starvation watch continues ($()-idiom, ≥5-C
   validity floor).

## ⏸ SESSION END 2026-07-29 (MacBook, library, hard time-stop) — §4.3 BUILD TM1–TM5 DONE + 2 SPEC AMENDMENTS · TM6 possibly in-flight at cutoff — **SUPERSEDED by the block above (TM6 reviewed, TM7–TM8 done, build sealed)**

**State:** sweep batch (km-refresh.sh + km-crank-in-gate.json + score NUL-key) DONE
reviewed. §4.3 prerequisite build (plan
`docs/superpowers/plans/2026-07-29-trial-mode-build.md`, ledger
`.superpowers/sdd/progress.md` host-local) — **TM1–TM5 complete, each
task-reviewed Approved, all pushed:**
- TM1 SensorLine amendment (forced/pluginVersion) `1af4b02`
- TM2 trial-arm module `739a172..e2113f9` + **SPEC AMENDMENT `fc252c2`**: the
  registered `%2` salt was PROVEN parity-linear (0%/100% collinearity with the
  reinject axis per fixed trialId — implementer-caught, coordinator-verified
  algebraically+empirically); amended pre-data to `(fnv1a >>> 16) & 1`.
- TM3 arm-aware compose + exposure wiring `9168a75` + armAware fix `df3970d`
  (**arms are Claude-Code-only per spec §1/§10** — opencode sessions always
  compose active; the armAware flag is the reopen extension point).
- TM4 rewardMode + stand-down guard + resolveGateTrial `694ae73`.
- TM5 calibration registry `fd37a49` + **SPEC ADDENDUM `bcbfdb3`**: 2/19 rate =
  LOWER-BOUND PROXY (measured arms ran mutation probe; shipped daily gate is
  verify-only) — rule-2 floor consumers bound to lower-bound reading.
- Suites at cutoff: opencode-plugin 1738/1/0 · cc-gate-plugin 345 · km-crank 81
  · gate-plugin 26. MacBook rdflib gotcha fixed (see gotchas below).

**TM6 LANDED at cutoff: `0fe63b9` — COMMITTED, UNREVIEWED. Review FIRST next
session** (plan Task 6 is the spec; km-crank 144 tests, all suites green).
Scrutiny list: §5 truth-table fidelity (22-row table shipped), §2 exclusion
matrix, A/A KEEP-by-tie, crank wiring before decideGate + all-REPOS scan,
enact-exactly-once, KKAMAK_DEV_CHECK drift-guard. **Plus one SPEC AMBIGUITY
the implementer surfaced (not silent): calibration-stale = §4 "verdicts
refused while stale" vs §5 abandon-list "registry goes stale mid-trial".
Implemented as pending-refuse (enacts nothing; manual abandon available) —
if mechanical abandon-on-stale was the registered intent, needs a pre-data
amendment ruling.** Snapshot-age SITREP line deferred to TM8 (no snapshot
files exist yet).

**Then:** TM7 (scorecard per-arm N_eff + exposure guard) → TM8 (km-sensors-sync
script + km-panic trial-off) → final whole-branch review vs base `fc03f95` →
HISTORY.md row + section for the build. Minors ledger for the final review
lives in `.superpowers/sdd/progress.md` (MacBook host-local) — key items also
listed per-task above in this block's commits.

**Rules unchanged:** spec-is-law (2 amendments this session were both
evidence-forced + pre-data); explicit go before spend; SITREP style.

## ⏸ SESSION END 2026-07-29 late (office `yoo-dev`) — GA2+GA3: §4.3 REGISTERED · GAUGE v1 M2 FAIL → v2 EXTRACTOR BUILT + DEPLOYED + WINDOW OPEN + LIVE-MEASURED · NEXT = §4.3 BUILD + EVENT-RATE MULTIPLIERS (need go)

**MacBook FIRST STEPS (before any work):**
```
cd ~/z2/meta-harness && git pull
claude plugin marketplace update kkamak-local
claude plugin uninstall kkamak && claude plugin install kkamak@kkamak-local
claude plugin list   # MUST show kkamak 0.2.0 — cache-path picking lies, list is authority
```
Store self-migrates on first plugin run; after the refresh MacBook joins the
v2 gauge window automatically.

**RESUME PROMPT (paste into the MacBook session):**
```
Resume kkamak (meta-harness), MacBook, 2026-07-29+. Read docs/resume.md FIRST
(top block "SESSION END 2026-07-29 late (office yoo-dev) — GA2+GA3") +
minimal/HISTORY.md GA2/GA3 as needed. Repo pushed through 18ca7f3.

WHERE WE ARE: §4.3 trial-mode pre-reg REGISTERED. Gauge v1 M2 FAIL (shadow
forever) → v2 extractor BUILT + DEPLOYED (0.2.0), fresh window OPEN —
MacBook joins after the cache refresh above. Watch: class-C starvation
trend ($() idiom, 0/4), ≥5-C validity floor; orphan supersede eats pendings
under rapid prompting.

QUEUE (GO before any spend): (1) §4.3 prerequisite build §11 (~4-6d);
(2) event-rate multipliers: squad dogfood (.km/ into squad .gitignore +
/kkamak:init) — MacBook install done via the refresh above.

RULES: explicit go before spend · no bare "gate" · pre-data amendments only
until data exists · `claude plugin list` = cache authority · never delete a
running session's plugin cache dir.
```

**State (full detail: HISTORY.md GA2):** **§4.3 trial-mode pre-registration
REGISTERED** (`docs/superpowers/specs/2026-07-29-trial-mode-gate-outcomes-preregistration.md`,
commits `fdd0055..59c4924`, SDD + 3 architect-review iterations, 24 findings
all resolved): playbook-class v0, salted per-session arms
FNV-1a(trialId:sessionID), MIN_N=20 gateCycles/arm + ≥5 sessions/arm +
E_MIN=5 block events, T_MAX=28d, KEEP="not measurably worse" NEVER better
(null-adopt ≈60%), auto keep/rollback + human-go start, golden baseline
every 3 KEEPs, A/A machinery test first, computed calibration staleness,
activation precondition trailing-14d ≥10 real-work cycles/day (stream
EMPTY today). Satellites: scorecard §5 scoping amendment, explicitly-not-now
§7.7, INDEX. **Gauge M0–M3 window CLOSED** (36 prompts): M0 91.7% / M1
63.6% / M3 PASS, **M2 FAIL 9/10 false-block (user-labeled)** → shadow
indefinitely per locked rule (`a18b73d`); root cause = refiner INVENTS
beyond its information bound (world/semantics/timing gaps, not "grounding").
User: fix-or-drop → **km-gauge v2 extractor pre-reg REGISTERED**
(`2026-07-29-km-gauge-v2-extractor-preregistration.md`, `63c94f2`+`61f8d78`):
A1/A2/B/C/D classes (user-ratified), extraction-only ENFORCED IN CODE
(path-in-prompt, repo-scope, B-screen, downgrades), two-strike multi-turn
eval, M1v2 = class-C precision ≥90%, M5 A2-share sizes the judge-shadow
case; **second M2 fail = derivation KILLED for good**. Shadow invariant
test-locked `af0a132` (241 CC tests). Live tmux smoke PASS (haiku session:
sensor exact, gauge full loop same-line, FIRST v0 reinject cycle —
arms v0:1/v1:19).

**km-gauge v2 BUILT + DEPLOYED + WINDOW OPEN (2026-07-29 late,
`a3638cb..1f4c0f6`, SDD 3 tasks + reviews + final review + fix wave; 332 CC
tests; build-review amendment landed PRE-deploy: floor-gated two-strike as
built, strike field, per-derivation M1v2/M5, class-presence filter).
Active cache verified 0.2.0 (stale 0.1.0 leftover dir removed — verify via
`claude plugin list`, never by cache-path picking). Live smoke: hooks ✓;
first real derivation = haiku's $(cat)-style check downgraded
D/no-path-reference with audit record (registered over-refusal direction
live — $()-idiom suppresses class-C rate; validity floor ≥5 C measures it).
MacBook joins window at its own cache refresh after pull. NOTE: in-session
spawn was daily-cap-blocked (30) during smoke — cap resets tomorrow.
LIVE MEASURE (post-reinstall, km-play 3-prompt haiku session, GA3): A2 and
B model-classified EXACT (check null, no downgrade needed); C-attempt →
$()-style check → D `no-path-reference` downgrade with audit (2nd $()
specimen — class-C 0/4 real derivations, starvation trend, ≥5-C validity
floor watches; redesign-round lever = prompt-nudge toward `grep -qxF`);
scorecard byClass renders, v1-era lines excluded by class filter; ORPHAN
MECHANISM OBSERVED LIVE (A2 pending stranded by highest-n supersede —
rapid-fire prompting amplifies, normal cadence less; eats M5 points).**

**QUEUE (WAIT FOR GO):** (1) **§4.3 prerequisite build** (§11, 10 items,
≈4-6 days). (2) event-rate multipliers: squad dogfood + MacBook install
(now ALSO joins the v2 gauge window). (3) small opens: cache-refresh
script, km-crank absent from gate.json check, score.ts NUL group-key
(git-binary diff nuisance), $()/backtick guard rule (next gauge round).
~17 commits UNPUSHED.

**Gotchas:** all prior + v2-window poisoning above; gauge keeps calling
haiku under v1 rules until v2 deploys (cap 30/day, shadow-only, harmless).
**Host-python `rdflib` is a per-host TEST prerequisite** (2026-07-29 MacBook
find): `test/minimal-relations-desk.test.ts` runs relation-probe scripts on
host python3 — missing rdflib = 2 suite fails that look like probe defects.
Fix: `pip3 install --user --break-system-packages rdflib` (user-site only).
Bench arms unaffected (probes run in containers); daily gate v1 unaffected
(no relation probes). These desk tests are the ONLY tripwire for the
missing-rdflib-silently-inert class if host-python probes ever ship.

## ⏸ SESSION END 2026-07-29 morning (office `yoo-dev`) — GA1 COMPLETE: kkamak INSTALLED + gauge window OPEN + scorecard + reinject A/B LIVE (v1 repaired `322f2c1`) — superseded by GA2 above; kept for lineage

**State (full detail: HISTORY.md GA1 + the 07-28 blocks below):** kkamak
plugin INSTALLED on office (auto-loads every session; per-host — MacBook
still needs `claude plugin marketplace add ~/z2/meta-harness/cc-gate-plugin`
+ `claude plugin install kkamak@kkamak-local` after pull). Gauge M0–M3
window CLOSED 2026-07-29: M0 91.7% PASS, M1 63.6% PASS, **M2 FAIL (9/10
false-block, user-labeled)**, M3 PASS (1 real catch: the DRAFT-status
defect, pre-final-review) → per locked rule **km-gauge stays SHADOW
indefinitely, no blocking pilot**; user directed FIX-OR-DROP →
**km-gauge v2 extractor pre-reg REGISTERED**
(`2026-07-29-km-gauge-v2-extractor-preregistration.md`: A/B/C/D prompt
classes, extraction-only enforced in code, two-strike multi-turn eval;
fresh window post-deploy; second M2 fail = derivation KILLED for good).
v2 build = next, needs go; deploy REQUIRES installed-cache refresh or
window poisoned by stale v1. Scorecard shipped
(`bun cc-gate-plugin/src/score-cli.ts`; **MIN_N=20 LOCKED by user** —
display floor, not certification; certified verdicts = separate
pre-registered sequential design). §4.4 reinject A/B LIVE and clean: v0
kernel-verbatim vs v1 composed at the round.ts IO seam (`322f2c1` — tees
raw check output, outcome-gated, fail-open; 2x adversarial architect plan
review; §4b re-registered pre-data; live-proven both arms). 240 CC tests.

**THE BOTTLENECK IS EVENTS, NOT INSTRUMENTS:** ~1 real block ever; MIN_N=20
per arm. Raise event rate: (a) squad dogfood — `.km/` into squad .gitignore
then `/kkamak:init`; (b) MacBook install (2 commands above; store
auto-migrates on first plugin run — rename `872cef8` is self-healing).

**QUEUE:** (1) **§4.3 trial-mode pre-registration** — DONE: WRITTEN +
registered
(`docs/superpowers/specs/2026-07-29-trial-mode-gate-outcomes-preregistration.md`;
3 architect-review iterations, 24 findings resolved; key decisions:
playbook-class v0 build path, within-workload salted per-session arms, auto
keep/rollback + human-go start, computed calibration staleness,
golden-baseline every 3 KEEPs, A/A machinery test first, activation
precondition trailing-14d ≥10 real-work cycles/day). NEXT for §4.3 =
prerequisite build items §11 (≈4-6 days, NEEDS GO). (2) squad + MacBook (above).
(3) small opens: cache-refresh script (installed copy = COPY, rots behind
source silently; refresh = `claude plugin marketplace update kkamak-local`
+ uninstall + install), km-crank (70 tests) absent from gate.json check.

**GOTCHAS FOR NEXT SESSION:** kkamak hooks now run in EVERY session in this
repo (installed) — gate check (~4.5s) fires on edited turns; after editing
cc-gate-plugin source, REFRESH THE CACHE or hooks run yesterday's build;
green gate after plugin-source edits ≠ plugin works (fail-open silence) —
trust the suite. `/reload-plugins` hot-loads incl. hooks (no restart).
Escape: `scripts/km-panic.sh {status|gauge-off|off|restore|nuke|--help}`
(lands next turn; KKAMAK_GAUGE=off is launch-time only). Mid-turn hang=Esc.

**Rules unchanged:** explicit go before spend · one variable per test ·
gate.ts sole adopter · forensics before verdict math · no bare "gate" ·
SITREP style · NEW: no reason-drift without new observations (flag "same
evidence, new interpretation").

## ⏸ SESSION END 2026-07-27 night (MacBook home) — §6.3 CLOSED · SM1 PASS · **2.1b CC PLUGIN SHIPPED + SMOKE PASS (SM2, merge 6d443df)** · NEXT = DOGFOOD INSTALL + §4.3 DESIGN

**✅ OFFICE VERIFY 2026-07-28 (yoo-dev, token-free):** repo at f95d56a; bun
install cc-gate-plugin + km-crank; all 4 suites green — opencode-plugin
1672 pass (1 skip), gate-plugin 26, cc-gate-plugin 120, km-crank 70;
`claude plugin validate` PASS (1 cosmetic warning: no author field) +
`claude --plugin-dir … plugin details kkamak` loads 0.1.0 (skill init,
hooks Stop/PostToolUse/UserPromptSubmit, ~32 tok always-on). CC 2.1.220.
Office box ready for queue items (b)/(c)/(d) — awaiting go for any spend.

**✅ SAME DAY (office): km-gauge PoC shipped + LIVE-PROVEN** (955fbec + spec
addendum). User-approved pre-reg (M0–M3) → TDD build (suite 120→178) →
tmux live smoke, 4 real haiku refiner calls: full loop closed — classifier →
detached refiner → pending → next-Stop shadow eval → sensor `gauge` field
(pass:true agreesWithFloor:true conf .95) → .done.json audit. Derivation
quality 3/3 excellent; latency 10.7–40.9s → one-shot headless = M0 miss,
interactive next-turn consume = works (dogfood shape). km-play (office)
armed `gauge:true`; meta-harness NOT armed yet. Naming: **km-gauge**
(go/no-go gauge metaphor; user dislikes .km/gauge file layout — PoC-only).
**WINDOW NOW OPEN (f3be80d):** safety guard shipped first (guard.ts, 11 tests,
189 total) — derived checks are model-generated shell, so anything not plainly
read-only is refused unrun (`gauge.refused:<reason>`, executable:false); all 4
live-smoke haiku checks pass it unchanged. Then `gate.json gauge:true`
committed → every kkamak-loaded session in THIS repo feeds M0–M3, both hosts
after pull. Analyse at ≥30 task-shaped prompts in the union stream. tmux gotcha: send prompt text and Enter as
separate send-keys (bracketed paste swallows submit); pre-trust dirs.

**✅ PLUGIN INSTALLED + ESCAPE HATCH (10e14c6, 5fe9ef4, 04abb9c).** Arming a
repo is NOT enough — an armed `gate.json` collects nothing unless kkamak's
hooks are loaded, and `--plugin-dir` loads them for one launch only.
Installed locally: `.claude-plugin/marketplace.json` + `claude plugin
marketplace add <dir>` + `claude plugin install kkamak@kkamak-local`;
auto-load verified with a plain `claude` run (sensor + gate state + gauge
refiner all fired). **Installation is PER-HOST and does NOT travel via git —
MacBook needs those 2 commands after pulling; only gate.json arming travels.**
`/reload-plugins` attaches hooks to an already-running session (no restart,
no context loss).

**Install bug, silent-failure class (fixed 10e14c6):** `claude plugin
install` COPIES the plugin dir out of the monorepo, so the three imports
escaping the plugin root (`../../minimal/…`) died with "Cannot find module"
— and fail-open turned that into SILENCE (exit 0, gate inert, zero sensor
data, no visible error). The first install was broken exactly this way; only
found by executing the cached copy directly. Fix: `cc-gate-plugin/vendor/`
holds byte-identical copies of the 4 kernel modules (minimal/ is a shared
kernel, can't move); `test/self-contained.test.ts` locks no-escaping-imports
+ a drift guard + an INSTALL-SHAPE test that copies the plugin to a temp dir
and drives a real gated Stop through it.

**Escape hatch (5fe9ef4, 04abb9c):** `KKAMAK_GAUGE=off` is launch-time only
(read from the CC process env) and CANNOT stop a session already running —
that is why `scripts/km-panic.sh {status|gauge-off|off|restore|nuke|--help}`
exists. `gate.json` is re-read on every hook call, so every action lands on
the NEXT turn with no restart and no lost context; `escape-hatch.test.ts`
locks that invariant. Mid-turn hang = Esc (km-panic can't reach an in-flight
hook). Built-in bounds: auto-allow after rounds+1 failures, CC force-ends
after 8 consecutive blocks, a new prompt preempts an open cycle, 3 internal
errors disarm the session.

200 tests, tsc clean. **OPEN (offered, not done):** cache-refresh script so
the installed copy can't silently rot behind source;
km-crank (70 tests) absent from the gate check.

**✅ RENAME meta-harness → kkamak, runtime store only (872cef8):**
`.meta-harness/` → `.kkamak/`, `~/.config/meta-harness` → `~/.config/kkamak`,
env `KKAMAK_HOME` (META_HARNESS_HOME still honored). Repo dir + remote
UNCHANGED (installed plugin path keeps resolving). BOTH roots auto-migrate on
first use (migrateAccountRoot + NEW migrateProjectRoot, back-compat symlinks;
migrateProjectRoot runs BEFORE migrateFlatToProjectGlobal or the old tree
strands). Live stores migrated byte-verified vs tar backup (14 playbooks,
active v7). MacBook: self-migrates on first plugin run, nothing manual.
Backup gotcha: cp -a to /mnt/d fails on timestamps → && chain left EMPTY
backup; tar to native fs + extract-verify instead.

**✅ SCORECARD (9ca8ad5) + §4.4 EXPERIMENT #1 (fc7fa38):**
`bun cc-gate-plugin/src/score-cli.ts` — M-catch/M-exhaust/M-interrupt/M-tax
per (check,host), rates suppressed <20 cycles, kkamak-dev never pools with
real work (--pool explicit). Claimable: M-exhaust/M-interrupt fall at
non-decreasing M-catch; M-catch alone NOT claimable (needs §4.3
counterfactual). Reinject experiment: v0 kernel wording vs v1, arm =
FNV-1a(sessionID) ~50/50 recorded on every sensor line, scorecard splits
arms + prints decision rule. Within-workload randomisation = both arms share
workload drift → mechanism comparison survives §4.3 confound.

**⚠ REINJECT CORRECTION (user-caught, read before touching wording):**
v1 as shipped is SELF-CONTRADICTORY (appends "do not run it yourself" after
kernel's "and re-run it") — repair = REPLACE the next-action sentence, not
append; v0 = deployed baseline, never changes unmeasured. Kernel ownership
inversion: term-bench2 agent owns verify.sh, kkamak repo owns check — but
defects #1 (wrong "your script") and #3 ("fix the script" = gate-gaming
invite) have ZERO observations; #2 (re-run stall) is n=1, artifact lost.
Audit 659a712..HEAD: zero check/test weakening (+430 assertions), but ~1
block opportunity = no power. #3 stays watch-item, not design driver.
~~V1 REPAIR NOT YET DONE~~ **DONE `322f2c1` (07-29): v1 composed at the
round.ts IO seam** (tees raw check output; never reads kernel prose —
collision edge-cases structurally eliminated; rawOut outcome-gated;
fail-open), v0 byte-identical, §4b re-registered pre-data (audit: zero
v1-tagged block rows existed), 2x adversarial architect plan review,
live-proven both arms. Process rule saved to memory: flag "same evidence,
new interpretation" — no reason-drift without new observations.

**2.1b DONE same night:** `cc-gate-plugin/` (plugin name **kkamak**) built via
15-node parallel-DAG subagent waves per the plan; suites 120+26 green, tsc
clean; wave reviews + final merge-gate review (2 blocking findings fixed:
.km gitignore, sweep littering; + post-kill stream-hang grace) → MERGE-READY
→ merged. **Live smoke (3 headless CC sessions): block-json evidence
delivery VERIFIED** (self-describing check → agent received the block reason
and fixed it, rounds ["verify-failed","accepted"] in 4s) — shipped default
stays block-json; rounds bound exact; marker/no-edit/mkdir/-p all ✓.
HISTORY.md SM2. Build ledger: .superpowers/sdd/progress.md (host-local).
**First interactive-dogfood finding (07-28 demo):** after a block, the agent may RE-RUN the check itself via Bash → permission prompt stalls the fix loop in default/acceptEdits modes (gate itself fine — turn just waits). Mitigation candidates: reinject wording ('do not re-run the check yourself; just fix and finish') or docs note; sensor durationMs inflates with human-wait time (282s incl. approval wait). **Dogfood state (07-28):** meta-harness `gate.json` COMMITTED (`659a712`,
both plugin suites ~4s — monorepo blind spot noted: doesn't cover
opencode-plugin edits); `~/z2/km-play` playground created; README trust
section (`078d6dd`); squad NOT yet (needs `.km/` in its .gitignore first).
Load via `claude --plugin-dir ~/z2/meta-harness/cc-gate-plugin` (alias
recommended).

**NEW DIRECTIVE (user, 07-28): at-least-HALF-AUTOMATIC evolution** —
"human is a mistaking animal, no full manual; even LLMs err, hence the
reviewer loop." Hand-cranked cadence rejected (rule 7b binds the human:
the human-as-scheduler is itself the failure point). → **NEW QUEUE ITEM
2.2a, BEFORE §4.3: the scheduled crank.** Design agreed in-session:
AUTOMATIC = trigger (launchd/N-new-sensor-lines) → evidence assembly
(sensor + trajs + ledger) → proposer (engine seat, headless) → review
gate kills junk pre-spend → stage candidate + SITREP to Slack via cc-acp.
HUMAN = exactly two touchpoints, both already mandated by standing rules:
"go" on trial spend (explicit-go rule) + adoption veto (R4-class scope
veto). Build cost small (pieces exist: §4.2 propose path, cc-acp
delivery, launchd pattern). §4.3 later dissolves touchpoint 1 (auto
keep/rollback on gate-outcome deltas) → fully-automatic-with-veto.

**2.2a DONE 07-28 (go received): `km-crank/` shipped** (70 tests; review wave fixed trial-clobber guard + check-only inflight gate + private lock; live gate-bug fix: zero evidence never runs). TWO LIVE ROUNDS: empty-evidence junk → review-gate REJECTED (thesis proven live); real-evidence (km-play 4 lines) → candidate v1 staged + trial started + Slack SITREPs delivered. launchd com.kkamak.crank daily 10:00 INSTALLED (MacBook). WATCH-ITEM: legacy-mode proposals bypass the review gate (it only covers playbook op:add) — close before trusting unsupervised rounds on real stores. Positions/evidence/log: ~/.config/meta-harness/km-crank/. **NEXT:** (b) squad
dogfood (gitignore + /kkamak:init); (c) §4.3 design (workload-confound
brainstorm; consumes ~10% calibration rate + two-host union stream);
(d) §4.4 mechanism proposals + S4 operators. First §4.4-class candidate
already queued from daily data: post-block reinject wording (see
HISTORY.md SM2 finding).

**WHAT CLOSED (full detail HISTORY.md FA1 + SM1 + the two ✅ UPDATE blocks
in the office section below):**
0. **§4.1 gate-plugin live smoke-test PASS → HISTORY.md SM1** (echo-guard
   assumption live-verified, full verify-fix cycle in 23s on a real
   session). Sensor producer trustworthy → §4.3 unblocked.
0b. **kkamak-CC plugin plan READY** (`docs/superpowers/plans/
   2026-07-27-kkamak-cc-plugin-v0.1.md`, 3 architect review rounds, 15-node
   parallel DAG) — 2.1b in the queue below; product decisions this session:
   plugin name kkamak on every host, km-/.km/ runtime prefix (node N renames
   the opencode sensor default in lockstep), meta-harness → kkamak-harness
   rename = future housekeeping.
1. **sparql k=5 probes-ON shape check (option c):** 5/5, all round-0 accepts,
   zero exhaustion/reinjects/false-accepts, ~1.2–2x tax. Clock preflight
   auto-fixed a −39190s VM skew (Mac-sleep class) at launch.
2. **headless control k=10 (user-directed on MacBook despite the cross-host
   caveat):** 9 valid = 8/9, false-accepts 1/9, exhaustion 0/9, median 446s,
   probes header null ✓; 1 void (a1 0-turn).
3. **§6.3 CLOSED BY MATH (user: "determine from the math"):** ON 1/10 vs
   control 1/9 p=1.0; rewards p=1.0; G1 2/5 reference uncertified (k=5
   noise). **Futility: perfect ON 0/10 vs control 1/9 → p=0.47; cert needs
   control ≥4/9 vs observed ~11% floor → BOTH remaining arms (b′/a) refused
   pre-spend.** Probes: no quantitative claim, ship fail-open, qualitative
   saves real-but-rare. **~10% residual (2/19 pooled) = §4.3 calibration
   rate.** Grip fix (G1) stays the only certified mechanism change.

**QUEUE: ranked item 1 DONE → item 2 live: ~~§4.1 gate-plugin live smoke-test~~
**DONE 2026-07-27 night (MacBook, ~$0.06, 23s gate cycle): PASS all criteria
— sensor line correct, rounds ["verify-failed","accepted"], interrupted:false
(echo-timing assumption LIVE-VERIFIED: echo guard consumed the self-inject),
reinject evidence REACHED the agent which fixed the check (created done.txt
unprompted). Bonus finding: bash-echo edits correctly do NOT arm the gate
(edit-tool set exactness live-confirmed). Scratch: scratchpad/km-smoke.** → **2.1b CC gate plugin** (PLAN READY:
`docs/superpowers/plans/2026-07-27-kkamak-cc-plugin-v0.1.md` — plugin name
kkamak, `.km/` runtime prefix, 15-node parallel DAG, 3 architect review
rounds applied; build via subagent-driven waves) → §4.3 trial mode
(calibration rate in hand; design against the host-tagged union sensor
stream) → §4.4 mechanism proposals. S4 operators open. Standing: mid-arm
futility curtailment still unexercised; wrapper-verify watch-item moves to
plugin sensor data. NAMING (user, this session): product prefix km-/.km/;
project rename meta-harness → kkamak-harness = future housekeeping.**

**BOX STATE (MacBook):** clean — no containers, no run tmux (squad gateway
only), no monitors; tree clean except known host-local logs
(logs-fa-* new tonight) + stray `.agents/`/`.roo/`. Everything pushed.

**Rules in force unchanged:** explicit go before token spend · one variable
per test · gate.ts sole adopter · forensics before verdict math · same-host
arms · tmux + rotated logs · no bare "gate" in new docs · SITREP style.

## ⏸ SESSION END 2026-07-27 ~16:20 (office `yoo-dev`) — §6.3 ARMS PARTIAL: headless-ON DONE (pooled), control+sparql HANDED TO MACBOOK — **EXECUTED + CLOSED same night, see block above**

**WHAT RAN (probes built + merge-ready earlier today, commits a61b08b..eb2ac11 +
4f9b46a; see the queue block below):** §6.3 headless probes-ON k=10 executed as
TWO pooled office runs (pre-registered void rule covers the pooling):
- run 1 (`headless-terminal-2026-07-27T05-54-08-764Z`): **6 valid, ALL
  reward=1, zero false-accepts, zero exhaustion**; a2 turns=3 = live probe
  verify-fix loop; a7/a8 VOID (auth-race at 15:42 oauth expiry — traj error
  "Claude Code credentials are unavailable or expired"; runner self-flagged
  SUSPECT(0-turn)). No results.json (run killed) — evidence = the 8 committed
  traj files + `...-run1-authrace.log` (attempt lines) in minimal/results/.
- run 2: false start (full k=10 relaunch, killed ~5 min per user — 2 in-flight
  partials wasted, nothing recorded).
- run 3 top-up k=4 (`headless-terminal-2026-07-27T06-5*`): auto-committed by
  the fa-finish script (this commit) — results.json + trajs.
**Headless-ON pooled verdict inputs (SEALED 16:28): 10 valid = 9/10 reward,
false-accepts 1/10 (a4; G1 ref 2/5), exhaustion 0/10 ✓, median 651s < 800s ✓,
probes header {requirements:5, relations:4} ✓. LIVE EVENTS: top-up a2 = first
live spec-probe save (verify covered 0 reqs → 2 named reinjects → rewritten →
pass); a4 = residual false-accept (probes passed, grader failed) = the
calibration data point.**
Auto-finish script killed the chain after the top-up (user call: control+sparql
NOT run at office).

**⚠️ PROVENANCE TRAP FOR MACBOOK (read before running the control arm):** the
§6.3 comparison is ON-vs-control SAME HOST. ON arm is office (`yoo-dev`).
Running control k=10 on MacBook against office ON = the exact cross-host
confound gate.ts refuses. Options: (a) run control+sparql at office next
session (cleanest, ~90 min); (b) rerun BOTH arms on MacBook (expensive); (c)
MacBook does sparql k=5 only (single-arm shape check, no cross-host math) and
control waits for office. Recommend (c) tonight + (a) next office session.
Control task dir recipe: copy `minimal/tasks/headless-terminal` MINUS
`requirements.json`, `relations/`, `oracle/` to a scratch dir (probes are
fail-open → same binary, one variable); office copy was
`/mnt/d/tmp/mh-control-headless`.

**✅ UPDATE 2026-07-27 evening (MacBook): option (c) EXECUTED — sparql k=5
probes-ON shape check DONE** (`sparql-university-2026-07-27T08-55-31-719Z.json`,
same-host MacBook, no cross-host math): **5/5 rewards, all turns=1, every
trial round-0 accept with 2–3/4 kills, zero exhaustion, zero probe
reinjects, zero false-accepts; 208–487s (median 291s) vs 117–286s gate-OFF
baseline — mild tax.** Watch-items quiet (no wrapper-verify exhaustion, no
relation timing issues). `coverage: "fallback-static"` all 5 (trace hook
doesn't grip .sparql — static fallback by design). Clock preflight
auto-corrected −39190s VM skew at launch. Detail in HISTORY.md FA1.
**REMAINING for §6.3 verdict: headless control k=10 AT OFFICE (option a)
— then the ON-vs-control false-accept math.**

**✅ UPDATE 2026-07-27 late evening (MacBook): headless control k=10 RUN HERE
(user-directed over the same-host recommendation)** —
`mh-control-headless-2026-07-27T09-31-48-897Z.json`: 9 valid = 8/9 reward,
**false-accepts 1/9**, exhaustion 0/9, all round-0 accepts, median 446s;
1 void (a1, 0-turn). Probes header null ✓. Control dir per recipe (scratchpad
copy, probe fixtures removed). **§6.3 CLOSED BY MATH same night (user-directed):** ON 1/10 vs control 1/9
p=1.0 null; rewards p=1.0 no-harm; G1 2/5 reference uncertified vs anything
(likely k=5 noise); **futility — even perfect ON 0/10 vs control 1/9 gives
p=0.47, certification needs control ≥4/9 → both remaining arms (b′ MacBook
ON, a office control) REFUSED pre-spend.** Probes ship fail-open, no
quantitative reduction claim; qualitative saves real-but-rare. **~10%
false-accept residual (2/19 pooled) = the §4.3 calibration rate — item 1
of the ranked queue is DONE; item 2 (machine crank: §4.1 smoke-test →
§4.3 → §4.4) unblocks. S4 operators remain open (mechanism work).**
Full math in HISTORY.md FA1.

**Verdict math when both arms exist:** primary = false-accept count (gate
accepted ∧ grader failed) ON vs control; reference G1 2/5. Guards: exhaustion
0, median elapsed < 2x G1 (400s), `probes:` header present in ON records /
null in control. Forensics first: void 0-turn/auth-race before counting
(§6.3, grip-fix design doc). Watch-items: wrapper-style verify.sh exhaustion
trigger; relation timing under load.

## ⏸ SESSION END 2026-07-27 (MacBook home, bg session) — PHASE 1 CLOSED · §4.1+§4.2 SHIPPED — OFFICE SESSION STARTS HERE

**READ ORDER AT OFFICE:** this block → `minimal/HISTORY.md` C2 + C1 sections
(both new) → the "UPDATE later same session" block under the 07-26 update below
(build detail) → `docs/2026-07-25-daily-evolution-loop.md` §4 (stages 3-4 = the
remaining queue).

**WHAT CLOSED THIS SESSION (all pushed through `c7811af`):**
1. **PHASE 1 EXIT CRITERIA MET.** C2 sealed: carryover reward-null confirmed at
   pre-registered k=10 both arms (B-alone 3/3 vs raw-B 10/10 vs marker-B pooled
   10/10, p=1.0); one real contamination event (raw a10, filesystem channel);
   marker A-side 4/12 vs raw 7/10 p=0.198 null-but-depressed → **marker ships
   default OFF**. C1 sealed: completion gate holds non-regression CERTIFIED on
   both held-out tasks (headless 7/9 vs 7/8 p=1.0; sparql 8/9 vs fresh same-host
   baseline 10/10 p=0.47) — but grip SPLITS: healthy verify-fix on sparql (~2x
   time tax) vs pure exhaustion on headless python artifact (no probe grip,
   6-30x tax). Futility designCheck made first live catch (refused playbook's
   --stop-futile as uncertifiable — mid-arm curtailment layer STILL unexercised).
   False-accept class (gate accepted, grader failed) recurred across C2+C1 —
   standing watch-item.
2. **DRIFT FORK RESOLVED: machine-seat path chosen (user).** §4.1 + §4.2 built
   same session via subagent-driven TDD (13 commits ec41938..c7811af, final
   whole-branch review READY after C1/I1 seam fixes; suites 1640+26 green).
   Build detail in the 07-26 update block below.
3. HISTORY.md now has the C2 + C1 sections + rows; two implementation plans in
   `docs/superpowers/plans/2026-07-26-*.md`.

**BOX STATE (MacBook):** tree clean except untracked logs (logs-c1/c2 etc,
host-local, ignorable) + stray `.agents/`/`.roo/` (not ours, untouched). No
tmux (squad gateway only), no containers. Everything pushed.

**⏭ OFFICE PLAYBOOK — REORDERED 2026-07-27 (user): opencode-plugin tasks
DEFERRED until after bench-side mechanism work. RANKED 2026-07-27 (gap
analysis, user-confirmed) — attack order:**
1. **False-accept countermeasures (bench): PROBES BUILT 2026-07-27 office**
   (SDD 8 tasks + fix wave, commits a61b08b..eb2ac11, final review
   MERGE-READY; suites 1671+26 green; desk-validated oracle-pass/
   degraded-fail both tasks; plan:
   `docs/superpowers/plans/2026-07-27-false-accept-probes.md`).
   ~~REMAINING: §6.3 calibration arms~~ **DONE + CLOSED BY MATH 07-27
   night (MacBook) — probe effect null, remaining arms futile; see the
   session-end block at top + HISTORY.md FA1.** S4 behavior-targeting
   operators ride along after (hand-design active — §4.4 deferred).
2. **Machine crank (plugin, deferred):** §4.1 live smoke-test → §4.3 trial
   mode (HARD constraint: gate-accept ≠ correct; consumes calibration rate
   from 1) → §4.4 mechanism proposals. Built only AFTER 1 — otherwise the
   crank optimizes a poisoned signal.
3. **Behavioral fingerprinting:** one evaluation session someday (86%-vs-0%
   regression-detection claim; smaller k per verdict if real). Not a build
   commitment.
4. **Task/curriculum generation:** → `explicitly-not-now.md` (oracle-squared
   trap: synthesized tasks need synthesized graders; revisit at band
   saturation with item-1 verification tech in hand).
5. **Cross-family judge check:** opportunistic — run when a judge verdict
   next materially matters (field: ~5–7% same-family inflation).
Original numbered list below kept for reference:
1. ~~git pull + installs + suite verify~~ **DONE 2026-07-27 office (`yoo-dev`):
   gate-plugin 26/26, opencode-plugin 1641 ran 0 fail. Pull through `7d37a3a`.**
2. **Live smoke-test of the gate plugin** (the one unverified assumption:
   chat.message echo timing vs client.session.prompt resolution — test-faked
   only). Drop a `gate.json` ({"check": "<cheap real check>"}) into a scratch
   project, run one real opencode session that edits a file, let it idle: check
   `.meta-harness/gate-outcomes.ndjson` line appears, `interrupted:false` on an
   uninterrupted run, rounds behave, engine double-score interaction tolerable
   (documented-accepted). If echo timing is wrong live → selfPrompt guard needs
   a counter or timing rework (final-fix-report has the design).
3. **§4.3: trial mode re-based on gate outcomes** (daily-evolution doc stage 3)
   — provisional candidates scored by gate-outcome deltas (round counts,
   exhaustion rate) instead of human score rate. Design first, then TDD.
4. **mutate.ts grip operators** — C1's headless no-grip finding is the first
   mechanism target. PREFER routing it through the machine seat once §4.4
   (mechanism-class proposals) exists; hand-design only if §4.4 stalls.
   **Design note written 07-27 office: `docs/2026-07-27-probe-grip-fix-design.md`**
   (root cause, field-grounded fix set S1–S5, outcome buckets, threat notes).
   **S1+S2+S3 IMPLEMENTED same day (TDD, suites 1656+26 green): coverage-guided
   sites (new `minimal/cover.ts` trace hook), `__main__` exclusion, ≥1-kill
   rule + coverage provenance in round results. VERIFIED same day: G1 arms
   (HISTORY.md) — headless exhaustion 0/5 vs C1 7/9, sparql 3/3 clean, both
   PASS pre-registered §6.1. False-accept fix directions researched →
   design note §5.1 (spec-coverage probe, metamorphic relations, §4.3
   calibration constraint). OPEN: S4 operators via machine seat.**
5. Backlog (record-only minors from final review, in `.superpowers/sdd/progress.md`
   host-local — key ones): ledger unbounded in prompts (render last-N later);
   reviewer duplicate check doesn't see ab-rejected candidates (stage-3
   deferral); runCheck has no timeout (loosest-envelope philosophy, accepted).

**PROVENANCE REMINDER at office:** office box = `yoo-dev`; all 07-25/26 arms are
`yoo-mac.local`. Any new comparison arms at office need OFFICE baselines
(gate.ts provenance check enforces — it refused cross-host once this session,
correctly).

**Rules in force unchanged:** explicit go before token spend · one variable per
test · gate.ts sole adopter · forensics before verdict math · tmux + rotated
logs · no bare "gate" in new docs · SITREP report style.

## ✅ UPDATE 2026-07-26 (MacBook home, bg session) — C2 + C1 EXECUTED, PHASE-1 EXIT CRITERIA MET

Playbook steps 1–3 below DONE (verdicts sealed in `minimal/HISTORY.md` C2 + C1
sections, commits `62f3602` + `ca1462f` + this one):
- **C2:** NULL reward effect (B-alone 3/3 vs raw-B 10/10 vs marker-B 5/5-valid,
  p=1.0, pre-registered ✓); contamination 1 event (raw a10 B read A's
  `/app/test.py`, filesystem channel, B still passed) vs marker 0/5 —
  underpowered; **marker arm closed by 07-26 top-up: B pooled 10/10 null confirmed; marker A-side 4/12 vs 7/10 p=0.198 — port ships marker default OFF**.
- **C1:** BOTH held-out tasks certified non-regression HOLDS. headless 7/9 vs
  7/8 (p=1.0) but **gate exhausted 7/9 valid trials** — probe no-grip on python
  artifact, 6–30x time tax. sparql 8/9 vs fresh same-host gate-OFF baseline
  10/10 (p=0.47), healthy gate shape, ~2x tax. gate.ts provenance check
  refused the office-box baselines (correct) — MacBook baseline rerun closed it.
- **Futility wiring first live exercise = pre-arm designCheck REFUSED playbook's
  --stop-futile** (even 10/10 can't certify vs 7/8 or 17/20 at k=10) — C1 ran
  without it; **mid-arm curtailment layer still unexercised**.
- **False-accept watch-item:** every real A-side fail across C2+C1 = completion
  gate ACCEPTED, grader failed. Next mechanism target: probe grip (mutate.ts
  operators).

**NEXT (queue discipline):** marker top-up k=5 (optional, honest-completeness) ·
minimal gate plugin port (`2026-07-25-daily-evolution-loop.md` §4.1) or drift
fork (§4.2-4.4) — user decision open.

**UPDATE later same session: BOTH BUILT (user chose machine-seat path + plugin
port in parallel; commits ec41938..6f39449, all pushed, suites 1640+26 green):**
- **§4.1 gate plugin SHIPPED:** standalone `gate-plugin/` (2nd entry in
  opencode.json), session.idle completion-gate loop reusing
  `minimal/complete-gate.ts` (mutants=0 v1), `gate.json` opt-in
  ({check, rounds:2, marker:false, sensor}), ndjson sensor at
  `.meta-harness/gate-outcomes.ndjson`, **marker default OFF (C2 verdict
  amendment over hygiene doc §4)**, self-inject echo guard + `[meta-harness]`
  child-session exclusion (final-review C1/I1 catches).
- **§4.2 review gate + ledger PORTED:** `rejected.json` per layer.root
  (harness-store API, atomic IO), `review-gate.ts` over `minimal/review.ts`
  (layer-1 free-fail incl. revise short-circuit, bounded revise 1, fail-closed),
  wired in `applyProposeArtifact` pre-createCandidate (both transports,
  whole-proposal reject), ledger feeds `buildProposerPrompt`.
- **Known interaction (accepted, documented in daily-evolution doc §4.1 note):**
  gate reinject turns can re-fire engine scoring on mh-sessions; score once at
  end; suppression deferred.
- **Before first daily use:** live smoke-test the chat.message echo-timing
  assumption (gate a real session once, check sensor line + no interrupted:true
  false positive). Then §4.3 (trial mode on gate outcomes) is next queue item;
  mutate.ts grip operators (C1 headless no-grip finding) = first mechanism
  target, ideally THROUGH the machine seat once §4.4 lands.

## ⏸ SESSION END 2026-07-25 FINAL (MacBook desk) — PROJECT NAMED **kkamak** · A2 ADOPTED · C2 READY — HOME SESSION STARTS HERE

**NAMED (sealed at close): the project is `kkamak` (까막)** — Aesop's
borrowed-plumes crow, in Korean; our inversion = the crow that runs the
plucking itself (gates as the flock). See [`docs/NAME.md`](NAME.md);
collision-clean. Repo/CLI renames = future housekeeping — name travels in
docs first.

**READ ORDER AT HOME:** this block → `minimal/HISTORY.md` (three-gate glossary at
top; rows through A2) → `docs/2026-07-25-gate-session-hygiene.md` §3 (C2 protocol)
→ `docs/2026-07-25-daily-evolution-loop.md` (the phase-2 plan, read once).

**MISSION FRAME RE-ANCHORED (user, end of session):** the original two-phase idea
is the map — **Phase 1: forge the SEED system prompt on the benchmark (provable
graders) = DONE-pending-transfer** (seed-v0 + system-v0 certified 30%→85%, plus a
certified mechanism — the completion gate — and the verdict machinery as durable
byproduct). **Phase 2: daily usage evolves the harness from that seed** — design
now written (`2026-07-25-daily-evolution-loop.md`): gate outcomes = the objective
daily grader that the first (pre-reboot) phase-2 attempt lacked; proposer = core
engine, investment path chosen (stages: gate plugin sensor → review gate + ledger
into engine → trial mode on gate outcomes → mechanism-class proposals). The week
was phase 1 executing, not a detour. C1+C2 arms = the last phase-1 exit criteria.

**ORIGINALITY LEDGER (user-questioned at close, honest record):** borrowed by
design — AHE method, Stop-hook/MutGen patterns, system-v0's curated sources,
classical stats, the forked scaffold. Genuinely ours — (1) empirical findings:
no-universal-interpretation-policy-across-graders (b7 ±), grip-is-content-
dependent, docstring-mutant probe failure mode, C1/C2 transfer-channel split;
(2) the integrated verdict discipline (machine adoption + guard-less-forbidden +
provenance refusal + rejection ledger + review gate + futility linting operating
TOGETHER — AHE ran no stats); (3) the specific loop: bench-forged seed →
gate-outcomes-as-daily-grader → daily evolution. Watch-items: proposer outputs
remain derivative; mechanism DESIGNS are borrowed — their CERTIFICATION is the
original part. Evolution is copying with selection; our originality lives in the
selection pressure and the verified record.

**STATE:** active minimal config = system-v0 + seed-v0 + `--complete-gate` (A2,
first mechanism-class adoption; gate-only increment 5/10→10/10 p=0.0325
user-corrected from the 3/10→10/10 full-stack headline). Suite 1621 green. Box
left clean: no tmux, no containers, tree clean.

**TODAY'S VERDICTS + DECISIONS (detail in HISTORY.md / hygiene doc):**
- A2 ADOPT (adoption gate: R10 lift + gate-ON guard holds cdt 2/2, chess 3/3).
- Locked: contract NOT in system prompt (falsifier registered) · port = cache
  preserved, no context editing, marker-only hygiene · filter dead (~130-turn
  break-even) · **C2 before C1** · futility mid-arm wiring = review-only,
  first-use check on C1.
- Drift fork OPEN: next mechanism through machine seat vs mission rename.

**INFRA SHIPPED TODAY (all TDD, subagent-built, reviewed):** clock-skew preflight
(`dc24972`) · `--then`/`--marker` C2 mode (`4530631`) · futility stopping
`--stop-futile basePass/baseN` + designCheck (`2803893`) · three-gate glossary
(`2859452`).

**⏭ HOME SESSION PLAYBOOK (in order):**
1. **Fire C2 arms** (~3 hr, mostly unattended). Two commands, run as one tmux chain:
```
cd ~/z2/meta-harness
tmux new-session -d -s c2 "PATH=/opt/podman/bin:\$PATH bun minimal/run.ts ../terminal-bench-2/cancel-async-tasks --k 10 --parallel 2 --system minimal/harness/system-v0.md --harness minimal/harness/seed-v0.md --complete-gate /app/run.py --then ../terminal-bench-2/count-dataset-tokens >> minimal/logs-c2.log 2>&1; echo C2RAW_DONE >> minimal/logs-c2.log; PATH=/opt/podman/bin:\$PATH bun minimal/run.ts ../terminal-bench-2/cancel-async-tasks --k 10 --parallel 2 --system minimal/harness/system-v0.md --harness minimal/harness/seed-v0.md --complete-gate /app/run.py --then ../terminal-bench-2/count-dataset-tokens --marker >> minimal/logs-c2.log 2>&1; echo C2MARKER_DONE >> minimal/logs-c2.log"
```
   Notes: NO --stop-futile here (curtailment watches A's reward; C2's verdict
   variable is B's). Clock preflight runs automatically (if the box slept, it
   resyncs or refuses with instructions). One aborted 07-25 launch left no records.
2. **C2 verdicts:** forensics first (voids, turnsB=0 = B-side skew class), then
   gate.ts: B-alone baseline = 07-25 gate-ON cdt records
   (`count-dataset-tokens-2026-07-25T05-02*` 1 valid + `T05-33*` 2/2 — 3 valid
   passes; screens 07-23 for the gateGuard baseline arg) vs raw-arm B rewards vs
   marker-arm B rewards. Plus vocabulary-contamination grep over B trajs:
   `grep -ciE "cancel|cleanup|mutant|asyncio" <traj after the then_b marker>` —
   leading indicator, independent of rewards. Expectations pre-registered in
   hygiene doc §3 (small/null reward effect; contamination detectable; marker
   halves it).
3. **C1 held-out arms** (headless-terminal + sparql k=10 gate-ON, ~2 hr) — WITH
   `--stop-futile 7/8` (headless) / `--stop-futile 17/20` (sparql) — first live
   exercise of mid-arm curtailment: verify the futility log line + stoppedFutile
   record field behave. Baselines on disk (07-23 adopted gate-OFF records).
   Salvaged partial: headless a2 pass (one healthy gate round) — context only.
4. **Then:** plugin port (item 4, fully scoped) or the drift fork decision.
   Queue discipline: close one before opening new.

## ⏸ SESSION END 2026-07-24 (office box, host POWERED OFF mid-R9) — RESUME HERE

**WHERE:** minimal loop R2–R9 in one day. Active base UNCHANGED (system-v0+seed-v0).
Read `minimal/HISTORY.md` (rows + sections R1–R9, current) FIRST, then
`docs/2026-07-24-completion-gate-design.md` + `docs/2026-07-24-proposer-review-loop.md`.

**BUILT today (all committed):** proposer opencode driver (default) + parity-proven;
balanced-brace extraction; rule 3b (behavior-level, agent-translated categories, domain-swap);
Reviewer seat + bounded revise loop (first live catch = R6); completion gate + mutation
adequacy probe (`minimal/complete-gate.ts`, `mutate.ts`, run.ts `--complete-gate`) — all TDD,
suite 1591 green.

**VERDICTS today:** R2 null · R3 null-negative (falsify fired) · R4 scope-veto (rule 3b born)
· R5+R6 ABSTAIN (prose exhausted, 2 independent paths) · R7 channel refuted (system-slot =
AGENTS.md, rule harmful both) · R8 staged-not-gated (wrong target: per-variant ≠ JOINT
coverage) · **R7 GROUND-TRUTH forensics: all 5 fails die ONLY on queued×awaiting-cleanup
CONJUNCTION (grader T5 n3/m2); each dimension tested separately by every fail (a3 verbatim);
verified by running grader shapes against extracted implementations.**

**R9 (completion-gate A/B) KILLED at 5/10 by host shutdown:** gate arm 4/5 pass
(a2 only fail), EVERY attempt turns=3 (both gate rounds consumed — check per-trial gate
field in trajs/record: was it no-verify→fix (healthy) or probe-never-satisfied
(gateExhausted bug)? UNKNOWN — first resume job). Partial record
`minimal/results/r9-gate-arm-partial.json` + trajs a1–a5 committed. Baseline = adopted arm
6/10 (`cancel-async-tasks-2026-07-24T01-43-48-351Z.json`). Guards/sparql/gate.ts NEVER RAN.

**⏭ NEXT (in order):**
1. **R9 forensics (FREE):** read a1–a5 trajs' gate_reinject blocks + gate outcomes —
   healthy rounds or exhaustion? What did mutants catch? Did verify.sh get gamed?
2. **Finish R9:** fresh candidate arm k=10 (do NOT --resume the partial) + guards k=3
   gate-ON (artifacts: cdt=/app/answer.txt chess=/app/move.txt sparql=/app/solution.sparql)
   + gate.ts vs the 6/10 baseline. Script: `/mnt/d/tmp/r3-chain/run-r9-gate.sh` (HOST-LOCAL,
   office box only — recreate from design doc §4 elsewhere).
3. **OVERFITTING CAVEAT (user-raised, standing):** gate designed FROM cancel-async
   forensics, measured ON cancel-async; `drop-cancel-call` operator is task-class-fitted;
   ~6 sequential interventions on one task = spent statistics. Any R9 verdict is
   "directional on design task, transfer untested". **Real test = gate held-out arms**
   (headless-terminal + fresh band picks the gate never saw).
4. **Minimal gate plugin (was: port into opencode-plugin)** — design + build stages now
   in [`2026-07-25-daily-evolution-loop.md`](2026-07-25-daily-evolution-loop.md) §4.1.
   Decisions locked: standalone engine-free plugin first (Gall; full-plugin integration
   evidence-gated later) · contract NOT in system prompt (R7; falsifier registered) ·
   cache preserved, no context editing ever · marker-only hygiene · PREREQ C1 held-out
   certification. Older capsule text superseded by the design doc.
5. **Proposer = core engine (user-settled 07-25): invest path chosen.** Build stages
   2–4 of [`2026-07-25-daily-evolution-loop.md`](2026-07-25-daily-evolution-loop.md):
   review gate + rejected ledger into engine propose path; trial mode re-based on
   gate outcomes (the daily grader); mechanism-class proposals (gate.json deltas
   through review + adoption gates). Older backlog list (timeout blindness, trail
   feedforward, reviewer diversity) still valid, folded behind those.
6. ~~Futility stopping~~ **DONE 07-25 (`2803893`): deterministic curtailment —
   `--stop-futile <basePass>/<baseN>` (design check refuses under-powered arms
   pre-spend; mid-arm stop halts new admissions, in-flight recorded) + guardFutility
   first-fail rule in futility.ts. History-replay tests pin R7 (futile at launch,
   p=0.0867) / R10 / loop-2 values. USE on C1 held-out arms (single-task, baseline
   known). NOT for C2 arms — curtailment watches task A's reward; C2's verdict
   variable is B's (inert there, harmless but pointless). **Live-test status
   (user-accepted 07-25): logic + design-check die = tested; MID-ARM stop wiring =
   review-only, first live exercise rides the next real --stop-futile arm (C1) —
   check its log line + stoppedFutile record field on first use.**
7. ~~Three-gate naming cleanup~~ **DONE 07-25: canonical glossary table at the top of
   `minimal/HISTORY.md`** (completion / review / adoption gates + modifiers +
   non-gates futility/scorer; rule: no bare "gate" in new docs).

**RULES IN FORCE:** explicit go before ANY token spend; one variable per test; gate.ts sole
adopter; rejected → rejected.json (5 entries) fed to proposer; behavior-level bullets only
(rule 3b); tmux + rotated logs; --resume freezes partial tasks (never top-up).

## ⏸ SESSION END 2026-07-23/24 (MacBook) — FIRST ADOPTION (gate.ts-decided) + HELD-OUT DIRECTIONAL — RESUME HERE

**MISSION (user-ordered, sequential gos):** run the office block's NEXT queue — forensics,
guards, Gate-as-code, held-out.

**RESULT (all DONE, all pushed through `0119619`):**
1. **Forensics (free):** 17/20 candidate trials emit DoD procedure vs 0/20 bare;
   verbatim mid-flight scope-leak catch; 3 candidate fails all complied (residual =
   held-out-only discriminators); anthropic.txt-removal hypothesis weakened. Detail in
   item-1 strikeout below.
2. **Gate-as-code BUILT** (`minimal/gate.ts`, `f3db54a`): forensics void-classification +
   Fisher lift + guard non-regression + combined verdict; TDD 17 tests (in
   `opencode-plugin/test/minimal-gate.test.ts`, runs with the main suite); reproduces
   both historical p-values from committed records; **guard-less adoption structurally
   forbidden** (hole found on first E2E run — it said ADOPT with zero guards).
3. **ADOPTED — FIRST ADOPTION IN PROJECT HISTORY** (`4fc9d68`,
   `minimal/results/adoption-1-verdict.json`, decided by gate.ts): lift 17/20 vs 6/20
   p=0.00106 certified + guards count-dataset-tokens 3/3 AND chess-best-move 3/3 HOLD,
   zero voids. **ACTIVE BASE for minimal = system-v0.md + seed-v0.md.**
4. **Held-out generalization (`0119619`):** first picks (financial-document-processor,
   sanitize-git-repo) DEAD for minimal — run.ts stages no Dockerfile RUN steps
   (run.ts:270); swapped to cancel-async-tasks + headless-terminal (screened).
   **cancel-async bare 3/10 vs adopted 5/10 (p=0.65) · headless bare 7/11 vs adopted
   7/8 (p=0.34) — BOTH positive, NEITHER certified per-task; informal cross-task pool
   10/30 vs 13/18 p=0.016** (gate.ts refuses cross-task pooling by design — context,
   not verdict). Guards re-held in both verdicts. 3 void trials auto-excluded.

**DARWIN PATCHES (run.ts, both E2E-verified + pushed):** `ab38dc7` auth — Keychain
export of CC oauth into throwaway 700/600 dir when `.credentials.json` absent;
`f118454` --parallel — /proc/stat//proc/meminfo fallbacks (loadavg/cores; mem gate
skipped on darwin). Ops trap logged: appended logs make `grep DONE`-style watchers fire
on STALE markers — rotate logs per launch or count markers.

**CONFIDENCE:** "improves the agent, not just sparql" ~85% (was 60% at office close).
Basis: certified target lift + mechanism read + 6/6 guards + 2/2 held-out direction.
Missing for full claim: per-task held-out certification (k=20/arm) or more tasks.

**⏭ NEXT (user decides, in queue order):**
1. Round-2 bullet gate (scope-leak candidate `harness/candidate-2026-07-23T08-39-05-972Z.md`)
   ON TOP of adopted base — gate.ts, sparql k=10 + guards.
2. Decomposition: system-v0-only arm — attribute assembly vs pieces (+ removal test).
3. k-boost a held-out task toward per-task certification (cancel-async +10/arm ≈ 1 hr).
4. Store (versioned ledger) — last unbuilt kernel seat; gate.ts JSON verdict line is
   the ledger surface, wire adoption state into it.
5. TB2 v11 gate run (2 blocks down) — still pending, untouched on MacBook side too.
6. Office box: v8 harness-size grep (old TB2 record question, cheap).

## PREVIOUS: SESSION END 2026-07-23 (office box) — minimal/ BUILT + FIRST BAND-CERTIFIED LIFT

**MISSION (pivoted mid-session by user):** build `minimal/` — a standalone code
extraction of the [`minimal-loop-ood.md`](minimal-loop-ood.md) kernel — and run its loop.
The pending v11 TB2 gate run was NOT executed (still pending, see previous block).

**BUILT (all committed, `minimal/`):** `run.ts` (podman mh-bench sandbox; drivers
opencode(default)/claude-code mirroring TB2 recipes; `--k` fresh-container repeats;
`--parallel M` with load-adaptive width via host /proc admission; `--harness` →
/app/AGENTS.md; `--system` → REPLACES opencode's base prompt via config agent.build.prompt
(anthropic.txt at opencode `session/prompt/`, override at `request.ts:60`); TB2-task import
= zero-rewrite (upstream tests/ + reward.txt protocol; environment/ staged as fixtures;
runs straight from `../terminal-bench-2/<task>`); suspect-trial flag (0-turn);
PID-labeled reap + PID-in-name (podman ps has NO .Label format — use podman inspect;
two live cross-kill incidents)). `traj.ts` (readable traj renderer, both drivers).
`propose.ts` (Proposer seat: one opus `claude -p` call over run-record trajs pass+fail +
scorer SOURCE + rejected ledger + guards; prompt via stdin — 537k chars blew argv E2BIG;
stages candidate; gate commands printed). `rejected.json` (invariant-5 ledger).

**LOOP RESULTS (sparql-university, opus/opencode, office box, all same-host paired):**
- Round 1 (machine bullet, thin 1-fail evidence): bare 4/10 vs bullet 5/10, p=1.0 —
  NULL; own falsify_if fired (first calibration point); rejected + ledgered.
- Round 2 proposer (10-traj evidence + ledger): scope-leak bullet (qualification filter
  leaking into output projection) — CONVERGED with independent human desk-check of the
  a2 fail (spec misread: EU filter on aggregated ?country; grader wants ALL countries).
  Staged `harness/candidate-2026-07-23T08-39-05-972Z.md`, NEVER GATED yet.
- **SYSTEM GATE (the headline): bare 6/20 (30%) vs [system-v0 + seed-v0] 17/20 (85%),
  pooled Fisher p=0.00106; unbiased replication batch alone 3/10 vs 9/10 p=0.0198.**
  Largest lift in project history. Committed f9ac50e + 87fc658. **NOT ADOPTED — zero
  guard tasks measured (v9 lesson). Composite candidate: attribution = assembly, not
  either piece.**

**THE CANDIDATE:** `minimal/harness/system-v0.md` (72-line replacement system prompt:
autonomous-mode overlay + observation/honesty + task discipline incl. unconditional
requirement-reading statement + scope-separation + DoD as REQUIRED EMITTED PROCEDURE;
lineage: opencode anthropic.txt essentials + CC prompts.ts ant-gated capy-v8
counterweights (verbatim source cloned at `~/z2/cc-clone`, grok at `~/z2/grok-clone`) +
grok goal templates + 2 measured failure classes; reviewed by external Fable + ralph
loop (5 fixes) + code-architect subagent (8 fixes — incl. the prompt's own
looks_done-shaped escape hatch)). Plus `harness/seed-v0.md` (2 DoD bullets, AGENTS.md).

**ASSESSMENT OF THE LIFT (calibrated, 2026-07-23 end-of-session):** the on-task effect
is real — p=0.001 pooled + p=0.02 unbiased replication kills "did nothing"; protocol
clean (fresh paired same-host arms, sha-pinned). What it does NOT yet establish, in
descending concern: (1) **scope** — n=1 task, and the prompt was FIT to this task's
failure classes then measured on fresh trials of the same task; "lifts sparql" is
certified, "improves the agent" is not (transfer to interpretation-heavy tasks est.
60-70%); (2) **guards zero** — AHE's −2.3pp system-prompt prior says the DoD-procedure
tax can hurt easy tasks; their aggregate-vs-our-single-task difference is why both can
be true; (3) **mechanism assumed** — candidate attempts ~30% slower is consistent with
the DoD procedure executing, but nobody has read the flipped trajectories; the lift
could partly be REMOVAL of anthropic.txt's 8KB rather than our content; (4) composite —
system-v0 vs seed-v0 split unmeasured. Holding "the agent improved" at ~60% until
guards + one held-out task land.

**NEXT (in order):**
1. ~~FREE FIRST — trajectory forensics on the system-gate arms~~ **DONE 07-23 (MacBook,
   zero trials). Findings:**
   - **Compliance: 17/20 candidate trials emit the numbered-requirements procedure vs
     0/20 bare** — emission is cleanly prompt-caused, not opus default.
   - **Catch event verbatim** (10-50 a2): agent found its own scope-leak DURING the
     requirement-vs-artifact check — "?country is bound with the EU filter. This is a
     bug — I must separate the condition from the output" → fixed → passed. The DoD
     procedure operates as designed, not just as upfront bias; in most other wins the
     condition/output separation appears already internalized at query-writing time.
   - **The 3 candidate fails ALL complied**: procedure executed, hand-computation
     matched dev data, still reward=0 → residual failure class = interpretation
     variants only the HELD-OUT graph discriminates (same class as TB2-v9's residual
     3/10). Procedure is necessary-not-sufficient; a held-out-thinking lesson (b7's
     core) is the matching next content, NOT more procedure.
   - **anthropic.txt-removal hypothesis WEAKENED**: 2 candidate passes without
     enumeration keep it alive as a minor term, but 17/20 emission + a verbatim
     mechanism-matched catch + bare arms' 0/20 attribute the lift primarily to added
     content. Decomposition (item 4) still worth it if cheap.
   - Bare arms: 6 wins show zero enumeration → bare passes look like lucky-correct
     interpretation draws, consistent with ~30% base rate.
2. ~~Guard screening + guard arms~~ **DONE 07-23 (MacBook) — ADOPTED. FIRST ADOPTION IN
   PROJECT HISTORY, decided by `minimal/gate.ts` (Gate-as-code, built this session: TDD
   17 tests; forensics + Fisher lift + guard non-regression + guard-less-adoption-
   forbidden encoded; reproduces both historical p-values from committed records).**
   Screens bare k=1: count-dataset-tokens PASS, chess-best-move PASS. Candidate arms
   k=3: **3/3 + 3/3 HOLD, zero voids** → `decision: ADOPT`
   (`minimal/results/adoption-1-verdict.json`). DoD-tax hypothesis not confirmed on
   these guards. **ACTIVE BASE for minimal from now on: system-v0.md + seed-v0.md.**
   Also: darwin auth ported to run.ts (Keychain export, `ab38dc7`). Caveats standing:
   n=1 target task; held-out = next item; lift arms office-host, guards MacBook
   (each internally same-host).
3. **Held-out generalization** — 1-2 interpretation-heavy TB2 tasks the prompt was NOT
   fit to, paired k=10; converts "lifts sparql" toward "improves the agent".
4. Decomposition (optional): system-v0-only arm vs assembly — attribute the 55pp
   (and test the anthropic.txt-removal hypothesis from forensics).
5. Round-2 bullet gate (scope-leak candidate) ON TOP of adopted base if 2 passes.
6. Remaining kernel: Store (versioned ledger) + Gate-as-code; question-tool disable in
   run.ts config (architect flag: prompt-only suppression = hang risk).
7. TB2 v11 gate run (previous block) still pending — untouched this session.

**RULES REAFFIRMED THIS SESSION:** explicit go before ANY token spend (violated once,
called out, memorized); questions ≠ authorization; baseline = bare fresh k=10, proposer
never feeds it; evidence-fit data can't judge its own bullet (fresh arms for verdicts).

## PREVIOUS: ⏸ SESSION END 2026-07-22/23 (MacBook) — LOOP-3 COMPLETE — active=v7 (TB2)

**2026-07-23 office-box session addendum (docs-only, all pushed HEAD `5a286d1`):**
techs.md Part-2 re-audited post loops 1–3 (lesson-lift PROVEN v9 p=0.020; gate both
directions; zero adoptions = the frontier) + NEW [`minimal-loop-ood.md`](minimal-loop-ood.md)
(7-element kernel, domain objects, 5 invariants, policy-seat roadmap — read alongside
reboot.md). No trials run this session. v11 gate run still the single pending action;
office box env (oauth/podman) unverified since 07-21 — check before launch.


**MISSION (was):** two parallel single-variable tracks. Track 1: v10 = hand-scoped b7 →
sparql k=10 + guards k=3. Track 2: wire the proposer as `bench propose-lesson`, validate
by desk-compare, zero trials.

**RESULT:** Track 1 FAILED — v10 rejected (sparql 5/10, p=0.14 uncertified; guard
configure-git-webserver 1/3 real vs 3/3 baseline; one turns=0 provider-error void trial
stripped + re-rolled). Track 2 SUCCEEDED — factory wired (TDD, 20 tests), validated by
equivalence; round-1 abstention exposed missing rule-8 re-scoping exception, fixed for
one judge call.

**ANALYSIS:** v10's scoping FIXED the sshd-blindness (trajectory-proven) but cgw is a
DOUBLE-trap: instruction says `user@server`, verifier logs in as `git`@localhost password
"password" — the retained "literal wording" clause steered agents to username `user`.
Counterweighting the poison clause is falsified; removal required. The factory dropped
that exact clause unprompted — track-1's failure retroactively validates the factory's
surgery. **Command error recorded: the `git`@localhost evidence was in hand since loop-2's
desk-check and was not used when predicting cgw recovery — evidence-possession ≠
evidence-use; rule 7b binds the human too.**

**STATE:** active=v7 (no adoption yet in project history; v8/v9/v10 all rejected with
mechanism). Snapshots v7/v9/v10 + `v11-factory-proposal.json` committed under
`term-bench2/store/global/candidates/`. Box clean. All pushed.

**NEXT (awaiting go): run v11 = the factory's own bullet through the unchanged gate**
(sparql k=10 + both guards k=3; create candidate from v11-factory-proposal.json bullet
text via the standing recipe — system.md MUST contain the bullet line, verify "Harness
assembled" chars > 394 at launch). Single variable vs v10: clause removed vs
counterweighted. Pass → FIRST adoption ever, authored end-to-end by the automated
pipeline; then score its falsify_if (first calibration data point) and proceed to loop-4
(held-out generalization). Fail on cgw with sshd built AND username correct → cgw is
triple-trapped → review its fitness as a guard (it punishes every interpretation policy).

## PREVIOUS: SESSION END 2026-07-22 — LOOP-2: v9 CERTIFIED (p=0.020) then GUARD-REJECTED — active=v7

**Forward plan + flowchart: [`docs/loop-roadmap.md`](loop-roadmap.md) (canonical roadmap).
Read [`docs/reboot.md`](reboot.md) LOOP-2 VERDICT section (bottom) first. MacBook box
clean: no tmux, no containers, active=v7 (v9 NOT adopted — guards + certification pending).
v9 snapshot committed to `term-bench2/store/global/candidates/v9/` (system.md, playbook.json,
score.json). ⚠ TOKEN WEEKLY LIMIT NEAR.**

**LOOP-2 RESULT (sparql-university k=10, MacBook):** v9 (= v7 + interpretation-enumeration
bullet b7) **7/10 vs v7's 3/10** (office, 07-21). Forensics clean (0 auth, all turns=1,
no artifacts). All 3 v9 failures show explicit lesson engagement in traj — the advisory
actuator GRIPPED this lesson (vs loop-1's ignored 7/8): grip is content-dependent, "prose
never grips" falsified. ~~Honest limits: p=0.18 cross-host~~ **SUPERSEDED same session:
the v7 same-host re-run (1/10) certified the lift — see phase A below. Remaining limit:
held-in single task (loop-4's question).**

**⏭ NEXT (in order, token-budget-gated; one manipulated variable per loop — the 07-22
discussion pruned loop-3 scope creep into the loop-3/loop-4 split below):**

**A. Certify/kill v9 first (decides every later baseline):**
1. ~~v7 re-run k=10 on the MacBook~~ **DONE 07-22: v7 = 1/10 same-host, forensics clean →
   v9 lift CERTIFIED (Fisher two-sided p=0.020 same-host; p=0.015 pooled 4/20 vs 7/10;
   host effect none, p=0.58 — MacBook trends harder). Log `loop2-v7-sparql.log`; v7
   MacBook score.json synced to `term-bench2/store/global/candidates/v7/`.**
2. ~~Guards~~ **DONE 07-22: v9 adoption REJECTED — configure-git-webserver 0/3 (office
   v0 ace 3/3), count-dataset-tokens 3/3 held. Trajectory-proven lesson cost: b7's
   "literal wording" made agents TRUST the task's false "I'll setup login" promise →
   skipped sshd the verifier secretly requires. b7 trades interpretation-overfit for
   spec-overtrust; no universal interpretation policy across graders. v7 stays active;
   v9 = certified-on-sparql, guard-rejected. See reboot.md GUARDS VERDICT.**
   → **Loop-3 target sharpened: v10 = scoped b7** (trigger on ambiguous TERMS only;
   explicit env promises still get verified — "trust but verify what the grader can
   test"). Both sparql lift AND guard must pass for adoption this time.

**B. ~~Wire the proposer~~ DONE 07-22 late:** `bench propose-lesson` shipped (TDD, 20
tests, commits `1602227`+`4a008e4`) — evidence auto-gathered (taxonomy + playbook +
`--rejected-file` + verifier sources from tbRoot + `--guards`), `--create vN` stages
INACTIVE candidates, hard 60-word/evidence≥2/falsify_if enforcement in the parser.

**C. ~~LOOP-3~~ DONE 07-22/23 (decomposed into parallel tracks per user order — see
session-end block above):** track 1 v10 REJECTED, track 2 factory VALIDATED. Verdicts in
reboot.md. Next candidate = v11 (factory-authored, clause-dropped).

**D. LOOP-4 — ONE question: does the accumulated playbook GENERALIZE?**
Held-OUT reserved set (build-pmars, cancel-async-tasks, polyglot-rust-c) — the playbook
that won two held-in gates vs baseline, nothing else changed. Property of the accumulated
playbook, not of any single lesson; deliberately NOT mixed into loop-3 (would make a null
unattributable across lesson-quality / mode-difficulty / held-out-difficulty).

**Supporting queue (slot between loops as budget allows):** pass-side traj persistence +
taxonomy-v2 divergence (feeds loop-3's proposer input); office-box v8 harness-size check
(settles loop-1's record); binding actuator DEPRIORITIZED (its premise — advisory prose
can't grip — is falsified for content-matched lessons).

**Setup trap caught this session (recipe fix):** naive `createCandidate(v0-system.md,
playbook+bullet)` SILENTLY DROPS the bullet from the assembled harness (composeHarness
faithful-render fallback → flat system.md). Correct recipe: candidate system.md must
CONTAIN the lesson line (v9 = v0 flat text + "\n- " + lesson → same flat path as baseline
arm, delta = exactly one line). Check "Harness assembled (N chars)" at launch: v0/v7=394,
v9=717. First launch was aborted for this (`loop2-v9-sparql.aborted-badharness.log`);
bad harness burned ~1 trial-minute, no store residue.

## PREVIOUS: SESSION END 2026-07-21 (night) — LOOP-1 NULL + POST-MORTEM REVERSAL; LOOP-2 = ONE TEST (v9)

**Read [`docs/reboot.md`](reboot.md) FIRST (ACTIVE PLAN + LOOP-1 VERDICT + POST-MORTEM sections
at bottom), then [`docs/proposer-lesson-prompt.md`](proposer-lesson-prompt.md). All pushed
(HEAD `95c3e8c`). Box clean: no tmux, no containers, active=v7 (v8 rolled back).
⚠ TOKEN WEEKLY LIMIT NEAR at close — loop-2 is deliberately ONE cheap test.**

**LOOP-1 RESULT (sparql-university, user-scoped single-task):** v7 3/10 vs v8 (=v7 + ORDER-BY/
determinism lesson b7) 2/10 = **PROVABLE NULL**, rolled back. Lesson ignored in 7/8 failing
trajectories. First gated verdict in project history.

**POST-MORTEM DESK-CHECK REVERSED THE DIAGNOSIS** (read reboot.md post-mortem section):
sparql verifier compares results as a SET (order IGNORED — ORDER-BY theory dead) and runs the
agent's query on a **HELD-OUT graph** with different expected answers → real failure mechanism =
**interpretation-overfit self-validated on dev data**. The taxonomy-fed lesson (interpretation-
enumeration + discriminating checks) was the RIGHT fix-class all along; the agentic run's
divergence analysis chased a dev-data confound. Meta-lesson recorded: neither proposer input
mode dominates; the free verifier desk-check beat both — **desk-check the verifier BEFORE
distilling any lesson from now on**.

**LOOP-2 = EXACTLY ONE TEST (nothing else runs first):**
Create **v9 = v7 + the interpretation-enumeration bullet** (text = the enhanced-prompt run's
proposal, saved at `/mnt/d/tmp/proposer-enhanced.json` on office box; text also quoted in
proposer-lesson-prompt.md's empirical section; VERBATIM for cross-host:
> "When acceptance depends on a term the prompt leaves ambiguous, do not treat your query reproducing your own predicted answer as confirmation. List the plausible interpretations, run checks against the raw data that would give different results under each, and pick the interpretation matching the spec's literal wording."
) → sparql k=10 under v9 (store-writing, tmux,
`META_HARNESS_HOME=$PWD/.meta-harness`, `--no-pack-measured`) → compare vs v7's 3/10.
- LIFT → lesson content was the variable; first certified win; then guards before adopting.
- NULL + lesson-ignored trajectories (grep traj for lesson language) → actuator falsified
  WITH a correct lesson → next tech = BINDING actuator (middleware/finish-hook, AHE's winner);
  prose lessons retired as an actuator.
~10 trials ≈ 20 min. Judge/proposer calls NOT needed (lesson text already exists).

**Queued AFTER v9 verdict only:** pass-side trajectory persistence + taxonomy-v2 divergence;
wire enhanced proposer prompt into propose.ts; binding-actuator build (if v9 nulls).

**⚠ OFFICE-BOX CHECK (next time it's reachable, BEFORE building the binding actuator):**
`grep "Harness assembled" <loop-1 v8-arm log>` (host-local, term-bench2/logs/ or /mnt/d/tmp/).
**~394 chars → loop-1's v8 harness never contained the lesson** (composeHarness falls back to
flat system.md when it doesn't faithfully render from the playbook — exactly the bug caught on
the MacBook 07-22, where naive createCandidate(v0 system.md + playbook-with-bullet) silently
dropped b7) **→ the "lesson ignored 7/8 = actuator weakness" finding is VOID** (confounded).
**~680+ chars → lesson rode, finding stands.** Repo evidence leans "stands": the "+290 bytes
only delta" matches a system.md-appended lesson line (playbook.json-only delta would be
~+460; bad-v9-style would be 0), and propose.ts:337/:1215 render system.md from the playbook
at write time — but the log line is the direct proof. The binding-actuator decision rests on
this finding, so confirm before investing.

**Env notes:** v7/v8 stores host-local (office box); v7 taxonomy synced to
`term-bench2/store/global/candidates/v7-taxonomy.json`. tmux-only detach rule stands.
`META_HARNESS_HOME=<repo>/.meta-harness` required for ALL store-touching commands (missing
export silently reads the ~/.config default store — bit us twice today). Guards on null
verdicts = moot, kill early (nothing to protect when not adopting).

## PREVIOUS: SESSION END 2026-07-21 (office/linux) — SCREEN COMPLETE, PLAN A MERGED, K-BOOST PENDING — RESUME HERE

**All pushed (HEAD `eda3dae`). Office box: tmux sessions closed after screen finished, orphans
reaped.** Two standing rules distilled with user this session (memory is host-local → restated
here): **(1) "I only value self improvable agent"** — every task must advance the
self-improvement loop or be deferred; **(2) distance-to-verdict rule** — tooling freeze until
loop-1 reaches a gated verdict (SPRT spec already deferred to `explicitly-not-now.md §7.5`).

**DONE this session:**
1. **Plan A SHIPPED + MERGED** (`e648a04`): `bench failure-taxonomy` subcommand (TDD, opus-reviewed
   per task, final review mergeable). Judge via `--model anthropic/claude-opus-4-8` (oauth). Field
   is `modeCounts` (renamed from plan's modeFractions — counts, divide by nClassified). Haiku
   v0/v3 taxonomies in `term-bench2/store/global/candidates/{v0,v3}/taxonomy.json`: **v3 n=19 =
   incomplete 13 / looks_done 4** — but HAIKU modes; opus fails differently (fast confident
   one-shots + long grinds), so **don't pre-commit the lesson — the v7 opus taxonomy decides**.
2. **Cat-A screen COMPLETE** (26 tasks × k=3, opus-4-8, width ~6 tmux, 78 trials, R2-audited
   clean): **BAND=10** → `term-bench2/splits/opus-band.txt` (build-pmars 1/3, cancel-async 1/3,
   path-tracing-reverse 2/3, mailman 2/3, headless-terminal 1/3, sanitize-git-repo 2/3,
   query-optimize 2/3, financial-document-processor 2/3, sparql-university 1/3, polyglot-rust-c
   1/3); **ACE=6 (guards)**: chess-best-move, configure-git-webserver, count-dataset-tokens,
   path-tracing(!), write-compressor, feal-linear-cryptanalysis; **FAIL=8** (0/3, incl 3 genuine
   3600s timeouts); **EXCLUDED=2 env-artifacts**: qemu-startup (apt `netcat` no candidate on newer
   base — qemu itself PROVEN working via TCG smoke test) + pytorch-model-recovery (opencode exits
   0.6-1.1s turns=0 ×3, agent never engaged, cause undiagnosed). Final snapshot committed:
   `term-bench2/rebaseline/opus-A-20260721.final.json`.
3. **v7 created + activated** on the OFFICE box store (content byte-identical to v0) = clean
   provenance for the opus baseline. **⚠ HOST-LOCAL — MacBook must recreate it** (recipe below).

**⏭ NEXT — K-BOOST (awaiting user go; the step that closes the loop):** store-writing run
(NO --results-file → sessions+trajectories land in the store under active v7), 10 band tasks ×
k=5 = 50 trials, est 3-6 hr (band tasks grind 30-60 min sometimes). Then: opus taxonomy on v7 →
ONE lesson → v8 candidate → **McNemar+held-out gated A/B (fixed-k; SPRT deferred) = loop-1
self-improvement verdict**. Power caveat (be honest in the writeup): 50 pairs/arm detects
~20pp+ lift; smaller real effects will read null — null is still provable knowledge (the edge).

**MacBook continuation recipe (cross-host: git + this file ONLY; store/scripts are host-local):**
1. `git pull`. Verify oauth (`claude` login) + podman.
2. Recreate v7 from the COMMITTED snapshot (deterministic — do NOT read the host-local store's
   v0, which may have drifted):
```
cd <repo> && export META_HARNESS_HOME=$PWD/.meta-harness && bun -e '
import { createCandidate, activateCandidate, activeVersion } from "./opencode-plugin/src/harness-store.ts"
const fs=require("fs"); const root=process.env.META_HARNESS_HOME+"/global"
const snap="term-bench2/store/global/candidates/v0"
const sys=fs.readFileSync(snap+"/system.md","utf8")
const pb=JSON.parse(fs.readFileSync(snap+"/playbook.json","utf8"))
createCandidate(root,"v7",sys,"",pb); activateCandidate(root,"v7")
console.log("active:",activeVersion(root))'
```
3. Launch k-boost **inside tmux** (NEVER setsid — silent-kill incident, see warning below):
```
tmux new-session -d -s kboost 'cd <repo> && export META_HARNESS_HOME=$PWD/.meta-harness && \
  bun term-bench2/runner.ts run --layers account \
  --task-file term-bench2/splits/opus-band.txt --model anthropic/claude-opus-4-8 \
  --k 5 --parallel --enforce-resources --min-cpus 2 --cpu-budget 12 --mem-budget 16000 \
  --min-agent-timeout 3600 --max-agent-timeout 3600 --host-pressure on --no-oauth-gate \
  --no-pack-measured >> <logpath> 2>&1; echo DONE_EXIT=$? >> <logpath>'
```
   (MacBook: add `PATH=/opt/podman/bin:$PATH` if needed; store-writing runs are NOT resumable —
   plan for the full run. `--no-pack-measured` mandatory: poisoned resource profiles.)
4. After: `bun term-bench2/runner.ts failure-taxonomy --layer account-global --candidate v7
   --limit 20 --model anthropic/claude-opus-4-8` (in tmux; ~90s/failure). Eyeball `modeCounts` +
   `general_mechanism` fields → distill ONE lesson → v8 = v7 + lesson bullet → ab v8-vs-v7 on
   held-in/held-out band split + ace guards. Surgical-sync v7 taxonomy.json into
   `term-bench2/store/` + commit (cross-host rule).
5. **Post-run audit before ANY band/gate math** (r2-audit is host-local — steps): grep log for
   `authentication error`; flag turns:0 trials — elapsed≈0 = setup/env artifact (EXCLUDE task),
   elapsed <60s = suspected auth-race (strip + re-roll), elapsed ≈3600s = genuine timeout (keep).
   Also check errors[] for setup_failed; results-file errors[] does NOT record agent_no_output
   (known gap).

## PREVIOUS (2026-07-21 early AM): CAT-A RE-BASELINE START (MacBook) — superseded by the block above

**The Cat-A re-baseline (26 tasks × k=3, opus-4-8, MY harness) RAN 00:20–01:20 KST on the
MacBook, then user-stopped for the commute; orphan containers reaped, machine clean.**
15/78 trials banked. **Partial results are COMMITTED (results/ is gitignored) at
`term-bench2/rebaseline/opus-A-20260721.partial.json`** (+ .log beside it).
**Banked (5 tasks complete):**
- **build-pmars 1/3 · cancel-async-tasks 1/3 → the evolvable band is REAL** (0<pass<1 on 4.8)
- chess-best-move 3/3 · configure-git-webserver 3/3 → 4.8 aces them, drop out (leaderboard pool was 4.5)
- break-filter-js-from-html 0/3 → hard even for 4.8 (capability-watch)
- count-dataset-tokens [1] partial (trial 1 pass, incomplete — re-rolls on resume)
**RESUME AT OFFICE (REVISED PLAN 2026-07-21 — speed review):** `git pull`, copy the partial back
to the live (gitignored) path:
`cp term-bench2/rebaseline/opus-A-20260721.partial.json term-bench2/results/opus-rebaseline-A-20260721.json`
then launch (office/linux: no `PATH=/opt/podman/bin` prefix; fresh oauth; `--no-oauth-gate` per
standing ruling). **Changes vs original: (a) width 2→4** (`--min-cpus 2 --cpu-budget 12` — trials
are LLM-latency-bound per cgroup data; ~3hr→~1.5hr), **(b) on-thesis-first task ordering**
(`opus-candidates-A-ordered.txt` — count-dataset re-roll + db-wal/path-tracing×2/openssl first) so
first failures land ~30min in → **start taxonomy DURING the screen** (pipeline overlap = the real
cadence win):
```
META_HARNESS_HOME=<repo>/.meta-harness bun term-bench2/runner.ts run --layers account \
  --task-file term-bench2/splits/opus-candidates-A-ordered.txt --model anthropic/claude-opus-4-8 \
  --k 3 --parallel --enforce-resources --min-cpus 2 --cpu-budget 12 --mem-budget 16000 \
  --min-agent-timeout 3600 --max-agent-timeout 3600 --host-pressure on --no-oauth-gate \
  --no-pack-measured \
  --results-file term-bench2/results/opus-rebaseline-A-20260721.json --resume
```

**⚠ CODE-ARCHITECT REVIEW (2026-07-21, applied — GO-WITH-CHANGES):**
- **B1 (BLOCKER, fixed):** `--resume` marks a task done on ANY non-empty rewards (`results.ts`
  resumeCarryForward) — partial tasks are FROZEN, never topped up. The earlier "re-rolls on
  resume" claim was FALSE. Fix applied: stripped `count-dataset-tokens` (1/3) from the live
  results copy → clean fresh k=3. If pausing mid-run again: strip ALL partial tasks on resume.
- **R1 (fixed via `--no-pack-measured`):** host resource-profile
  (`resource-profiles/x64-8c-…-i5-14400.json`) is POISONED — 8 tasks with impossible avgCpu
  (openssl 98, extract-elf 127, sqlite-with-gcov 235 "cores"; all peakRssMb=0) from a
  WSL2/rootless-podman shared-cgroup read bug. Without the flag, packer runs those tasks SOLO
  (width 1). Cross-cutting: load-aware-scheduler's captured data on this host = garbage until the
  cgroup read is fixed; packer-flip increment blocked on that.
- **R2 (post-run audit, DO IT before computing the band):** auth-race trial = silent reward=0
  with `error:"agent_no_output"`, indistinguishable in results.json. Grep run log for
  `authentication error` (AUTH_FAIL_MARK) + flag any `turns:0` with anomalously LOW elapsed
  (genuine 0-turn burns retries/timeout; auth-fail returns instantly). Manually re-roll matches.
- **Methodology note:** k=3 screen false-excludes a p≈0.5 task 25% of the time (3/3 or 0/3 by
  variance) and it's never revisited — accepted bounded blind spot, traded for speed.
**Speed-review verdicts (don't relitigate):** width 6 = HOLD (build-heavy tasks can contend on
8-core WSL2; resource-starved trial = FAKE band member → polluted band costs a whole loop
iteration; check measured cgroup load after this width-4 run first). Adaptive-k screen = SKIP
(real saving ~15% not ~half — 1/1 pass is worthless ace evidence, needs confirm trial anyway).
SPRT/sequential McNemar for the recurring GATE stage = YES but needs a small pre-registered-
boundaries spec + tests first (ad-hoc peeking inflates alpha = torches our one claimed edge);
spec it while screens run. Two-host split = reserve. "Overnight" premise was WRONG: 62 trials ≈
3hr at width 2 (MacBook measured 15 trials/hr).
AFTER the run: keep `0<pass<1` tasks = evolvable band → failure-taxonomy → memory/risk-hints
lesson → inject → McNemar + held-out gate (band k≥5; screen k=3 is provisional). Copy completed
results back into `term-bench2/rebaseline/` + commit so they transfer across hosts.

## SESSION END 2026-07-20 (PM) — opus test done + leaderboard pivot (context for the run above)

**Prior AM session context preserved below (AHE pivot, Plan A, detection+haiku prototypes).**
This PM session: ran the pending **opus improvement test**, then a **course-correction** off the TB2
leaderboard (user pushed for playwright ground truth). Net: **openssl is a bad target; the real
target is a leaderboard-derived candidate band.** New artifacts committed under repo.

**1. OPUS improvement test (openssl, k=2) = DIRECTIONAL LIFT but discarded as artifact.**
`baseline 0/2 → +lesson 1/2` (all turns=1; opus one-shots too). Contrast haiku 0/2→0/2. Looked like
the pivot's cross-model win — BUT n=2, and then the leaderboard showed it's a **harness-deficiency
artifact**, not a strong-model lift. Did NOT scale k (killed the k=10 run mid-flight). Log:
`/mnt/d/tmp/opus-improve-20260720.log`.

**2. LEADERBOARD PIVOT (`docs/2026-07-20-opus-candidate-tasks.md` — READ IT).** Scraped 2 TB2 2.0
entries via playwright (WebFetch summary was WRONG on several tasks — use playwright):
- **OpenCode / Opus-4.5 / 51.7% / 1-trial** = my-harness family (driver=opencode). openssl = **0/1 FAIL**.
- **WOZCODE / Opus-4.7 / 80.2% / 5-trial** = strong-harness ref. openssl = **5/5 PASS**.
- **Headline: opencode 51.7% vs wozcode 80.2% = same model class, ~28pp gap ≈ ALL harness/workflow.
  THAT gap is the research target.** openssl = 1 of 26 such tasks (workflow-fixable, not capability).
- **Candidate band** (opencode-FAIL ∩ wozcode-rate): **Cat A = 26 tasks** (wozcode ≥80%, HIGH
  headroom) → `term-bench2/splits/opus-candidates-A.txt`; **Cat B = 9** (wozcode 20-60%, partial) →
  `opus-candidates-B.txt`; **SKIP = 8** (wozcode <20%, capability-bound = the haiku trap).
  Detection-proto's 3 tasks (openssl, db-wal-recovery, path-tracing) all ∈ A = validates.

**⏭ NEXT (resume here) — OPUS-4.8 RE-BASELINE of Category A (user was about to approve/trim).**
Run opus-4.8 across the 26 Cat-A tasks (k≥3-5) in MY harness → **keep tasks landing `0 < pass < 1` =
the evolvable band** (opus-4-8 > 4.5 → some A may now pass unprompted; 1-trial leaderboard = noisy
POOL, not final band). Then: failure-taxonomy → distilled lesson (memory/risk-hints) → inject →
**McNemar + held-out gate** (our edge). Open question user raised: trim A to ~12 (drop crypto/build-
heavy) vs run all 26 (~2hr detached). Recipe below.

**Re-baseline command (detached, per CLAUDE.md host-local caveat):**
```
META_HARNESS_HOME=<repo>/.meta-harness bun term-bench2/runner.ts run --layers account \
  --task-file term-bench2/splits/opus-candidates-A.txt --model anthropic/claude-opus-4-8 \
  --k 3 --parallel --enforce-resources --min-cpus 2 --max-agent-timeout 3600 --results-file <out.json>
```
(or reuse the throwaway `runTaskOnce` harness from the improvement recipe below, looping the A list.)

**Prior prototypes (AM, throwaway in HOST-LOCAL `/tmp` — recreate from recipes below):**
1. **DETECTION = WORKS.** AHE root-cause taxonomy (opus-4.8 judge via oauth, `runJudgeOpencode`) on
   3 real v0 failing traj: openssl→`looks_done`, path-tracing→`other` (time-mgmt/incomplete), db-wal→
   `looks_done`. Root causes accurate; **`general_mechanism` field = ready-made memory lessons** (the
   pivot's Component 2). Refinement: add an `incomplete`/time-management mode to the seed schema.
2. **IMPROVEMENT (haiku) = NO LIFT.** openssl on haiku, baseline vs +lesson (lesson = the taxonomy's
   own `general_mechanism` "re-read every produced file vs every literal requirement"), k=2 each →
   **baseline 0/2, +lesson 0/2, no change** (all turns=1 — haiku one-shots + ignores the lesson).
   Evidence FOR the opus pivot: a distilled lesson doesn't lift a capability-bound one-shot model.
   (Superseded framing: opus 0/2→1/2 later shown to be harness artifact — see #1/#2 above.)

**Prototype recipes (recreate the host-local scripts):**
- *Detection:* bun script importing `readTrajectory` + `renderJudgeAuditEvents` (bench/judge-audit.ts,
  both exported) + `runJudgeOpencode` (bench/opencode-run.ts); build the taxonomy prompt (Plan A Task 1
  in the failure-taxonomy plan); judge=`anthropic/claude-opus-4-8`; run on `.meta-harness/global`
  candidates/v0 failing traj/*.ndjson.
- *Improvement:* bun script importing `runTaskOnce` (bench/cmd-run.ts) + `makeBenchPaths` (bench/paths.ts,
  `{tbRoot:"~/z2/terminal-bench-2"}`) + `assembleAgentsMd` (bench/record.ts) + `taskTimeouts` (bench/tasks.ts).
  baseline harness = `assembleAgentsMd("account", paths.metaRoot, "", {}, model)`; +lesson = baseline +
  the `general_mechanism` text. `runTaskOnce(paths, task, model, "", harness, agentTimeout, verifierTimeout)`;
  model=`anthropic/claude-opus-4-8`; k≥2; compare `.reward`. `META_HARNESS_HOME=<repo>/.meta-harness`;
  needs oauth (`claude` login) + podman; reap `mh-*` orphans between; Bash-tool 2min cap → run detached.
  **⚠ DETACH = tmux ONLY (2026-07-21):** setsid-detached runners get SILENTLY KILLED mid-flight
  (screen died ~35min in, taxonomy judge ~5min in; no OOM, no API error; orphan containers mask it
  as "slow trials"). Launch long runs as `tmux new-session -d -s <name> "<cmd> >> <log> 2>&1"`.
  After any mid-run death: strip partial (rewards.length<k) AND empty-array tasks from the live
  results file before `--resume` (B1 freeze trap).

## ➡️ NEXT DIRECTION (2026-07-20) — READ THIS FIRST: harness-evolution, Opus 4.8 base, memory/risk-hints first

**⚠️ 2026-07-20 PIVOT (AHE prior-art — [`docs/2026-07-20-ahe-prior-art.md`](2026-07-20-ahe-prior-art.md), our exact problem, #3 on TB2):**
(1) **base agent haiku → Opus 4.8** (haiku capability-bound = no harness headroom; AHE's gains came on a strong model → re-baseline v0 on opus);
(2) **first evolvable component → memory (boundary-case lessons) + risk-hints middleware** (AHE ablation winners; NOT verify-retry — AHE's `ralph_loop` lost — NOT prompt — regressed −2.3pp).
Our **statistical gate stays the edge** (it's the regression-blindness AHE names as its #1 limit). Adopt: four-field predict-and-falsify contract (as gate-power/calibration input), one-component-per-edit, k≥2, AHE's Agent-Debugger root-cause taxonomy. Workflow-loop spec's Component-1 (taxonomy) + machinery still valid; Component-2 verify-retry DEFERRED. Next: Plan A (taxonomy, AHE method) → re-baseline on opus → spec+build the memory/risk-hints component.

**Full doc: [`docs/2026-07-20-next-direction.md`](2026-07-20-next-direction.md)** ·
**deep-research report (24/25 confirmed, peer-reviewed): [`docs/2026-07-20-deep-research-failure-analysis-workflow.md`](2026-07-20-deep-research-failure-analysis-workflow.md)** — validates the pivot: failure-taxonomy as MODE classification (MAST 94%, not step-attribution ~14%); workflow>prompt on a fixed model (Agentless, DirectSolve CoT 9→32%, best-of-N +15); the looks-done gap is named (Huang ICLR24 intrinsic self-correct degrades; gate on executable ground truth).

The loop is **validated** (correctly rejects — v3 killed after held-in: 2 pass-regressions,
0 improvement, speed-only win on a tie → negative delta blocked the tiebreak; active stays
**v0**). But the **target has no headroom**: bench = **opencode+haiku, minimal config, NO
MCP, NO CC** (verified live) → our playbook is a thin veneer on an already-capable agent →
v0–v3 = **0 pass-lift.** Stop tuning prompt-bullets.

**Pivot (concrete, in the doc):**
1. **Failure taxonomy — no new runs.** Read `candidates/vN/traj/*.ndjson`; classify each
   failing task: spec-precision / capability / comprehension. VERIFIED example:
   openssl-selfsigned-cert = **spec-precision, workflow-fixable** (haiku had the required
   values in `instruction.md`, dropped them, self-verified against its own interpretation;
   a passive prompt bullet didn't fix it — advice ≠ enforcement).
2. **Optimize WORKFLOW, not playbook** — enforced verify-retry loop / extract-spec
   checklist / tool-feedback / best-of-k. Structure changes outcomes; bullets don't.
3. **OR change target for headroom** — raw model / stronger model (haiku→sonnet) / routing.
4. **Cheapest gate before v4:** no-injection vs v0 diagnostic (if equal, the playbook does ≈0).

Reframe: on a near-ceiling target the loop's honest output = convergence + speed +
not-regressing, NOT pass-lift. The validated **machinery is the asset** — point it at real
mass, not feathers.

---

## ➡️ K=5 AB PAUSED MID-FLIGHT (2026-07-19 ~22:00 KST) — RESUME HERE (SUPERSEDED — v3 rejected, ab killed 07-20; see NEXT DIRECTION above)

**The v3-vs-v0 k=5 `--speed-tiebreak` ab ran 19:20–~22:00 KST 07-19, then was STOPPED
(user); orphaned containers reaped; partial is resume-compatible.** State =
`candidates/v3/ab-verdict.partial.json` (status in_progress).
**Banked: constraints-scheduling 5/5 pairs — BOTH arms 5/5 pass** (pass-tie; v3 slightly
faster on most pairs — speed-tiebreak fodder). In-flight pairs were lost to task-level
resume granularity (db-wal was at pair 5/5, distribution-search mid, path-tracing +
tune-mjcf grinding 1h-timeout pairs — those two are the wall-clock bottleneck: several
quiet-machine hours for held-in, more for held-out ×10).
**RESUME (exact, this Mac):**
`META_HARNESS_HOME=<repo>/.meta-harness PATH=/opt/podman/bin:$PATH bun term-bench2/runner.ts ab \
 --layer account-global --candidate v3 --split-file term-bench2/splits/loop1.json \
 --model anthropic/claude-haiku-4-5 --k 5 --parallel --enforce-resources --min-cpus 2 \
 --cpu-budget 4 --mem-budget 7000 --min-agent-timeout 3600 --max-agent-timeout 3600 \
 --host-pressure on --speed-tiebreak --resume --no-oauth-gate`
(idle machine preferred — shared 1.4GB opencode.db makes bootstrap load-sensitive;
casualty discipline per memory `no-token-expiry-engineering`: rotation-straddling
containers 0-turn — re-roll them, never build prevention.)

## K=5 AB LAUNCH CONTEXT (2026-07-19 evening) — three-way settled: NO v3 regression

**Three-way k=1 reference (same-day, all-real-attempts, after casualty re-runs): v3 5/14
(passElapsed 2231s) > v0-TODAY 4/14 (1963s) > v2 3/14 (2401s).** Yesterday's v0 8/14 was
day-variance (v0 itself dropped to 4/14 today) — NO v3 regression; v3 also uniquely passes
large-scale-text-editing (521s; v0's real attempt today failed at 2138s). Screen-favor
condition MET → **k=5 `--speed-tiebreak` ab LAUNCHED** (log
`term-bench2/logs/ab-v3-k5-20260719.log`, partial in `candidates/v3/ab-verdict.partial.json`,
chunk via `--resume`; recipe = (c) below + `--no-oauth-gate`). Casualty discipline:
rotation-straddling containers 0-turn — just re-run them (memory
`no-token-expiry-engineering`). tune-mjcf note: 0-turned/timed-out for ALL versions today —
watch it in the ab.

## SCREEN VERDICT (2026-07-19 afternoon) — v3 ADVANCES (5/14 vs v2 3/14, clean)

**(a)+(b) DONE.** v3 proposed (opus, off honest evidence: dropped v2's 2 bullets as harmful,
added read-the-on-disk-spec + never-declare-done-with-unmet-criteria; synced to store
snapshot). Screen tournament v2-vs-v3 (k=1, loop1 band, `--no-oauth-gate`) FINAL after
infra-noise re-runs (6 tasks re-run: 5×v2 + 1×v3 — morning casualties from a CC-token
rotation race killing pre-rotation containers + load-100+ starvation 0-turns; all patched
into `results/screens/account-global/*.json` [gitignored] with rerunNote):
**v3 5/14 (passElapsed 2231s) > v2 3/14 (2401s)** — v3 wins pass count AND speed.
v3 passes: sqlite-with-gcov 158s · merge-diff 188s · constraints-scheduling 164s ·
**large-scale-text-editing 521s (v0 TIMEOUTs this at 4264s!)** · distribution-search 1200s.
Screen ≠ verdict (k=1): absolute rates not comparable to v0's 8/14.
**NEXT = (c): k=5 `--speed-tiebreak` ab for v3** (recipe below; add `--no-oauth-gate`;
run on an IDLE machine — the 1.4GB shared opencode.db makes container bootstrap
load-sensitive: ~1min quiet vs ~10min under load; USER RULING: no token-expiry
engineering, opencode handles refresh; re-run casualties instead).

## CURRENT STATE (2026-07-19) — ENV FIXED · v0 RE-BASELINED HONEST 8/14 · loop unblocked

**Merged + pushed, tip ≥ `1f77f11`. Suite 1503/0/1 skip.**
1. **Env-leakage FIXED** (`dfb2f4b..9440391`): agent containers get NO `/tb`/`/mh` mounts and
   no `TB_ROOT`; staging + verifier tests + patches via rc-checked `podman cp` (stage-then-
   purge); `rm`/`find -delete` Dockerfile lines now EXECUTE (best-effort; apt-cache cleanup
   still dropped). Oracle path unchanged + test-pinned. Live-verified: oracle path-tracing
   PASS ×2; container probe /tb absent, orig.c deleted. copyTests failures now surface as
   setup_failed (never silent reward=0).
2. **v0 RE-BASELINED on the honest env: 8/14 (57.1%)** — was 12/14 (85.7%) inflated. Leakage
   predictions CONFIRMED: db-wal-recovery FAIL(442s), path-tracing FAIL(1832s). Other deltas
   (k=1 noise vs real): write-compressor TIMEOUT(3658), large-scale-text-editing
   TIMEOUT(4264), llm-inference-batching-scheduler FAIL(1360) — all former passes;
   extract-elf FLIPPED TO PASS(741s); openssl-selfsigned-cert FAIL (consistent). Old
   baseline backed up: `.meta-harness/backups/v0-pre-envfix-20260719/` + git history.
   Store synced+pushed (`1f77f11`). NOTE: post-envfix sessions distinguishable by env
   pluginSha stamp; pre-envfix data must not mix into rates.
3. **NEXT (loop unblocked, honest instruments) — exact recipes, this Mac:**
   (a) **Propose v3**: fresh traj evidence is thin post-reset (score has 14 new sessions but
   traj pruning applies) — proposer reads score + traj under `.meta-harness`; start opencode
   in the repo, `/mh-propose account` → verify a NEW vN ≠ v0 in
   `.meta-harness/global/candidates/`. Proposer now sees the 6 honest fails (incl.
   ex-leakage db-wal/path-tracing), SLOW-PASS markers, and v1/v2's rejected history.
   Optional: enable the external-evidence seam first (config `externalEvidenceDir:
   "evidence/tb2-leaderboard"` + distill per docs/tb2-evidence-mining.md — held-in only).
   (b) **Screen tournament (k=1, cheap)**:
   `META_HARNESS_HOME=<repo>/.meta-harness PATH=/opt/podman/bin:$PATH bun term-bench2/runner.ts \
    screen --layer account-global --candidates v2,v3 --task-file term-bench2/splits/loop1-band.txt \
    --model anthropic/claude-haiku-4-5 --parallel --enforce-resources --min-cpus 2 \
    --cpu-budget 4 --mem-budget 7000 --host-pressure on \
    --min-agent-timeout 3600 --max-agent-timeout 3600`
   (explicit timeout envelope REQUIRED — oauth+parallel pre-flight errors without
   `--max-agent-timeout`, and hard-rejects if the token has < max-agent-timeout+5min left.
   USER RULING 2026-07-19: add `--no-oauth-gate` — the host auto-rotates the token during
   active CC/opencode use, so the freshness gate is over-strict; the flag skips the
   pre-flight + launch-guard (oauth gates like key-auth). Prints ADVANCE line; store
   never written.)
   (c) **Winner → k=5 verdict ab** (needs fresh oauth; freshness gate is task-item-level —
   see pt-4 learnings; prefer starting on a fresh ~8h token):
   `... runner.ts ab --layer account-global --candidate <winner> --split-file
    term-bench2/splits/loop1.json --model anthropic/claude-haiku-4-5 --k 5 --parallel
    --enforce-resources --min-cpus 2 --cpu-budget 4 --mem-budget 7000
    --min-agent-timeout 3600 --max-agent-timeout 3600 --host-pressure on --speed-tiebreak --resume`
   (~24-40h on this Mac — chunk across days via --resume, or office box when available.)
   (d) **Phase-6 loop2 curation now legal**: full 75-sub matrix in git
   (`term-bench2/leaderboard/matrix.json`); follow plan Phase 6 (band probe with the NEW
   honest rates → curate-band → `split make ... --split-file term-bench2/splits/loop2.json
   --sentinels 3`; set MhConfig.activeSplitFile when loop2 goes live).
   Caveats: v2's old k=2 screen verdict (inconclusive-negative) AND all pre-envfix evidence
   are old-regime — never mix into rates; k=5 remains the only verdict grade
   (memory `k5-verdict-standard`).

(pt-5 and older blocks below are HISTORICAL.)

## CURRENT STATE (2026-07-18 pt 5 — HISTORICAL; env since FIXED + re-baselined, see 07-19 block) — VELOCITY LEVERS MERGED · ENV SOFTNESS FOUND · v2 screen NEGATIVE

**Everything MERGED + PUSHED to main (tip ≥ `69b4ff0`). Suite 1486/0/1 skip, both tscs clean.**
Built via subagent-driven dev off the 3×-architect-reviewed plan
(`~/.claude/plans/plan-to-follow-your-purrfect-diffie.md`); every phase task-reviewed to
Approved; final whole-branch review MERGE-READY. Ledger: `.superpowers/sdd/progress.md`.

**Shipped (all default-off / additive; NOT budget-identity changes):**
1. **Time-to-resolve metric** — agent-phase elapsed (agentElapsedSec on every completion
   path) → ab `candidateElapsed/activeElapsed` arrays → `speed` block in verdict/meta-metrics/
   report-loop (`pairedSpeedStats`: both-pass pairs only, median of per-pair ratios, exact
   sign test). SLOW-PASS proposer marker + section. **`--speed-tiebreak`**: guarded
   inconclusive→accept upgrade (structural: ho!==null excl. legacy, !earlyStopped, delta≥0,
   nPairs≥8/p≤.05/ratio≤.8); part of the standard k=5 recipe going forward.
2. **`bench screen`** — k=1 candidate tournament (layer-scoped outDir + provenance stamp,
   passing-only elapsed tiebreak, parallel+floor threading, error isolation). Winner → k=5 ab.
3. **Leaderboard tooling** — `term-bench2/leaderboard/pull-leaderboard.ts` (all-76 sweep,
   atomic resumable cache) + pure `src/bench/leaderboard.ts` curation (harnessVariance,
   minSubs=4 floor) + curate-band driver. NOTE: committed matrix.json is a 2-sub placeholder;
   the full sweep was RUNNING in background at session end — on completion run
   `bun pull-leaderboard.ts --merge` + commit matrix/submissions.
4. **traj-replay helper** (`extractShellCommands`, truncation-flagged, newline-safe) +
   **external-evidence seam** (`evidence/tb2-leaderboard/`, MhConfig.externalEvidenceDir +
   activeSplitFile, LIVE held-out contamination guard, index-only UNTRUSTED injection after
   the L1 guard, cwd-independent path resolution). Distill procedure: docs/tb2-evidence-mining.md.

**🚨 ENV-FIDELITY VERDICT (docs/env-fidelity-spotcheck.md): `untrusted` — the bench is SOFT.**
Our db-wal-recovery + path-tracing passes are ENVIRONMENT LEAKAGE, proven by official-image
replays (both failed): (1) `cmd-run.ts:212` mounts the whole task source RO at `/tb` — agents
read fixtures/answer material; (2) `staging.ts` drops `rm`-only RUN lines, so answer-key
deletions (e.g. path-tracing `rm /app/orig.c`) never happen. **Consequences: v0's 12/14
baseline is partially inflated; leaderboard-fail band picks gated untrusted; loop2/Phase-6
curation BLOCKED. USER DECISION needed: fix the two bugs (small, localized) → re-baseline v0
(measurement-regime change) → then loop2.**

**v2 k=2 SCREEN — FINAL (test-grade, k=2): inconclusive-NEGATIVE.** Full held-in 7 tasks:
b=0/c=3 all favoring v0 (v2 lost prove-plus-comm 0/2, tune-mjcf 1/2 — tune-mjcf REVERSED vs
the earlier discarded chunk; haiku variance is huge = the k=5 argument). Held-out never ran
(freshness gate). Speed signal consistent: v2 much faster on tie pairs (e.g. tune-mjcf 485s vs
2536s). **k=5-confirm condition ("screen favors v2") UNMET — do NOT k=5 v2.** Recommended:
`/mh-propose` v3 off this evidence (proposer now sees SLOW-PASS + rejected verdicts; env
evidence optional via the new seam), then `bench screen` v2-vs-v3(-vs-v4), winner → k=5
`--speed-tiebreak` ab — AFTER the env fix + re-baseline above.

**Deferred/open:** env-bug fix + re-baseline (USER DECISION, blocks loop2) · full-sweep
--merge + commit · Phase-6 loop2 split (blocked) · trajectory distillation (manual,
docs/tb2-evidence-mining.md) · host-sharded abs · Axis-2 vendor leg (openrouter =
oauth-TTL-free too) · pressure-threshold default-flip · capture-cap raise for replayability
(300-char args made write/edit trajectories unreplayable).

## CURRENT STATE (2026-07-18 pt 4 — HISTORICAL; ab finished as k=2 screen, see pt 5) — (b) ab LIVE, 4/7 held-in banked · resume at home

**The (b) ab (v2 vs v0) is MID-FLIGHT.** Ran at the office in two chunks (05:35–06:52 and
07:06–08:40 UTC), stopped cleanly for the commute. State =
`.meta-harness/global/candidates/v2/ab-verdict.partial.json` (status `in_progress`, ident
`minAgentTimeout:3600` + `env.resourceEnforcement:true` — resume-compatible with the recipe
below by construction). Doc-only commit; code tree unchanged from pt 3, suite untouched.

**Banked (4/7 held-in, k=2):** constraints-scheduling A[1,1]/B[1,1] · path-tracing A[1,1]/B[1,1]
· distribution-search A[1,0]/B[1,0] (pair-2 both-arm genuine fails) · db-wal-recovery
A[1,1]/B[1,1]. All ties so far in banked data.

**Headline (in DISCARDED work):** tune-mjcf pair 1 = **v0 FAIL(1197s) / v2 PASS(2867.6s)** —
a discordant c=1 for v2, now **2-for-2 across attempts** (the aborted no-floor run also had v2
winning its only discordant). The pass took 2868s — impossible under the old 900s TB2 cap;
the 1h floor bought it. The task was mid-pair-2 at the departure stop → whole task re-rolls
(task-level resume granularity keeps only all-k-pairs-complete tasks). If real, it reproduces.

**RESUME AT HOME:** exact pt-3 recipe below + `--resume` (skips the 4 banked tasks). Token
fresh until **15:02 UTC** (midnight KST) — NO login needed tonight. Remaining: tune-mjcf,
prove-plus-comm, openssl-selfsigned-cert (held-in), then held-out ×10. Re-arm the monitors
(completion + pressure watchers, resource sampler). See memory `ab-v2-chunk-state`.

**Live validation of this week's shipped features (all confirmed on real runs):**
- **Measured packing → width-3** on the 4-CPU VM from the first scan (pt 0.86c + cs 0.88c +
  cold 2c = 3.74/4 packed; declared-int would have pinned width-2). `[pack] measured` lines live.
- **1h floor changed outcomes**: pt arm A passed at 1810.5s (past its 1800s TB2 cap) and the
  tune-mjcf 2868s pass above. Also the first HONEST recorded timeout: tune-mjcf v0-arm
  3600s/reward=0 in chunk 1 (then a 1197s genuine fail on the re-roll — haiku variance).
- **`--host-pressure on`: ZERO false pauses** across observed load 0.3–3.4/core (sampler CSV
  `term-bench2/logs/loop1-ab-v2.resources.log`). First calibration point for the default-flip.
- Profile store warmed further (ds/db-wal/tune-mjcf samples added) — packing gets more measured
  next run.

**Discoveries / follow-ups (new):**
- **`canLaunch` freshness gate is task-ITEM-level** (`scheduler.ts` — checked per scan for NEW
  items only): a k=2 ab task = up to 4 sequential sessions, so in-flight tasks STRADDLE token
  expiry. Tonight's mitigation = kill the chunk before the ~5-min pre-expiry refresh window
  (a straddling container's plugin could race the host refresh with the copied refresh token).
  FOLLOW-UP: per-arm/per-session canLaunch check.
- **"No locking in CC" is STALE**: the reconstructed CC source (github
  yasasbanukaofficial/claude-code) shows host CC refresh uses a proper-lockfile on `~/.claude`
  + post-lock re-read + race recovery. Host-side concurrent sessions are SAFE; the real
  remaining race is container-copy divergence (darwin Keychain export can't write back).
  Correct `agent-auth.ts` header + `auth-delegation-design.md` when convenient. Also: refresh
  fires only within ~5 min of expiry (`isOAuthTokenExpired` buffer) — any active session
  rotates it automatically at that point; a Keychain `expiresAt` watcher is a clean launch
  trigger (used tonight, worked).
- ab-verdict gap noted: an all-4-transient-retries or gate-slipped auth 0-turn session pushes
  reward 0 into the VERDICT (store self-protects, verdict doesn't; only `setup_failed`
  excludes). Remedy = delete the task from `taskResults` in the partial + `--resume`.
  `retry-provider.ts` wrapper exists for sustained provider outage (tonight ran unwrapped).

**Deferred/open (unchanged from pt 3):** (d) Axis-2 vendor content + panel — note a keyed
openrouter/xai/etc. leg would ALSO kill the whole oauth-TTL fragility class (needs its own
model re-baseline first); host-class stamping; sensor stale-cache nit; pressure-threshold
default-flip; capRaised-into-TaskFootprint; per-arm canLaunch (above).

## CURRENT STATE (2026-07-18 pt 3 — HISTORICAL; the (b) ab is now LIVE, see pt 4) — #3 SHIPPED · v0 baseline KEPT · next = the (b) ab

**Everything PUSHED — tip ≥ `969f418`, tree clean** (this block commits after). Suite **1367 / 0
fail**. No background runs; no orphan containers; podman machine still up.

**Session outcomes since pt 2:**
1. **v0 re-baseline SKIPPED — USER RULING**: no session in v0's baseline was time-clipped
   (max elapsed 789s vs 900s budget; both fails genuine completions), so a 1h floor changes
   nothing → the 14-session Linux baseline is outcome-equivalent and KEPT. Consequence: v0's
   stamps are floor-absent while new runs stamp `minAgentTimeout:3600` → **`/mh-activate` will
   flag identity mismatch — use `--force`** with this rationale.
2. **Load-aware #3 SHIPPED + MERGED** (`26fb293..969f418`): `--host-pressure observe|on` — see
   the pt-2.5 block below for full detail. LIVE-SMOKED: real-spike pause/resume cycle PASS.
   Final review caught 1 BLOCKER pre-merge (unref'd pause timer → silent process exit;
   fixed + subprocess regression test).
3. **First (b) ab attempt #2 ABORTED for host load** (loadavg 149 — the episode that motivated
   #3). Partial evidence before abort: 4 pairs consumed, **candidate v2 led c=1/b=0** (won the
   path-tracing discordant pair; tune-mjcf F/F both-arm timeouts under the OLD no-floor
   envelope). Aborted partial set aside as
   `candidates/v2/ab-verdict.partial.superseded-no-floor.json` — do NOT resume it (identity
   mismatch, correctly rejected).
4. **v2 candidate synced into the git snapshot** (`term-bench2/store/global/candidates/v2/`,
   surgical) — v2 = v0 + 2 proposer bullets targeting the spec-misread fails (derive
   under-specified formats from task text; verify against stated criteria, not self-checks).

**NEXT SESSION = run the (b) ab, updated recipe (this Mac):**
```
# fresh oauth first: claude, login, ctrl-D (freshness gate needs token > 1 task)
META_HARNESS_HOME=<repo>/.meta-harness PATH=/opt/podman/bin:$PATH bun term-bench2/runner.ts ab \
  --layer account-global --candidate v2 --split-file term-bench2/splits/loop1.json \
  --model anthropic/claude-haiku-4-5 --k 2 --parallel --enforce-resources \
  --min-cpus 2 --cpu-budget 4 --mem-budget 7000 \
  --min-agent-timeout 3600 --max-agent-timeout 3600 \
  --host-pressure on --resume
```
- `--min-agent-timeout 3600` = the 1h/task floor (user's loosest-envelope ruling — budget-identity
  `{max:3600, min:3600, timeoutRecording:true, resourceEnforcement:true}`).
- `--host-pressure on` = the new gate; the run coexists with laptop use (launches pause under
  real host pressure, resume on recovery). First real run doubles as threshold calibration —
  watch `[pressure]` lines for false pauses. Daytime alternative: `--cpu-budget 2`; or run
  overnight / on the office box (v2 is in the git snapshot now; office would cold-start
  profiles + floor matters less there).
- Profiles are warm on this Mac (cs n=4, pt n≥3 → measured packing + raised caps kick in at
  start — expect the `[pack] measured` lines and possibly width-3).
- On accept: `/mh-activate account v2 --force` (identity mismatch is adjudicated — see #1),
  then SURGICAL sync of v2 (incl. new score/verdict) into `term-bench2/store/` + push.
- Also new since pt 2: **on-host sensor sanity** `cd opencode-plugin && bun -e
  'import {createHostPressure} from "./src/bench/host-pressure.ts"; const
  hp=createHostPressure({}); console.log(hp.underPressure(), hp.state())'`.

**Deferred/open (unchanged):** (d) Axis-2 vendor content + panel; host-class stamping of score
sessions (cross-host mixing); sensor stale-cache-after-error nit; `--host-pressure` threshold
calibration then default-flip; `capRaised`-into-TaskFootprint cleanup.

## CURRENT STATE (2026-07-18 pt 2 — HISTORICAL; re-baseline was SKIPPED per ruling above) — TIMEOUT FLOOR shipped

**USER CORRECTION (recorded as feedback memory):** the standing decision is **1 hour per task**
(loosest envelope; load-aware scheduling compensates) — NOT TB2-exact budgets. The code's
cap-only-lowers semantics (`min(TB2, --max-agent-timeout)`) was a design misreading: on this
3×-slower 4-CPU VM, TB2 budgets are artificial limits → live-observed tune-mjcf 0-for-4 timeouts
at 900s (Linux passed in 267s) during the first (b) `ab` attempt.

**Shipped: `--min-agent-timeout` floor** (`248fe8f` + fix `d22ecb0`, suite 1327/0): effective
per-task agent time = `min(max(TB2, floor), cap)` — time-domain mirror of `--min-cpus`. Floor
threaded through ALL budget-identity sites (env stamp, ab verdict + resume-ident, T6/T7 tuple,
/mh-activate gate); absent=0 keeps old records comparable. Verifier stays TB2-exact. Review
caught a CRITICAL before merge: cmd-ab never passed the floor to taskTimeouts (stamped-but-inert
on the ab path) — fixed + execution-tested.

**Budget-identity is now `{maxAgentTimeout:3600, minAgentTimeout:3600, timeoutRecording:true,
resourceEnforcement:true}`** → the Linux v0 baseline (floor-absent, and host-mismatched anyway) is
superseded. **Re-baseline #2 runs ON THIS MacBook** (v0 score reset per the established
procedure; old baseline preserved in git history): 14-task band, k=1, parallel,
`--min-agent-timeout 3600 --max-agent-timeout 3600 --enforce-resources --min-cpus 2 --cpu-budget 4
--mem-budget 7000`. This also warms the resource-profile store → measured packing kicks in for
the subsequent ab re-run (v2 vs re-baselined v0).

**Aborted first (b) ab attempt (partial evidence, superseded):** 4 pairs consumed, candidate v2
led c=1/b=0 (won the path-tracing discordant pair; the rest ties incl. tune-mjcf F/F both-arm
timeouts). v2 = v0 + 2 proposer bullets targeting the spec-misread fails (derive under-specified
formats from authoritative sources; verify against stated criteria, not self-checks). v2 stays a
candidate; ab re-runs after the re-baseline.

## CURRENT STATE (2026-07-18 pt 1 — superseded above where they conflict)

**Everything PUSHED — `git pull` fast-forwards.** Tip ≥ `dca27be` (this doc commits after code).
Tree clean. Suite **1310 pass / 0 fail**, tsc clean. Loop store (MacBook: repo `.meta-harness`,
mirrored to `~/.config/meta-harness`): **active = v0, 12 PASS / 2 FAIL / 14 sessions (85.7%)**,
budget-identity `{maxAgentTimeout:3600, timeoutRecording:true, resourceEnforcement:true}`.

Shipped since the 07-17 pickup: **load-aware scheduler increment #2** — measured packing
default-ON + raise-only cap lift + OOM-escalation retry + cap provenance (full detail in the
"LOAD-AWARE #2 SHIPPED" section below). NOT a budget-identity change → the v0 baseline stays valid.

**OPEN WORK (pick any):**
- **(b) first real loop `ab`** — the throughline, AND load-aware #2's first live validation
  (fills n≥3 profiles for the whole band → packing goes measured automatically). Recipe: the
  "(b) recipe, MacBook-adapted" steps below. Needs fresh oauth (`claude`, login, ctrl-D).
- **(d) Axis-2** — seed/propose vendor content so routing does something; multi-model panel needs
  a 2nd vendor model.
- **load-aware #3 — SHIPPED (2026-07-18)**: `--host-pressure observe|on` (default OFF =
  byte-identical). Sensor `bench/host-pressure.ts` (per-signal hysteresis: load/core 2.0/1.2 +
  darwin memory_pressure / linux PSI w/ MemAvailable fallback, 20s cache, tick=sample,
  fail-safe never-throws); TRANSIENT `pauseGate`+`pausePollMs` on `schedule()` (checked AFTER
  the terminal oauth gate; timer only when inFlight=0, keep-alive — NO unref, that was a
  final-review BLOCKER with subprocess regression test; timer-clear at both settle points);
  `buildPressureGate` (one sensor/command, shared across ab phases). Suite 1367/0.
  **LIVE-SMOKED on this Mac**: real 34-spinner spike → `[pressure] paused launches (load/core
  8.9…)` → 0 leaked launches → decay+dwell 190s → `[pressure] resumed` → all tasks ran, exit 0.
  Observe-mode caveat CONFIRMED live: with sparse scans (2 long tasks) a mid-run spike is
  invisible — sampling rides scan events by design. NOT a budget-identity change. Follow-ups
  deferred: sensor stale-cache-after-error coherence nit; threshold calibration via observe
  mode on real sweeps. Spec: `docs/superpowers/specs/2026-07-18-load-aware-3-host-pressure.md`
- Post-merge cleanup candidate: fold `capRaised` into `TaskFootprint` (dedupes the two
  `capRaisedFor` closures in cmd-run/cmd-ab).

---

## ✅ MACBOOK PICKUP DONE (2026-07-17) — open work (a) COMPLETE, band hole FILLED

Home steps 1–3 executed clean: suite **1250 pass / 0 fail** on macOS; store diff showed exactly the
expected v0-re-baseline drift; surgically imported (no `--delete`) + activated v0 in **BOTH** local
stores — `~/.config/meta-harness` AND the repo `.meta-harness` (which existed on the MacBook but was
STALE: old v1, pre-rebaseline active, no config.json — the open-work recipes point `META_HARNESS_HOME`
at it, so it had to be brought current too).

**(a) write-compressor re-run — DONE, PASSED.** Serial (no `--parallel`, oauth-race dodged),
reward=1 in 788.9s (turns=1, verifier clean). Store: **v0 = 12 PASS / 2 FAIL over 14 sessions
(85.7%)** — the 13/14 band hole is filled; fails remain extract-elf + openssl-selfsigned-cert
(genuine). Synced to `term-bench2/store/` (surgical) + mirrored to `~/.config/meta-harness`.
Recipe fix: **`--cpu-budget`/`--mem-budget` are `--parallel`-only** — drop them for serial runs
(the runner errors out otherwise).

**FIRST resource profile written** (load-aware scheduler #1 live-proven on macOS/applehv):
`<repo>/resource-profiles/x64-12c-intel-r-core-tm-i7-8850h-cpu-2-60ghz.json` → write-compressor
`{avgCpu: 0.43, peakRssMb: 1217, wall: 788.9}`. Declared/floored 4 cpus vs measured 0.43 sustained
cores = the over-declaration increment #2 will exploit. `resource-profiles/` is now GITIGNORED
(host-local by design — `readResourceProfile` keys by the CURRENT host class, so profiles don't
transfer meaningfully).

**MacBook host notes:** podman = official installer at `/opt/podman/bin` (NOT on default PATH —
prefix `PATH=/opt/podman/bin:$PATH`); machine applehv **4 CPUs / 8 GiB** → parallel budgets must be
scaled down from the 8-core Linux recipes (a `--cpu-budget 8`/`--min-cpus 4` parallel run degenerates
to width-1 here).

**REMAINING OPEN WORK:** (b) first real loop `ab` — propose a NEW candidate ≠ v0, same
budget-identity — now runs on the MEASURED packer (below) and fills profiles for all 14 band
tasks; (d) Axis-2 vendor content + panel. Details in the handoff block below.

## ✅ LOAD-AWARE #2 SHIPPED (2026-07-18) — measured packing DEFAULT-ON + OOM-escalation retry

Open-work (c) is DONE and merged (branch `feat/loadaware-2`, 10 commits, suite **1310 pass / 0
fail**). Built via parallel subagent waves (3∥ → 2∥ → serial ×3), per-task spec+quality reviews,
final whole-branch review = MERGE-READY. Plan (3× architect-reviewed to FLAWLESS before build):
`~/.claude/plans/plan-to-flip-2-tidy-aurora.md`.

**What changed:**
- **Packing weight = measured profile** (default-ON): `packingWeight` (resource-profile.ts) —
  avgCpu (floor 0.5) / peakRssMb×1.2 (floor 256MB), gated `n≥3 && avgCpu>0`; declared/floored =
  cold-start prior. `packingFootprints` (tasks.ts) splits `{cap, pack}` — containers ALWAYS get
  the generous cap, the scheduler packs the honest weight. scheduler.ts itself unchanged.
- **Cap raise-only lift**: `raiseCapMeasured` — cap.memoryMb = max(declared/floored, peak×1.5) at
  n≥3, parallel AND serial enforce paths (cmd-oracle excluded, test-pinned). Closes the
  chronic-OOM loop (measured demand > declared cap no longer kills every run).
- **OOM-escalation retry**: cgroup `memory.events oom_kill` (cumulative-counter caveat → trigger
  is `oomKilled && reward !== 1` — an OOM'd-then-recovered PASS is kept); single retry in a fresh
  container at 2× memory (clamped to mem-budget under parallel); carry-forward across k-repeats
  and both ab arms; killed attempt never recorded (infra noise, like the auth-skip); oomKilled
  samples never memorized into profiles.
- **Escape hatch**: `--no-pack-measured` (run+ab, legal with AND without `--parallel`) disables
  ALL measured decisions. **Provenance**: per-session `capMemoryMb`/`capRaised` on SessionRecord
  (threaded like cpuSeconds/peakRssMb). **task-load**: MeasCPU/MeasMB/n columns + a second
  "measured packing" co-run preview block.
- **NOT a budget-identity change** (packing width is verdict-equivalent; ab re-runs both arms
  under identical caps) → no re-baseline needed.

**Deferred to increment #3**: online wall-clock back-pressure (the real fix for burst-phase
contention — avgCpu is a whole-run median; watch first live sweeps for timeout upticks), CPU
escalation, scheduler-visible escalated footprints. Post-merge cleanup candidate (final-review
minor): fold `capRaised` into `TaskFootprint` to delete the duplicated `capRaisedFor` closures.

**First live validation** = the (b) loop `ab`: it accumulates n≥3 profiles for the whole band,
after which packing goes measured automatically. On this 4-CPU VM expect width to rise from 1-2
toward ~4 as profiles mature (mem-bounded).

**(b) recipe, MacBook-adapted** (the Linux `run-loop3-ab.sh` assumed 8 cores; this VM is 4c/8GiB):
1. Propose off the fresh 14-session evidence: store-writing history is already in the loop store —
   start opencode in the repo, `/mh-propose account` → emits a NEW candidate vN (with Axis-2
   generality tags — first live capture data). Verify vN ≠ active: `ls .meta-harness/global/candidates/`.
2. `ab`, detached + logged (`term-bench2/logs/`), oauth fine (freshness gate), fresh token first (`claude`, login, ctrl-D):
   ```
   META_HARNESS_HOME=<repo>/.meta-harness PATH=/opt/podman/bin:$PATH bun term-bench2/runner.ts ab \
     --layer account-global --candidate vN --split-file term-bench2/splits/loop1.json \
     --model anthropic/claude-haiku-4-5 --k 2 --parallel --enforce-resources \
     --min-cpus 2 --cpu-budget 4 --mem-budget 7000 --max-agent-timeout 3600 --resume
   ```
   (`--min-cpus 2 --cpu-budget 4` = width-2 on the 4-cpu VM — the Linux `--min-cpus 4 --cpu-budget 8`
   pins width-1 here. Serial alternative: drop `--parallel`/`--cpu-budget`/`--mem-budget`, keep the rest.
   Same budget-identity either way: {3600, timeoutRecording:true, resourceEnforcement:true}.)
3. Verdict `report-loop`; on accept `/mh-activate account vN` (T6 gate checks budget-identity), then
   SURGICAL sync of `candidates/vN/` into `term-bench2/store/` + commit + push (never blind export).

---

## ➡️ MACBOOK HOME PICKUP (handoff 2026-07-16 evening) — DONE 2026-07-17, see block above

**Everything is PUSHED — `git pull` fast-forwards to the latest `origin/main`.** Clean tree (only a stray untracked `oom` — ignore). Recent commits (newest last): `2a8fda5` v0 re-baseline snapshot · `e113f43` cgroup capture+memorize · `e0e6e7c` ab-path cgroup capture · then this handoff on top. (Don't assert an exact tip hash — this doc commits after the code, so the tip is always ≥ the hashes listed.)

**What did NOT transfer from the Linux box (git-only cross-host — [[tmp-dir-mnt-d]]):** the `.meta-harness` runtime store (active=v0 pointer + `config.json recordTimeouts=true`), the `/mnt/d/tmp/*.sh` scripts (rebaseline-v0 / -sync / run-loop3-ab — recreate from the procedures below), and `~/.claude` memories (their content is folded into THIS file). The v0 baseline itself IS in git (`term-bench2/store/global/candidates/v0/`).

**Home steps, in order:**
1. `git pull` (fast-forwards to the latest origin/main).
2. `cd opencode-plugin && bun test` → expect **1250 pass / 0 fail** (confirms the cgroup-capture code lands clean on macOS). NOTE: `readCgroupStats`/live bench needs Linux+podman cgroup v2 — macOS podman runs in a Linux VM so the container cgroup read still works; but the UNIT tests are pure/mocked and pass anywhere.
3. **Store import — DIFF FIRST, never blind export** (the export-trap fired TWICE on the stale MacBook store — [[tmp-dir-mnt-d]]): `term-bench2/store-sync.sh diff`. Only if it shows the v0 re-baseline missing, surgically import (NO --delete): `rsync -a term-bench2/store/global/candidates/v0/ ~/.config/meta-harness/global/candidates/v0/` + `cp term-bench2/store/config.json ~/.config/meta-harness/config.json`, then ACTIVATE v0 (the active pointer is host-local, not in the snapshot).
4. Pick up the open work below.

**OPEN WORK (pick any):**
- **(a) write-compressor re-run** — fill the 13/14 band hole. It dropped as an oauth-parallel-race 0-turn (auth/transient skip, not a timeout). Re-run SERIALLY (drop `--parallel`) or with a fresh token: `run --layers account --tasks write-compressor --model anthropic/claude-haiku-4-5 --enforce-resources --min-cpus 4 --cpu-budget 8 --max-agent-timeout 3600` under `META_HARNESS_HOME=<repo>/.meta-harness`. This also writes the FIRST resource profile.
- **(b) first real loop `ab`** — propose a NEW candidate ≠ active(v0), same budget-identity → valid comparison. `ab` dies "nothing to compare" if candidate==active (`cmd-ab.ts`). Recipe: `/mnt/d/tmp/run-loop3-ab.sh <candidate>` (recreate — see LINUX block below).
- **(c) load-aware scheduler increment #2** — flip the packer input from declared `cpus` int → measured `avgCpu` (`readResourceProfile`), declared int + `--min-cpus` kept only as cold-start prior. NEEDS profile data first → run the loop live (step a/b) to accumulate, THEN flip. See the Load-aware section in the LINUX block + [[load-aware-scheduler]].
- **(d) Axis-2** — seed/propose vendor content so routing does something; multi-model panel needs a 2nd vendor model.

---

## LINUX SESSION (2026-07-16 cont.) — MASTER SHIPPED · Axis-2 tag CAPTURE+ROUTING shipped · TB2-timeout fixed · cgroup-capture shipped

**HEAD `2a8fda5`, PUSHED to `origin/main` (`origin/main..HEAD` empty, `git ls-remote` confirms). Tree clean** (except a stray empty `oom` file, untracked — ignore). **Loop-3 v0 re-baseline DONE + synced — see the "Re-baseline v0" section at the end of this block.**

**Shipped to main (local) this session:**
1. **MASTER BUILT + MERGED** — the 8-module deterministic boundary/orchestration layer under `opencode-plugin/src/fleet/master/` (gate-state · transport · frozen-gate · namespace · relay · scheduler · reconcile · master) + a `master` CLI case + hermetic E2E. Executed the master DAG as parallel subagent waves (wave0 4∥ · wave1 3∥ · wave2 1), TDD per task, per-task code-architect review + a final whole-branch review (merge-ready, 0 crit/imp). Review-driven fixes: T4 frozen-gate `testsRun` parse (was reading pass-count not `Ran N tests` → blinded the DGM-114 gaming detector); T1 gate-state made **kind-aware** (`resolveGate`/`markRelayed` take a `GateKind` — HUMAN-approved interface change, guards co-pending different-kind gates); T5 upsert test. The 4 open Qs settled in-build (masterRoot = injected param; grammar `approve|revise <project>/<sliceId>` + `status`; gateRoot injected; lock TTL deferred). Plan `docs/superpowers/plans/2026-07-16-master-build.md`. Suite 1214 pass.
2. **TB2-timeout fix** — the loop `ab` recipe was capping tasks BELOW their real TB2 budgets: `--max-agent-timeout 1800` halved distribution-search (TB2 3600), `--max-verifier-timeout 300` starved nearly every verifier (TB2 verifiers 900–3600s). `taskTimeouts` (tasks.ts) ALREADY reads exact TB2 `task.toml` timeouts; a cap only LOWERS. Fix = agent cap **3600** (split max), **DROP** the verifier cap. The "oauth+parallel recipe" section below already reflects this; `/mnt/d/tmp/run-loop3-ab.sh` fixed too.
3. **Axis-2 generality tag CAPTURE** (`ecc6874`) — per-bullet `generality?: "universal"|"vendor"|"model"` + `slice?` on `PlaybookBullet`; proposer emits it per op; `applyPlaybookOps` coerces invalid→universal + caps slice; no-op guard now playbook-aware (a pure re-tag is no longer silently dropped); `generalityRollup` in candidate meta + `/mh-status gen[u v m]`. `renderPlaybook` UNCHANGED → injection byte-identical. Promote left untouched (pre-existing playbook-null-on-activate, documented `explicitly-not-now §2.4.1`). Docs: `target-model-axis.md §7.0` + research fold `§0.1`.
4. **Axis-2 generality tag ROUTING** (`4b13060..bbca3e4`) — a bullet tagged `vendor:anthropic` now INJECTS only for Anthropic sessions, via ONE shared `renderPlaybookRouted` + `composeHarness(model?)` with a **faithful-render guard** (`renderPlaybook(pb).trim()===flat.trim()` — absorbs `seedPlaybook`'s non-format-preserving migration → byte-identical by construction). Threaded through ALL 4 injection entry points: runtime `composeInjection` (session model), bench `cmd-ab`/`cmd-run` (`--model`), fleet `renderRole` (role's fixed model). Spec `2026-07-16-generality-routing-design.md` (SUPERSEDES `target-model-axis §4`'s separate-coordinate approach for delivery — the tag lives on the bullet, routing is a render filter); plan `2026-07-16-generality-routing.md`. 2 code-architect rounds to production-flawless. Suite 1233 pass.

**Loop-2 timeout-mirage CONFIRMED live:** tune-mjcf + distribution-search both PASS at generous budgets (`--min-cpus 4`). Loop-2's "no lift" was compute/timeout starvation, not real regression.

**Loop-3 re-baseline — flipped + DONE + synced (2026-07-16 21:49):**
- **`recordTimeouts` FLIPPED ON** — `<repo>/.meta-harness/config.json` = `{"recordTimeouts": true}`. That is the REPO store (loop runs point `META_HARNESS_HOME` there); `~/.config/meta-harness` is NOT the loop store. Budget-identity is now `{maxAgentTimeout:3600, timeoutRecording:true, resourceEnforcement:true}`.
- **Baseline reset v6→v0.** Active WAS the untested v6 (drift, no verdict). Reverted: v0 migrated to a 6-bullet playbook from its `DEFAULT_SYSTEM_PROMPT` (its header line becomes a `- ` bullet — a NON-faithful migration, so routing's faithful-render guard falls back to flat = v0's EXACT original prompt, byte-identical) + activated NON-destructively (v6 preserved as a candidate) + `score.json` reset to `{nPass:0,nFail:0,sessions:[]}` (its old score was 5 degenerate all-None placeholder rows, not real data). **active = v0.**
- **Re-baseline DONE + synced + pushed (`2a8fda5`).** Stored v0 baseline = **11 PASS / 2 FAIL over 13 sessions (84.6%), 0 timeouts** — budget-identity stamped `{maxAgentTimeout:3600, resourceEnforcement:true}`. Fails: extract-elf, openssl-selfsigned-cert (genuine, no timeout). Timeout fix CONFIRMED live: distribution-search (426s) + tune-mjcf (267s) both PASS where they used to time out under the old caps.
  - **⚠️ write-compressor MISSING from the 14-task band** — ran 602s but `opencode done turns=0` → store logged `skip store record: 0 agent turns (auth/transient agent failure)` = the oauth-parallel race, NOT a timeout. So the band is 13/14; runner's own summary counts it as a fail (11/14 = 78.6%), the STORE correctly excludes it as infra noise (11/13 = 84.6%). **`recordTimeouts` does NOT cover this skip path** — it records timeout 0-turn runs, but "auth/transient agent failure" 0-turn runs are a SEPARATE skip in the runner. write-compressor needs a re-run (serial, or fresh token to dodge the oauth-race) to fill the hole. See [[loop-blind-spots]].

**STILL dark / deferred:**
- **Axis-2 not fully APPLIED** — CAPTURE + ROUTING shipped, but (a) NO content is tagged vendor/model yet (a fresh propose emits tags, or hand-seed the documented Anthropic rules); (b) NO multi-model PANEL to VALIDATE a tag (needs a 2nd vendor model). Routing delivers the CLAIM, doesn't prove it. Deferred: `target-model-axis §6` (panel) + promote-playbook-preservation (`explicitly-not-now §2.4.1`).
- **No meaningful loop `ab` YET** — needs (i) the v0 re-baseline above to FINISH, THEN (ii) a NEW candidate ≠ active to compare. `ab` = candidate-vs-ACTIVE; a candidate == active dies "nothing to compare" (`cmd-ab.ts:184`). v0–v6 all pre-date the new budget-identity → only the re-baselined v0 is a valid baseline. `META_HARNESS_HOME=<repo>/.meta-harness`, detached+logged (`/mnt/d/tmp/run-loop3-ab.sh <candidate>`).

### Re-baseline v0 — procedure (scripts are HOST-LOCAL `/mnt/d/tmp`; recreate from these steps at home)
Prereq: fresh oauth (`claude`, login, ctrl-D — `--parallel` needs a live token). `run` (NOT `ab`) re-scores the ACTIVE version; store-writing by default (no `--results-file`/`--no-store`). `run` takes `--task-file`, NOT `--split-file` (that flag is `ab`-only).
1. **Baseline run** (`/mnt/d/tmp/rebaseline-v0.sh`): guards `active==v0` → extracts loop1's 14 tasks to a plain task-file → launches detached
   `META_HARNESS_HOME=<repo>/.meta-harness bun term-bench2/runner.ts run --layers account --task-file <14tasks> --model anthropic/claude-haiku-4-5 --k 1 --parallel --enforce-resources --min-cpus 4 --cpu-budget 8 --mem-budget 16000 --max-agent-timeout 3600`
   → 14 v0 sessions land in `candidates/v0/score.json` stamped the new budget-identity. k=1 fits the ~1h window; bump `--k 2/5` later for a robust baseline.
2. **Sync** (`/mnt/d/tmp/rebaseline-v0-sync.sh`, run SEPARATELY after eyeballing the log): SURGICAL — `rsync -a` (NO `--delete`) of `candidates/v0/` + `config.json` from the `.meta-harness` store → `term-bench2/store/` snapshot → `git add term-bench2/store` → commit → push. Do NOT `store-sync.sh export` (a full `--delete` mirror → would drag the dead v2–v6 into the snapshot). Self-guards on v0 sessions > 0.
3. **At home:** `git pull` → `rsync -a term-bench2/store/global/candidates/v0/ ~/.config/meta-harness/global/candidates/v0/` + `cp term-bench2/store/config.json ~/.config/meta-harness/config.json` → activate v0 (the active pointer + active playbook are host-local, NOT in the snapshot — activate separately on the home host).

**NEXT:** (a) a real loop `ab` — propose a NEW candidate vs the re-baselined v0 (same budget-identity → valid comparison); (b) re-run write-compressor SERIALLY to fill the 13/14 band hole; (c) seed/propose vendor content so routing does something; (d) the multi-model panel (needs a 2nd vendor model) to validate tags. [re-baseline + sync DONE — origin/main @ `2a8fda5`]

**Load-aware scheduler — increment #1 (capture+memorize) WIRED + COMMITTED + PUSHED (`e113f43` capture+memorize, `e0e6e7c` ab-path), tests green:**
- **Problem (user critique):** the bench packer (`scheduler.ts`, `d528ae5`) IS load-aware (`fitsBudget` sums per-task `cpus`≤budget) but packs on a STATIC declared int (task.toml default `cpus=1`); `--min-cpus 4` floors every task → on the 8-core box `--cpu-budget 8` degenerates to fixed width-2. A declared count is meaningless across P/E cores / hosts (and inside WSL2 the topology is invisible); most tasks are LLM-latency-bound anyway. Only in-env MEASUREMENT is ground truth.
- **Shipped (behavior-neutral — packer UNCHANGED, only collects):** `bench/cgroup.ts` `readCgroupStats` reads the container's OWN cgroup v2 (`/sys/fs/cgroup/cpu.stat usage_usec` + `memory.peak`) via `podman exec` just before teardown (mirrors `readSelfScore`; null on any fail). `bench/resource-profile.ts` MEMORIZES a per-task × per-host-class profile at `<metaRoot>/resource-profiles/<hostClass>.json` (`hostClass()` = `<arch>-<Ncpu>c-<model-slug>`; rolling window 5; `avgCpu = median(cpuSeconds/wall)` = sustained core-demand; `readResourceProfile` for the future packer). `SessionRecord` gains `cpuSeconds?`/`peakRssMb?`, threaded through `record.ts`; wired in BOTH `cmd-run.ts` (serial+parallel) AND `cmd-ab.ts` (memorizes BOTH arms A+B — a footprint is a task×host property, ~prompt-independent; stamps arm-B score too). tsc clean, **1250 pass / 0 fail** (+17). Live-verified against a real container. (Test-hygiene note: profile tests MUST isolate metaRoot — the cmd-ab harness sets `metaRoot=dirname(termBenchDir)`, which collapses to `os.tmpdir()` when termBenchDir is the tmpDir itself; other tests survive it via createCandidate reset, the profile store has none → `isolatedPaths()` nests termBenchDir.)
- **NEXT for this feature:** (i) increment #2 = flip the packer input `enforcedResources` declared-int → measured `avgCpu`, declared int + `--min-cpus` kept only as cold-start prior (needs profile data → run the loop with #1 live first); (ii) increment #3 = online wall-clock back-pressure. Capture now covers both run + ab paths. See [[load-aware-scheduler]].

---

## OFFICE PICKUP (2026-07-16 evening, MacBook session end)

**Everything pushed, `git status` clean, HEAD = `ce54fd3`.** Discipline first:
`git pull && term-bench2/store-sync.sh diff` (import only if drift — the
export-trap nearly fired again today on the stale MacBook store; that's twice).

MacBook session shipped today (details in sections below):
1. **Bench resource-scheduler SHIPPED DARK** (`d528ae5`) — see its section +
   the ⚠️ UNTESTED oauth-race block (user-flagged big issue).
2. Office-runnable pickups, any order:
   (a) **3-concurrent smoke** = the --parallel flag-flip gate — needs an
       ANTHROPIC_API_KEY in env; keyOnly mode is platform-independent, linux OK.
   (b) **oauth-race sandbox experiment** (defined in the ⚠️ block) — settles
       whether the key requirement is genuinely needed or over-strict.
   (c) **Loop-3 T6+T7 + pre-flip checklist** (the standing throughline) → then
       ONE combined re-baseline: recordTimeouts + --enforce-resources together.
3. Still pending a go (unchanged): Phase-0 SELF_CHECK_INSTRUCTION re-run;
   seed-corpus stays measure-first behind loop-1's ab.

## HOME SESSION pt 2 (2026-07-16) — Loop-3 COMPLETE · oauth-parallel SHIPPED+VALIDATED · T3 built · master DAG

Everything committed + pushed. HEAD `f37ec51` (see `git log`). Loop-2 stays inconclusive (v0 active). Recipe: the "oauth+parallel recipe" section above.

**Shipped (all pushed):**
1. **Loop-3 FUNCTIONALLY COMPLETE** (was T1-T5 dark) — T6 (`0c9f2be`, `/mh-activate` budget-identity gate) + T7 (`f598d08`, report-loop segmentation) + emission (`cc64dea`, ab+trial meta-metric events stamp the {maxAgentTimeout,timeoutRecording,resourceEnforcement} tuple → segmentation LIVE, proven by an integration test) + pre-flip (`da0e107`: per-task timeout-marker denominator via `SessionRecord.agentTimeout`, project-scope steer gate, clearer undefined-active toast). **`recordTimeouts` STILL default-OFF.** To flip: `config.json recordTimeouts=true` + re-baseline v0 (budget-identity change → T6/T7 handle it).
2. **oauth-parallel freshness gate SHIPPED+VALIDATED** (`0a823bd`+`ec3b31f`+`aeabef1`) — run `--parallel` on oauth, **NO API KEY**, safe by construction (no task runs across the ~8h token refresh → no auth.json race). = pre-flight (token must outlive one task; oauth+parallel REQUIRES explicit `--max-agent-timeout`) + scheduler `canLaunch` launch-guard (stops launching near expiry, graceful resolve, `--resume` continues) + oauth mount under parallel (`useKeyOnlyForParallel`: keyOnly only if key present). Validated LIVE 2-concurrent.
3. **`--min-cpus`/`--min-mem-mb` resource floor** (`f37ec51`) — generous per-task cgroup cap `max(declared,floor)` so `--enforce-resources` doesn't starve compute-heavy tasks. Default off = byte-identical.
4. **VALIDATION (live runs):** tune-mjcf + distribution-search (both loop-2 timeout-fails @600s) → **2/2 PASS serial @1800s**. Parallel @1-cpu-cap → 1/2 (distribution-search STARVED: 1367s+fail vs 446s serial). Parallel GENEROUS (`--min-cpus 4`, 8-cpu machine) → distribution-search recovered (196s+pass partial at handoff; **CHECK `term-bench2/results/validate-parallel-generous.json` for the full result**). LESSON: artificial resource limits (time OR cpu) → false fails → weaker loop signal; loop wants the loosest envelope that fits the machine. Loop-2's "no improvement" was partly a **timeout mirage**. USER DECISION: parallel + generous footprints.
5. **Self-hosting T3 BUILT** (`a39c1db`..`71216b0`) — `fleet/dag.ts` DagNode{id,task,deps[],files?,mutatesDeps?} + total validator + PLANNER_SQUAD + gate2-reuse. **DAG: T1+T3 built; T4/T5/T6sh/T2/T7sh/master planned.**
6. **oauth-race fully resolved+documented** — `oauth-parallel-race-research.md` + `auth-delegation-design.md` (UPDATED: freshness gate SUPERSEDES the old "surface don't handle / key-or-serial" decision).
7. **MASTER decomposed into a parallel task-DAG** (max-parallelism, expressed in the `fleet/dag.ts` TaskDag format = dogfood): **Wave0 (4∥):** gate-state · transport · frozen-gate · namespace. **Wave1 (3∥):** relay(gs,tr) · scheduler(ns) · reconcile(gs,ns). **Wave2:** daemon+CLI+E2E(all). Each node = a distinct `master/*.ts` file → no intra-wave conflict. Build-plan `docs/superpowers/plans/2026-07-16-master-build.md` (8 tasks), **4 open Qs** (masterRoot convention, inbound grammar, gateRoot provisioning, singleton-lock TTL) to settle before building.

**NEXT:** (a) check the generous-validation result; (b) settle master's 4 open Qs → execute master DAG **wave-0 as 4 parallel subagents** (distinct files, no worktree needed); (c) OR flip Loop-3 `recordTimeouts` + re-baseline v0 + a real loop `ab` run (parallel+generous, `--min-cpus 4 --cpu-budget 8`). grok-build = xAI leaf-agent coding TUI (possible future `--driver`, not orchestration prior-art).

---

## SESSION END 2026-07-16 (leaving office) — loop-2 CALLED · Loop-3 shipped DARK · T1 shipped

**Everything is committed + pushed. `git status` clean, 0 unpushed. HEAD = `7e23797`.**
The sections below this one (office/v1/Phase-0) are HISTORICAL — superseded by the loops since.

**Is the necessary data saved?** YES — all code, docs, plans, the Loop-3 build, the T1
primitive, and the bug fix are in git (`origin/main`). Store note: the account store's
`active` is the EMPTY baseline (nothing promoted); the git snapshot `term-bench2/store/`
has `v0 v1`, which is all home needs. Dead candidates `v2` (superseded) and `v3` (loop-2,
called) are host-local and NOT needed — **do NOT store-export them** (blind export is the
data-loss trap; nothing new needs syncing anyway). To run anything at home: `git pull`
(+ `store-sync.sh import` only if you need the candidate store).

**What happened this session:**
1. **Loop-2 CALLED = `inconclusive / no-lift`** (user decision — grinding the rest was
   hours of timeout-dominated compute to confirm a near-certain reject). Candidate `v3`
   (the proposer-fix's output) vs active `v0`: 3 held-in TIES incl **tune-mjcf FAIL/FAIL
   (both ~600s timeout)**, a `v3` regression hint on distribution-search. `v3` NOT
   activated; active stays baseline. **Meta-win stands:** the proposer-fix (`679326f`)
   worked — `v3` self-corrected off `v1`'s reject. Full detail: memory `loop-2-outcome`
   (host-local) + `.superpowers/sdd/progress.md` ledger (host-local).
2. **Loop-3 (timeout blind-spot fix) T1–T5 SHIPPED DARK** — commits `062ca93..85fbfed`,
   final-reviewed (opus) merge-ready. Flag `recordTimeouts` **default-OFF = zero behavior
   change**. This is the priority self-improvement fix: makes agent timeouts a first-class,
   proposer-visible failure (today they're 0-turn results invisible to the proposer, so the
   loop can't learn its frontier failures — tune-mjcf above is the live proof).
   **To turn it ON (next session):** finish **T6+T7** (stamp `maxAgentTimeout`/
   `timeoutRecording` into verdictDict + `writeRunResults`; the MANUAL re-baseline op +
   runbook) + the **pre-flip checklist** (thread the real per-task `agentTimeout` — already
   captured as `agentElapsedSec` — into the proposer marker, which today uses the run-cap
   denominator; scope-gate the T4 steer to project layers), THEN set `recordTimeouts=true`
   in `config.json` + **re-baseline `v0`**, THEN a fresh loop-3 run. Plan:
   `docs/superpowers/plans/2026-07-16-loop3-timeout-fix.md`; pre-flip details in the ledger.
3. **T1 git-worktree primitive SHIPPED** (`144f31b..f536b6e`, reviewed-to-merge) — the
   fleet/self-hosting execution substrate (worktree-isolated squad-runs, ledger survives
   cleanup). Self-hosting build DAG: **T1 built; T3/T4/T6 + master + Loop-3 planned;
   T2/T5/T7 unplanned.** Also landed: **master build-plan** (`6c2ee4f`, 8-task deterministic
   orchestrator, §9+R1-R4), **R4 credit-assignment research** (`9e246d4`, closes the last
   master gap — exact-replay difference rewards). All mapped in `docs/INDEX.md`.
4. **Harness bug fixed** (`ac0cd18`): every chunked `ab --resume` was silently dying
   (`verdictDict` omitted the top-level `driver` field the resume-ident check requires).
   Fixed + regression-tested. NOTE: a partial written BEFORE `ac0cd18` still lacks the
   field — patch top-level `"driver":"opencode"` into `ab-verdict.partial.json` to resume
   it without a full restart.

**Next session — pick up any of:** (a) Loop-3 T6+T7 + pre-flip fixes → flip it ON →
re-baselined loop-3 run (the throughline); (b) execute a planned self-hosting task
(T3/T4/T6, SDD like T1); (c) write the remaining plans (T2/T5/T7); (d) resolve the
~30 open-questions accumulated across the new plans (each plan lists its own). The
current loop empirically produces NO task-pass lift yet — Loop-3 (honest signal on
frontier tasks) is the highest-leverage near-term fix; the self-hosting substrate is
the bigger structural bet after that.

## oauth+parallel recipe (2026-07-16 — NEW, no API key needed)

The bench can now run `--parallel` on your subscription oauth (no `ANTHROPIC_API_KEY`),
**safe by construction** — the freshness gate guarantees no task runs across the ~8h token
refresh, so the shared `auth.json` is read-only during the parallel window (no race).
Commits `0a823bd` + `ec3b31f` + `aeabef1`. **Validated live** (2 concurrent, oauth, 2/2 pass).

Also loosen the agent timeout: the loop-2 **600s cap was artificially clipping** tasks below
their declared budgets (tune-mjcf declares 900s, distribution-search 3600s) → false timeouts.
Run at the real budget.

```
# 1. fresh token (the gate refuses if it can't outlive one task; re-login if stale)
claude          # or: opencode auth login   (~8h TTL)
# 2. run parallel on oauth, no key — TB2-EXACT per-task timeouts (NO sub-TB2 cap):
#    vN must be a REAL, NON-ACTIVE version (else cmd-ab.ts:184 "nothing to compare")
bun term-bench2/runner.ts ab --layer account-global --candidate vN \
  --split-file term-bench2/splits/loop1.json --model anthropic/claude-haiku-4-5 \
  --k 2 --parallel --enforce-resources --max-agent-timeout 3600 --resume
```
- **`taskTimeouts` (tasks.ts) ALREADY reads each task's exact TB2 `[agent]/[verifier] timeout_sec`**
  from `<tbRoot>/<task>/task.toml`; a `--max-*-timeout` flag only ever LOWERS it, never raises.
  So "take timeout from TB2" = set the agent cap AT OR ABOVE the split's per-task max, and OMIT
  the verifier cap. (TB2 agent budgets across the 89 tasks: 48×900, 17×1800, 12×3600, 1×7200, 1×12000.)
- `--parallel`+oauth REQUIRES an explicit `--max-agent-timeout` (freshness math). Set it to the
  split's MAX real TB2 agent budget — loop1 = **3600** (distribution-search) — so NO task is
  shortened below TB2; a ~8h token easily outlives 3600s. **Do NOT set it below TB2** — the old
  `1800` halved distribution-search (3600→1800).
- **No `--max-verifier-timeout`.** The verifier runs AFTER the agent and never touches the oauth
  token, so it needs no cap. Omit it → each task's exact TB2 `[verifier] timeout_sec` (up to 3600)
  is used. The old `300` STARVED nearly every verifier (TB2 verifiers are 900–3600s) — the real
  false-timeout source on heavy tasks.
- Self-limiting: as the token nears expiry the scheduler stops launching new tasks, lets
  in-flight finish, ends the chunk → re-login + `--resume` continues.
- Raising `--max-agent-timeout` (→3600) is a **budget-identity change** → Loop-3 T6/T7 re-baseline
  it (re-score the active version at the new budget first).
- With a static `ANTHROPIC_API_KEY` set, `--parallel` uses keyOnly (no token TTL → omit
  `--max-agent-timeout` entirely for fully-exact TB2 timeouts).

**VALIDATION (2026-07-16):** tune-mjcf + distribution-search (both loop-2 timeout-fails at
600s) → **2/2 PASS** at loosened timeout, serial AND 2-concurrent oauth+parallel. Loop-2's
"no improvement" was partly a **timeout mirage** (the artificial 600s cap), not harness
quality — validates Loop-3's thesis.

---

## AT THE OFFICE (2026-07-16) — v1-into-git DONE ✅ (read the warning)

**DONE (commit `9bc5166`):** v1 is now in the git snapshot (`term-bench2/store/global/candidates/` = `v0 v1`).

⚠️ **The original instruction here (`store-sync.sh export` on the linux host) was a
DATA-LOSS TRAP and was NOT used.** By 2026-07-16 the hosts were split-brain: the
linux host had `v1` in its live store but was STALE on the overnight tier-2 work
(role stores `mh-analyzer/designer/evaluator/implementer`, config, calibration);
the git snapshot had the overnight work but not `v1`. `export` is `rsync --delete`
(store→snapshot), so it would have DELETED the overnight role stores from git.
Instead v1 was added SURGICALLY (`rsync` no `--delete`, only `global/candidates/v1`)
— zero deletions. **Lesson: always `store-sync.sh diff` first; if it shows
`*deleting` lines you care about, do NOT export — surgically copy just the new
candidate dir into `term-bench2/store/` and commit.** The import-before-work
discipline prevents this; it was skipped when linux made v1 before store-sync existed.

Next: `ab` can run on ANY host. The linux host can run it directly (its live store
already has `v0 v1`). Other hosts: `git pull && store-sync.sh import` (now safe —
the snapshot has v1 + the overnight roles).

## Where we are (2026-07-16)

First propose→ab improvement loop (#5). Done: baseline (haiku pass@5 **0.381**),
14-task band split, store-writing run, **propose → account-global `v1`**
(a real generalized playbook). The `ab` verdict (v0 vs v1) is the last step.

Landed overnight 2026-07-15→16 (MacBook, pushed to `main`):
- **Prompt-mining plan EXECUTED** (was saved-only) — `docs/external-prompts-cc-opencode.md`
  (17-row verdict table, 22-bullet dual-tagged seed corpus, 6 meta-prompt lessons),
  the two HIGH lessons applied to `buildProposerPrompt` (L1 untrusted-evidence,
  L2 evidence-gated rejection list — conditional on non-empty failures so fresh-layer
  bootstrap still writes a baseline; live propose smoke passed), and
  `docs/target-model-axis.md` spec (additive-only v1; build deferred,
  `explicitly-not-now.md` §2.4). Raw extraction scratch: `.superpowers/sdd/mining/`
  (host-local, MacBook). Seed corpus is measure-first: do NOT hand-seed until
  loop-1's ab shows what propose finds on its own.
- **Phase-0 self-score correlation run DONE** (best-of-k gate; MacBook, 2026-07-16
  morning): 43 baseline tasks × k=1 haiku `--self-check` →
  `term-bench2/results/phase0-selfscore-haiku.json`. **GATE: UNDERSIZED, not
  predictive on current data** — pass@1 5/43 (11.6%); capture rate 11/43 (26%,
  haiku usually skips the self-check); among captured pairs essentially every
  self-claim is 1.0 (no variance), so score-value lift is only +2.7pp (30% vs
  27.3% within-pairs base) with 7/10 self-PASS claims false-positive; N=11 < 30
  floor. Per the plan's stopping rule: do NOT build the k-loop on this. Two real
  findings: (1) the self-report VALUE is near-uninformative as-is; (2) writing a
  self-check at ALL correlates with success (27.3% vs 6.3% for non-compliant
  runs) — compliance is the stronger signal. NEXT (deliberate revision):
  strengthen `SELF_CHECK_INSTRUCTION` (`opencode-plugin/src/bench/self-score.ts`)
  to force compliance + honest fractions, then re-run the 43-task night.

Landed 2026-07-15 (all pushed to `main`):
- **Store is git-syncable** — `term-bench2/store-sync.sh` + `term-bench2/store/` snapshot (next section). No more scp.
- **Verifier-timeout bug fixed** — `--max-verifier-timeout` now bounds each attempt (was unbounded; `ab` command below already includes it).
- **Tier-2 machinery HARDENED** (`7503ae0`) — adversarial review of the office-host code found + fixed 2 Critical + 4 Important bugs before any loop leans on it: squad-run pins one def-version per slice (no mid-run-activation drift); `squad-trial` is now a PAIRED comparison with the tier-1 McNemar significance test (no promote-on-noise, default n=5 floor); Phase-0 self-score gate floors on self-PASS sample size (n=1 greenlight killed); `flow.reentry` frozen; failure retrieval blends importance×diversity. 916 tests green. Detail: `.superpowers/sdd/tier2-fix-report.md` + `selfscore-fix-report.md`.
- **Slack/OpenClaw fixed** (fleet, oc-test side) — root cause of "#oc doesn't answer" was `requireMention` defaulting true (plain messages dropped as `no-mention`), NOT agent provisioning. Fix: `requireMention:false` on #oc. Token-free patch + sanitized gateway template in `oc-test/agents-fleet/gateway/` for office-host bring-up (new bot). Live DM outbound proven.

**BLOCKER RESOLVED (2026-07-16, commit `9bc5166`):** `v1` is now in the git
snapshot (added surgically — see the office section above for why blind `export`
was NOT used). NEXT = run `ab` (v0 vs v1). Linux host can run it directly; other
hosts `git pull && store-sync.sh import` first.

Full detail + v1's diagnosis & playbook: **[loop-1-state.md](loop-1-state.md)**.

**Completed run data also travels via git now:** `term-bench2/results-archive/`
holds committed copies of final results (both baselines, phase-0 self-score,
gate/soak) — the working `term-bench2/results/` dir stays git-ignored.

## The store travels via git now (no scp)

The account store (`~/.config/meta-harness` — candidates v0/v1, active, playbooks,
traces, role/squad stores) is mirrored into the repo at **`term-bench2/store/`** by
`term-bench2/store-sync.sh`. So loop artifacts cross hosts by `git push`/`git pull`.

- **Host that HAS the new candidate** (e.g. linux with v1):
  ```
  git pull
  term-bench2/store-sync.sh export          # ~/.config/meta-harness -> term-bench2/store/
  git add term-bench2/store && git commit -m "store: loop-N candidates" && git push
  ```
- **Other host** (e.g. MacBook, to run `ab`):
  ```
  git pull
  term-bench2/store-sync.sh import          # term-bench2/store/ -> ~/.config/meta-harness (backs up existing to .bak)
  ls ~/.config/meta-harness/global/candidates/   # expect: v0 v1
  ```
Discipline (single-user serial, like the old scp-replace): **pull+import before working, export+push after.** `import` is a full mirror (`--delete`) but backs up the prior store to `.bak` first; `store-sync.sh diff` shows drift.

## Resume the loop (Path A — keeps this exact v1)

1. `cd ~/z2/meta-harness && git pull && term-bench2/store-sync.sh import` (brings v1 into the store).
2. Bench prereqs (macOS): `podman machine start` (if needed) → `bun term-bench2/runner.ts prep --apply`. Needs the TB2 task repo at `~/z2/terminal-bench-2`.
3. Run `ab` (detached, ~3–5 hr, resumable). **Bound each attempt** with the timeout flags (verifier was uncapped — fixed 2026-07-15):
   ```
   nohup bun term-bench2/runner.ts ab --layer account-global --candidate v1 \
     --split-file term-bench2/splits/loop1.json --model anthropic/claude-haiku-4-5 \
     --k 2 --max-agent-timeout 600 --max-verifier-timeout 300 --resume \
     > term-bench2/logs/loop1-ab.log 2>&1 &
   ```
4. Verdict: `bun term-bench2/runner.ts report-loop`; on accept → `/mh-activate account v1`, then `store-sync.sh export` + commit + push so every host has the new active.

**No committed v1 yet?** Path B (re-derives a DIFFERENT v1): store-writing run
`run --task-file term-bench2/splits/loop1-band.txt --k 2 --layers account --model anthropic/claude-haiku-4-5`,
then start opencode + `/mh-propose account` (the `external_directory` grant is already in `opencode.json`), then `ab` as above.

## Gotchas (already handled, don't re-hit)
- Account-scope propose needs `opencode.json` → `"permission": {"external_directory": "allow"}` (committed) — else the headless proposer hangs on a permission prompt.
- `--results-file` forces `--no-store` (a run feeds the store OR writes results, never both); store-writing runs aren't resumable; `ab` is.

## Landed 2026-07-16 evening (MacBook): bench resource-scheduler SHIPPED DARK
`--enforce-resources` + `--parallel` (budget-packed, D5 verdict-equivalent) +
`task-load` — all default-OFF, merged `d528ae5`. Spec/plan in docs/superpowers/
{specs,plans}/2026-07-16-bench-resource-scheduler*. applehv cgroup caps VERIFIED
live; serial enforce smoke green; parallel key-gate verified. **Flag-flip gate
(NOT merge gate): the 3-concurrent smoke needs ANTHROPIC_API_KEY** (parallel
forbids shared oauth mounts by design) — then flipping enforcement on is a
re-baseline event, bundled with Loop-3's recordTimeouts flip. Deferred
pre-first-sweep item: interior log-line prefixes under --parallel.

✅ **RESOLVED 2026-07-16 (home session): the oauth-race rationale is CONFIRMED,
not just assumed** — Anthropic's own tracker (claude-code #22600/#48786) + local
`~/.claude` `expiresAt` ≈ 8h show the refresh token is single-use, rotated on
refresh (~8h expiry, NOT per task), with no locking in CC or the harness → the
`--parallel` shared-credential race is real. DECISION recorded in
`docs/auth-delegation-design.md`: **surface, don't handle** — the `--parallel`
guard rejects oauth+parallel up front, user chooses serial (safe) or a static key
(keyOnly). The destructive live experiment is NOT needed (existence proven; a real
refresh would rotate + invalidate the live token). Now TESTED (`46131ec`: ab-guard
fires + keyOnly removes the race surface). The block below is the original OPEN
framing, kept for context.

⚠️ **(historical) the oauth-race rationale behind the --parallel key requirement was
UNTESTED (user-flagged as a big issue 2026-07-16).** The whole D4 design (no
oauth under --parallel; ANTHROPIC_API_KEY mandatory) rests on the pre-existing
`agent-auth.ts:32-37` comment ("plugin rotates the refresh token on use;
concurrent containers can race auth.json") — a code-grounded ASSUMPTION, never
reproduced by anyone. What IS verified: every container mounts the same rw
credential dir (fact, from code). What is NOT verified: that rotation actually
happens on use, or that concurrent rotations corrupt the store. We designed
around it without testing because the destructive test would race the REAL
credential store (asymmetric risk, cheap mitigation). **Safe experiment, defined
and pending:** copy the auth dir to scratch, point two containers at the COPY
(XDG override — same isolation the propose-smoke used), force both to refresh
concurrently (expire the access token in the copy), diff what survives.
Outcomes: (a) corruption reproduced → assumption confirmed, key requirement
stands, close the question; (b) no corruption → the key gate is over-strict —
consider relaxing D4 to allow oauth+parallel (spec + gate change + re-review).
Until tested, oauth+parallel stays FORBIDDEN (fail-safe default). Also note:
API keys CAN carry org-set expiry (CC shows remaining days) — check before an
overnight parallel sweep; mid-run expiry = fail-fast 401, ab resumes, run loses
in-flight tasks only.

## Pending decisions (not started, need a go)
- **Phase-0 re-run** (MacBook, overnight ~7h): strengthen `SELF_CHECK_INSTRUCTION`
  in `opencode-plugin/src/bench/self-score.ts` (force compliance + honest
  fractions — current one yields 26% capture, all-1.0 claims), then re-run the
  43-task `--self-check` night and re-check the gate.
- **Seed corpus** (`docs/external-prompts-cc-opencode.md`): measure-first — only
  after loop-1's `ab` verdict shows what propose finds on its own.

## Bigger map
`docs/INDEX.md` → all design docs. The prompt-mining plan
(`docs/superpowers/plans/2026-07-14-cc-opencode-prompt-mining.md`) was EXECUTED
2026-07-15→16 (see "Landed overnight" above) — no saved-but-unexecuted plans remain.
