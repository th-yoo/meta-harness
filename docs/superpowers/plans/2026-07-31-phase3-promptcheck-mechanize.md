# Phase 3 — Async prompt-check Sensor Class + Mechanize-Instead Rubric Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover measurement from queued-prompt-destroyed Stop boundaries via a detached prompt-check runner (registered 5th pre-data amendment, `906d210`), and add the mechanize-instead rubric key to the review gate (roadmap Phase 3.2).

**Architecture:** Two independent halves. (A) At the existing skipped-stop seam in hook-cli (`hook-cli.ts:253-255`), a new spawn module double-forks a detached CLI (gauge `spawn.ts`/`refiner-cli.ts` precedent) that runs the repo's check under the config timeout, then fabricates one `promptCheck:true` sensor line (built by CALLING the frozen `buildSensorLine` and spreading the two new optional fields — `core/` is never edited) and appends it through the same single choke point as every other line. Two small extractions move the append and check-runner seams out of hook-cli into importable modules first. Classification/exclusion ripple (classifyCycle order, join rule 8, `newLineCount` discount) implements the amendment's binding pins. (B) `mechanize_instead` becomes the 5th `RUBRIC_KEYS` entry with an artifact-requiring question; a mechanize violation coerces abstain IMMEDIATELY (revise seat never called — it must not rephrase around mechanizability); the existing rejected ledger already preserves the violation text as the check-candidate log.

**Tech Stack:** Bun + TypeScript; Bun.spawn with SIGTERM→SIGKILL escalation; nohup double-fork detach.

## Global Constraints

- **F1:** NO commit may touch `cc-gate-plugin/src/core/` or `cc-gate-plugin/vendor/` (`km-crank/src/calibration.ts:65-72` MECHANISM_PATHS — also covers `minimal/complete-gate.ts`, `minimal/mutate.ts`, `minimal/spec-probe.ts`, `minimal/session2.ts`; `minimal/review.ts` and `minimal/propose.ts` are OUTSIDE it, confirmed). Calling core functions (`buildSensorLine`) from new files is allowed; editing them is not.
- **F2:** no new file enters `scripts/km-sensors-sync.sh` FILES (prompt-check writes to the EXISTING gate-outcomes stream — that is the point; no new sidecars in this phase).
- **Amendment pins (verbatim law, `docs/superpowers/specs/2026-07-29-trial-mode-gate-outcomes-preregistration.md` 5th amendment):** accompany-never-replace (skippedStop line unchanged, emitted first); spawn DETACHED only, at the hook-cli seam only; `classifyCycle` tests `promptCheck` immediately after `skippedStop` and BEFORE the empty-rounds gauge-only branch; `joinAndExclude` rule 8 (metrics AND density excluded); `newLineCount` discounts prompt-check lines; the line stamps the spawn timestamp (`spawnTs`) for joining.
- **Contract:** golden-vector fixture (kkamak `test/fixtures/sensor-contract.ndjson`, byte-shared) UNTOUCHED; `promptCheck`/`spawnTs` are tolerated-absent optionals like `pluginVersion`/`forced`; the kkamak kernel does NOT implement prompt-check (no cross-repo change).
- Defaults: prompt-check ON whenever a check is configured; kill switch is ENV-ONLY — `KKAMAK_PROMPT_CHECK=off` (gauge `KKAMAK_GAUGE` precedent); NO gate.json flag (`GateConfig` has no such field and this plan does not grow the config surface); per-repo single-flight lockfile with atomic stale takeover (resource guard).
- Vocabulary: no bare standalone "gate" in new docs/comments.
- Suites green after every task: `bun test` + `bunx tsc --noEmit` in `cc-gate-plugin/`, `km-crank/`, and (T5) `opencode-plugin/`.

## File Structure

```
cc-gate-plugin/src/sensor-append.ts      NEW  extracted appendSensor + sensorFilePath + readPluginVersion (single stamp choke point)
cc-gate-plugin/src/check-runner.ts       NEW  extracted timeout-guarded runCheck (SIGTERM→SIGKILL)
cc-gate-plugin/src/hook-cli.ts           MOD  delegate to the two extractions; wire maybeSpawnPromptCheck after skippedStop append (:253-255)
cc-gate-plugin/src/prompt-check-spawn.ts NEW  spawn decision (skippedStop seam, config/env gates, lockfile single-flight)
cc-gate-plugin/src/prompt-check-cli.ts   NEW  detached runner: lock → run check → fabricate line (buildSensorLine + spread) → append → unlock
cc-gate-plugin/src/types.ts              MOD  SensorLine += promptCheck?: true; spawnTs?: number
cc-gate-plugin/src/score.ts              MOD  CycleClass += "prompt-check"; classify order; counts
km-crank/src/trial-verdict.ts            MOD  join rule 8; counts
km-crank/src/scan.ts                     MOD  optional fields on local shape; newLineCount discount
minimal/review.ts                        MOD  RUBRIC_KEYS 5th key; question; immediate-abstain routing in reviewLoop
+ tests beside each (cc-gate-plugin/test/*, km-crank/test/*, opencode-plugin/test/minimal-review.test.ts, review-gate.test.ts)
```

