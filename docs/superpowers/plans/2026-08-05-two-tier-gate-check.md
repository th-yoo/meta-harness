# Two-Tier Gate Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the dogfood gate's blocking Stop-hook cost from ~160s back to ~25-45s by splitting the check into a sync fast tier (blocks, package-scoped) and a detached async full tier (marker-keyed debt gate), without touching the gate mechanism.

**Architecture:** The gate kernel (`cc-gate-plugin/src/core/`, MECHANISM_PATH) and `check-runner.ts` are untouched — the entire change lives inside the check command that `gate.json` names. A new `scripts/gate-check.ts` (thin CLI) + `km-crank/src/gate-check-core.ts` (pure, tested logic) implement: dirty-tree hashing (temp-index `git write-tree`, the `fixture-ref.ts` precedent), package-level test-impact selection with a conservative run-everything fallback, a background full run detached from the hook (`nohup`-style, survives hook exit), and a marker state machine under `.km/gate-bg/` whose `red` state forces a synchronous full-run debt repayment on the next gated Stop. Industry pattern: Fowler's pre-integrate/post-integrate split + TIA with fallback-to-full.

**Tech Stack:** Bun/TypeScript, git plumbing (`write-tree` with `GIT_INDEX_FILE`), bun:test.

## Global Constraints

- **F1:** `cc-gate-plugin/src/core/` is a MECHANISM_PATH — never edited. This plan touches only `km-crank/`, `scripts/`, `gate.json`, and docs.
- **F2:** no sampled prompt text in committed artifacts. Marker files live under `.km/gate-bg/` (host-local, gitignored via `.km/`); the stored failure-output tail is check output only and never committed.
- **Tier 1 is the incumbent check VERBATIM:** `cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test && cd ../km-crank && bun test && cd .. && bun scripts/doc-check.ts` — byte-identical string, run async (or sync on debt/`KKAMAK_GATE_FULL=1`). The gate's full-verification semantics never weaken; only WHEN the full check blocks changes (next gated Stop instead of this one).
- **Conservative fallback:** any changed path not matched by the TIA map selects ALL suites; missing/invalid marker state degrades to spawning a fresh full run; `KKAMAK_GATE_FULL=1` forces the incumbent behavior exactly.
- **Portability:** darwin + linux. No `/proc`, no `timeout` binary, no `pkill -f`. Background-process kill is pid-scoped only (repo standing rule).
- **Zero model calls** in all tasks and tests.
- **Sensor-line schema frozen:** no new fields emitted to `gate-outcomes.ndjson`; the `check` string changing and `durationMs` distribution shifting is an INSTRUMENT change recorded in the adoption ledger at deploy (Task 3), not a schema change.
- **Test hermeticity:** CLI tests run in throwaway temp git repos with command tables injected via the `KKAMAK_GATE_COMMANDS` test seam (path to a JSON file); they never read this repo's `gate.json`, never touch `.km/` of this repo, and never leave processes behind (pid-scoped cleanup, condition-polling not bare sleeps).

## File Structure

- `km-crank/src/gate-check-core.ts` — NEW. Pure logic, no I/O: marker (de)serialization + validation, decision state machine, TIA path→suite mapping, fast-file-list filter. Everything unit-testable without git or processes.
- `km-crank/test/gate-check-core.test.ts` — NEW. Unit tests for the above.
- `scripts/gate-check.ts` — NEW. CLI entry the gate.json check invokes. Binds real git calls, real command table, marker file I/O, detached spawn. Thin: every branch decision comes from core.
- `km-crank/test/gate-check-cli.test.ts` — NEW. Integration tests: temp git repos + fake commands.
- `gate.json` — MODIFIED in Task 3 only (check string swap).
- `docs/2026-08-01-gauntlet-adoption-ledger.md` — MODIFIED in Task 3 (instrument note + deploy ts).

---

### Task 1: `gate-check-core.ts` — pure decision logic

**Files:**
- Create: `km-crank/src/gate-check-core.ts`
- Test: `km-crank/test/gate-check-core.test.ts`

**Interfaces:**
- Consumes: nothing from this repo (pure module; `GateBgMarker`, `GateDecision` defined here).
- Produces (Task 2 relies on these exact names):
  - `interface GateBgMarker { status: "running" | "green" | "red"; tree: string; pid?: number; startedTs: number; finishedTs?: number; outputTail?: string }`
  - `parseMarker(raw: string | undefined): GateBgMarker | undefined` — undefined on missing/malformed/unknown-status (degrade, never throw).
  - `type GateDecision = { mode: "tier0"; suites: SuiteId[]; spawnBg: boolean } | { mode: "full-sync"; reason: "debt" | "forced" }`
  - `decide(input: { tree: string; marker: GateBgMarker | undefined; pidAlive: (pid: number) => boolean; forceFull: boolean }): GateDecision`
  - `type SuiteId = "ccgate" | "opencode" | "gateplugin" | "kmcrank" | "doccheck"`
  - `ALL_SUITES: SuiteId[]` — `["ccgate", "opencode", "gateplugin", "kmcrank", "doccheck"]`
  - `suitesForChangedPaths(paths: string[]): SuiteId[]` — TIA map, conservative.
  - `ccgateFastFiles(allTestFiles: string[]): string[]` — filters the slow spawn-heavy files.
  - `SLOW_CCGATE_TEST_RE: RegExp` — the exclusion policy, one place.

- [ ] **Step 1: Write the failing tests**

