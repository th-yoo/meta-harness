# Fleet integration — meta-harness side (primitives + one-squad E2E)

## Context

The OpenClaw dev-fleet (`~/z2/oc-test`, briefing `docs/fleet-context.md`) drives four opencode role personas (analyzer/designer/implementer/evaluator) through design→build→evaluate with human gates. Integration: fleet roles become **evolvable meta-harness roles**; fleet gates emit **fitness scores**. User's model: a **node** = agent | **squad** {analyzer, designer, implementer, evaluator}; **any slot can itself be a node** (fractal recursion); **one evolvable store per role NAME** across all depths — node path/depth is provenance on records, never a store split. First slice: meta-harness primitives + one depth-1 squad E2E. **oc-test stays read-only** (gets a recipe doc; master wiring is fleet-side later). A demo script stands in for the master.

Decisive facts (explored + verified):
- Fleet drive seam is aspirational (no code shells `opencode run`; prompt-eval harness pattern: `opencode run --agent <name> "<input>"`, stdout=payload, fresh session per drive) — meta-harness defines the primitive.
- Plugin-captured headless sessions record NOTHING (5-min score timeout → discard, score.ts:59-69, engine.ts:496-501; session id unexposed). **Bypass the plugin**: bench pattern — synthesize id, parse NDJSON (`drivers/opencode.ts parseOutput`), record via `recordToStores` (bench/record.ts:281).
- Fleet roles are self-contained `.opencode/agent/*.md` monoliths (mode:all, pinned models, permission blocks, **fixed greppable payload headings** + `VERDICT: PASS|FAIL` = inter-role wire contract).
- `runJudgeOpencode` (opencode-run.ts:92-106) already proves headless host-side `opencode run --agent` with a custom persona — and provides the **fallback mechanism** (opencode.json `agent.<name>.prompt` block) if the agent-md-body assumption fails.
- meta-harness becomes the **renderer** of role agent-md files from evolvable layers — no plugin in fleet targets.

## Tasks

