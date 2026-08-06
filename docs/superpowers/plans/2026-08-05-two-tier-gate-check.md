# Two-Tier Gate Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the dogfood gate's blocking Stop-hook cost from ~160s back to ~25-45s by splitting the check into a sync fast tier (blocks, package-scoped) and a detached async full tier (marker-keyed debt gate), without touching the gate mechanism.

**Architecture:** The gate kernel (`cc-gate-plugin/src/core/`, MECHANISM_PATH) and `check-runner.ts` are untouched — the entire change lives inside the check command that `gate.json` names. A new `scripts/gate-check.ts` (thin CLI) + `km-crank/src/gate-check-core.ts` (pure, tested logic) implement: dirty-tree hashing (temp-index `git write-tree`, the `fixture-ref.ts` precedent), package-level test-impact selection with a conservative run-everything fallback, a background full run detached from the hook (`nohup`-style, survives hook exit), and a marker state machine under `.km/gate-bg/` whose `red` state forces a synchronous full-run debt repayment on the next gated Stop. Industry pattern: Fowler's pre-integrate/post-integrate split + TIA with fallback-to-full. Three pre-execution amendments (2026-08-05 office assessment, ruled before any execution) are folded into the tasks below: **(a)** wedged-bg liveness bound — a `running` marker older than `BG_STALE_MS` with a live pid is treated as dead (pid-scoped kill + respawn); **(b)** slow-source pull-in — changed slow-covered sources pull their matching slow test file(s) into tier 0, targeted, not the whole ~110s; **(c)** fallback scope — every conservative fallback runs `FALLBACK_SUITES` (the incumbent check's scope, opencode excluded) so the stated ~25-45s fallback cost stays true.

**Tech Stack:** Bun/TypeScript, git plumbing (`write-tree` with `GIT_INDEX_FILE`), bun:test.

## Global Constraints

