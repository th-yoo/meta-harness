# Minimal Gate Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standalone opencode plugin that arms the certified completion gate on daily sessions (gate.json opt-in), reinjects "not done" evidence bounded by rounds, and appends every outcome to a local ndjson sensor file — the daily objective grader (design: `docs/2026-07-25-daily-evolution-loop.md` §4.1).

**Architecture:** New top-level dir `gate-plugin/` registered as a SECOND entry in root `opencode.json` `plugin` array (each plugin loads independently; this one is engine-free — deliberately sidesteps the engine.sessionIdle ordering hazard). Two files: `core.ts` (pure hook factory, all deps injected — testable with fakes) and `index.ts` (thin binding to `PluginInput`). Gate round semantics come from `minimal/complete-gate.ts` `runCompletionGate` imported directly (DRY; tests already import across dirs this way, e.g. `opencode-plugin/test/minimal-complete-gate.test.ts`). v1 runs mutants=0 (mutation probe is v2 per design doc — daily value starts with "checks must pass before done").

**Tech Stack:** Bun + TypeScript, `@opencode-ai/plugin` types, `bun:test`.

## Global Constraints

- **Marker default OFF** — C2 verdict amendment (HISTORY.md C2 section: marker A-side 4/12 vs 7/10 p=0.198 null-but-depressed; hygiene doc §4's "default ON" is superseded). `gate.json` may opt in with `"marker": true`.
- Marker text = `HYGIENE_MARKER` from `minimal/session2.ts:21` VERBATIM (the bench-measured wording): `"gate for the previous task is closed; its fault-injection evidence and verification transcripts are obsolete — do not apply them to the next task."`
- CACHE PRESERVED — no context editing ever (user decision, final). Reinjection appends messages only.
- No engine imports. This plugin must not import anything from `opencode-plugin/src/`.
- Reinject prompts must not re-trigger this plugin's own hooks (guard sets, see Task 2).
- Sensor output is host-local runtime store (`.meta-harness/gate-outcomes.ndjson` under the WORKTREE) — gitignored territory per repo CLAUDE.md; never a repo file.
- All tests run from `opencode-plugin/` via `bun test ../gate-plugin/test/` or repo root `bun test gate-plugin/` — verify the chosen invocation actually collects the files in Task 1.

## File Structure

- Create: `gate-plugin/src/core.ts` — `parseGateConfig()`, `makeGateHooks(deps)` (pure; all IO injected)
- Create: `gate-plugin/src/index.ts` — plugin entry binding `PluginInput` → `makeGateHooks`
- Create: `gate-plugin/test/core.test.ts` — full behavior suite with fake deps
- Create: `gate-plugin/package.json`, `gate-plugin/tsconfig.json` — mirror `opencode-plugin/` minimal versions
- Modify: `opencode.json` — add `"./gate-plugin/src/index.ts"` to `plugin` array (LAST task — nothing half-built ever loads into live sessions)

---

### Task 1: Scaffold + gate.json config parser

**Files:**
- Create: `gate-plugin/package.json`, `gate-plugin/tsconfig.json`
- Create: `gate-plugin/src/core.ts` (config part only)
- Test: `gate-plugin/test/core.test.ts`

**Interfaces:**
- Produces: `interface GateConfig { check: string; rounds: number; marker: boolean; sensor: string }`, `parseGateConfig(raw: string): GateConfig | undefined` — `undefined` on unparseable/missing `check`; defaults `rounds: 2`, `marker: false`, `sensor: ".meta-harness/gate-outcomes.ndjson"`.

- [ ] **Step 1: Scaffold package files**

`gate-plugin/package.json`:
```json
{
  "name": "meta-harness-gate-plugin",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "devDependencies": { "@opencode-ai/plugin": "^1.17.14", "typescript": "^5" }
}
```
Copy `opencode-plugin/tsconfig.json` to `gate-plugin/tsconfig.json` (read it first; adjust `include` to `["src", "test"]`). Run `cd gate-plugin && bun install`.

- [ ] **Step 2: Write failing tests for parseGateConfig**

```ts
// gate-plugin/test/core.test.ts
import { test, expect } from "bun:test"
import { parseGateConfig } from "../src/core.ts"

test("parseGateConfig: minimal valid config gets defaults", () => {
  const c = parseGateConfig(`{"check": "bun test"}`)
  expect(c).toEqual({ check: "bun test", rounds: 2, marker: false, sensor: ".meta-harness/gate-outcomes.ndjson" })
})
test("parseGateConfig: explicit fields respected", () => {
  const c = parseGateConfig(`{"check": "make verify", "rounds": 1, "marker": true, "sensor": "out.ndjson"}`)
  expect(c).toEqual({ check: "make verify", rounds: 1, marker: true, sensor: "out.ndjson" })
})
test("parseGateConfig: missing check → undefined", () => {
  expect(parseGateConfig(`{"rounds": 3}`)).toBeUndefined()
})
test("parseGateConfig: malformed JSON → undefined", () => {
  expect(parseGateConfig(`{nope`)).toBeUndefined()
})
test("parseGateConfig: non-string check → undefined", () => {
  expect(parseGateConfig(`{"check": 42}`)).toBeUndefined()
})
```

- [ ] **Step 3: Run tests, verify they fail** — `cd gate-plugin && bun test` → FAIL (module has no export).

- [ ] **Step 4: Implement parseGateConfig in `gate-plugin/src/core.ts`**

```ts
/**
 * gate-plugin/src/core.ts — standalone completion-gate plugin core
 * (design: docs/2026-07-25-daily-evolution-loop.md §4.1; engine-free).
 * Round semantics reused from minimal/complete-gate.ts. v1: mutants=0.
 * Marker default OFF (C2 verdict, HISTORY.md; overrides hygiene doc §4).
 */
export interface GateConfig {
  check: string
  rounds: number
  marker: boolean
  sensor: string
}

export function parseGateConfig(raw: string): GateConfig | undefined {
  try {
    const j = JSON.parse(raw)
    if (typeof j.check !== "string" || !j.check) return undefined
    return {
      check: j.check,
      rounds: typeof j.rounds === "number" ? j.rounds : 2,
      marker: j.marker === true,
      sensor: typeof j.sensor === "string" ? j.sensor : ".meta-harness/gate-outcomes.ndjson",
    }
  } catch {
    return undefined
  }
}
```

- [ ] **Step 5: Run tests, verify pass** — `bun test` → 5 pass.

- [ ] **Step 6: Commit** — `git add gate-plugin && git commit -m "feat(gate-plugin): scaffold + gate.json parser"`

---

### Task 2: makeGateHooks — the full hook factory

**Files:**
- Modify: `gate-plugin/src/core.ts`
- Test: `gate-plugin/test/core.test.ts`

**Interfaces:**
- Consumes: `runCompletionGate, type GateIO, type GateResult` from `../../minimal/complete-gate.ts`; `GateConfig`/`parseGateConfig` from Task 1.
- Produces:
```ts
export interface GateDeps {
  readGateConfig(): string | undefined          // gate.json content or undefined
  runCheck(cmd: string): Promise<{ code: number; out: string }>
  promptSession(sessionID: string, text: string): Promise<boolean>
  toast(message: string, variant: "info" | "success" | "warning" | "error"): Promise<void>
  appendSensor(relPath: string, line: string): void
  now(): number
}
export function makeGateHooks(deps: GateDeps): {
  toolExecuteAfter(tool: string, sessionID: string): void
  chatMessage(sessionID: string): void
  sessionIdle(sessionID: string): Promise<void>
}
```

**Behavior contract (each bullet = at least one test):**
1. `sessionIdle`: no gate.json → no-op (no check run, no sensor line).
2. `sessionIdle`: gate.json present but session never edited (no edit-tool call recorded) → no-op.
3. Edit tools are exactly `new Set(["write", "edit", "patch", "multiedit"])`; `toolExecuteAfter` with an edit tool marks the session edited; `bash`/`read` do not.
4. Happy path: edited session + check exits 0 → `runCompletionGate` accepts round 0; sensor line appended with `{ts, sessionID, check, accepted: true, gateExhausted: false, rounds: [...], durationMs}`; NO session prompt sent (marker off by default); success toast.
5. Fail→fix path: check fails (code 1) then passes on second call → one reinject prompt sent containing the check output tail; accepted; sensor records 2 rounds.
6. Exhaustion: check always fails with `rounds: 1` → reinject once, then accept-anyway with `gateExhausted: true`; warning toast; sensor line records it.
7. Marker: config `marker: true` + acceptance (not exhaustion) → one extra `promptSession` with EXACTLY the `HYGIENE_MARKER` string imported from `../../minimal/session2.ts`. `marker: false` (or exhaustion) → no marker prompt.
8. Re-entrancy: while a session is being gated, further `sessionIdle` calls for that session return immediately (test: start a gate whose `runCheck` is a pending promise, call `sessionIdle` again, resolve — check ran once).
9. Post-gate idle: after gating completes, the next `sessionIdle` (no new edits) is a no-op; a new edit re-arms.
10. Human interrupt: `chatMessage(sid)` during gating → the NEXT reinject is refused (`reinject` returns false → `runCompletionGate` exits with gateExhausted per its own semantics); sensor still written. `chatMessage` when idle just re-arms (clears gated flag).
11. Edits performed DURING gating (by the reinjected agent) do not mark the session edited (else infinite re-gate).
12. `runCheck` receives `cfg.check` verbatim.

- [ ] **Step 1: Write the failing tests.** Build a `fakeDeps(overrides)` helper: records `checks: string[]`, `prompts: {sid, text}[]`, `toasts: string[]`, `sensor: string[]`; `readGateConfig: () => '{"check":"bun test"}'`, `runCheck: async () => ({code: 0, out: "ok"})`, `promptSession: async () => true`, `now: () => 1000`. Write one `test(...)` per contract bullet above (12+ tests). For bullet 5 use a call-counting `runCheck` that fails first, passes second. For bullet 8 use a manually-resolved promise.

- [ ] **Step 2: Run, verify fail** — `bun test` → new tests FAIL (`makeGateHooks` not exported).

- [ ] **Step 3: Implement `makeGateHooks`** (append to core.ts):

```ts
import { runCompletionGate, type GateIO } from "../../minimal/complete-gate.ts"
import { HYGIENE_MARKER } from "../../minimal/session2.ts"

const EDIT_TOOLS = new Set(["write", "edit", "patch", "multiedit"])
const OUT_TAIL = 600

export interface GateDeps { /* as in Interfaces block above */ }

export function makeGateHooks(deps: GateDeps) {
  const edited = new Set<string>()     // sessions with un-gated edits
  const gating = new Set<string>()     // gate loop currently running
  const gated = new Set<string>()      // gated since last human turn/edit
  const interrupted = new Set<string>() // human typed while gating

  return {
    toolExecuteAfter(tool: string, sessionID: string): void {
      if (gating.has(sessionID)) return                      // contract 11
      if (EDIT_TOOLS.has(tool)) { edited.add(sessionID); gated.delete(sessionID) }
    },
    chatMessage(sessionID: string): void {
      if (gating.has(sessionID)) interrupted.add(sessionID)  // contract 10
      gated.delete(sessionID)
    },
    async sessionIdle(sessionID: string): Promise<void> {
      if (gating.has(sessionID) || gated.has(sessionID)) return
      if (!edited.has(sessionID)) return
      const raw = deps.readGateConfig()
      if (!raw) return
      const cfg = parseGateConfig(raw)
      if (!cfg) return
      gating.add(sessionID)
      interrupted.delete(sessionID)
      const t0 = deps.now()
      try {
        const io: GateIO = {
          verifyExists: () => true,
          runVerify: async () => deps.runCheck(cfg.check),
          readArtifact: () => "",           // v1: no mutation probe
          writeArtifact: () => false,
          restoreArtifact: () => true,
          syntaxOk: () => true,
          reinject: async (message) => {
            if (interrupted.has(sessionID)) return false
            await deps.toast(`gate: check failed — reinjecting evidence`, "warning")
            return deps.promptSession(sessionID, message.slice(0, 4000 + OUT_TAIL))
          },
        }
        const result = await runCompletionGate(io, { rounds: cfg.rounds, mutants: 0 })
        deps.appendSensor(cfg.sensor, JSON.stringify({
          ts: deps.now(), sessionID, check: cfg.check,
          accepted: result.accepted, gateExhausted: result.gateExhausted,
          rounds: result.rounds.map((r) => r.outcome),
          interrupted: interrupted.has(sessionID),
          marker: cfg.marker, durationMs: deps.now() - t0,
        }))
        if (result.gateExhausted) await deps.toast(`gate: rounds exhausted — accepting anyway`, "warning")
        else await deps.toast(`gate: check passed`, "success")
        if (cfg.marker && result.accepted && !result.gateExhausted)
          await deps.promptSession(sessionID, HYGIENE_MARKER)
        gated.add(sessionID)
        edited.delete(sessionID)
      } finally {
        gating.delete(sessionID)
        interrupted.delete(sessionID)
      }
    },
  }
}
```
NOTE for implementer: `runCompletionGate` with `verifyExists: true`, passing check, `mutants: 0` yields `accepted` round 0 (mutant loop over empty list) — no complete-gate.ts changes. On failing check it emits `verify-failed` with the output tail and calls `reinject`. Verify against `minimal/complete-gate.ts:46-99` before wiring.

- [ ] **Step 4: Run tests, verify all pass** — `bun test` in `gate-plugin/`.

- [ ] **Step 5: Commit** — `git commit -m "feat(gate-plugin): hook factory — gate loop, sensor, marker-off default, interrupt/re-entrancy guards"`

---

### Task 3: Plugin entry (index.ts) + registration

**Files:**
- Create: `gate-plugin/src/index.ts`
- Modify: `opencode.json`
- Test: typecheck + existing suites

**Interfaces:**
- Consumes: `makeGateHooks`, `parseGateConfig` (Task 2); `PluginInput` gives `{ client, $, worktree }` (see `opencode-plugin/src/index.ts:96-116` for the pattern; hook names/signatures at `index.ts:119,167,182`).

- [ ] **Step 1: Write `gate-plugin/src/index.ts`**

```ts
/** gate-plugin — standalone completion-gate sensor for daily sessions.
 * Engine-free by design (sidesteps engine.sessionIdle ordering hazard).
 * Opt-in per project: gate.json at the worktree root. */
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { makeGateHooks } from "./core.ts"

const gatePlugin: Plugin = async ({ client, $, worktree }) => {
  const hooks = makeGateHooks({
    readGateConfig: () => {
      const p = join(worktree, "gate.json")
      return existsSync(p) ? readFileSync(p, "utf-8") : undefined
    },
    runCheck: async (cmd) => {
      const r = await $`bash -c ${cmd}`.quiet().nothrow()
      return { code: r.exitCode, out: r.stdout.toString("utf8") + r.stderr.toString("utf8") }
    },
    promptSession: async (sessionID, text) => {
      const res = await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      })
      return !!res.data
    },
    toast: async (message, variant) => {
      await client.tui.showToast({ body: { title: "Gate", message, variant, duration: 8_000 } })
    },
    appendSensor: (relPath, line) => {
      const p = join(worktree, relPath)
      mkdirSync(dirname(p), { recursive: true })
      appendFileSync(p, line + "\n")
    },
    now: () => Date.now(),
  })
  return {
    "tool.execute.after": async (toolInput) => {
      hooks.toolExecuteAfter(toolInput.tool, toolInput.sessionID)
    },
    "chat.message": async (msgInput) => {
      const sid = (msgInput as any)?.message?.sessionID ?? (msgInput as any)?.sessionID
      if (sid) hooks.chatMessage(sid)
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sid = (event.properties as any)?.sessionID
      if (sid) await hooks.sessionIdle(sid)
    },
  }
}
export const server: PluginModule["server"] = gatePlugin
```
IMPLEMENTER: verify the `chat.message` input shape against `opencode-plugin/src/index.ts:119-135` (how it extracts sessionID) and mirror exactly; same for `event` at `index.ts:182-188` and `tool.execute.after` at `index.ts:167-172`. `client.session.prompt` shape per `opencode-plugin/src/adapters/opencode-host.ts:84-104` — note prompts here must NOT deny tools (the reinjected agent needs its tools to fix the work).

- [ ] **Step 2: Typecheck** — `cd gate-plugin && bunx tsc --noEmit` → clean.

- [ ] **Step 3: Register.** In root `opencode.json` change `"plugin": ["./opencode-plugin/src/index.ts"]` → `"plugin": ["./opencode-plugin/src/index.ts", "./gate-plugin/src/index.ts"]`.

- [ ] **Step 4: Full regression** — run `bun test` in `gate-plugin/` AND the main suite from `opencode-plugin/` (`bun test`) → all green (expect 1621+ from main suite baseline).

- [ ] **Step 5: Commit** — `git commit -m "feat(gate-plugin): plugin entry + opencode.json registration — gate sensor live, opt-in via gate.json"`

---

## Self-Review Notes (author-run)

- Spec coverage vs §4.1: hook ✓, applicability (gate.json/edits/rounds/human) ✓, reinject via client ✓, toasts ✓, ndjson sensor ✓, complete-gate reuse ✓, mutants v2 deferral ✓, marker knob (default OFF — deliberate amendment) ✓, cache preserved ✓, adapter/engine split ✓. `validatedFor` runtime scope-guard: DEFERRED (optional in design; add when a second validated task class exists).
- The bench GateIO contract (`readArtifact: "" + mutants: 0 → accepted`) is asserted by contract bullet 4's test, not assumed.