```typescript
// km-crank/test/gate-check-core.test.ts
import { describe, expect, test } from "bun:test"
import {
  parseMarker, decide, suitesForChangedPaths, ccgateFastFiles,
  ALL_SUITES, type GateBgMarker,
} from "../src/gate-check-core.ts"

const T1 = "aaaa1111"
const T2 = "bbbb2222"
const mk = (m: Partial<GateBgMarker>): GateBgMarker =>
  ({ status: "green", tree: T1, startedTs: 1, ...m }) as GateBgMarker
const alive = () => true
const dead = () => false

describe("parseMarker", () => {
  test("round-trips a valid marker", () => {
    const m = mk({ status: "running", pid: 42 })
    expect(parseMarker(JSON.stringify(m))).toEqual(m)
  })
  test("undefined input, malformed JSON, unknown status, missing tree -> undefined", () => {
    expect(parseMarker(undefined)).toBeUndefined()
    expect(parseMarker("{nope")).toBeUndefined()
    expect(parseMarker(JSON.stringify({ status: "purple", tree: T1, startedTs: 1 }))).toBeUndefined()
    expect(parseMarker(JSON.stringify({ status: "green", startedTs: 1 }))).toBeUndefined()
  })
})

describe("decide", () => {
  test("forceFull wins over everything, even red", () => {
    expect(decide({ tree: T1, marker: mk({ status: "red" }), pidAlive: alive, forceFull: true }))
      .toEqual({ mode: "full-sync", reason: "forced" })
  })
  test("red marker -> full-sync debt repayment, regardless of tree match", () => {
    expect(decide({ tree: T2, marker: mk({ status: "red", tree: T1 }), pidAlive: alive, forceFull: false }))
      .toEqual({ mode: "full-sync", reason: "debt" })
  })
  test("running + pid alive -> tier0, no new spawn", () => {
    const d = decide({ tree: T2, marker: mk({ status: "running", tree: T1, pid: 7 }), pidAlive: alive, forceFull: false })
    expect(d).toEqual({ mode: "tier0", suites: ALL_SUITES, spawnBg: false })
  })
  test("running + pid dead (crash/reboot) -> treated as absent: tier0 + spawn", () => {
    const d = decide({ tree: T1, marker: mk({ status: "running", tree: T1, pid: 7 }), pidAlive: dead, forceFull: false })
    expect(d).toEqual({ mode: "tier0", suites: ALL_SUITES, spawnBg: true })
  })
  test("running with pid ABSENT is malformed-in-effect -> tier0 + spawn", () => {
    const d = decide({ tree: T1, marker: mk({ status: "running", pid: undefined }), pidAlive: alive, forceFull: false })
    expect(d).toEqual({ mode: "tier0", suites: ALL_SUITES, spawnBg: true })
  })
  test("green + same tree -> tier0, nothing to spawn", () => {
    expect(decide({ tree: T1, marker: mk({ status: "green", tree: T1 }), pidAlive: alive, forceFull: false }))
      .toEqual({ mode: "tier0", suites: ALL_SUITES, spawnBg: false })
  })
  test("green + different tree -> tier0 + spawn for the new tree", () => {
    expect(decide({ tree: T2, marker: mk({ status: "green", tree: T1 }), pidAlive: alive, forceFull: false }))
      .toEqual({ mode: "tier0", suites: ALL_SUITES, spawnBg: true })
  })
  test("no marker -> tier0 + spawn", () => {
    expect(decide({ tree: T1, marker: undefined, pidAlive: alive, forceFull: false }))
      .toEqual({ mode: "tier0", suites: ALL_SUITES, spawnBg: true })
  })
})

describe("suitesForChangedPaths (package-level TIA)", () => {
  test("maps each known prefix to its suite (doccheck always included)", () => {
    expect(suitesForChangedPaths(["cc-gate-plugin/src/x.ts"])).toEqual(["ccgate", "doccheck"])
    expect(suitesForChangedPaths(["opencode-plugin/src/x.ts"])).toEqual(["opencode", "doccheck"])
    expect(suitesForChangedPaths(["minimal/llm.ts"])).toEqual(["opencode", "doccheck"])
    expect(suitesForChangedPaths(["gate-plugin/src/x.ts"])).toEqual(["gateplugin", "doccheck"])
    expect(suitesForChangedPaths(["km-crank/src/x.ts"])).toEqual(["kmcrank", "doccheck"])
  })
  test("docs-only / markdown-only changes -> doccheck only", () => {
    expect(suitesForChangedPaths(["docs/resume.md", "README.md"])).toEqual(["doccheck"])
  })
  test("unknown path -> ALL suites (conservative fallback)", () => {
    expect(suitesForChangedPaths(["term-bench2/store/x.json"])).toEqual(ALL_SUITES)
    expect(suitesForChangedPaths(["scripts/gate-check.ts"])).toEqual(ALL_SUITES)
  })
  test("union across paths, deduplicated, stable ALL_SUITES order", () => {
    expect(suitesForChangedPaths(["km-crank/src/a.ts", "cc-gate-plugin/src/b.ts"]))
      .toEqual(["ccgate", "kmcrank", "doccheck"])
  })
  test("empty change list -> doccheck only (nothing to test, doc drift still checked)", () => {
    expect(suitesForChangedPaths([])).toEqual(["doccheck"])
  })
})

describe("ccgateFastFiles", () => {
  test("filters exactly the spawn-heavy files, keeps the rest", () => {
    const files = [
      "test/acp-client.test.ts", "test/acp-daemon.test.ts", "test/acp-pool.test.ts",
      "test/anthropic-cli-warm.test.ts", "test/warm-session.test.ts",
      "test/gauge-agent-transport.test.ts",
      "test/acp-wire.test.ts", "test/acp-paths.test.ts", "test/reinject.test.ts",
    ]
    expect(ccgateFastFiles(files)).toEqual([
      "test/acp-wire.test.ts", "test/acp-paths.test.ts", "test/reinject.test.ts",
    ])
  })
  test("empty in, empty out", () => {
    expect(ccgateFastFiles([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd km-crank && bun test test/gate-check-core.test.ts`