- **F1:** `cc-gate-plugin/src/core/` is a MECHANISM_PATH — never edited. This plan touches only `km-crank/`, `scripts/`, `gate.json`, and docs.
- **F2:** no sampled prompt text in committed artifacts. Marker files live under `.km/gate-bg/` (host-local, gitignored via `.km/`); the stored failure-output tail is check output only and never committed.
- **Tier 1 is the incumbent check VERBATIM:** `cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test && cd ../km-crank && bun test && cd .. && bun scripts/doc-check.ts` — byte-identical string, run async (or sync on debt/`KKAMAK_GATE_FULL=1`). The gate's full-verification semantics never weaken; only WHEN the full check blocks changes (next gated Stop instead of this one).
- **Conservative fallback (amendment c):** any changed path not matched by the TIA map unions in `FALLBACK_SUITES` — the incumbent check's scope (`ccgate`/`gateplugin`/`kmcrank`/`doccheck`). opencode is NOT in the fallback set: the incumbent check never ran it, and including it would add ~47s to every no-green-baseline Stop. opencode still runs whenever TIA matches `opencode-plugin/` or functional `minimal/` paths (blocking coverage the incumbent never had). Missing/invalid marker state degrades to spawning a fresh full run; `KKAMAK_GATE_FULL=1` forces the incumbent behavior exactly.
- **Wedged-bg liveness bound (amendment a):** a `running` marker whose `startedTs` is older than `BG_STALE_MS` (15 min ≈ 3× expected full-check duration) is treated as dead even when the pid is alive — pid-scoped kill, then fresh respawn. Without this bound one hung bg run (alive pid that never finishes — the ACP daemon tests have exactly this failure mode: 36s budgets, hanging stubs) makes every future Stop see running+alive ⇒ never spawn, and full-check coverage silently stops for as long as the process lives.
- **Slow-source pull-in (amendment b):** a changed slow-covered source (e.g. `src/gauge/acp-daemon.ts`) would otherwise get ZERO blocking coverage — TIA picks ccgate, and tier 0 excludes exactly the tests that cover the change. Fix: changed slow sources/stubs/test files pull their MATCHING slow test file(s) into the ccgate tier-0 argv (`slowCcgateTestsForChangedPaths`), targeted, not the whole ~110s.
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
  - `type GateDecision = { mode: "tier0"; suites: SuiteId[]; spawnBg: boolean; killPid?: number } | { mode: "full-sync"; reason: "debt" | "forced" }` — `killPid` set only for a wedged bg run (amendment a).
  - `decide(input: { tree: string; marker: GateBgMarker | undefined; pidAlive: (pid: number) => boolean; forceFull: boolean; now: number }): GateDecision`
  - `BG_STALE_MS: number` — wedged-bg liveness bound, `15 * 60_000`.
  - `type SuiteId = "ccgate" | "opencode" | "gateplugin" | "kmcrank" | "doccheck"`
  - `ALL_SUITES: SuiteId[]` — `["ccgate", "opencode", "gateplugin", "kmcrank", "doccheck"]`
  - `FALLBACK_SUITES: SuiteId[]` — `["ccgate", "gateplugin", "kmcrank", "doccheck"]`, incumbent scope, used for every conservative fallback (amendment c).
  - `suitesForChangedPaths(paths: string[]): SuiteId[]` — TIA map, conservative; doc-only paths checked FIRST (so `minimal/HISTORY.md` stays doc-only) with `minimal/CLAUDE.md` carved out as functional (sha256'd harness slot).
  - `ccgateFastFiles(allTestFiles: string[]): string[]` — filters the slow spawn-heavy files.
  - `slowCcgateTestsForChangedPaths(paths: string[]): string[]` — matching slow test files for changed slow-covered sources/stubs/tests (amendment b).
  - `SLOW_CCGATE_TEST_RE: RegExp` — the exclusion policy, one place.

- [ ] **Step 1: Write the failing tests**

```typescript
// km-crank/test/gate-check-core.test.ts
import { describe, expect, test } from "bun:test"
import {
  parseMarker, decide, suitesForChangedPaths, ccgateFastFiles,
  slowCcgateTestsForChangedPaths,
  ALL_SUITES, FALLBACK_SUITES, BG_STALE_MS, type GateBgMarker,
} from "../src/gate-check-core.ts"

const T1 = "aaaa1111"
const T2 = "bbbb2222"
const NOW = 100_000_000
const mk = (m: Partial<GateBgMarker>): GateBgMarker =>
  ({ status: "green", tree: T1, startedTs: NOW - 1000, ...m }) as GateBgMarker
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
    expect(decide({ tree: T1, marker: mk({ status: "red" }), pidAlive: alive, forceFull: true, now: NOW }))
      .toEqual({ mode: "full-sync", reason: "forced" })
  })
  test("red marker -> full-sync debt repayment, regardless of tree match", () => {
    expect(decide({ tree: T2, marker: mk({ status: "red", tree: T1 }), pidAlive: alive, forceFull: false, now: NOW }))
      .toEqual({ mode: "full-sync", reason: "debt" })
  })
  test("running + pid alive + fresh -> tier0, no new spawn", () => {
    const d = decide({ tree: T2, marker: mk({ status: "running", tree: T1, pid: 7 }), pidAlive: alive, forceFull: false, now: NOW })
    expect(d).toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: false })
  })
  test("running + pid alive + startedTs older than BG_STALE_MS -> WEDGED: kill + respawn (amendment a)", () => {
    const d = decide({
      tree: T1, marker: mk({ status: "running", tree: T1, pid: 7, startedTs: NOW - BG_STALE_MS - 1 }),
      pidAlive: alive, forceFull: false, now: NOW,
    })
    expect(d).toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: true, killPid: 7 })
  })
  test("running exactly AT the bound is not yet wedged", () => {
    const d = decide({
      tree: T1, marker: mk({ status: "running", tree: T1, pid: 7, startedTs: NOW - BG_STALE_MS }),
      pidAlive: alive, forceFull: false, now: NOW,
    })
    expect(d).toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: false })
  })
  test("running + pid dead (crash/reboot) -> treated as absent: tier0 + spawn, no killPid", () => {
    const d = decide({ tree: T1, marker: mk({ status: "running", tree: T1, pid: 7 }), pidAlive: dead, forceFull: false, now: NOW })
    expect(d).toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: true })
  })
  test("running with pid ABSENT is malformed-in-effect -> tier0 + spawn", () => {
    const d = decide({ tree: T1, marker: mk({ status: "running", pid: undefined }), pidAlive: alive, forceFull: false, now: NOW })
    expect(d).toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: true })
  })
  test("green + same tree -> tier0, nothing to spawn", () => {
    expect(decide({ tree: T1, marker: mk({ status: "green", tree: T1 }), pidAlive: alive, forceFull: false, now: NOW }))
      .toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: false })
  })
  test("green + different tree -> tier0 + spawn for the new tree", () => {
    expect(decide({ tree: T2, marker: mk({ status: "green", tree: T1 }), pidAlive: alive, forceFull: false, now: NOW }))
      .toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: true })
  })
  test("no marker -> tier0 + spawn", () => {
    expect(decide({ tree: T1, marker: undefined, pidAlive: alive, forceFull: false, now: NOW }))
      .toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: true })
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
  test("markdown under a TIA package is still doc-only: minimal/HISTORY.md does not drag opencode in", () => {
    expect(suitesForChangedPaths(["minimal/HISTORY.md"])).toEqual(["doccheck"])
  })
  test("minimal/CLAUDE.md is FUNCTIONAL (sha256'd harness slot) -> opencode despite .md", () => {
    expect(suitesForChangedPaths(["minimal/CLAUDE.md"])).toEqual(["opencode", "doccheck"])
  })
  test("unknown path -> FALLBACK_SUITES (incumbent scope — no opencode; amendment c)", () => {
    expect(suitesForChangedPaths(["term-bench2/store/x.json"])).toEqual(FALLBACK_SUITES)
    expect(suitesForChangedPaths(["scripts/gate-check.ts"])).toEqual(FALLBACK_SUITES)
  })
  test("unknown path + opencode-matched path -> union is ALL_SUITES (fallback never DROPS a TIA pick)", () => {
    expect(suitesForChangedPaths(["scripts/x.ts", "opencode-plugin/src/y.ts"])).toEqual(ALL_SUITES)
  })
  test("union across paths, deduplicated, stable ALL_SUITES order", () => {
    expect(suitesForChangedPaths(["km-crank/src/a.ts", "cc-gate-plugin/src/b.ts"]))
      .toEqual(["ccgate", "kmcrank", "doccheck"])
  })
  test("empty change list -> doccheck only (nothing to test, doc drift still checked)", () => {
    expect(suitesForChangedPaths([])).toEqual(["doccheck"])
  })
})

describe("slowCcgateTestsForChangedPaths (amendment b)", () => {
  test("changed slow source pulls its DIRECT value-import consumers (exact lists)", () => {
    expect(slowCcgateTestsForChangedPaths(["cc-gate-plugin/src/gauge/acp-daemon.ts"]))
      .toEqual(["test/acp-daemon.test.ts"])
    expect(slowCcgateTestsForChangedPaths(["cc-gate-plugin/src/gauge/agent-transport.ts"]))
      .toEqual(["test/acp-client.test.ts", "test/anthropic-cli-warm.test.ts", "test/gauge-agent-transport.test.ts"])
    expect(slowCcgateTestsForChangedPaths(["cc-gate-plugin/src/gauge/providers/anthropic-cli-warm.ts"]))
      .toEqual(["test/anthropic-cli-warm.test.ts"])
    expect(slowCcgateTestsForChangedPaths(["cc-gate-plugin/src/gauge/warm-session.ts"]))
      .toEqual(["test/acp-pool.test.ts", "test/warm-session.test.ts"])
    expect(slowCcgateTestsForChangedPaths(["cc-gate-plugin/src/gauge/acp-pool.ts"]))
      .toEqual(["test/acp-daemon.test.ts", "test/acp-pool.test.ts"])
  })
  test("changed slow TEST file pulls itself", () => {
    expect(slowCcgateTestsForChangedPaths(["cc-gate-plugin/test/warm-session.test.ts"]))
      .toEqual(["test/warm-session.test.ts"])
  })
  test("changed test stubs pull their direct slow consumers (exact lists)", () => {
    expect(slowCcgateTestsForChangedPaths(["cc-gate-plugin/test/acp-fake-daemon.ts"]))
      .toEqual(["test/acp-client.test.ts", "test/anthropic-cli-warm.test.ts"])
    expect(slowCcgateTestsForChangedPaths(["cc-gate-plugin/test/agent-cli-stub.ts"]))
      .toEqual([
        "test/acp-client.test.ts", "test/acp-daemon.test.ts",
        "test/gauge-agent-transport.test.ts", "test/warm-session.test.ts",
      ])
  })
  test("fast files, foreign packages, near-miss basenames pull nothing", () => {
    expect(slowCcgateTestsForChangedPaths([
      "cc-gate-plugin/src/gauge/acp-wire.ts",     // fast, not in the slow set
      "km-crank/src/acp-daemon.ts",               // foreign package
      "cc-gate-plugin/src/reinject.ts",
    ])).toEqual([])
  })
  test("deduplicated union across paths", () => {
    expect(slowCcgateTestsForChangedPaths([
      "cc-gate-plugin/src/gauge/acp-pool.ts", "cc-gate-plugin/test/acp-pool.test.ts",
    ])).toEqual(["test/acp-daemon.test.ts", "test/acp-pool.test.ts"])
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

/** Conservative-fallback scope = the incumbent check's scope (amendment c).
 * opencode is deliberately absent: the incumbent gate never ran it, and
 * putting it in the fallback would add ~47s to every no-baseline Stop.
 * opencode still runs when TIA matches opencode-plugin/ or functional
 * minimal/ paths — blocking coverage the incumbent never had. */
export const FALLBACK_SUITES: SuiteId[] = ["ccgate", "gateplugin", "kmcrank", "doccheck"]

/** Wedged-bg liveness bound (amendment a): a "running" marker older than
 * this is treated as dead even with a live pid (≈3× expected full-check
 * duration). A hung bg run must not stop full-check coverage forever. */
export const BG_STALE_MS = 15 * 60_000

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
  | { mode: "tier0"; suites: SuiteId[]; spawnBg: boolean; killPid?: number }
  | { mode: "full-sync"; reason: "debt" | "forced" }

/** The whole state machine, one place. Order matters:
 * forced > debt > running-alive (fresh vs wedged) > everything-else. */
export function decide(input: {
  tree: string
  marker: GateBgMarker | undefined
  pidAlive: (pid: number) => boolean
  forceFull: boolean
  now: number
}): GateDecision {
  if (input.forceFull) return { mode: "full-sync", reason: "forced" }
  const m = input.marker
  if (m?.status === "red") return { mode: "full-sync", reason: "debt" }
  if (m?.status === "running" && typeof m.pid === "number" && input.pidAlive(m.pid)) {
    if (input.now - m.startedTs > BG_STALE_MS) {
      // wedged (amendment a): alive pid that never finishes. Kill pid-scoped,
      // respawn — otherwise full-check coverage silently stops for as long
      // as the hung process lives.
      return { mode: "tier0", suites: FALLBACK_SUITES, spawnBg: true, killPid: m.pid }
    }
    return { mode: "tier0", suites: FALLBACK_SUITES, spawnBg: false }
  }
  if (m?.status === "green" && m.tree === input.tree) {
    return { mode: "tier0", suites: FALLBACK_SUITES, spawnBg: false }
  }
  // no marker, dead "running", pid-less "running", or green-for-older-tree
  return { mode: "tier0", suites: FALLBACK_SUITES, spawnBg: true }
}

/** Package-level TIA. Conservative: any path outside the map unions in
 * FALLBACK_SUITES (never an early return — a fallback must never DROP a
 * TIA-picked suite like opencode). `minimal/` maps to opencode (its tests
 * live in opencode-plugin/test/; cc-gate-plugin only holds VENDORED
 * byte-copies, which change under cc-gate-plugin/ and select ccgate on
 * their own). Doc-only paths are checked FIRST so markdown inside a TIA
 * package (minimal/HISTORY.md) stays doc-only; minimal/CLAUDE.md is
 * carved out — it is the FUNCTIONAL sha256'd harness slot, not a doc.
 * doccheck always runs — seconds, and doc drift is half of what the gate
 * exists to catch. */
const TIA_MAP: Array<{ re: RegExp; suite: SuiteId }> = [
  { re: /^cc-gate-plugin\//, suite: "ccgate" },
  { re: /^opencode-plugin\//, suite: "opencode" },
  { re: /^minimal\//, suite: "opencode" },
  { re: /^gate-plugin\//, suite: "gateplugin" },
  { re: /^km-crank\//, suite: "kmcrank" },
]
const FUNCTIONAL_MD_RE = /^minimal\/CLAUDE\.md$/
const DOC_ONLY_RE = /^docs\/|\.md$/

export function suitesForChangedPaths(paths: string[]): SuiteId[] {
  const picked = new Set<SuiteId>()
  for (const p of paths) {
    if (DOC_ONLY_RE.test(p) && !FUNCTIONAL_MD_RE.test(p)) continue  // doccheck added below
    const hit = TIA_MAP.find((e) => e.re.test(p))
    if (hit) { picked.add(hit.suite); continue }
    for (const s of FALLBACK_SUITES) picked.add(s)   // conservative fallback, unioned
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

/** Amendment b: slow-source pull-in. A changed slow-covered source must
 * pull its MATCHING slow test file(s) into tier 0 — otherwise the one
 * suite that tests the change is exactly the one excluded (edit
 * acp-daemon.ts ⇒ TIA picks ccgate ⇒ tier 0 runs ccgate MINUS the
 * acp-daemon tests). Targeted: only the matching file(s), never the whole
 * ~110s slow set. Source basenames + stub consumers grep-verified
 * 2026-08-05 against cc-gate-plugin (sources in src/gauge/ and
 * src/gauge/providers/; stubs in test/). */
// Policy: DIRECT value imports only (one hop, source/stub -> slow test
// file; `import type` does not count — it cannot break at runtime).
// Deeper transitive chains (e.g. warm-session.ts -> acp-pool.ts ->
// acp-daemon.test.ts) are deliberately NOT chased: full closure would pull
// most of the ~110s slow set and defeat "targeted"; the bg debt gate is
// the stated safety net for that depth.
const SLOW_SOURCE_TO_TESTS: Array<{ re: RegExp; tests: string[] }> = [
  { re: /(^|\/)acp-client\.ts$/, tests: ["test/acp-client.test.ts"] },
  { re: /(^|\/)acp-daemon\.ts$/, tests: ["test/acp-daemon.test.ts"] },
  { re: /(^|\/)acp-pool\.ts$/, tests: ["test/acp-daemon.test.ts", "test/acp-pool.test.ts"] },
  { re: /(^|\/)anthropic-cli-warm\.ts$/, tests: ["test/anthropic-cli-warm.test.ts"] },
  { re: /(^|\/)warm-session\.ts$/, tests: ["test/acp-pool.test.ts", "test/warm-session.test.ts"] },
  { re: /(^|\/)agent-transport\.ts$/, tests: [
    "test/acp-client.test.ts", "test/anthropic-cli-warm.test.ts", "test/gauge-agent-transport.test.ts",
  ] },
  // test stubs — direct value consumers among the SLOW files only
  // (anthropic-api.test.ts also imports agent-cli-stub but is fast — it
  // already runs in every ccgate tier 0):
  { re: /(^|\/)acp-fake-daemon\.ts$/, tests: ["test/acp-client.test.ts", "test/anthropic-cli-warm.test.ts"] },
  { re: /(^|\/)agent-cli-stub\.ts$/, tests: [
    "test/acp-client.test.ts", "test/acp-daemon.test.ts",
    "test/gauge-agent-transport.test.ts", "test/warm-session.test.ts",
  ] },
]

export function slowCcgateTestsForChangedPaths(paths: string[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    if (!/^cc-gate-plugin\//.test(p)) continue
    // a changed slow TEST file pulls itself (test/ or a future src/-colocated one)
    const tm = p.match(/^cc-gate-plugin\/((?:test|src)\/.*\.test\.ts)$/)
    if (tm && SLOW_CCGATE_TEST_RE.test(p)) { out.add(tm[1]!); continue }
    for (const m of SLOW_SOURCE_TO_TESTS) if (m.re.test(p)) for (const t of m.tests) out.add(t)
  }
  return [...out].sort()
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
- Consumes (from Task 1, exact names): `decide`, `parseMarker`, `suitesForChangedPaths`, `ccgateFastFiles`, `slowCcgateTestsForChangedPaths`, `GateBgMarker`, `SuiteId` from `../km-crank/src/gate-check-core.ts` (script imports by relative path from repo root; km-crank has no exports map — direct file import, same pattern as `opencode-plugin/test` importing `cc-gate-plugin` files).
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
import { execFileSync, spawn, spawnSync } from "node:child_process"

const GATE_CHECK = path.join(import.meta.dir, "..", "..", "scripts", "gate-check.ts")
const CLEANUP: string[] = []
const CLEANUP_PIDS: number[] = []
afterEach(() => {
  for (const p of CLEANUP_PIDS.splice(0)) { try { process.kill(p) } catch {} }  // pid-scoped only
  for (const d of CLEANUP.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "gate-check-"))
  CLEANUP.push(dir)
  execFileSync("git", ["init", "-q"], { cwd: dir })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir })
  fs.mkdirSync(path.join(dir, ".km"), { recursive: true })
  return dir
}

/** Command-table fixture: every suite runs `fake.ts <suite>` which appends
 * its suite id to ran.txt (and its full argv tail to args.txt — lets tests
 * assert appended slow-test files) and exits with the code in exits.json
 * (default 0). The full check appends "FULL". */
function writeCommands(dir: string): string {
  const fake = path.join(dir, "fake.ts")
  fs.writeFileSync(fake, `
const fs = require("node:fs"); const path = require("node:path")
const dir = ${JSON.stringify(dir)}
const tag = process.argv[2]
fs.appendFileSync(path.join(dir, "ran.txt"), tag + "\\n")
fs.appendFileSync(path.join(dir, "args.txt"), process.argv.slice(2).join(" ") + "\\n")
console.log("FAKE_OUT:" + tag)   // lets tests prove output capture is real
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
  test("first run (no marker, no baseline): tier0 = FALLBACK_SUITES (incumbent scope — ccgate yes, opencode NO), exits 0, spawns bg full run that lands green", async () => {
    const dir = tempRepo()
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    const r = runGate(dir)
    expect(r.status).toBe(0)
    // no green baseline exists yet -> TIA has nothing to diff against ->
    // conservative fallback = incumbent scope (amendment c), NOT doc-only
    expect(ran(dir)).toContain("doccheck")
    expect(ran(dir)).toContain("ccgate")
    expect(ran(dir)).not.toContain("opencode")
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)
    expect(ran(dir)).toContain("FULL")
  }, 30_000)

  test("docs-only change AFTER a green baseline: TIA active, tier0 runs doccheck only", async () => {
    const dir = tempRepo()
    const r1 = runGate(dir)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)  // baseline
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    fs.rmSync(path.join(dir, "ran.txt"))
    const r2 = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r2.status).toBe(0)
    expect(ran(dir)).toContain("doccheck")
    expect(ran(dir)).not.toContain("ccgate")
  }, 30_000)

  test("tier0 failure blocks: failing suite -> non-zero exit, failure output present, NO bg spawn", async () => {
    // CONTRACT (implementer writes the body): write exits.json
    // {"kmcrank": 1}; runGate(dir). This is a first run (no baseline), so
    // tier0 = FALLBACK_SUITES which includes kmcrank — TIA is not involved.
    // Assert: r.status !== 0; ran(dir) contains "kmcrank" and NOT "FULL";
    // r.stdout+r.stderr contains "FAKE_OUT:kmcrank" (proves the
    // runSyncCaptured output-capture path); marker(dir) stays undefined
    // (no spawn while broken).
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

  test("wedged bg run (running + ALIVE pid + stale startedTs): group kill, fresh respawn (amendment a)", async () => {
    const dir = tempRepo()
    // detached => own process group, same shape as a real spawnBg child
    const hung = spawn("bun", ["-e", "setTimeout(() => {}, 1_000_000_000)"], { stdio: "ignore", detached: true })
    hung.unref()
    CLEANUP_PIDS.push(hung.pid!)
    fs.mkdirSync(path.join(dir, ".km", "gate-bg"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".km", "gate-bg", "state.json"),
      JSON.stringify({ status: "running", tree: "t", pid: hung.pid, startedTs: Date.now() - 16 * 60_000 }))
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    const r = runGate(dir)
    expect(r.status).toBe(0)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)   // fresh bg landed
    expect(await until(() => { try { process.kill(hung.pid!, 0); return false } catch { return true } }, 5_000))
      .toBe(true)                                                                    // old pid is dead
  }, 30_000)

  test("changed slow-covered source pulls its matching slow test into the ccgate argv (amendment b)", async () => {
    const dir = tempRepo()
    const r1 = runGate(dir)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)   // green baseline
    fs.mkdirSync(path.join(dir, "cc-gate-plugin", "src", "gauge"), { recursive: true })
    fs.writeFileSync(path.join(dir, "cc-gate-plugin", "src", "gauge", "acp-daemon.ts"), "// x")
    fs.rmSync(path.join(dir, "args.txt"), { force: true })
    const r2 = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r2.status).toBe(0)
    const args = fs.readFileSync(path.join(dir, "args.txt"), "utf8")
    expect(args).toContain("ccgate test/acp-daemon.test.ts")
  }, 30_000)
})
```

Note on the "tier0 failure blocks" test: implement it as — set `exits.json` `{"kmcrank": 1}` in a fresh temp repo (first run ⇒ no baseline ⇒ tier0 = `FALLBACK_SUITES`, which includes `kmcrank`; TIA plays no part); assert non-zero exit, `ran.txt` contains `kmcrank`, does NOT contain `FULL`, and `r.stdout + r.stderr` contains `FAKE_OUT:kmcrank` (the fake's stdout line — proves `runSyncCaptured` actually captures and re-emits suite output). The stub in Step 1 is deliberately left for the implementer to write out fully — the assertions above are the contract.

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
  slowCcgateTestsForChangedPaths,
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
  // Scan test/ AND src/ recursively: bare `bun test` (the full check)
  // discovers .test.ts anywhere in the package, so a src/-colocated test
  // must not silently drop out of tier 0. None exist today (verified
  // 2026-08-05) — this is the guard for when one lands.
  const fast: string[] = (() => {
    const all: string[] = []
    for (const root of ["test", "src"]) {
      const abs = path.join(cwd, "cc-gate-plugin", root)
      let entries: string[] = []
      try { entries = fs.readdirSync(abs, { recursive: true }) as string[] } catch { continue }
      // foreign repo / missing dirs -> empty list; suite selection won't pick ccgate anyway
      for (const e of entries) if (e.endsWith(".test.ts")) all.push(`${root}/${e}`)
    }
    return ccgateFastFiles(all)
  })()
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
 * survives the hook's exit (detached + unref, stdio to a log file).
 * MUST use import.meta.path (the script's own resolved location), NOT a
 * cwd-relative guess — the CLI tests run this script from throwaway temp
 * repos that contain no scripts/ directory. */
function spawnBg(tree: string): void {
  fs.mkdirSync(BG_DIR, { recursive: true })
  const log = fs.openSync(path.join(BG_DIR, "bg.log"), "w")
  const child = spawn("bun", [import.meta.path, "--bg", tree], {
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
    now: Date.now(),
  })

  if (d.mode === "full-sync") {
    if (d.reason === "debt") {
      console.log("gate-check: repaying background-check debt (previous full check FAILED) — running full check synchronously")
      if (marker?.outputTail) console.log(`--- previous failure tail ---\n${marker.outputTail}\n---`)
    }
    process.exit(runFullSync(table, tree))
  }

  if (d.killPid !== undefined) {
    // wedged bg run (amendment a): spawnBg used detached:true, so killPid is
    // a process-GROUP leader — signal the group (negative pid) so the hung
    // bash/bun grandchildren die too, not just the wrapper. Falls back to
    // the single pid if the group is already gone. Still pid-scoped
    // (standing rule: never pkill -f).
    console.log(`gate-check: bg full run wedged (pid ${d.killPid}, started >15min ago) — killing group + respawning`)
    try { process.kill(-d.killPid) } catch { try { process.kill(d.killPid) } catch { /* died in between */ } }
  }

  // tier 0: package-TIA scoped fast suites (+ amendment-b slow pull-in)
  const base = marker?.status === "green" ? marker.tree : undefined
  const changed = base ? changedPathsSince(base, tree) : undefined
  const suites = changed !== undefined ? suitesForChangedPaths(changed) : [...d.suites]
  const slowPull = changed !== undefined ? slowCcgateTestsForChangedPaths(changed) : []
  console.log(`gate-check: tier0 suites [${suites.join(", ")}]${slowPull.length ? ` + slow pull-in [${slowPull.join(", ")}]` : ""} (tree ${tree.slice(0, 8)})`)

  for (const s of suites) {
    // amendment b: changed slow-covered sources append their matching slow
    // test files to the ccgate argv (fast list never contains them — no dupes)
    const cmd = s === "ccgate" && slowPull.length > 0
      ? { cwd: table.suites.ccgate.cwd, argv: [...table.suites.ccgate.argv, ...slowPull] }
      : table.suites[s]
    const { code } = runSyncCaptured(cmd)
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
- On `tier0` with NO green baseline, `changed` is `undefined` → suites = `d.suites` = `FALLBACK_SUITES` (incumbent scope, amendment c) and the slow pull-in list is empty (nothing to diff against — the bg full run covers the slow files).
- Tier-0 failure exits without spawning: no point burning 3 CPU-minutes while the tree is known-broken.
- `bgMain` always exits 0 — the MARKER is the channel, not the exit code.
- The wedged-pid kill signals the process GROUP (`process.kill(-pid)`, falling back to `process.kill(pid)`): `spawnBg`'s `detached: true` makes the bg child a group leader, and a positive-pid signal would kill only the wrapper while orphaning the actually-hung `bash -c` chain underneath it. Both calls try/catch'd — the process may die between `decide` and the kill. Never `pkill -f` (standing rule).

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
## Gate check two-tier deploy (<date>, <host>)

- **Deployed <KST time> (ts <Date.now() at swap>), <host>.** `gate.json`
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
- **Merge gate unaffected:** scripts/merge-with-gate.sh still runs full
  suites synchronously — the post-integrate stage keeps its cost.
- **Office host:** NOT deployed by this entry; gate.json is committed so the
  swap travels with git pull — office's first pulled session inherits it.
  Same-repo semantics, no per-host activation needed (config, not env).
```