---

### Task 1: extract sensor-append + check-runner seams (extraction + ONE additive change: `ms` timing)

**Files:**
- Create: `cc-gate-plugin/src/sensor-append.ts`, `cc-gate-plugin/src/check-runner.ts`
- Modify: `cc-gate-plugin/src/hook-cli.ts:32` + `:34` (constants `MAX_OUTPUT_BYTES` + `DEFAULT_SENSOR_REL_PATH` move; `GAUGE_CHECK_TIMEOUT_MS` at `:35` STAYS — used only by the retained gauge call at `:327`), `:61-106` (readPluginVersion/sensorFilePath/appendSensor), `:108-179` (buildDeps.runCheck body)
- Test: existing suites are the regression net; plus `cc-gate-plugin/test/sensor-append.test.ts` AND `cc-gate-plugin/test/check-runner.test.ts` (both new, direct units)

**Interfaces:**
- Produces (T2/T3 consume): `sensor-append.ts` exports `DEFAULT_SENSOR_REL_PATH = ".km/gate-outcomes.ndjson"`, `readPluginVersion(): string | undefined` (module-relative `../.claude-plugin/plugin.json`, cached), `sensorFilePath(cwd: string, gateConfigRaw: string | undefined): string` — SIGNATURE UNCHANGED from today's `hook-cli.ts:73-79` (raw JSON string in, `parseGateConfig` inside; a pre-parsed-object signature would be a contract change and would silently break the `sensor:` override if the internal parse were missed), `appendSensor(cwd: string, gateConfigRaw: string | undefined, sensor: SensorLine, log: (m: string) => void): void` — byte-identical behavior to today's `hook-cli.ts:84-106` including the pluginVersion stamp being applied HERE only (single choke point, hook-cli comment preserved). `check-runner.ts` exports `runCheck(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; out: string; ms: number }>` — semantics of `hook-cli.ts:113-179` (Bun.spawn bash -c, SIGTERM at timeout, SIGKILL escalation, stream drain, `capOutput` cap — move `MAX_OUTPUT_BYTES`/`capOutput` here and re-export for hook-cli) PLUS one additive change, honestly scoped as new work: an `ms` elapsed-time field (monotonic wall time around the spawn), which T3's `durationMs` needs. `code` keeps today's `number` type.

- [ ] **Step 1: Write the new unit test** — `test/sensor-append.test.ts`: (a) `sensorFilePath` honors `cfg.sensor` override else default; (b) `appendSensor` appends one JSON line with `pluginVersion` stamped, to a temp cwd; (c) write-failure swallowed (dir-as-file trick, sidecar.test.ts:34-66 pattern), log callback called.