Expected: FAIL — `Cannot find module '../src/gate-check-core.ts'`

- [ ] **Step 3: Implement**

```typescript
// km-crank/src/gate-check-core.ts
/**
 * Two-tier gate check — pure decision logic (no I/O, no processes).
 *
 * Design (docs/superpowers/plans/2026-08-05-two-tier-gate-check.md):
 * the blocking Stop-hook check runs a FAST tier scoped by package-level
 * test-impact selection; the incumbent full check runs DETACHED in the
 * background keyed by dirty-tree hash. A red background result becomes
 * debt: the next gated Stop repays it by running the full check
 * synchronously (self-clearing — failure mode degenerates to the old
 * behavior, never silently weaker).
 */

export type SuiteId = "ccgate" | "opencode" | "gateplugin" | "kmcrank" | "doccheck"

export const ALL_SUITES: SuiteId[] = ["ccgate", "opencode", "gateplugin", "kmcrank", "doccheck"]

export interface GateBgMarker {
  status: "running" | "green" | "red"
  /** dirty-tree object id (temp-index write-tree) the run was keyed to */
  tree: string
  pid?: number
  startedTs: number
  finishedTs?: number
  /** tail of the failing check output (host-local only, never committed) */
  outputTail?: string
}

const MARKER_STATUSES = new Set(["running", "green", "red"])

/** Missing/malformed/unknown -> undefined: a broken marker must degrade to
 * "no marker" (spawn a fresh run), never crash the gate. */
export function parseMarker(raw: string | undefined): GateBgMarker | undefined {
  if (raw === undefined) return undefined
  let v: unknown
  try { v = JSON.parse(raw) } catch { return undefined }
  if (typeof v !== "object" || v === null) return undefined
  const m = v as Record<string, unknown>
  if (typeof m.status !== "string" || !MARKER_STATUSES.has(m.status)) return undefined
  if (typeof m.tree !== "string" || m.tree.length === 0) return undefined
  if (typeof m.startedTs !== "number") return undefined
  return m as unknown as GateBgMarker
}

export type GateDecision =
  | { mode: "tier0"; suites: SuiteId[]; spawnBg: boolean }
  | { mode: "full-sync"; reason: "debt" | "forced" }

/** The whole state machine, one place. Order matters:
 * forced > debt > running-alive > everything-else. */
export function decide(input: {
  tree: string
  marker: GateBgMarker | undefined
  pidAlive: (pid: number) => boolean
  forceFull: boolean
}): GateDecision {
  if (input.forceFull) return { mode: "full-sync", reason: "forced" }
  const m = input.marker
  if (m?.status === "red") return { mode: "full-sync", reason: "debt" }
  if (m?.status === "running" && typeof m.pid === "number" && input.pidAlive(m.pid)) {
    return { mode: "tier0", suites: ALL_SUITES, spawnBg: false }
  }
  if (m?.status === "green" && m.tree === input.tree) {
    return { mode: "tier0", suites: ALL_SUITES, spawnBg: false }
  }
  // no marker, dead "running", pid-less "running", or green-for-older-tree
  return { mode: "tier0", suites: ALL_SUITES, spawnBg: true }
}

/** Package-level TIA. Conservative: any path outside the map selects ALL.
 * `minimal/` maps to opencode (its tests live in opencode-plugin/test/;
 * cc-gate-plugin only holds VENDORED byte-copies, which change under
 * cc-gate-plugin/ and select ccgate on their own). doccheck always runs —
 * seconds, and doc drift is half of what the gate exists to catch. */
const TIA_MAP: Array<{ re: RegExp; suite: SuiteId }> = [
  { re: /^cc-gate-plugin\//, suite: "ccgate" },
  { re: /^opencode-plugin\//, suite: "opencode" },
  { re: /^minimal\//, suite: "opencode" },
  { re: /^gate-plugin\//, suite: "gateplugin" },
  { re: /^km-crank\//, suite: "kmcrank" },
]
const DOC_ONLY_RE = /^docs\/|\.md$/

export function suitesForChangedPaths(paths: string[]): SuiteId[] {
  const picked = new Set<SuiteId>()
  for (const p of paths) {
    const hit = TIA_MAP.find((e) => e.re.test(p))
    if (hit) { picked.add(hit.suite); continue }
    if (DOC_ONLY_RE.test(p)) continue        // doccheck is added below anyway
    return [...ALL_SUITES]                    // conservative fallback
  }
  picked.add("doccheck")
  return ALL_SUITES.filter((s) => picked.has(s))
}

/** Spawn-heavy cc-gate-plugin test files excluded from tier 0. Measured
 * 2026-08-05 (darwin): these files ≈134s of a ≈160s suite (real daemon +
 * CC CLI subprocess spawns, 2s settles). They still run in tier 1 on every
 * background full check, and in the merge gate. ONE regex = one policy site. */
export const SLOW_CCGATE_TEST_RE =
  /(acp-client|acp-daemon|acp-pool|anthropic-cli-warm|warm-session|gauge-agent-transport)\.test\.ts$/

export function ccgateFastFiles(allTestFiles: string[]): string[] {
  return allTestFiles.filter((f) => !SLOW_CCGATE_TEST_RE.test(f))
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd km-crank && bun test test/gate-check-core.test.ts` — 0 fail.
Run: `cd km-crank && bunx tsc --noEmit` (or `./node_modules/.bin/tsc --noEmit` if bunx resolves a global) — clean.
Run: `cd km-crank && bun test` — full km-crank suite still green.