### T0 — Live probe (controller-run, ~15 min, 2-3 haiku calls, BEFORE any code)
Scratch dir, minimal opencode.json (provider only, NO plugin):
1. **Body composition** (load-bearing): `.opencode/agents/mh-probe.md` mode:all with marker body → `opencode run --agent mh-probe --format json "say hi"` → marker in reply? Pass → T1 renders md bodies. Fail → T1 renders opencode.json `agent.prompt` blocks (mh-judge mechanism, judge-audit.ts:216) — only render.ts's output target changes.
2. **--model precedence**: CLI `--model` must beat frontmatter (settles model source of truth: manifest frontmatter = truth; `role-run --model` = explicit override).
3. **--auto vs permission:deny**: deny-role must stay denied under `--auto` (fleet's read-only roles depend on it); else role-run drops `--auto` for deny roles.
Also capture one real multi-turn NDJSON trace for T3 fixtures. Record outcomes in T6 doc.

**T0 RESULTS (run 2026-07-13, ~$0.03):**
1. **PASS** — agent-md body IS the system prompt headlessly (marker obeyed). T1 renders md bodies; no fallback needed.
2. **PASS** — CLI `--model` beats the frontmatter pin (proven via step_finish cost math: haiku pricing on a sonnet-pinned agent). Manifest = truth, `--model` = override, confirmed.
3. **PASS with correction** — `permission: deny` HOLDS under `--auto`, but the key is **`bash`, not `shell`**. The fleet's role files use `shell:` — opencode silently ignores it, so **the fleet's read-only enforcement is currently broken upstream** (flag in T6 recipe; our manifest uses correct keys).
4. **BONUS — real sessionID is free**: every `--format json` NDJSON event carries the genuine opencode `sessionID` (`ses_…`), and `step_finish` carries per-step `tokens` + `cost`. T3 therefore uses the REAL session id (extracted from any event) instead of synthesizing one — better provenance, and cost/token telemetry can ride the pending file for free.

### T1 — Role manifest + `roles-render` (+ contract lint) (~1d)
- NEW `opencode-plugin/src/fleet/roles.ts`: `FLEET_ROLES: RoleSpec[]` — per role: `agent` ("mh-analyzer"…, mh- prefix keeps interactive-plugin compat), `frontmatter` {description, mode:"all", model, temperature, permission} lifted verbatim from oc-test personas (analyzer opus/0.2 read-only; designer 0.3; evaluator 0.1 +shell; implementer sonnet/0.1 +edit/write/shell), `requiredHeadings: string[][]` as OR-groups (analyzer: [["## Use Cases","## Functional Spec"],["## Clarify"]]; evaluator: test-spec vs VERDICT modes).
- NEW `fleet/render.ts` + cli subcommand `roles-render --project <dir> [--role r]... [--pin LAYER=vN]... [--force]`: per role — `layerStoreRoots("global", agent, project)` + `parsePins` (record.ts:56,73 reused) → `composeHarness`+`renderAgentsMd` (compose.ts) → **lint** (die listing missing heading-groups; `--force` for deliberate contract changes) → write `<project>/.opencode/agents/mh-<role>.md`: hand-serialized frontmatter + **render stamp** HTML comment (`<!-- mh-render {versions per layer, harnessHash, renderedAt} -->`) + body. Atomic write (add `writeTextAtomic` sibling in bench/util.ts). Idempotent.
- The stamp is the attribution backbone: T4 scores route to the exact versions that ran, via recordToStores' `pins` param (record.ts:308) — immune to activation drift between render and score.
- Tests (hermetic tmp project + META_HARNESS_HOME): frontmatter byte-exactness, body parity with assembleAgentsMd, stamp round-trip, idempotence, --pin renders candidate, lint refuse + --force, unknown role dies.

### T2 — `roles-import`: fleet monoliths → account-role v1 (~0.5d)
- NEW `fleet/import.ts` + subcommand `roles-import --from <dir> [--role r]... [--force]`: per role — read `<from>/<role>.md`, `stripFrontmatter`, verify manifest still matches source frontmatter (warn on drift), `createCandidate(accountRoleRoot(agent),"v1",body)` + `writeActive` (harness-store.ts:630,570). Body verbatim (contract intact; SOUL/voice dedup = follow-up). Refuse if active non-empty unless `--force`.
- Account layer because roles span ~5 projects; project-role stays for per-repo adaptation.
- Tests: synthesized fixture personas (real heading set, NOT oc-test copies) under test/fixtures/fleet/; strip, v1+active, refuse/force, drift warning.

### T3 — `role-run`: headless drive + capture (~1-1.5d)
- NEW `fleet/pending.ts`: `FleetPendingSession` {id, role, agent, project, model, turnCount, toolUsage, events, payload, nodePath?, sliceId?, renderStamp?, agentVersion, pluginSha, ts}; `pendingDir = <project>/.meta-harness/runtime/fleet`; write (writeJsonAtomic) / read (die actionable) / archive (→ scored/); id sanitization per cc file-state.
- NEW `fleet/run.ts` + subcommand `role-run --project <dir> --role <r> [--model m] [--node-path p] [--slice-id s] [--timeout-sec n] [--json] (--input-file f | "input")`:
  - Verify rendered agent md exists (die "run roles-render first"); parse its stamp.
  - id = the REAL opencode sessionID extracted from any NDJSON event (`ses_…`, per T0 result 4); fallback to synthesized `fleet-<role>-<epochSec>-<hex3>` (cmd-run.ts:131 pattern) only if extraction fails. Also lift per-step `tokens`/`cost` from `step_finish` into the pending file. Spawn `["opencode","run","--dir",project,"--agent",agent,"--auto","--format","json",...model,input]` (runJudgeOpencode shape; injectable execFn).
  - Classify via `opencodeDriver.classifyAttempt`: auth → die with authHint; transient → die "re-drive" (**no retry loop — master owns retries**); timeout → die. Parse via `opencodeDriver.parseOutput`. `turnCount===0` → die, write nothing.
  - `extractFinalPayload(ndjson)`: last step_finish-delimited segment's joined text (final message IS the payload — fleet contract; judgeReplyText's join-all is wrong for multi-turn roles). `--payload full` escape hatch.
  - Output: payload → stdout, `id:` line → stderr; `--json` → {id, payload, turnCount, toolUsage} envelope (recommended to the master).
  - Warn if target opencode.json loads a meta-harness plugin (double-injection + idle-hang hazard); plugin-off in targets is the documented requirement.
- Tests (injectable execFn + NDJSON fixtures incl. the T0-captured real trace): argv, payload extraction (single/multi-turn/trailing-step_finish), pending shape + stamp passthrough, 0-turn refusal, error paths, --json, missing-render die.