```ts
import { describe, expect, test } from "bun:test"
import fs from "node:fs"; import os from "node:os"; import path from "node:path"
import { appendSensor, sensorFilePath, DEFAULT_SENSOR_REL_PATH } from "../src/sensor-append"

const LINE = { ts: 1, sessionID: "s", check: "true", accepted: true, gateExhausted: false,
  rounds: [] as string[], interrupted: false, marker: false, durationMs: 0, host: "h", app: "claude-code" }

describe("sensorFilePath", () => {
  test("default vs override (raw JSON string in, exactly as hook-cli passes it)", () => {
    expect(sensorFilePath("/x", undefined)).toBe(path.resolve("/x", DEFAULT_SENSOR_REL_PATH))
    expect(sensorFilePath("/x", JSON.stringify({ check: "true", sensor: "custom.ndjson" })))
      .toBe(path.resolve("/x", "custom.ndjson"))
  })
})
describe("appendSensor", () => {
  test("appends one stamped ndjson line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-"))
    appendSensor(dir, undefined, LINE as never, () => {})
    const txt = fs.readFileSync(path.join(dir, DEFAULT_SENSOR_REL_PATH), "utf-8")
    const rec = JSON.parse(txt.trim())
    expect(rec.sessionID).toBe("s")
    expect(typeof rec.pluginVersion === "string" || rec.pluginVersion === undefined).toBe(true)
  })
  test("write failure swallowed + logged", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-"))
    fs.mkdirSync(path.join(dir, ".km"), { recursive: true })
    fs.mkdirSync(path.join(dir, DEFAULT_SENSOR_REL_PATH), { recursive: true }) // path occupied by a dir
    const logs: string[] = []
    expect(() => appendSensor(dir, undefined, LINE as never, (m) => logs.push(m))).not.toThrow()
    expect(logs.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 1b: Write `test/check-runner.test.ts`** — (a) `exit 0` → `{code: 0, ms > 0}`, out captured; (b) `exit 3` → code 3; (c) `echo hi; sleep 30` with `timeoutMs: 500` → resolves within ~2s, nonzero code, `ms` ≈ elapsed (assert `ms >= 400 && ms < 10_000`); (d) output larger than `MAX_OUTPUT_BYTES` is capped.
- [ ] **Step 2: Run both, verify FAIL** ("Cannot find module '../src/sensor-append'" / '../src/check-runner').
- [ ] **Step 3: Create the two modules by MOVING code out of hook-cli** (cut, not copy — hook-cli imports them; keep every comment, incl. the choke-point comment; the ONE addition is the `ms` field, marked with a one-line comment as T1's additive change). `sensorFilePath`/`appendSensor` keep their exact current signatures (raw config string). `buildDeps` keeps its signature; its `runCheck` field becomes a thin wrapper over `check-runner.ts`'s `runCheck` binding `cwd` and the resolved timeout, discarding `ms` (core callers don't consume it).
- [ ] **Step 4: Full suite + typecheck** — `cd cc-gate-plugin && bun test && bunx tsc --noEmit`. Expect 404+3 green; cli.test.ts integration tests are the refactor's real net.
- [ ] **Step 5: Commit** — `git commit -m "refactor(cc-gate): extract sensor-append + check-runner seams from hook-cli (behavior identical)"`

---

### Task 2: SensorLine fields + spawn module + hook-cli wiring

**Files:**
- Create: `cc-gate-plugin/src/prompt-check-spawn.ts`
- Modify: `cc-gate-plugin/src/types.ts` (~:198, beside `skippedStop`), `cc-gate-plugin/src/hook-cli.ts:253-273` (after skippedStop append, beside `maybeSpawnGauge`)
- Test: `cc-gate-plugin/test/prompt-check-spawn.test.ts`

**Interfaces:**
- Consumes: T1's `DEFAULT_SENSOR_REL_PATH` (for lock path convention only), `SensorLine`.
- Produces (T3 consumes): types — `SensorLine` gains `promptCheck?: true` and `spawnTs?: number` (doc comments citing the 5th amendment); `prompt-check-spawn.ts` exports `LOCK_REL_PATH = ".km/cc-gate/prompt-check.lock"`, `maybeSpawnPromptCheck(args: { cwd: string; sessionID: string; sensor: SensorLine | undefined; cfg: GateConfig | undefined; env: Record<string, string | undefined>; now: number; spawn: (cmd: string[]) => void }): "spawned" | "skipped:<reason>"` — `cfg` is the REAL `GateConfig` (`types.ts:72-79`), exactly like the gauge precedent (`gauge/spawn.ts:18`); an ad hoc subset type would not carry `checkTimeoutMs` and would not typecheck against item 3 below. The ENTIRE function body is wrapped `try { ... } catch { return "skipped:error" }` — whole-function fail-open, `maybeSpawnGauge`'s own discipline (`spawn.ts:33-57`); a corrupt lock, parse error, or fs error is a silently dropped spawn opportunity, never a hook error.

Spawn decision (all must hold, in order, each miss returns its `skipped:` reason):
1. `sensor?.skippedStop === true` (the ONLY trigger — amendment: accompany, never replace; the skippedStop line was already appended by the caller).
2. `cfg?.check` non-empty; `env.KKAMAK_PROMPT_CHECK !== "off"`. The kill switch is ENV-ONLY: `GateConfig` has no `promptCheck` field and `parseGateConfig` (`config.ts:3-23`) parses none — a gate.json-level flag would be dead code unless this plan also grew the config surface, which it deliberately does not (YAGNI; the Global Constraints bullet names only the env switch).
3. Lockfile single-flight: `O_EXCL`-create `LOCK_REL_PATH` containing `{"pid":<pid>,"spawnTs":<now>}`. On `EEXIST`: read the lock (a read failure = lock vanished between check and read; an unparseable content = torn write from a killed process — BOTH are treated as stale-equivalent and fall through to the atomic takeover below, NEVER to the outer catch); if its `spawnTs` is younger than `staleMs = (cfg?.checkTimeoutMs ?? 300_000) + 60_000` (derived from the LIVE repo's configured timeout — `checkTimeoutMs` has NO enforced ceiling, `config.ts:17`, so a hardcoded 360s would misclassify a long-configured check as stale mid-run and double-spawn) → `skipped:in-flight`. Stale (or vanished) → ATOMIC takeover: `unlink` the stale lock (ignore ENOENT), then attempt ONE fresh `O_EXCL` create; `EEXIST` on that second create = lost the takeover race to a concurrent event → `skipped:in-flight`, never "overwrite and assume ownership" (a plain overwrite lets N concurrent UserPromptSubmit events — an everyday occurrence in this repo's multi-session fleet usage — each believe they own the lock and each spawn a duplicate runner). The lock is REMOVED by the detached CLI (T3) ONLY if the lock's content still matches its own `spawnTs` (ownership check before unlink — an unconditional unlink could delete a successor's lock after a stale takeover, silently defeating single-flight for a third spawn).
4. Spawn argv: `["bun", path.join(import.meta.dir, "prompt-check-cli.ts"), cwd, sessionID, String(now)]` (module-relative resolution, gauge `spawn.ts:12` precedent), through the injected `spawn` — hook-cli passes its existing nohup double-fork wrapper (`hook-cli.ts:266-273`).

- [ ] **Step 1: Write failing tests** — table-driven over the decision list: fires only when sensor has `skippedStop`; respects env off, missing check; creates lock and returns `spawned` with the injected spawn called once carrying `[.../prompt-check-cli.ts, cwd, sessionID, ts]`; second call while lock fresh → `skipped:in-flight`, spawn NOT called; stale lock (backdated spawnTs) → takeover succeeds and spawns; staleness derives from cfg: with `checkTimeoutMs: 600000`, a lock aged 400s is still `skipped:in-flight` (would be falsely stale under a hardcoded 360s); takeover race: injected fs hook (or pre-creating the lock between unlink and re-create via a wrapped fs — simplest: call the exported takeover step with a colliding `O_EXCL` simulated by pre-creating the file) → `skipped:in-flight`, spawn NOT called; TWO DISTINCT lock-failure cases, each with a PINNED outcome (never "either way"): (a) lock VANISHED between the `EEXIST` probe and the read (deterministic mock-free construction, round-4 reviewer: create the lock path as a DANGLING SYMLINK via `fs.symlinkSync` to a nonexistent target — `O_EXCL` open sees the entry and fails `EEXIST`, the read fails `ENOENT`, exactly "exists at probe, gone at read"; a naive pre-delete would land in the ordinary no-lock path and pass for the wrong reason) → MUST take over and return `spawned` — never `skipped:error` (routing this through the outer catch would permanently disable spawning for the repo: the staleness timer is never reached); (b) lock PRESENT but content unparseable (torn write from a killed process — documented lineage risk) → treat as stale-equivalent and fall through to the SAME atomic takeover (unlink + fresh `O_EXCL`) → `spawned`; the outer whole-function catch is for genuinely unexpected fs errors only, and no listed test may accept `skipped:error` as an alternative outcome for (a) or (b). Use temp dirs + a recording fake `spawn`. `cfg` literals in tests are plain `GateConfig` objects (`{check: "bun test", checkTimeoutMs: 600000, ...}`).
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement module + types fields.**
- [ ] **Step 4: Wire hook-cli** — in the UserPromptSubmit branch directly after `if (sensor) appendSensor(...)` (`:255`), guarded so ordering is law:

```ts
// 5th pre-data amendment (prompt-check): accompany, never replace — the
// skippedStop line above is already appended; this only SPAWNS, detached.
maybeSpawnPromptCheck({
  cwd, sessionID: sessionId, sensor,
  cfg: parseGateConfig(gateConfigRaw) ?? undefined,
  env: process.env as Record<string, string | undefined>,
  now: Date.now(),
  spawn: (cmd) => { /* the existing nohup double-fork wrapper, verbatim from maybeSpawnGauge's spawn arg */ },
})
```

- [ ] **Step 5: Full suite + tsc; commit** — `feat(cc-gate): prompt-check spawn seam — skippedStop-triggered detached spawn w/ single-flight lock (5th amendment)`

---

### Task 3: prompt-check-cli detached runner

**Files:**
- Create: `cc-gate-plugin/src/prompt-check-cli.ts`
- Test: `cc-gate-plugin/test/prompt-check-cli.test.ts`

**Interfaces:**
- Consumes: T1 `appendSensor` + `runCheck`; T2 `LOCK_REL_PATH`; `buildSensorLine` from `core/sensor.ts` (CALLED, never edited — F1-safe by construction); gate.json via the same `readGateConfigRaw`/`parseGateConfig` helpers hook-cli uses (import from hook-cli if exported, else re-read the file with the same parse — keep to one small local `readCfg(cwd)`).
- Produces: appended line shape (LAW — cite the amendment in the file header):

```ts
// buildSensorLine is TWO-arg: (deps: CoreDeps, args) — core/sensor.ts:3; ts/host/app
// come from deps.now()/deps.hostname() (sensor.ts:33,42). CoreDeps (types.ts:82-88)
// structurally requires runCheck/log too, so pass inert stubs for the fields
// buildSensorLine never reads:
const deps = {
  now: () => Date.now(),
  hostname: () => os.hostname(),
  runCheck: async () => ({ code: 0, out: "" }),
  log: () => {},
}
const base = buildSensorLine(deps, {
  sessionID, check: cfg.check, accepted: res.code === 0, gateExhausted: false,
  rounds: [], interrupted: false, marker: false, durationMs: res.ms,
})  // frozen core builder, CALLED not edited — stamps ts/host/app like every other line
const line = { ...base, promptCheck: true as const, spawnTs }
appendSensor(cwd, gateConfigRaw, line, log)
```

Behavior, `main()` under `import.meta.main` guard (crank.ts:485 precedent — `bun test` must never run a check): argv `<cwd> <sessionID> <spawnTs>`; validate all three (spawnTs numeric) else exit 0 silently; run `runCheck(cfg.check, cwd, cfg.checkTimeoutMs ?? 300_000)`; timeout/kill → STILL append (`accepted:false`, `durationMs` = elapsed) — a timing-out check is signal, not noise; `finally`: read `LOCK_REL_PATH`, unlink ONLY if its `spawnTs` equals this process's own argv spawnTs (ownership check, T2's rule — never delete a successor's lock after a stale takeover), best-effort; every failure path swallowed (fail-open family rule) — this process must never leave a visible error in the user's terminal (stdout/stderr already nohup-discarded by the spawn wrapper).

NOTE — `reinject`/`forced` are hook-cli Stop-path stamps (`hook-cli.ts:313-333`); `checkMs` is built inside `core/stop.ts` (`:102,124,147` — a MECHANISM_PATH file this plan never touches) and appears only because Stop-path callers pass a `checkMs` arg to `buildSensorLine`. The prompt-check line carries NONE of the three: the first two because this line is born and appended outside hook-cli's Stop path, `checkMs` because T3's `buildSensorLine` call simply never passes that arg. The test asserts all three keys absent.

- [ ] **Step 1: Write failing integration test** — temp repo with `gate.json` `{"check":"exit 0"}` (then a failing variant `exit 1`, then a sleeping variant with tiny `checkTimeoutMs`): run `bun src/prompt-check-cli.ts <dir> sess-1 12345` as a real subprocess; assert `.km/gate-outcomes.ndjson` gains exactly one line with `promptCheck:true`, `spawnTs:12345`, `rounds:[]`, correct `accepted`, `pluginVersion` AND `host` stamped, NO `reinject`/`forced`/`checkMs` keys; lock ownership: a hand-written lock with `spawnTs:12345` is removed afterward, but a lock with a DIFFERENT spawnTs survives the run (foreign lock never deleted); garbage argv → exit 0, no line.
- [ ] **Step 2: FAIL run.**  - [ ] **Step 3: Implement.**  - [ ] **Step 4: Suite + tsc.**
- [ ] **Step 5: Commit** — `feat(cc-gate): prompt-check detached runner — fabricated line via frozen buildSensorLine + spread (core untouched)`

---

### Task 4: classification + exclusion ripple (amendment pins 2-4)

**Files:**
- Modify: `cc-gate-plugin/src/score.ts:14` (CycleClass union), `:29-30` (order), `:50/182/199` (counts); `cc-gate-plugin/src/score-cli.ts:183-189` (`joinTrialArms` — CRITICAL: this file independently REIMPLEMENTS the exclusion rule rather than calling km-crank's `joinAndExclude` (its own docstring `:133-135` admits the mirror); without an explicit `cls !== "prompt-check"` on BOTH the density push (`:188`) and the metrics push (`:189`), the scorecard CLI silently double-INCLUDES prompt-check lines — the exact violation the 5th amendment forbids) + `:316-324` (`render()` prints each class count by name — add `prompt-check ${c.promptCheck}` for skipped-stop display parity); `km-crank/src/trial-verdict.ts:137-183` (rule 8 + counts `:197`); `km-crank/src/scan.ts:27-74` (optional fields on local shape), `:121-125` (`newLineCount`)
- Test: `cc-gate-plugin/test/score.test.ts` (extend), score-cli's covering suite (extend where `joinTrialArms` is tested today; if uncovered, add `cc-gate-plugin/test/score-cli.test.ts` with a minimal `joinTrialArms` case), `km-crank/test/trial-verdict.test.ts` + `km-crank/test/scan.test.ts` (extend)

**Interfaces:**
- Consumes: T2's `promptCheck`/`spawnTs` fields.
- Produces: `CycleClass` = `"interrupted" | "exhausted" | "catch" | "clean" | "gauge-only" | "skipped-stop" | "prompt-check"`; counts objects gain `promptCheck: number` everywhere the existing six live.

Order pin (LAW — extend the existing load-bearing comment at `score.ts:21-27`):

```ts
if (l.skippedStop) return "skipped-stop"
if (l.promptCheck) return "prompt-check" // 5th amendment: BEFORE the empty-rounds
// gauge-only branch — a prompt-check line also carries rounds: [], and gauge-only
// is density-INCLUDED; misorder silently converts the registered exclusion into inclusion.
if (l.rounds.length === 0) return "gauge-only"
```

`joinAndExclude`: `if (cls === "prompt-check") continue` beside rule 7's skipped-stop continue, with a rule-8 comment citing the amendment's three rationales (wrong quantity / density false-void / no actuator exposure). `newLineCount`: `if (!l.skippedStop && !l.promptCheck) n++` and extend its header comment the same way the skipped-stop one reads.

- [ ] **Step 1: Failing tests** — score.test.ts, THREE tests mirroring the skipped-stop precedent trio exactly: (a) classify — a line with `promptCheck:true, rounds:[]` classifies `"prompt-check"` (and NOT gauge-only); (b) precedence pair test with both a skippedStop line and a promptCheck line; (c) counts-aggregation via `scoreLines` (mirror `score.test.ts:68-78`): a mixed stream asserts `counts.promptCheck` INCREMENTS and the lines are excluded from `gateCycles`/rate denominators — this is the ONLY test able to catch a forgotten `case "prompt-check"` in `scoreGroup`'s switch (`score.ts:186-201`, no default, not exhaustiveness-checked: a missing case silently no-ops while classify/precedence tests stay green). Plus a CLI-level render test mirroring `score.test.ts:309-314`: `"prompt-check N"` appears in score-cli's printed cycles breakdown. score-cli suite: `joinTrialArms` over a stream containing a prompt-check line with a matching exposure row → the line appears in NEITHER the density pool NOR the metrics pool (mirror the skipped-stop expectations). trial-verdict.test.ts: a prompt-check line inside a joined stream is excluded from metrics AND density counts (mirror the rule-7 test shape at the skipped-stop cases). scan.test.ts: `newLineCount` skips it.
- [ ] **Step 2: FAIL.**  - [ ] **Step 3: Implement (both packages).**  - [ ] **Step 4: Both suites + tsc; ALSO run `bun test test/sensor-contract.test.ts` in km-crank — golden fixture must still byte-match (nothing in this task may touch it).**
- [ ] **Step 5: Commit** — `feat(scoring): prompt-check class — classify order pin, join rule 8, newLineCount discount (5th amendment)`

---

### Task 5: mechanize-instead rubric key (Phase 3.2)

**Files:**
- Modify: `minimal/review.ts:140-145` (`ReviewChecks` interface — MUST gain the new typed field; without it the LLM's named command never reaches typed code), `:147` (RUBRIC_KEYS), `:149-163` (`computeVerdict` — needs a `mechanize_instead`-specific violation formatter, see below), `:165-223` (buildReviewPrompt checks block), `:276-302` (reviewLoop immediate-abstain routing)
- Test: `opencode-plugin/test/minimal-review.test.ts` (extend), `opencode-plugin/test/review-gate.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from Tasks 1-4 (independent half; can run in parallel-in-time but is sequenced last for review focus).
- Produces: `ReviewChecks` += `mechanize_instead?: { pass: boolean; command: string }` (`command` = the named runnable check when failed, `""` when passed); `RUBRIC_KEYS = ["category", "domain_swap", "behavior_level", "duplicate", "mechanize_instead"]`; `computeVerdict` (`review.ts:149-163`) already iterates RUBRIC_KEYS as a strict conjunction (no hardcoded 4-key assumption — verified), but its generic violation formatter (`:159`) would emit only `"mechanize_instead: failed"` — add a special case (the existing `domain_swap` "(unwritable)" suffix at the same line is the precedent) appending the command: `` `mechanize_instead: failed (${c.command})` `` — the violations string array is the ONLY thing `reviewLoop` and the rejected ledger (`harness-store.ts:1951-1970`, `violations: string[]`) ever see, so the check-candidate text must be embedded there; `reviewLoop` gains the routing rule below.