- [ ] **Step 5: Commit**

```bash
git add km-crank/src/gate-check-core.ts km-crank/test/gate-check-core.test.ts
git commit -m "feat(gate): two-tier gate-check core — marker state machine + package TIA (pure logic)"
```

### Task 2: `scripts/gate-check.ts` — CLI, detached background run, markers

**Files:**
- Create: `scripts/gate-check.ts`
- Test: `km-crank/test/gate-check-cli.test.ts`

**Interfaces:**
- Consumes (from Task 1, exact names): `decide`, `parseMarker`, `suitesForChangedPaths`, `ccgateFastFiles`, `ALL_SUITES`, `GateBgMarker`, `SuiteId` from `../km-crank/src/gate-check-core.ts` (script imports by relative path from repo root; km-crank has no exports map — direct file import, same pattern as `opencode-plugin/test` importing `cc-gate-plugin` files).
- Produces: the executable the new `gate.json` check names (Task 3). Exit 0 = allow, non-zero = block, failure output on stdout/stderr (check-runner captures it for the block reason). Test seam: `KKAMAK_GATE_COMMANDS=<path.json>` replaces the built-in command table; `KKAMAK_GATE_FULL=1` forces full-sync; `KKAMAK_GATE_NO_BG=1` suppresses the background spawn (tests/CI).

**Command table (the real one, embedded in the script):**

```typescript
// suite -> { cwd, argv } — argv arrays, never shell strings (no quoting bugs).
// ccgate tier-0 argv is COMPUTED: bun test + fast file list from ccgateFastFiles(readdir).
const REAL_COMMANDS: Record<SuiteId, { cwd: string; argv: string[] }> = {
  ccgate:     { cwd: "cc-gate-plugin", argv: ["bun", "test", /* + fast files */] },
  opencode:   { cwd: "opencode-plugin", argv: ["bun", "test"] },
  gateplugin: { cwd: "gate-plugin", argv: ["bun", "test"] },
  kmcrank:    { cwd: "km-crank", argv: ["bun", "test"] },
  doccheck:   { cwd: ".", argv: ["bun", "scripts/doc-check.ts"] },
}
/** Tier 1 = the incumbent check VERBATIM (Global Constraints). */
const FULL_CHECK =
  "cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test && cd ../km-crank && bun test && cd .. && bun scripts/doc-check.ts"
```

- [ ] **Step 1: Write the failing tests**

```typescript
// km-crank/test/gate-check-cli.test.ts
/** Integration tests for scripts/gate-check.ts in THROWAWAY temp git repos.
 * The KKAMAK_GATE_COMMANDS seam points every suite and the full check at
 * tiny fake scripts (touch/exit) so no real suite ever runs. Background
 * assertions poll the marker file (condition-based waiting, never bare
 * sleeps). All spawned pids are collected and SIGTERMed pid-scoped in
 * afterEach. */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { execFileSync, spawnSync } from "node:child_process"

const GATE_CHECK = path.join(import.meta.dir, "..", "..", "scripts", "gate-check.ts")
const CLEANUP: string[] = []
afterEach(() => { for (const d of CLEANUP.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "gate-check-"))
  CLEANUP.push(dir)
  execFileSync("git", ["init", "-q"], { cwd: dir })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir })
  fs.mkdirSync(path.join(dir, ".km"), { recursive: true })
  return dir
}

/** Command-table fixture: every suite runs `fake.ts <suite>` which appends
 * its suite id to ran.txt and exits with the code in exits.json (default 0).
 * The full check appends "FULL". */
function writeCommands(dir: string): string {
  const fake = path.join(dir, "fake.ts")
  fs.writeFileSync(fake, `