Fill `<date>`/`<host>`/`<KST time>`/`<ts>` with the real values at deploy (`hostname; bun -e 'console.log(Date.now(), new Date().toISOString())'`) — the deploy host is wherever Task 3 actually executes (the other host inherits via git pull, as the entry's last bullet records; adjust that bullet's host name accordingly).

- [ ] **Step 4: HISTORY.md line**

Add under the GA14 section's State bullet (or as a trailing bullet):

```markdown
- **<date> follow-up (<host>):** gate.json check swapped to two-tier
  `scripts/gate-check.ts` — ACP-arc test growth had pushed every gated Stop
  to ~160s (was 26-31s pre-arc); blocking tier back to ~25-45s, full check
  unchanged as a background debt gate. Instrument note in the adoption
  ledger; durationMs never pools across the deploy ts.
```

- [ ] **Step 5: Full-suite sanity + commit**

```bash
cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test && cd ../km-crank && bun test && cd .. && bun scripts/doc-check.ts && cd opencode-plugin && bun test && cd ..
git add gate.json docs/2026-08-01-gauntlet-adoption-ledger.md minimal/HISTORY.md
git commit -m "feat(gate): deploy two-tier gate check — fast blocking tier + bg debt gate (instrument ts in ledger)"
```

(The suites here are the merge-gate-grade proof; the branch merge itself goes through `scripts/merge-with-gate.sh` with a review artifact per 7b — that step belongs to the finishing flow, not this task.)