Prompt question (append to the checks block, matching the artifact-requiring style of the existing four):

```
mechanize_instead: could this bullet's effect be enforced by a runnable
check instead (a shell command or test the completion gate could run
mechanically)? If yes: name the concrete command or check it should
become, and mark this key FAILED — prose must never do a check's job
(spec §4 rule 3 harmonization). If no: state in one sentence why the
behavior cannot be expressed as a runnable check, and mark it passed.
```

Routing rule (the roadmap's abstain-on-reject pin): in `reviewLoop`, when a review round's `violations` contains an entry starting `"mechanize_instead"`, coerce `action: "abstain"` IMMEDIATELY with reason = that violation entry verbatim (which now embeds the named command via the `computeVerdict` special case above) — the revise seat is NOT called for that bullet (revision could rephrase around mechanizability; the violation string lands in the rejected/abstain reason, which the ledger preserves verbatim as the check-candidate log).

- [ ] **Step 1: Failing tests** — minimal-review.test.ts: (a) computeVerdict fails when only `mechanize_instead` fails and the violation string embeds the named command (`mechanize_instead: failed (bun test --filter x)`); (b) all-5 pass → pass; (c) reviewLoop with a seat returning a mechanize_instead violation → abstain on ROUND 1, revise seat spy never called, reason contains the named command; (d) non-mechanize fail still goes to revise as today (regression). review-gate.test.ts: integration — staged=false, rejected/abstain path records the command-bearing reason.
- [ ] **Step 2: FAIL.**  - [ ] **Step 3: Implement.**  - [ ] **Step 4: `cd opencode-plugin && bun test test/minimal-review.test.ts test/review-gate.test.ts` then full suite. TYPECHECK CAVEAT: `opencode-plugin/tsconfig.json` has `"include": ["src"]` — `bunx tsc --noEmit` there checks NEITHER `minimal/review.ts` NOR `test/*.ts`, and `bun test` strips types without checking. Run the explicit file-scoped check FROM `opencode-plugin/` (the repo root has no `node_modules`, so `@types/node` for `node:fs`/`node:path` resolves only from there) WITH `--allowImportingTsExtensions` (review.ts:332 does `await import("./llm.ts")` — TS5097 without the flag): `cd opencode-plugin && bunx tsc --noEmit --strict --skipLibCheck --allowImportingTsExtensions --target esnext --module esnext --moduleResolution bundler ../minimal/review.ts`. Run it ONCE BEFORE editing review.ts to confirm a zero-error baseline (if the baseline is not clean, record the pre-existing errors and require only no NEW ones), then again after — this is the only command in the phase that would surface a missing `ReviewChecks` field.**
- [ ] **Step 5: Commit** — `feat(review): mechanize-instead 5th rubric key — immediate abstain, revise seat locked out, named check preserved in ledger`

---

### Task 6: live smoke + registration cross-check + roadmap status

**Files:**
- Modify: `docs/2026-07-30-enhancement-roadmap.md` (status line: Phase 3 complete), `docs/resume.md` (top block)
- No product code.

- [ ] **Step 1: Live smoke (installed-copy analog, scratch repo — NOT the real kkamak repo):** temp gated repo, drive working-tree hook-cli: PostToolUse (edit) then a UserPromptSubmit payload (queued-prompt shape) → assert the skippedStop line appears AND, within the check's runtime, the `promptCheck:true` line with matching `sessionID` + `spawnTs`; verify lock created then removed; run a second immediate UserPromptSubmit → skippedStop line appended but spawn skipped (in-flight), proving accompany + single-flight live.
- [ ] **Step 2: Amendment conformance read-back:** re-read the 5th amendment block and tick each pin against the built code (file:line list into the report): accompany ✓ / detached-only ✓ / classify order ✓ / rule 8 in `joinAndExclude` ✓ / the SAME exclusion in `score-cli.ts`'s independent `joinTrialArms` mirror (both density and metrics filters) ✓ / discount ✓ / spawnTs join ✓ / hook-cli seam ✓. Every consumer of `classifyCycle` found by grep must be on the list — a new mirror site appearing since this plan means a new exclusion edit.
- [ ] **Step 3: F1/F2 verification** — `git log <phase-base>..HEAD -- cc-gate-plugin/src/core cc-gate-plugin/vendor minimal/complete-gate.ts minimal/mutate.ts minimal/spec-probe.ts minimal/session2.ts` EMPTY; `git log <phase-base>..HEAD -- scripts/km-sensors-sync.sh` EMPTY; golden fixture diff empty; all three suites + tsc, record counts.
- [ ] **Step 4: Docs + commit** — roadmap Phase 3 status, resume top block; `docs: phase 3 complete — prompt-check live smoke + amendment conformance + suites`

---

## Deferred within the phase (explicit)

- **Deploy** (km-refresh both hosts) — separate go after merge; until deployed, live streams gain no prompt-check lines.
- **Proposer evidence rendering of prompt-check results** (evidence.ts excerpt-style) — the lines land in the stream and counts now; a render decision is a later, cheap follow-up once real lines exist (YAGNI until data).
- **kkamak kernel parity for prompt-check** — none planned; tolerated-absent optionals, kernel does not queue-check.

## Self-review notes

- Amendment pins → tasks: accompany/detached/seam (T2-T3), classify order (T4), rule 8 + score-cli mirror-site exclusion (T4), discount (T4), spawnTs (T2-T3), skippedStop shape unchanged (no task touches core/prompt.ts — F1 verifies).
- Roadmap 3.2 → T5 with the abstain-on-reject and ledger-as-check-candidate-log pins, incl. the ReviewChecks/violation-formatter wiring the command text needs to actually reach the ledger.
- Type consistency: `promptCheck?: true`/`spawnTs?: number` named identically in types.ts (T2), fabrication (T3), score.ts + score-cli.ts (T4), scan.ts (T4). `runCheck` return `{code: number, out, ms}` consistent T1→T3. `buildSensorLine` called with its real 2-arg `(deps, args)` signature (core/sensor.ts:3).
- Architect review round 1 (2026-07-31) closed: 2 Critical (buildSensorLine arity; score-cli mirror double-inclusion), 5 Important (ms-field honesty + check-runner tests; sensorFilePath signature preserved; ReviewChecks wiring; cfg-derived lock staleness + ownership unlink; minimal/ typecheck gap), 3 Minor (cite drifts; checkMs attribution; render() parity) — all folded in above.
- Architect review round 2 (2026-07-31) closed: 3 Critical (`cfg` typed as real `GateConfig` — subset type omitted `checkTimeoutMs`; gate.json `promptCheck` flag was dead code → kill switch is env-only by design; file-scoped tsc command fixed — run from `opencode-plugin/`, `--allowImportingTsExtensions`, baseline-first), 1 Critical race (stale takeover now atomic: unlink + fresh `O_EXCL`, `EEXIST` = lost race = `skipped:in-flight`, never overwrite-and-assume), 1 Important (whole-function try/catch fail-open per `spawn.ts` precedent + vanished-lock-after-EEXIST fallback).
- Architect review round 3 (2026-07-31) closed: 2 Important, both test-coverage pins — (a) vanished-lock and torn-write lock cases split into two deterministic tests, both MUST take over and spawn, `skipped:error` explicitly disallowed as an accepted outcome (a wrong routing would permanently disable spawning undetected); (b) T4 gains the counts-aggregation test (the only guard on `scoreGroup`'s non-exhaustive switch) and the CLI render test, completing the skipped-stop precedent trio. Round 3 verified all round-1/round-2 closures against live code and found no amendment pin without a task and no stale cross-round contradictions. NOTE: these two round-3 fixes were folded in after the round-3 verdict.
- Architect review round 4 (2026-07-31, verification-only): both round-3 closures verified against live code (incl. score.test.ts:68-78/:309-314 shapes and score-cli.ts render), no regressions from the edits, no stale cross-round text — **verdict FLAWLESS**. One non-blocking implementation hint folded in (dangling-symlink construction for the vanished-lock test).
- No placeholder scan hits; every code step carries concrete code or an exact behavior table.