const fs = require("node:fs"); const path = require("node:path")
const dir = ${JSON.stringify(dir)}
const tag = process.argv[2]
fs.appendFileSync(path.join(dir, "ran.txt"), tag + "\\n")
let exits = {}
try { exits = JSON.parse(fs.readFileSync(path.join(dir, "exits.json"), "utf8")) } catch {}
process.exit(exits[tag] ?? 0)
`)
  const table = {
    suites: Object.fromEntries(["ccgate", "opencode", "gateplugin", "kmcrank", "doccheck"]
      .map((s) => [s, { cwd: ".", argv: ["bun", fake, s] }])),
    full: { cwd: ".", argv: ["bun", fake, "FULL"] },
  }
  const p = path.join(dir, "commands.json")
  fs.writeFileSync(p, JSON.stringify(table))
  return p
}

function runGate(dir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bun", [GATE_CHECK], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, KKAMAK_GATE_COMMANDS: writeCommands(dir), ...extraEnv },
  })
}

function ran(dir: string): string[] {
  try { return fs.readFileSync(path.join(dir, "ran.txt"), "utf8").split("\n").filter(Boolean) } catch { return [] }
}
function marker(dir: string): any {
  try { return JSON.parse(fs.readFileSync(path.join(dir, ".km", "gate-bg", "state.json"), "utf8")) } catch { return undefined }
}
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)) }
  return pred()
}

describe("gate-check CLI", () => {
  test("first run, docs-only change: tier0 runs doccheck only, exits 0, spawns bg full run that lands green", async () => {
    const dir = tempRepo()
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    const r = runGate(dir)
    expect(r.status).toBe(0)
    expect(ran(dir)).toContain("doccheck")
    expect(ran(dir)).not.toContain("ccgate")
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)
    expect(ran(dir)).toContain("FULL")
  }, 30_000)

  test("tier0 failure blocks: failing suite -> non-zero exit, failure output present, NO bg spawn", async () => {
    // CONTRACT (implementer writes the body): mkdir km-crank/ in the temp
    // repo + write one file there so TIA selects "kmcrank"; write
    // exits.json {"kmcrank": 1}; runGate(dir). Assert: r.status !== 0;
    // ran(dir) contains "kmcrank" and NOT "FULL"; r.stdout+r.stderr
    // contains the fake's output; marker(dir) stays undefined (no spawn
    // while broken).
  })

  test("KKAMAK_GATE_NO_BG=1 suppresses the spawn", async () => {
    const dir = tempRepo()
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    const r = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r.status).toBe(0)
    await new Promise((res) => setTimeout(res, 500))
    expect(ran(dir)).not.toContain("FULL")
    expect(marker(dir)).toBeUndefined()
  })

  test("red marker -> full-sync debt repayment: FULL runs in-process, green marker replaces red, exit 0", () => {
    const dir = tempRepo()
    fs.mkdirSync(path.join(dir, ".km", "gate-bg"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".km", "gate-bg", "state.json"),
      JSON.stringify({ status: "red", tree: "stale", startedTs: 1, outputTail: "old failure" }))
    const r = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r.status).toBe(0)
    expect(ran(dir)).toEqual(["FULL"])          // debt path runs ONLY the full check
    expect(marker(dir)?.status).toBe("green")
  })

  test("red marker + full check still failing -> non-zero exit, marker stays red with fresh outputTail", () => {
    const dir = tempRepo()
    fs.mkdirSync(path.join(dir, ".km", "gate-bg"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".km", "gate-bg", "state.json"),
      JSON.stringify({ status: "red", tree: "stale", startedTs: 1 }))
    fs.writeFileSync(path.join(dir, "exits.json"), JSON.stringify({ FULL: 1 }))
    const r = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r.status).not.toBe(0)
    expect(marker(dir)?.status).toBe("red")
  })

  test("bg full-run failure lands a red marker with outputTail", async () => {
    const dir = tempRepo()
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    fs.writeFileSync(path.join(dir, "exits.json"), JSON.stringify({ FULL: 1 }))
    const r = runGate(dir)
    expect(r.status).toBe(0)                     // tier0 green; debt lands async
    expect(await until(() => marker(dir)?.status === "red", 15_000)).toBe(true)
  }, 30_000)

  test("running marker + live pid: no duplicate spawn", async () => {
    const dir = tempRepo()
    fs.mkdirSync(path.join(dir, ".km", "gate-bg"), { recursive: true })
    // this test process's own pid is definitely alive
    fs.writeFileSync(path.join(dir, ".km", "gate-bg", "state.json"),
      JSON.stringify({ status: "running", tree: "t", pid: process.pid, startedTs: Date.now() }))
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    const r = runGate(dir)
    expect(r.status).toBe(0)
    await new Promise((res) => setTimeout(res, 500))
    expect(ran(dir)).not.toContain("FULL")
  })

  test("running marker + dead pid: recovered, new bg spawn happens", async () => {
    const dir = tempRepo()
    fs.mkdirSync(path.join(dir, ".km", "gate-bg"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".km", "gate-bg", "state.json"),
      JSON.stringify({ status: "running", tree: "t", pid: 999999999, startedTs: 1 }))
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    const r = runGate(dir)
    expect(r.status).toBe(0)
    expect(await until(() => marker(dir)?.status !== "running" || marker(dir)?.pid !== 999999999, 15_000)).toBe(true)
  }, 30_000)

  test("green marker + unchanged tree: tier0 only, no spawn", async () => {
    const dir = tempRepo()
    const first = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })   // establishes tree hash? no marker written
    // Establish a green marker for the CURRENT tree via a real bg cycle:
    const r1 = runGate(dir)
    expect(r1.status).toBe(0)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)
    fs.rmSync(path.join(dir, "ran.txt"))
    const r2 = runGate(dir)
    expect(r2.status).toBe(0)
    await new Promise((res) => setTimeout(res, 500))
    expect(ran(dir)).not.toContain("FULL")                    // no re-spawn for same tree
  }, 40_000)

  test("KKAMAK_GATE_FULL=1 forces full-sync regardless of marker state", () => {
    const dir = tempRepo()
    const r = runGate(dir, { KKAMAK_GATE_FULL: "1", KKAMAK_GATE_NO_BG: "1" })
    expect(r.status).toBe(0)
    expect(ran(dir)).toEqual(["FULL"])
  })

  test("untracked files change the tree hash (dirty-tree, not HEAD)", async () => {
    const dir = tempRepo()
    const r1 = runGate(dir)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)
    const t1 = marker(dir).tree
    fs.writeFileSync(path.join(dir, "newfile.txt"), "u")      // untracked
    const r2 = runGate(dir)
    expect(await until(() => marker(dir)?.tree !== t1 && marker(dir)?.status === "green", 15_000)).toBe(true)
  }, 40_000)
})
```

Note on the second test ("tier0 failure blocks"): implement it as — create `km-crank/` subdir in the temp repo with one file, so TIA selects `kmcrank`; set `exits.json` `{"kmcrank": 1}`; assert non-zero exit, `ran.txt` contains `kmcrank`, does NOT contain `FULL`, and `r.stdout + r.stderr` contains the fake's output. The stub in Step 1 is deliberately left for the implementer to write out fully — the assertions above are the contract.

