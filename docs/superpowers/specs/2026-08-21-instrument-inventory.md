# Instrument inventory — cc-gate-plugin/src (2026-08-21)

Task M1 of `.superpowers/sdd/2026-08-21-instruments-convergence-migration/`.
`cc-gate-plugin/` is READ-ONLY here; this is a read-only survey feeding K2's
gate and the future back-port plan.

**Rubric (fixed, applied verbatim — no per-instrument invention):** an
instrument is **migrate-now** iff (a) it has a live measurement record
produced by deployed code (emission files, dogfood-log entries — a pointer to
actual bytes, not a memory claim; POINTER-OR-INADMISSIBLE), (b) it never
alters a `GateDecision` (annotate/observe/spawn only), and (c) its runtime
code can satisfy kkamak's zero-dependency rule, possibly behind a transport
port. Otherwise **lab-only** (experiment machinery, unproven, or dep-bound)
or **dead**.

## Step 1 — enumeration method

Every file under `cc-gate-plugin/src/` **outside** `core/`, `config.ts`,
`hook-cli.ts`, `state.ts`, `types.ts`, `output.ts`, `check-runner.ts`,
`init-cli.ts`, found by `find cc-gate-plugin/src -type f -name "*.ts"`
(recounted 2026-08-21 after fix round 1): **39 candidate `.ts` files**,
grouped below into **15 rows** — the 12 named in the M1 brief, plus
`rule-checks.ts` (found by Step 1's enumeration, not named in the brief),
plus the brief's single "gauge/ runtime subset" row split into two
(core / transport, Flag #2) plus `gauge/corpus-store.ts` broken out as its
own row (fix round 1, Flag #4 — missed in the first pass; see "file-coverage
arithmetic" below for the re-runnable count).

## Verdict table

| instrument | files | live evidence (pointer) | decision-neutral? | external deps | verdict |
|---|---|---|---|---|---|
| **gauge/ runtime — core** | `gauge/channel.ts`, `classifier.ts`, `evaluate.ts`, `files.ts`, `guard.ts`, `nudge.ts`, `send-prompt.ts`, `shadow.ts`, `spawn.ts`, `validate.ts` (10 — `state-resolve.ts` moved OUT to the experiment-subset row in fix round 1, see Flag #4) | `~/z2/kkamak/.km/gauge/*.done.json` → **50 files** (`ls ... \| wc -l`); wired live via `hook-cli.ts:23-28` (`maybeSpawnGauge`, `decideNudge`, `shadowEvaluateAtStop`) | **Yes** — shadow-mode by construction (`guard.ts:1-3`: "Shadow mode means the check cannot change a GATE DECISION"); `hook-cli.ts:321-323`: "Sensor append never changes the decision... runs AFTER the decision is final" | **Zero runtime** — all 10 files import only `node:*` builtins and in-repo modules at the VALUE level (verified: `grep -n "^import"` on each). One exception is type-only, not runtime: `send-prompt.ts:36` `import type { WarmIsolation } from "@th-yoo/cc-api-daemon"` — the module's own header states this must stay `import type` so "no value from the barrel enters this module's runtime graph," i.e. it erases at compile and costs zero RUNTIME dependency. It is still a compile-time reference to the banned package name, so K-lane must replace it with a locally-declared type (kkamak will not have `@th-yoo/cc-api-daemon` in `node_modules` at all) rather than copy the line verbatim | **migrate-now** |
| **gauge/ runtime — transport** | `gauge/transport.ts`, `gauge/agent-transport.ts`, `gauge/channel-run.ts` (3) | same `.done.json` evidence as above (these files are what *produce* the gauge calls the core consumes) | Yes (same shadow-mode discipline; transport failures fail-open, never touch decision) | **External** — `transport.ts:19` `import Anthropic from "@anthropic-ai/sdk"` (1 hit); `agent-transport.ts:112` `await import("@anthropic-ai/claude-agent-sdk")` (dynamic); `channel-run.ts` rides `transport.ts`'s `sdkCall`. Both packages are the ones global-constraints.md explicitly bans (`@anthropic-ai/sdk`) or bans by extension (Agent-SDK, same family, same "zero runtime dependencies" clause) | **lab-only (dep-bound) — NOT directly portable.** Must be reimplemented as a fresh CLI-spawn provider behind `send-prompt.ts`'s port (global-constraints.md: "LLM calls go through an extension-local transport port; only the CLI-spawn provider is ported") — no such CLI-spawn provider exists yet in this tree (checked: only `anthropic-api.ts` [HTTP SDK] and `anthropic-cli-warm.ts` [ACP daemon] exist under `gauge/providers/`; neither is a bare-CLI-spawn implementation) |
| **gauge/ experiment subset** | `gauge/cls-ab.ts`, `paired-validation.ts`, `corpus-mine.ts`, `corpus-replay.ts`, `replay-cli.ts`, `refiner.ts`, `refiner-cli.ts`, `state-resolve.ts` (8 — `state-resolve.ts` added here in fix round 1: `grep -rln "state-resolve" .` shows its ONLY importer is `gauge/replay-cli.ts`; it is never imported by `hook-cli.ts`, `gauge/shadow.ts`, `gauge/spawn.ts`, or `gauge/nudge.ts`, so it belongs in the offline mine→derive→resolve→report pipeline, not the live core — see Flag #4, a self-caught correction of the original doc) | Evidence exists but **only in the lab's own dogfood store**: `~/z2/meta-harness/.km/gauge-cls-ab/` = 8 entries, `.km/gauge-corpus/` = 1, `.km/gauge-corpus-shadow/` = 2 (`ls | wc -l`, run 2026-08-21). **Zero** equivalent dirs in `~/z2/kkamak/.km/` (`ls` → No such file or directory ×2) | N/A (offline batch CLIs, never called from `hook-cli.ts`'s live Stop path — confirmed: none of the 8 filenames appear as an import in `hook-cli.ts`) | Downstream of `transport.ts`'s `@anthropic-ai/sdk` import (via shared `sdkCall`) | **lab-only** (confirms brief's prior) |
| **gauge/corpus-store.ts** | `gauge/corpus-store.ts` (1 — missing from the original table; fix round 1 Flag #4, CRITICAL finding) | `~/z2/meta-harness/.km/gauge-corpus/records.ndjson` = **410 lines, 2,187,641 bytes**, real corpus records (`{"provenance":"corpus-transcript","stage":"resolved","repo":"/home/th-yoo/z2/kkamak","sessionId":"ddaa7162-...",...}`, mtime 2026-08-04). Absent from `~/z2/kkamak/.km/` (`ls ~/z2/kkamak/.km/gauge-corpus/` → No such file or directory) | **Yes** — pure storage layer, own header: "Single append/rewrite target for the whole mine -> derive -> resolve -> report pipeline"; `grep -ni "decision\|block\|accept" gauge/corpus-store.ts` → **0 hits** | **Zero runtime** — `gauge/corpus-store.ts:34-36`: `import fs from "node:fs"`, `import path from "node:path"`, `import type { GaugeFile } from "./files.ts"` (in-repo, type-only) — no external package reference at all, not even type-only | **lab-only** — individually clears all three rubric legs, but `grep -rln "corpus-store" .` shows every one of its importers (`corpus-mine.ts`, `corpus-replay.ts`, `replay-cli.ts`, `channel-run.ts`, `cls-ab.ts`, `paired-validation.ts`, `state-resolve.ts`) is itself lab-only offline mine→derive→resolve→report tooling, never wired into `hook-cli.ts`'s live Stop path. Nothing in the migrate-now set calls it — migrating a storage layer with zero live callers in kkamak would ship dead code, so it tracks its callers rather than migrating standalone. If any offline tooling in this family is later promoted, this file promotes with it (same live-evidence pointer, same zero-dep profile) |
| **gauge/providers/*** | `providers/anthropic-api.ts`, `providers/anthropic-cli-warm.ts` (2) | `anthropic-api.ts` is a thin `SendPromptProvider` wrapper around `transport.ts`'s live-evidenced `sdkCall`; `anthropic-cli-warm.ts` has no independent live-emission pointer found (not imported by `hook-cli.ts` or any spawn seam) | Yes (both are pure request/response wrappers, no decision access) | `anthropic-api.ts`: imports `transport.ts` (→ `@anthropic-ai/sdk` transitively); `anthropic-cli-warm.ts:42-43`: `import { ensureDaemon, daemonCall } from "../../acp-client-singleton.ts"` + `import { modelProvenBy, ACP_BUDGET } from "@th-yoo/cc-api-daemon"` — the second package global-constraints.md bans by name | **lab-only (dep-bound)** — both providers require a package kkamak's zero-dependency rule forbids; neither is the (not-yet-existing) CLI-spawn provider |
| **review-sensor/ (+spawn)** | `review-sensor/core.ts`, `review-sensor/git-diff.ts`, `review-sensor/runner.ts`, `review-sensor-spawn.ts` (4) | Ships OFF by default: `review-sensor-spawn.ts:33` `if (env.KKAMAK_REVIEW_SENSOR !== "1") return false`. Live evidence exists **only where manually armed** (lab dogfood, this repo): `~/z2/meta-harness/.km/review-findings.ndjson` = 982 lines, `.km/review-sensor-state.json` = `{"lastPassTs":1787307055089,...,"dayKey":"2026-08-21","dayCount":27}` (mtime 2026-08-21, today). **Zero** trace in `~/z2/kkamak/.km/` (`review-findings.ndjson`, `review-sensor-state.json` both absent). `docs/techs.md:391`: "review-sensor moves from unbuilt to built-and-held (arming = user decision)" | Yes — `review-sensor-spawn.ts` header: "best-effort... the gate check plus one spawn call, nothing else"; findings are annotate-only | `runner.ts:38,45`: `import { modelProvenBy, type WarmIsolation } from "@th-yoo/cc-api-daemon"` + `import { ensureDaemon, daemonCall, closeSession } from "../acp-client-singleton.ts"` — banned package | **lab-only** (confirms brief's prior — built, ships OFF, never armed in the deployment target, and dep-bound in its execution path) |
| **prompt-check** | `prompt-check-cli.ts`, `prompt-check-spawn.ts` (2) | `~/z2/kkamak/.km/gate-outcomes.ndjson`: real lines carry `"promptCheck":true,"spawnTs":...` (confirmed via `python3 -m json.load` over all 87 lines — key set includes `promptCheck`, `spawnTs`, `skippedStop`); also `~/z2/kkamak/docs/dogfood-log.md:482`: "skippedStop 1, nonCycleLines 1 (promptCheck, spawnTs 1786065473715)" | Yes — `prompt-check-cli.ts` header: "fabricates ONE sensor line via the frozen `buildSensorLine` core builder (CALLED, never edited)"; `prompt-check-spawn.ts` header: "accompany skippedStop, never replace it" | **Zero** — `prompt-check-spawn.ts` imports only `node:fs`, `node:path`, in-repo `types.ts`; `prompt-check-cli.ts` imports only in-repo `config.ts`, `sensor-append.ts`, `check-runner.ts`, `core/sensor.ts`, `types.ts` | **migrate-now** |
| **sidecar.ts** | `sidecar.ts` (1) | `~/z2/meta-harness/.km/check-output.ndjson` = 22 lines, real check-output excerpts (`{"ts":1787200310958,...,"check":"bun scripts/gate-check.ts","excerpt":"gate-check: tier0 suites..."}`, mtime 2026-08-20). Not yet present in `~/z2/kkamak/.km/` (expected pre-migration) | Yes — own header: "Phase 1 check-output sidecar (evidence-only... capture the failing check output the block branch otherwise discards. PRE-reinject" | **Zero** — `node:fs`, `node:path` only | **migrate-now** |
| **sensor-append.ts** | `sensor-append.ts` (1) | This is the append call that produces `gate-outcomes.ndjson` itself: `~/z2/kkamak/.km/gate-outcomes.ndjson` = 87 lines; `~/z2/meta-harness/.km/gate-outcomes.ndjson` = 1017 lines | Yes — append happens post-decision (`hook-cli.ts` calls it after the accept/block branch resolves) | **Zero** — `node:fs`, `node:path`, in-repo `config.ts`/`types.ts` | **migrate-now** — NOTE: kkamak's kernel already emits an equivalent frozen-contract stream independently (global-constraints.md: "kkamak's sensor schema deliberately mirrors cc-gate-plugin"); K-lane must reconcile the extension-added fields (`gauge`, `reinject`, `promptCheck`, etc.) against the existing kernel appender rather than replacing it wholesale |
| **reinject.ts** | `reinject.ts` (1) | `~/z2/kkamak/.km/gate-outcomes.ndjson`: real `"reinject":"v0"` / `"v1"` values present with **no accompanying `"forced"` key** on those lines (checked across all 87 lines) — i.e. the 50/50 wording split runs unconditionally in production, not only when `KKAMAK_REINJECT` is set | Yes — verified by reading source: `applyReinjectVariant` only rewords the *tail* of an already-decided block message (`v0`=kernel text verbatim, `v1`=composed from `rawOut`, `v2`=v1 + gap headline); it never touches whether the gate blocks or accepts | **Zero** — `reinject.ts` has **no import statements at all** (pure functions: FNV-1a hash + string templates) | **migrate-now — ⚠ CONTRADICTS BRIEF'S STATED PRIOR, FLAGGED FOR CONTROLLER** (see note below) |
| **score.ts / score-cli.ts** | `score.ts`, `score-cli.ts` (2) | `~/z2/meta-harness/docs/resume.md:5950,6063`: documented live invocations, `bun cc-gate-plugin/src/score-cli.ts` rendering `M-catch/M-exhaust/M-interrupt/M-tax` classes against real sensor data, `MIN_N=20 LOCKED by user`; `resume.md:5934`: "scorecard + reinject A/B LIVE"; `docs/2026-08-01-gauntlet-adoption-ledger.md:13`: "score-cli render dropped v2 arm" (a round-1 test failure against real output, later fixed) | Yes — `score.ts` header: "PURE: no fs, no process"; `score-cli.ts` header: "READ-ONLY: never writes, never adopts" | **Zero** — `score.ts` imports only in-repo `types.ts`; `score-cli.ts` imports `node:fs`, `node:path`, in-repo `score.ts` | **migrate-now** |
| **hook-rule-outcomes.ts** | `hook-rule-outcomes.ts` (1) | **None found.** Searched: `hookRules` key in `~/z2/kkamak/.km/gate-outcomes.ndjson` → 0 hits; same key in `~/z2/meta-harness/.km/gate-outcomes.ndjson` → 0 hits; `find ... -name "hook-rule-outcomes-*.ndjson"` in both repos → no files | Yes by design (own header: fail-open, "absent key is the cleaner line") | Zero (`node:fs`, `node:path` only) | **lab-only (unproven — no live pointer)**. Note: its own header states the producer is a *different* plugin ("opencode-plugin", PreToolUse dispatch side) that cc-gate-plugin does not own and kkamak has no equivalent of — even if armed, kkamak would have no producer for this file to consume |
| **fixture-ref.ts** | `fixture-ref.ts` (1) | `~/z2/meta-harness/.km/fixture-refs.ndjson` = 22 lines, real git data (`{"ts":1787200310958,...,"headSha":"39613c7e...","treeSha":"2db3c40e...","ref":"refs/kkamak/fixtures/...","transcriptPath":"/home/th-yoo/.claude/projects/..."}`, mtime 2026-08-20). Also referenced (read-side) by `gauge/state-resolve.ts` | Yes — captures block-time git refs for later fixture harvest, does not gate | **Zero** — `node:fs`, `node:os`, `node:path` only | **migrate-now** |
| **acp-client-singleton.ts** | `acp-client-singleton.ts` (1) | Consumed by `gauge/providers/anthropic-cli-warm.ts` and `review-sensor/runner.ts`, both of which have partial lab-only live evidence (see their rows) | Yes (a connection-pooling utility, no decision access) | **External by definition** — its entire purpose is funneling every consumer onto ONE `@th-yoo/cc-api-daemon` process (`import { ... } from "@th-yoo/cc-api-daemon"` at line 50-ish); this is the banned package itself, not merely a transitive user of it | **lab-only (dep-bound)** — cannot satisfy zero-dependency rule even behind a port; the "port" here IS an external daemon process |
| **rule-checks.ts** | `rule-checks.ts` (1) — **not named in the brief's expected-rows list; found by Step 1's artifact enumeration** | **None found.** Searched: `ruleChecks` key in both repos' `gate-outcomes.ndjson` → 0 hits each; `find ... -name "rule-checks.json"` in both repos → no files | Yes by explicit design — own header: "SHADOW: outcomes annotate the sensor line only; this module has no access to, and no effect on, the Stop decision" | Zero own imports beyond in-repo `gauge/guard.ts` (re-screens commands via `unsafeReason`) | **lab-only (unproven — no live pointer)** |

## Flags for the controller

1. **`reinject.ts` contradicts the brief's stated prior.** The brief expected
   lab-only because `KKAMAK_REINJECT` looked like an opt-in experiment flag.
   Reading the source (`reinject.ts:70-77`) and the live data together shows
   the opposite: the 50/50 v0/v1 wording split runs **unconditionally** in
   production (no env var needed); `KKAMAK_REINJECT` only *forces* a specific
   arm for testing, and forcing stamps a `forced:true` flag that is **absent**
   on every real line in `~/z2/kkamak/.km/gate-outcomes.ndjson`. Per rubric
   (a) live evidence, (b) decision-neutral (wording only, never the
   accept/block boolean), (c) zero imports at all — this verdicts
   **migrate-now**. I did not find a formally specified "halt condition"
   procedure elsewhere in the plan directory (`global-constraints.md`,
   `progress.md`, other task briefs) to execute automatically, so I am
   surfacing this as a flagged row rather than silently overriding the
   brief's prior or silently accepting it. Recommend the controller confirm
   before K-lane treats reinject as lab-only-and-skip.
2. **`gauge/ runtime subset` needed to be split.** The brief's "expected
   rows at minimum" lists it as one row, and the live-evidence half of the
   prior (`.done.json` emissions) does hold. But 3 of the 13 files
   (`transport.ts`, `agent-transport.ts`, `channel-run.ts`) carry the exact
   external dependencies (`@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`)
   that `global-constraints.md` bans outright — they cannot migrate as literal
   ports. I split the row into "core" (10 files, migrate-now) and "transport"
   (3 files, lab-only/needs-reimplementation) rather than forcing one verdict
   onto files with materially different dependency profiles. **This directly
   answers the downstream-gating question: yes, gauge's runtime subset is
   migrate-now for its decision-neutral annotate/evaluate logic; the SDK-based
   transport files are not directly portable and need a fresh CLI-spawn
   provider built against `send-prompt.ts`'s existing port interface (which
   itself has zero runtime imports — one type-only reference to
   `@th-yoo/cc-api-daemon` that erases at compile, see row 1's evidence
   cell — and is migrate-now as the port shape).**
3. **`sensor-append.ts` overlaps kkamak's existing kernel appender.** Verdict
   is migrate-now on rubric grounds, but K-lane needs to reconcile field-level
   additions against kkamak's own frozen-contract sensor stream rather than
   installing a second appender.
4. **Fix round 1 (2026-08-21): `gauge/corpus-store.ts` had no row — CRITICAL
   finding, self-verified.** `find cc-gate-plugin/src -type f -name "*.ts"`
   minus the excluded set is 39 files; the original table's rows summed to
   38. Added as its own row (above); verdicted lab-only per the rubric
   applied to its actual import list (`node:fs`, `node:path`, one in-repo
   type-only import — zero external deps at any level) and its actual
   caller list (all 7 importers are lab-only offline tooling). While
   tracing that caller list I found a second, self-caught error: the
   original table placed `gauge/state-resolve.ts` in the migrate-now
   "core" row, but `grep -rln "state-resolve" cc-gate-plugin/src --include="*.ts"`
   shows its **only** importer is `gauge/replay-cli.ts` (an experiment-subset
   CLI) — it is never imported by `hook-cli.ts` or any file on the live
   Stop path (`shadow.ts`, `spawn.ts`, `nudge.ts` all checked, none
   reference it). `state-resolve.ts`'s own header confirms this: "km-gauge
   corpus-replay execution-state resolver... mine -> derive -> resolve ->
   report pipeline, stage 3." This was not one of the review's 2 reported
   findings — I corrected it because leaving a known-disproven row-membership
   claim in the doc after discovering it, while fixing an adjacent finding
   on the same seam, would repeat the exact failure mode this repo's method
   rules warn against (a claim not checked against the artifact). Moved to
   the experiment-subset row; core dropped from 11 to 10 files.

## File-coverage arithmetic (re-runnable)

```
$ find cc-gate-plugin/src -type f -name "*.ts" | \
    grep -vE "^cc-gate-plugin/src/(core/(classify|edits|prompt|round|sensor|stop)\.ts|config\.ts|hook-cli\.ts|state\.ts|types\.ts|output\.ts|check-runner\.ts|init-cli\.ts)$" | \
    wc -l
39
```

Row-by-row file counts, summed: gauge/ runtime — core (10) + gauge/ runtime
— transport (3) + gauge/ experiment subset (8) + gauge/corpus-store.ts (1)
+ gauge/providers/* (2) + review-sensor/ (+spawn) (4) + prompt-check (2)
+ sidecar.ts (1) + sensor-append.ts (1) + reinject.ts (1) + score.ts/
score-cli.ts (2) + hook-rule-outcomes.ts (1) + fixture-ref.ts (1)
+ acp-client-singleton.ts (1) + rule-checks.ts (1)
= 10+3+8+1+2+4+2+1+1+1+2+1+1+1+1 = **39 = 39 candidates.**
Every candidate file appears in exactly one row (checked by hand against
the `find` listing above); no file appears in two rows and none are
missing.

## Evidence commands run (verbatim, Step 2 of the brief)

```
$ ls ~/z2/kkamak/.km/gauge/*.done.json | wc -l
50

$ ls ~/z2/meta-harness/.km 2>/dev/null
cc-gate  channel-chain.log  check-output.ndjson  fixture-refs.ndjson  gate-bg
gate-outcomes.ndjson  gauge  gauge-cls-ab  gauge-corpus  gauge-corpus-shadow
review-findings.ndjson  review-findings-text  review-sensor-state.json
trial-arms.ndjson

$ ls ~/z2/meta-harness/cc-gate-plugin/.km/cc-gate/ | head
1fa631e7-...json  39b387ee-...json  48904a90-...json  6cd78010-...json
9316f954-...json  a384d95d-...json  b6acdcce-...json  d2ce61a4-...json

$ grep -rn "review-sensor\|sidecar" ~/z2/kkamak/docs/dogfood-log.md ~/z2/meta-harness/docs/ --include="*.md" -l | head
docs/2026-07-30-enhancement-roadmap.md
docs/reviews/68d3b6c-p2-judge-logging-plus-sidecar-fix.md
docs/reviews/7a2fec8-sensor-checkpoint-reader.md
docs/2026-07-31-phase2-fixture-registration.md
docs/2026-08-01-gauntlet-adoption-ledger.md
docs/reviews/852ddde-acp-singleton-client.md
docs/reviews/4f113c7-review-sensor-swap.md
docs/techs.md
docs/reviews/8cd568e-acp-decouple-swap-lane-b.md
docs/reviews/a5eeef1-p2-a4-review-swap.md

$ grep -c "cc-api-daemon\|@anthropic-ai/sdk\|acp-client-singleton" \
    gauge/transport.ts gauge/send-prompt.ts gauge/providers/*.ts
gauge/transport.ts:1
gauge/send-prompt.ts:5
gauge/providers/anthropic-api.ts:0
gauge/providers/anthropic-cli-warm.ts:5
```

Additional evidence commands (beyond the brief's Step 2 minimum, needed to
verdict every row against the fixed rubric) are reproduced in the task
report, `task-M1-report.md`, alongside this file.

## b3 continuity — 2026-08-21 (M4)

Purpose: prove the migration-planning work (M1, this doc's fix round 1)
did not disturb the deployed lab plugin or its gauge/b3 emission stream —
`global-constraints.md`'s "b3 continuity" clause: "the installed plugin
cache (`~/.claude/plugins/`, `kkamak-local` → `cc-gate-plugin` @ 0.4.x)
must be untouched; gauge emissions to `.km/gauge/` must continue."

**1. Installed-plugin source check.**

```
$ python3 - <<'EOF'
import json, pathlib
p = pathlib.Path.home() / ".claude/plugins/installed_plugins.json"
d = json.loads(p.read_text())
print(json.dumps({k: v for k, v in d.items() if "kkamak" in k.lower()}, indent=2))
EOF
{}
```

The prescribed one-liner returns `{}` — **not** because kkamak is missing,
but because `installed_plugins.json`'s top level is `{"version": 2,
"plugins": {...}}`, so filtering `d.items()` (the top level) never sees
plugin names; they live one level down in `d["plugins"]`. Re-ran filtering
the correct level:

```
$ python3 -c "
import json, pathlib
d = json.loads((pathlib.Path.home()/'.claude/plugins/installed_plugins.json').read_text())
print(json.dumps({k: v for k, v in d['plugins'].items() if 'kkamak' in k.lower()}, indent=2))
"
{
  "kkamak@kkamak-local": [
    {
      "scope": "user",
      "installPath": "/home/th-yoo/.claude/plugins/cache/kkamak-local/kkamak/0.4.0",
      "version": "0.4.0",
      "installedAt": "2026-08-02T23:00:29.176Z",
      "lastUpdated": "2026-08-06T06:06:19.645Z",
      "gitCommitSha": "4d279812ee2af65ecad0773f804f21cd0e5ac7a0"
    }
  ]
}
```

`installPath` is the plugin CACHE, not the marketplace source — resolved
the source separately from `~/.claude/plugins/known_marketplaces.json`:

```
$ python3 -c "
import json, pathlib
d = json.loads((pathlib.Path.home()/'.claude/plugins/known_marketplaces.json').read_text())
print(json.dumps({k: v for k, v in d.items() if 'kkamak' in k.lower()}, indent=2))
"
{
  "kkamak-local": {
    "source": {
      "source": "directory",
      "path": "/home/th-yoo/z2/meta-harness/cc-gate-plugin"
    },
    "installLocation": "/home/th-yoo/z2/meta-harness/cc-gate-plugin",
    "lastUpdated": "2026-08-02T23:00:27.607Z"
  }
}
```

**Result: matches expected exactly** — `kkamak-local` sources from
`/home/th-yoo/z2/meta-harness/cc-gate-plugin`, installed version `0.4.0`
(within `0.4.x`), `lastUpdated` on both records predates this session
(2026-08-06 / 2026-08-02) — i.e. nothing in M1 or its fix round touched
the plugin's registration or triggered a reinstall. No "anything else"
condition triggered; proceeded.

**2. Gauge emission continuity.**

```
$ ls ~/z2/kkamak/.km/gauge/*.done.json | wc -l
61

$ find ~/z2/kkamak/.km/gauge -name '*.done.json' -newermt '2026-08-21 12:00' | wc -l
20
```

Comparison against the inventory doc's recorded count: the verdict table
above (Step 2 evidence, and row 1's evidence cell) recorded **50** files,
captured earlier today during the M1 task. The count is now **61** — a
**+11 delta**, not a zero delta, so the "report a zero delta with context"
instruction does not apply here; noting it anyway for completeness: this
is a genuine, non-zero increase, meaning gauge-gated sessions kept landing
in kkamak throughout the M1 work and its fix round, including 20 of them
after 12:00 today. This is the expected shape for "undisturbed" — a
frozen or broken stream would show a zero or negative delta; this shows
continued live growth.

**Verdict: UNDISTURBED.** Plugin source, install path, and version are
byte-identical to the pre-M1 baseline (`global-constraints.md`'s "b3
continuity" clause holds); the gauge `.done.json` stream grew by 11 files
(20 in today's post-12:00 window) across the M1 task and its fix round,
confirming the migration-planning work in this repo did not touch the
installed plugin cache or interrupt live gauge emission.