### T4 — `role-score`: headless fitness entry (~0.5d)
- NEW `fleet/score.ts` + subcommand `role-score --project <dir> --id <id> good|bad [--note] [--node-path p] [--gate gate1|gate2|verdict]`:
  - readPending (die listing pending ids if missing; `scored/<id>` exists → die "already scored").
  - env = {driver:"opencode", agentVersion, pluginSha, harnessHash, fleet:{nodePath, sliceId, gate}} — free-form SessionRecord.env; arbitrary-depth nodePath (`root/slice-42/implementer.squad/analyzer`) is provenance-only (fractal contract preserved).
  - `recordToStores(sliceId??role, id, passed, turnCount, toolUsage, model, "", "global", project, false, agent, stampVersionsAsPins, env, events, false)` — stamp versions as pins = exact-candidate attribution; platform:"opencode" auto from env.driver; failure trajectories handled by recordToStores.
  - archivePending.
- Master usage: Gate① → score analyzer; Gate② → designer; VERDICT → implementer; evaluator scored on payload well-formedness for now (verdict-vs-merge meta-scoring = follow-up).
- Tests: records in all 4 layers of the right role store on the STAMPED version (not since-activated), fleet provenance + platform present, double-score refused, missing id die, archived.

### T5 — Squad-demo E2E (~1d)
1. **Hermetic pipeline test** (CI, zero tokens): tmp everything; import(fixtures) → render → drive analyzer→designer→evaluator(test-spec)→implementer→evaluator(verdict) via cmdRoleRun with per-role fixture NDJSON (payloads carry real headings + `VERDICT: PASS`) → parse `/^VERDICT:\s*(PASS|FAIL)\s*$/m` → score all 5 with distinct --gate/--node-path `root/demo-slice/<role>` → assert 5 records across 4 role stores, provenance, score.json counts.
2. **Live smoke** `smoke/fleet/squad-demo.sh` (controller-run): import from real oc-test (read-only) → fixture repo + tiny slice ("add slugify() + test") → drive the 5 steps with `--json --model <haiku-class>` piping payloads via --input-file (script = master stand-in, auto-approves gates) → score → print per-store score.json counts (propose threshold trajectory). ~5 haiku-class runs.

### T6 — `docs/fleet-integration.md` (~0.5d)
Node/squad grammar (node := agent | squad; any slot recursive; nodePath convention, provenance-only, one store per role name at every depth); master's contract (re-run roles-render on activation — idempotent; role-run --json per drive; role-score per gate/verdict); target prerequisites (opencode.json provider, host auth, **no meta-harness plugin**, `.opencode/agents/` vs fleet's singular `agent/` note); contract-change procedure (edit manifest requiredHeadings + --force); ab path (`--pin account-role=vN` on a drive subset → stamp routes scores → existing trial/ab machinery); T0 probe results; troubleshooting. Mermaid squad-loop diagram.

## Reuse (no engine/adapter edits anywhere)
compose.ts; drivers/opencode.ts (parseOutput/classifyAttempt/authHint); bench/record.ts (layerStoreRoots, parsePins, recordToStores, envBlock provenance helpers); harness-store.ts (roots, createCandidate/writeActive, SessionRecord.env); runJudgeOpencode spawn shape + fallback mechanism; writeJsonAtomic (+ new writeTextAtomic); cc file-state pending-file discipline; cli.ts subcommand pattern (only existing file materially edited, + tiny util.ts addition).

## Sequencing / sizing
T0 → T1 → T2 → T3 → T4 → T5 → T6, each green on main (pure additions). ~5-6 solo days, ~35-45 new tests, 728 existing untouched by construction.

## Risks
1. Agent-md-body composition — probed first; proven fallback (agent.prompt block) changes only render output target.
2. --auto vs permission:deny — probed; fallback drops --auto for deny roles.
3. Payload extraction mis-slicing — real-trace fixtures + `--payload full` escape hatch.
4. Attribution drift — solved structurally (stamp→pins).
5. Evolution breaking wire contract — render lint (hard) + selection gate (soft); content-degradation is what the fitness loop is FOR.
6. oc-test installer rework — no coupling (master just shells three subcommands).

## Verification
- Suite green + tsc clean per task; hermetic tests only (tmp worktrees, META_HARNESS_HOME, injectable spawn — L2 lesson enforced).
- T0 probe results recorded before T1 builds on them.
- T5 live smoke = acceptance: one real squad chain, 5 scored records, fractal provenance, wire format intact hop-to-hop, propose counters advancing.

## Follow-ups (out of slice)
Evaluator meta-scoring (verdict vs merge outcome, judge-audit mirror); runtime payload lint v2; SOUL/voice dedup into account-global; recursive depth>1 orchestration (primitives already carry arbitrary nodePath); oc-test master-doctrine wiring + runbook; auto re-render on activation; role-run retry flag; trial-threshold sanity for gate-frequency scoring.