- [ ] **Step 2: Run to verify they fail**

Run: `cd km-crank && bun test test/gate-check-cli.test.ts`
Expected: FAIL — gate-check.ts does not exist (spawnSync exits non-zero / marker never appears).

- [ ] **Step 3: Implement `scripts/gate-check.ts`**

```typescript
// scripts/gate-check.ts
/**
 * Two-tier gate check — the command gate.json names (design:
 * docs/superpowers/plans/2026-08-05-two-tier-gate-check.md; decision logic:
 * km-crank/src/gate-check-core.ts, tested there).
 *
 * Exit 0 = allow the Stop; non-zero = block (check-runner captures output
 * as the block reason). Env: KKAMAK_GATE_FULL=1 forces the incumbent
 * full-sync check; KKAMAK_GATE_NO_BG=1 suppresses the background spawn
 * (tests/CI); KKAMAK_GATE_COMMANDS=<json> replaces the command table
 * (TEST SEAM ONLY).
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawnSync, spawn } from "node:child_process"
import {
  decide, parseMarker, suitesForChangedPaths, ccgateFastFiles,
  type GateBgMarker, type SuiteId,
} from "../km-crank/src/gate-check-core.ts"

const cwd = process.cwd()
const BG_DIR = path.join(cwd, ".km", "gate-bg")
const MARKER = path.join(BG_DIR, "state.json")
const OUTPUT_TAIL_BYTES = 4096

// ---------- command table (real, or test-seam override) ----------
interface Cmd { cwd: string; argv: string[] }
interface CommandTable { suites: Record<SuiteId, Cmd>; full: Cmd }

function realCommands(): CommandTable {
  const testDir = path.join(cwd, "cc-gate-plugin", "test")
  let fast: string[] = []
  try {
    fast = ccgateFastFiles(fs.readdirSync(testDir).filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`))
  } catch { /* no cc-gate-plugin (foreign repo) — suite selection won't pick ccgate anyway */ }
  return {
    suites: {
      ccgate: { cwd: "cc-gate-plugin", argv: ["bun", "test", ...fast] },
      opencode: { cwd: "opencode-plugin", argv: ["bun", "test"] },
      gateplugin: { cwd: "gate-plugin", argv: ["bun", "test"] },
      kmcrank: { cwd: "km-crank", argv: ["bun", "test"] },
      doccheck: { cwd: ".", argv: ["bun", "scripts/doc-check.ts"] },
    },
    // Tier 1 = incumbent check VERBATIM (plan Global Constraints).
    full: { cwd: ".", argv: ["bash", "-c",
      "cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test && cd ../km-crank && bun test && cd .. && bun scripts/doc-check.ts"] },
  }
}

function commands(): CommandTable {
  const seam = process.env.KKAMAK_GATE_COMMANDS
  if (seam) return JSON.parse(fs.readFileSync(seam, "utf8")) as CommandTable
  return realCommands()
}

// ---------- dirty-tree hash (fixture-ref.ts precedent) ----------
function dirtyTreeId(): string {
  const tmpIndex = path.join(BG_DIR, `index-${process.pid}`)
  fs.mkdirSync(BG_DIR, { recursive: true })
  try {
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex }
    execFileSync("git", ["read-tree", "HEAD"], { cwd, env })
    execFileSync("git", ["add", "-A", "--", ".", ":!.km"], { cwd, env })
    return execFileSync("git", ["write-tree"], { cwd, env, encoding: "utf8" }).trim()
  } finally {
    fs.rmSync(tmpIndex, { force: true })
  }
}

function changedPathsSince(tree: string, current: string): string[] | undefined {
  try {
    const out = execFileSync("git", ["diff", "--name-only", tree, current], { cwd, encoding: "utf8" })
    return out.split("\n").filter(Boolean)
  } catch {
    return undefined   // unknown tree (pruned) -> caller falls back to ALL
  }
}