---

## Post-plan notes (recorded so the executor does not invent them)

- **Why not UserPromptSubmit surfacing:** surfacing debt at prompt-submit needs hook-cli changes (mechanism territory) for one event of earlier warning. The next-gated-Stop debt block gets the same guarantee with zero mechanism change. Revisit only if debt discovery latency proves painful in practice.
- **Why marker-forced full-sync repayment instead of block-with-stored-output:** self-clearing. A stored-output block would need a separate "how do I clear it" path; repayment IS the clearing, and its failure mode is exactly the incumbent gate.
- **`.km/gate-bg/` is host-local runtime state** — never committed, never synced; each host earns its own green markers (parallel: resource-profiles convention).
- **CPU note:** the background full run still costs ~3 CPU-minutes (sys-heavy on this 6-core/12-thread Intel MacBook (i7-8850H)); it no longer blocks the session, but fan noise is real. If it bothers, `KKAMAK_GATE_NO_BG=1` in a session env disables bg runs at the cost of debt never accruing (gate weakens to tier-0-only — do not leave it set).
- **Known limitation, accepted:** two rapid gated Stops can observe the same running marker and the second one skips spawning — the running run's tree may be one edit stale. The NEXT gated Stop after it lands spawns for the newer tree. Debt latency is bounded by consecutive gated Stops, which is the design's stated trade.
- **Why opencode is out of the fallback set (amendment c):** the incumbent check never ran the opencode suite, so a fallback that includes it would make every no-green-baseline Stop ~80-90s and falsify the ~25-45s claim. Fallback = incumbent scope exactly; opencode's blocking coverage (TIA-selected on `opencode-plugin/` / functional `minimal/` changes) is strictly ADDED coverage relative to the incumbent, never traded against fallback cost.
- **Why the wedged bound is 15 min (amendment a):** ≈3× the expected full-check duration (~3 min) with margin for load; long enough that no healthy run is ever killed, short enough that a hung ACP-daemon-style run (alive pid, never finishes) costs at most one 15-min coverage gap instead of a silent forever-gap.
- **Slow-source mapping is data, not scan (amendment b):** `SLOW_SOURCE_TO_TESTS` is a hand-verified table (grep'd 2026-08-05, DIRECT value imports only — `import type` excluded since it cannot break at runtime; deeper transitive chains deliberately not chased, the bg debt gate covers that depth). If a new slow test lands, `SLOW_CCGATE_TEST_RE` and this table change together — same file, same policy site.

## Self-review

- Spec coverage: fast blocking tier (T1 core + T2 CLI), async full tier + markers (T2), debt gate (T1 decide + T2 tests), TIA w/ conservative fallback (T1), escape hatches (T2), verbatim tier-1 (T2 constant + constraint), instrument boundary (T3), portability (no /proc//timeout/pkill anywhere). ✓
- Pre-execution amendments folded in (2026-08-05, ruled before any execution — spec-is-law compliant): (a) wedged-bg liveness bound `BG_STALE_MS` + `killPid` (T1 decide + tests, T2 kill + wedged CLI test); (b) slow-source pull-in `slowCcgateTestsForChangedPaths` (T1 + tests, T2 argv merge + CLI test); (c) `FALLBACK_SUITES` incumbent-scope fallback (T1 + tests, T3 ledger numbers). Minors: `runSync` dead code deleted; doc-first TIA ordering with `minimal/CLAUDE.md` functional carve-out. ✓
- Placeholders: second CLI test intentionally specified as a contract note (assertions enumerated) rather than left "TBD" — implementer writes the body; everything else has full code. ✓
- Type consistency: `GateBgMarker`/`GateDecision`/`SuiteId`/`ALL_SUITES`/`FALLBACK_SUITES`/`BG_STALE_MS`/`ccgateFastFiles`/`slowCcgateTestsForChangedPaths`/`suitesForChangedPaths`/`parseMarker`/`decide` names match across T1 definitions, T1 tests, and T2 imports; `KKAMAK_GATE_COMMANDS` JSON shape (`suites`/`full`) matches between T2 test fixture and T2 `commands()`; the T2 fake records `args.txt` which the amendment-b CLI test reads. ✓
- Architect-review round 1 (2026-08-05) — all findings fixed in-plan: (1) `spawnBg` re-execs via `import.meta.path`, not a cwd-relative guess (was breaking every bg-dependent CLI test in temp repos); (2) first-run semantics reconciled — no green baseline ⇒ `FALLBACK_SUITES`, TIA activates only after a baseline lands; CLI Test 1 + the failure-test contract rewritten to match, doc-only-after-baseline covered by its own test; (3) `SLOW_SOURCE_TO_TESTS` regenerated from the actual direct value-import graph (acp-pool→+acp-daemon.test, warm-session→+acp-pool.test, agent-transport→+acp-client/anthropic-cli-warm tests, agent-cli-stub corrected to its four slow direct consumers; `import type` excluded); unit tests tightened to exact lists; (4) wedged kill signals the process GROUP (`kill(-pid)` w/ single-pid fallback) so the hung chain dies, not just the wrapper — CLI test spawns its hung stand-in detached to match; (5) fake emits `FAKE_OUT:<tag>` so output-capture assertions are non-vacuous; (6) tier-0 file discovery scans `test/` + `src/` recursively (guards future src-colocated tests; self-pull regex widened to match); (7) Task 3 Step 5 runs the genuinely full suite set. ✓