// ---------- marker I/O ----------
function readMarker(): GateBgMarker | undefined {
  try { return parseMarker(fs.readFileSync(MARKER, "utf8")) } catch { return parseMarker(undefined) }
}
function writeMarker(m: GateBgMarker): void {
  fs.mkdirSync(BG_DIR, { recursive: true })
  const tmp = `${MARKER}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(m))
  fs.renameSync(tmp, MARKER)
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

// ---------- runners ----------
function runSync(cmd: Cmd): { code: number; tail: string } {
  const r = spawnSync(cmd.argv[0]!, cmd.argv.slice(1), {
    cwd: path.join(cwd, cmd.cwd), stdio: ["ignore", "inherit", "inherit"], env: process.env,
  })
  return { code: r.status ?? 1, tail: "" }
}
function runSyncCaptured(cmd: Cmd): { code: number; tail: string } {
  const r = spawnSync(cmd.argv[0]!, cmd.argv.slice(1), {
    cwd: path.join(cwd, cmd.cwd), encoding: "utf8", env: process.env,
  })
  const out = (r.stdout ?? "") + (r.stderr ?? "")
  process.stdout.write(out)   // check-runner captures this as the block reason
  return { code: r.status ?? 1, tail: out.slice(-OUTPUT_TAIL_BYTES) }
}

function runFullSync(table: CommandTable, tree: string): number {
  const { code, tail } = runSyncCaptured(table.full)
  writeMarker(code === 0
    ? { status: "green", tree, startedTs: Date.now(), finishedTs: Date.now() }
    : { status: "red", tree, startedTs: Date.now(), finishedTs: Date.now(), outputTail: tail })
  return code
}

/** Detached tier-1: this script re-execs itself in bg mode; the child
 * survives the hook's exit (detached + unref, stdio to a log file). */
function spawnBg(tree: string): void {
  fs.mkdirSync(BG_DIR, { recursive: true })
  const log = fs.openSync(path.join(BG_DIR, "bg.log"), "w")
  const child = spawn("bun", [path.join(cwd, "scripts", "gate-check.ts"), "--bg", tree], {
    cwd, detached: true, stdio: ["ignore", log, log],
    env: { ...process.env, KKAMAK_GATE_NICE: "1" },
  })
  writeMarker({ status: "running", tree, pid: child.pid!, startedTs: Date.now() })
  child.unref()
  fs.closeSync(log)
}

/** --bg <tree>: run the full check, write green/red for <tree>. */
function bgMain(tree: string): never {
  const table = commands()
  const r = spawnSync(table.full.argv[0]!, table.full.argv.slice(1), {
    cwd: path.join(cwd, table.full.cwd), encoding: "utf8", env: process.env,
  })
  const out = (r.stdout ?? "") + (r.stderr ?? "")
  const code = r.status ?? 1
  writeMarker(code === 0
    ? { status: "green", tree, startedTs: Date.now(), finishedTs: Date.now() }
    : { status: "red", tree, startedTs: Date.now(), finishedTs: Date.now(), outputTail: out.slice(-OUTPUT_TAIL_BYTES) })
  process.exit(0)   // bg exit code is irrelevant; the marker is the result
}

// ---------- main ----------
function main(): never {
  if (process.argv[2] === "--bg") bgMain(process.argv[3]!)

  const table = commands()
  const tree = dirtyTreeId()
  const marker = readMarker()
  const d = decide({
    tree, marker, pidAlive,
    forceFull: process.env.KKAMAK_GATE_FULL === "1",
  })

  if (d.mode === "full-sync") {
    if (d.reason === "debt") {
      console.log("gate-check: repaying background-check debt (previous full check FAILED) — running full check synchronously")
      if (marker?.outputTail) console.log(`--- previous failure tail ---\n${marker.outputTail}\n---`)
    }
    process.exit(runFullSync(table, tree))
  }

  // tier 0: package-TIA scoped fast suites
  const base = marker?.status === "green" ? marker.tree : undefined
  const changed = base ? changedPathsSince(base, tree) : undefined
  const suites = changed !== undefined ? suitesForChangedPaths(changed) : [...d.suites]
  console.log(`gate-check: tier0 suites [${suites.join(", ")}] (tree ${tree.slice(0, 8)})`)

  for (const s of suites) {
    const { code } = runSyncCaptured(table.suites[s])
    if (code !== 0) {
      console.error(`gate-check: tier0 suite '${s}' FAILED — blocking`)
      process.exit(code)   // no bg spawn while broken
    }
  }

  if (d.spawnBg && process.env.KKAMAK_GATE_NO_BG !== "1") spawnBg(tree)
  process.exit(0)
}

main()
```

Implementation notes the code above already encodes — keep them true:
- `:!.km` pathspec excludes `.km/` from the dirty-tree hash — otherwise every marker write changes the tree and re-triggers a spawn (feedback loop).
- On `tier0` with NO green baseline, `changed` is `undefined` → suites = `ALL_SUITES` (conservative).
- Tier-0 failure exits without spawning: no point burning 3 CPU-minutes while the tree is known-broken.
- `bgMain` always exits 0 — the MARKER is the channel, not the exit code.

- [ ] **Step 4: Run to verify tests pass**

Run: `cd km-crank && bun test test/gate-check-cli.test.ts` — 0 fail.
Run: `cd km-crank && bun test` — whole km-crank suite green.
Run: `cd km-crank && ./node_modules/.bin/tsc --noEmit` — clean (add `../scripts/gate-check.ts` to km-crank tsconfig include only if it isn't picked up; otherwise verify with `cd cc-gate-plugin && ./node_modules/.bin/tsc --noEmit` untouched).

- [ ] **Step 5: Execute-proof against THIS repo (token-free, no gate.json change yet)**

```bash
KKAMAK_GATE_NO_BG=1 bun scripts/gate-check.ts; echo "exit=$?"
# Expect: tier0 suites line, real fast suites run, exit=0, wall-clock well under 60s.
time KKAMAK_GATE_FULL=1 bun scripts/gate-check.ts >/dev/null; echo "exit=$?"
# Expect: incumbent full check, exit=0 (this one takes ~3min — run once).
```

Record both wall-clocks in the report.

- [ ] **Step 6: Commit**

```bash
git add scripts/gate-check.ts km-crank/test/gate-check-cli.test.ts
git commit -m "feat(gate): scripts/gate-check.ts — tiered check CLI with detached bg full run"
```

### Task 3: Deploy — gate.json swap, instrument note, docs

**Files:**
- Modify: `gate.json` (check string only)
- Modify: `docs/2026-08-01-gauntlet-adoption-ledger.md` (instrument note, deploy ts)
- Modify: `minimal/HISTORY.md` (one-line entry under the GA14 section or a new dated bullet)

**Interfaces:**
- Consumes: `scripts/gate-check.ts` (Task 2).
- Produces: the live gate configuration.

- [ ] **Step 1: Swap the check**

```json
{
  "check": "bun scripts/gate-check.ts",
  "rounds": 2,
  "gauge": true
}
```

- [ ] **Step 2: Live execute-proof of the swapped config**

The gate reads `gate.json` per Stop; prove the exact string it will run:

```bash
bash -c "$(bun -e 'console.log(JSON.parse(require("fs").readFileSync("gate.json","utf8")).check)')"; echo "exit=$?"
```

Expect: tier0 run, exit 0. Then verify the background run it kicked off lands a marker: poll `.km/gate-bg/state.json` until `status` is `green` (it runs the incumbent full check, ~3 min).

- [ ] **Step 3: Instrument note in the adoption ledger**

Append to `docs/2026-08-01-gauntlet-adoption-ledger.md` (pattern: the warm-lane activation log entry above it):

```markdown
## Gate check two-tier deploy (2026-08-05, yoo-mac)

- **Deployed <KST time> (ts <Date.now() at swap>), yoo-mac.local.** `gate.json`
  check swapped from the inline 3-suite string to `bun scripts/gate-check.ts`
  (design: docs/superpowers/plans/2026-08-05-two-tier-gate-check.md). Blocking
  tier = package-TIA-scoped fast suites (spawn-heavy cc-gate files excluded,
  policy regex `SLOW_CCGATE_TEST_RE` in km-crank/src/gate-check-core.ts);
  incumbent full check runs VERBATIM as a detached background run; a red
  background result blocks the next gated Stop with a synchronous full-run
  repayment. `KKAMAK_GATE_FULL=1` restores the incumbent behavior exactly.
- **INSTRUMENT BOUNDARY: gate-outcomes `durationMs`/`checkMs` distributions
  shift at this ts** (~160s gated Stops drop to ~25-45s typical; occasional
  debt-repayment Stops run ~3min). The `check` field string also changes, so
  lines partition cleanly by it. Do not pool duration metrics across the
  boundary. Rounds semantics, block semantics, and the sensor-line schema are
  unchanged.
- **Merge gate unaffected:** scripts/merge-with-gate.sh still runs full
  suites synchronously — the post-integrate stage keeps its cost.
- **Office host:** NOT deployed by this entry; gate.json is committed so the
  swap travels with git pull — office's first pulled session inherits it.
  Same-repo semantics, no per-host activation needed (config, not env).
```

Fill `<KST time>`/`<ts>` with the real values at deploy (`bun -e 'console.log(Date.now(), new Date().toISOString())'`).

- [ ] **Step 4: HISTORY.md line**

Add under the GA14 section's State bullet (or as a trailing bullet):

```markdown
- **2026-08-05 follow-up (yoo-mac):** gate.json check swapped to two-tier
  `scripts/gate-check.ts` — ACP-arc test growth had pushed every gated Stop
  to ~160s (was 26-31s pre-arc); blocking tier back to ~25-45s, full check
  unchanged as a background debt gate. Instrument note in the adoption
  ledger; durationMs never pools across the deploy ts.
```

- [ ] **Step 5: Full-suite sanity + commit**

```bash
cd cc-gate-plugin && bun test && cd ../opencode-plugin && bun test && cd ..
git add gate.json docs/2026-08-01-gauntlet-adoption-ledger.md minimal/HISTORY.md
git commit -m "feat(gate): deploy two-tier gate check — fast blocking tier + bg debt gate (instrument ts in ledger)"
```

(The suites here are the merge-gate-grade proof; the branch merge itself goes through `scripts/merge-with-gate.sh` with a review artifact per 7b — that step belongs to the finishing flow, not this task.)

---

## Post-plan notes (recorded so the executor does not invent them)

- **Why not UserPromptSubmit surfacing:** surfacing debt at prompt-submit needs hook-cli changes (mechanism territory) for one event of earlier warning. The next-gated-Stop debt block gets the same guarantee with zero mechanism change. Revisit only if debt discovery latency proves painful in practice.
- **Why marker-forced full-sync repayment instead of block-with-stored-output:** self-clearing. A stored-output block would need a separate "how do I clear it" path; repayment IS the clearing, and its failure mode is exactly the incumbent gate.
- **`.km/gate-bg/` is host-local runtime state** — never committed, never synced; each host earns its own green markers (parallel: resource-profiles convention).
- **CPU note:** the background full run still costs ~3 CPU-minutes (sys-heavy on this 4-core Intel MacBook); it no longer blocks the session, but fan noise is real. If it bothers, `KKAMAK_GATE_NO_BG=1` in a session env disables bg runs at the cost of debt never accruing (gate weakens to tier-0-only — do not leave it set).
- **Known limitation, accepted:** two rapid gated Stops can observe the same running marker and the second one skips spawning — the running run's tree may be one edit stale. The NEXT gated Stop after it lands spawns for the newer tree. Debt latency is bounded by consecutive gated Stops, which is the design's stated trade.

## Self-review

- Spec coverage: fast blocking tier (T1 core + T2 CLI), async full tier + markers (T2), debt gate (T1 decide + T2 tests), TIA w/ conservative fallback (T1), escape hatches (T2), verbatim tier-1 (T2 constant + constraint), instrument boundary (T3), portability (no /proc//timeout/pkill anywhere). ✓
- Placeholders: second CLI test intentionally specified as a contract note (assertions enumerated) rather than left "TBD" — implementer writes the body; everything else has full code. ✓
- Type consistency: `GateBgMarker`/`GateDecision`/`SuiteId`/`ALL_SUITES`/`ccgateFastFiles`/`suitesForChangedPaths`/`parseMarker`/`decide` names match across T1 definitions, T1 tests, and T2 imports; `KKAMAK_GATE_COMMANDS` JSON shape (`suites`/`full`) matches between T2 test fixture and T2 `commands()`. ✓
