# Phase 1 — check-output sidecar + proposer excerpt rendering: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the failing check output the block branch currently discards into a host-local sidecar (`.km/check-output.ndjson`), and render size-capped excerpts beside counts in km-crank's proposer evidence.

**Architecture:** New `cc-gate-plugin/src/sidecar.ts` (pure record builder + fail-open appender) called from `hook-cli.ts`'s Stop block branch — the F1-safe seam. New pure `km-crank/src/check-output.ts` (parser + session join); `crank.ts` reads each repo's sidecar whole-file; `evidence.ts` renders up to 2 excerpts per notable session. Sidecar never enters the sync-script export list (F2), asserted by test.

**Tech Stack:** Bun/TypeScript, `bun:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-30-phase1-check-output-sidecar-design.md`

## Global Constraints

- **F1:** NO commit may touch `minimal/complete-gate.ts`, `minimal/mutate.ts`, `minimal/spec-probe.ts`, `minimal/session2.ts`, `cc-gate-plugin/src/core/`, `cc-gate-plugin/vendor/` (MECHANISM_PATHS — touching them stales the §4.3 calibration registry). Task 4 verifies `git log f3bb362.. -- <those paths>` is empty.
- **F2:** Sidecar file must never appear in `scripts/km-sensors-sync.sh`'s `FILES=(…)` list, and no code-bearing text may enter `gate-outcomes.ndjson`. Asserted by test (Task 3).
- Excerpt cap: **8192 chars = head 2048 + tail 6144**, splice marker `\n…[kkamak sidecar: N chars elided]…\n`, field `elidedChars` only when elided. Chars, not bytes (parity with `capOutput`).
- Sidecar path fixed: `<cwd>/.km/check-output.ndjson` — independent of `gate.json`'s `sensor` override.
- Fail-open: sidecar write failure must never change the hook's emitted decision/output.
- km-crank stays a standalone package: re-declare the record type locally in `km-crank/src/check-output.ts`; never import cross-package from cc-gate-plugin.
- Evidence output must be byte-identical to today's when no sidecar data exists.
- Per-task review is mandatory (session standing rule).

---

### Task 1: cc-gate-plugin sidecar module + hook-cli wiring

**Files:**
- Create: `cc-gate-plugin/src/sidecar.ts`
- Create: `cc-gate-plugin/test/sidecar.test.ts`
- Modify: `cc-gate-plugin/src/hook-cli.ts` (Stop branch, after sensor append at line ~332, before `// (c) Emit`)
- Modify: `cc-gate-plugin/test/cli.test.ts` (append integration tests)

**Interfaces:**
- Consumes: `StopDecision` block variant `{ kind: "block"; evidence: string; round: number; roundsMax: number; rawOut?: string }` (`src/types.ts:103`); `cfg` from `parseGateConfig` already in scope at the wiring point (`hook-cli.ts:321`).
- Produces (Task 2 mirrors this shape; Task 1 is the emitter of record):
  ```ts
  export interface CheckOutputRecord {
    ts: number
    sessionID: string
    round: number
    roundsMax: number
    check: string
    excerpt: string
    elidedChars?: number
  }
  export function buildCheckOutputRecord(args: {
    ts: number; sessionID: string; round: number; roundsMax: number
    check: string; rawText: string
  }): CheckOutputRecord
  export function appendCheckOutput(cwd: string, rec: CheckOutputRecord, log: (msg: string) => void): void
  ```

- [ ] **Step 1: Write failing tests** — `cc-gate-plugin/test/sidecar.test.ts`:

```ts
// test/sidecar.test.ts — pure excerpt-capping + fail-open append for the
// Phase 1 check-output sidecar (evidence-only; spec
// docs/superpowers/specs/2026-07-30-phase1-check-output-sidecar-design.md).
import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildCheckOutputRecord, appendCheckOutput } from "../src/sidecar.ts"

const BASE = { ts: 1000, sessionID: "s1", round: 1, roundsMax: 2, check: "bun test" }

test("short rawText passes through uncapped, no elidedChars field", () => {
  const rec = buildCheckOutputRecord({ ...BASE, rawText: "FAIL: expected 2 got 3" })
  expect(rec.excerpt).toBe("FAIL: expected 2 got 3")
  expect("elidedChars" in rec).toBe(false)
  expect(rec).toMatchObject(BASE)
})

test("rawText at exactly 8192 chars is NOT elided", () => {
  const rec = buildCheckOutputRecord({ ...BASE, rawText: "x".repeat(8192) })
  expect(rec.excerpt.length).toBe(8192)
  expect("elidedChars" in rec).toBe(false)
})

test("long rawText keeps head 2048 + tail 6144 with splice marker + elidedChars", () => {
  const rawText = "H".repeat(2048) + "M".repeat(5000) + "T".repeat(6144)
  const rec = buildCheckOutputRecord({ ...BASE, rawText })
  expect(rec.excerpt.startsWith("H".repeat(2048))).toBe(true)
  expect(rec.excerpt.endsWith("T".repeat(6144))).toBe(true)
  expect(rec.excerpt).toContain("[kkamak sidecar: 5000 chars elided]")
  expect(rec.elidedChars).toBe(5000)
})

test("appendCheckOutput appends one ndjson line, mkdir -p as needed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-"))
  try {
    const rec = buildCheckOutputRecord({ ...BASE, rawText: "boom" })
    appendCheckOutput(dir, rec, () => {})
    appendCheckOutput(dir, { ...rec, round: 2 }, () => {})
    const lines = fs
      .readFileSync(path.join(dir, ".km", "check-output.ndjson"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatchObject({ ...BASE, excerpt: "boom" })
    expect(lines[1].round).toBe(2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("appendCheckOutput swallows write failure and logs (fail-open)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-"))
  try {
    // Make the sidecar PATH a directory so appendFileSync fails (EISDIR).
    fs.mkdirSync(path.join(dir, ".km", "check-output.ndjson"), { recursive: true })
    const logs: string[] = []
    const rec = buildCheckOutputRecord({ ...BASE, rawText: "boom" })
    expect(() => appendCheckOutput(dir, rec, (m) => logs.push(m))).not.toThrow()
    expect(logs.length).toBe(1)
    expect(logs[0]).toContain("check-output")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("F1: sidecar module lives outside every MECHANISM_PATH", () => {
  // Documentation-grade guard: the sidecar seam must stay out of the
  // calibration-covered paths (roadmap constraint F1).
  const rel = "cc-gate-plugin/src/sidecar.ts"
  for (const p of ["cc-gate-plugin/src/core", "cc-gate-plugin/vendor"]) {
    expect(rel.startsWith(p)).toBe(false)
  }
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cc-gate-plugin && bun test test/sidecar.test.ts`
Expected: FAIL — `Cannot find module '../src/sidecar.ts'`

- [ ] **Step 3: Implement `cc-gate-plugin/src/sidecar.ts`**

```ts
/**
 * sidecar.ts — Phase 1 check-output sidecar (evidence-only; spec
 * docs/superpowers/specs/2026-07-30-phase1-check-output-sidecar-design.md).
 *
 * Captures the failing check output that the Stop block branch otherwise
 * discards after delivering it to the agent. Lives at the hook-cli seam ON
 * PURPOSE (F1): src/core/ and vendor/ are MECHANISM_PATHS — any commit
 * there stales the §4.3 calibration registry. This file must never move
 * under either.
 *
 * The sidecar is host-local and NEVER exported by km-sensors-sync.sh (F2:
 * the snapshot is a one-way door; code-bearing text must not reach it).
 */
import fs from "node:fs"
import path from "node:path"

const HEAD_CHARS = 2048
const TAIL_CHARS = 6144
const SIDECAR_REL_PATH = ".km/check-output.ndjson"

export interface CheckOutputRecord {
  ts: number
  sessionID: string
  round: number
  roundsMax: number
  check: string
  excerpt: string
  /** Present only when the raw text exceeded HEAD_CHARS + TAIL_CHARS.
   * Chars, not bytes — parity with hook-cli's capOutput, which slices
   * String.length. */
  elidedChars?: number
}

export function buildCheckOutputRecord(args: {
  ts: number
  sessionID: string
  round: number
  roundsMax: number
  check: string
  rawText: string
}): CheckOutputRecord {
  const { rawText, ...rest } = args
  if (rawText.length <= HEAD_CHARS + TAIL_CHARS) {
    return { ...rest, excerpt: rawText }
  }
  const elidedChars = rawText.length - HEAD_CHARS - TAIL_CHARS
  const excerpt =
    rawText.slice(0, HEAD_CHARS) +
    `\n…[kkamak sidecar: ${elidedChars} chars elided]…\n` +
    rawText.slice(-TAIL_CHARS)
  return { ...rest, excerpt, elidedChars }
}

/** mkdir -p then append one ndjson line. Never throws: failures are logged
 * and swallowed — a sidecar-write problem must never change the emitted
 * decision (same fail-open contract as hook-cli's appendSensor). Path is
 * the FIXED default, deliberately independent of gate.json's `sensor`
 * override (spec §A). */
export function appendCheckOutput(cwd: string, rec: CheckOutputRecord, log: (msg: string) => void): void {
  try {
    const p = path.resolve(cwd, SIDECAR_REL_PATH)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(rec) + "\n")
  } catch (e) {
    try {
      log(`hook-cli: failed to append check-output sidecar (swallowed): ${String(e)}`)
    } catch {
      // even logging failed; nothing more to do
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cc-gate-plugin && bun test test/sidecar.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Write failing integration tests** — append to `cc-gate-plugin/test/cli.test.ts` (reuse existing `runHook`/`mkRepo`/`rmRepo`/`writeGate`/`seedState` helpers already defined at the top of that file):

```ts
function sidecarRecords(repo: string): Record<string, unknown>[] {
  const p = path.join(repo, ".km", "check-output.ndjson")
  return fs
    .readFileSync(p, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

test("Stop block round appends one check-output sidecar record with pre-reinject raw output", async () => {
  const repo = mkRepo()
  try {
    writeGate(repo, { check: "echo COMPILE_HEAD; echo TEST_TAIL; exit 1", rounds: 2 })
    seedState(repo, "sc1", { edited: true })
    const r = await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "sc1", cwd: repo }) })
    expect(r.exitCode).toBe(0) // block-json delivery: decision on stdout
    const recs = sidecarRecords(repo)
    expect(recs.length).toBe(1)
    expect(recs[0]).toMatchObject({ sessionID: "sc1", round: 1, roundsMax: 2 })
    expect(recs[0]!.excerpt as string).toContain("COMPILE_HEAD")
    expect(recs[0]!.excerpt as string).toContain("TEST_TAIL")
    expect(typeof recs[0]!.ts).toBe("number")
  } finally {
    rmRepo(repo)
  }
})

test("Stop accepted round appends NO sidecar record", async () => {
  const repo = mkRepo()
  try {
    writeGate(repo, { check: "true", rounds: 2 })
    seedState(repo, "sc2", { edited: true })
    await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "sc2", cwd: repo }) })
    expect(fs.existsSync(path.join(repo, ".km", "check-output.ndjson"))).toBe(false)
  } finally {
    rmRepo(repo)
  }
})

test("sidecar write failure changes nothing about the emitted block decision", async () => {
  const repo = mkRepo()
  try {
    writeGate(repo, { check: "echo NOPE; exit 1", rounds: 2 })
    // Baseline run in a healthy twin repo for comparison.
    const twin = mkRepo()
    writeGate(twin, { check: "echo NOPE; exit 1", rounds: 2 })
    seedState(twin, "sc3", { edited: true })
    const healthy = await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "sc3", cwd: twin }) })
    // Sabotage: sidecar path is a directory -> append fails (EISDIR).
    fs.mkdirSync(path.join(repo, ".km", "check-output.ndjson"), { recursive: true })
    seedState(repo, "sc3", { edited: true })
    const sabotaged = await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "sc3", cwd: repo }) })
    expect(sabotaged.exitCode).toBe(healthy.exitCode)
    expect(sabotaged.stdout).toBe(healthy.stdout)
    expect(sabotaged.stderr).toContain("check-output")
    rmRepo(twin)
  } finally {
    rmRepo(repo)
  }
})
```

Run: `cd cc-gate-plugin && bun test test/cli.test.ts`
Expected: new tests FAIL (no sidecar file written yet); all pre-existing tests PASS.

- [ ] **Step 6: Wire into `hook-cli.ts`**

Import (with the other `./` imports at the top):

```ts
import { appendCheckOutput, buildCheckOutputRecord } from "./sidecar.ts"
```

Insert after `if (line) appendSensor(cwd, gateConfigRaw, line, deps.log)` (line ~332) and before the `// (c) Emit` comment — `cfg` is already in scope from line ~321:

```ts
  // Phase 1 check-output sidecar (evidence-only; spec docs/superpowers/
  // specs/2026-07-30-phase1-check-output-sidecar-design.md): capture the
  // failing check output the block branch otherwise discards. PRE-reinject
  // rawOut on purpose — the sidecar records what the check printed, not
  // what delivery shaped. Fail-open inside; never touches gate-outcomes,
  // never changes the decision. Exhausted final rounds are NOT captured:
  // their rawOut never leaves core/stop.ts, and core/ is a MECHANISM_PATH
  // (F1) — documented spec limitation, not an oversight.
  if (decision.kind === "block") {
    appendCheckOutput(
      cwd,
      buildCheckOutputRecord({
        ts: Date.now(),
        sessionID: sessionId,
        round: decision.round,
        roundsMax: decision.roundsMax,
        check: cfg?.check ?? "",
        rawText: decision.rawOut ?? decision.evidence,
      }),
      deps.log,
    )
  }
```

- [ ] **Step 7: Run full plugin suite**

Run: `cd cc-gate-plugin && bun test`
Expected: PASS, 385 pre-existing + 9 new (6 sidecar + 3 cli)

- [ ] **Step 8: Commit**

```bash
git add cc-gate-plugin/src/sidecar.ts cc-gate-plugin/test/sidecar.test.ts cc-gate-plugin/src/hook-cli.ts cc-gate-plugin/test/cli.test.ts
git commit -m "feat(cc-gate-plugin): check-output sidecar at hook-cli seam — capture block-round raw output (Phase 1, evidence-only)"
```

---

### Task 2: km-crank check-output parser + session join (pure)

**Files:**
- Create: `km-crank/src/check-output.ts`
- Create: `km-crank/test/check-output.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (standalone pure module; record type RE-DECLARED locally — km-crank never imports cross-package, same rule as `scan.ts`).
- Produces (Task 3 relies on these exact names):
  ```ts
  export interface CheckOutputRecord {
    ts: number; sessionID: string; round: number; roundsMax: number
    check: string; excerpt: string; elidedChars?: number
  }
  export function parseCheckOutputRecords(text: string): CheckOutputRecord[]
  /** Records grouped per requested sessionID, sorted ts DESC (latest first).
   * Sessions with no records are absent from the map. */
  export function joinBySession(sessionIDs: string[], records: CheckOutputRecord[]): Map<string, CheckOutputRecord[]>
  ```

- [ ] **Step 1: Write failing tests** — `km-crank/test/check-output.test.ts`:

```ts
// test/check-output.test.ts — pure parser + session join for the Phase 1
// check-output sidecar (emitter: cc-gate-plugin/src/sidecar.ts; shape
// re-declared locally per the standalone-package rule, same as scan.ts).
import { test, expect } from "bun:test"
import { parseCheckOutputRecords, joinBySession, type CheckOutputRecord } from "../src/check-output.ts"

function rec(over: Partial<CheckOutputRecord>): CheckOutputRecord {
  return {
    ts: 1000, sessionID: "s1", round: 1, roundsMax: 2,
    check: "bun test", excerpt: "FAIL", ...over,
  }
}

test("parses valid ndjson lines, skips blank/malformed/wrong-shape lines", () => {
  const text = [
    JSON.stringify(rec({})),
    "",
    "not json {",
    JSON.stringify({ ts: 2, sessionID: "s2" }), // missing required fields
    JSON.stringify(rec({ sessionID: "s2", ts: 2000, elidedChars: 7 })),
  ].join("\n")
  const out = parseCheckOutputRecords(text)
  expect(out.length).toBe(2)
  expect(out[0]!.sessionID).toBe("s1")
  expect(out[1]!).toMatchObject({ sessionID: "s2", elidedChars: 7 })
})

test("empty text parses to empty array, never throws", () => {
  expect(parseCheckOutputRecords("")).toEqual([])
})

test("joinBySession groups only requested sessions, sorted ts DESC", () => {
  const records = [
    rec({ sessionID: "a", ts: 1, round: 1 }),
    rec({ sessionID: "a", ts: 3, round: 2 }),
    rec({ sessionID: "b", ts: 2 }),
    rec({ sessionID: "zzz-not-requested", ts: 9 }),
  ]
  const m = joinBySession(["a", "b", "c"], records)
  expect([...m.keys()].sort()).toEqual(["a", "b"])
  expect(m.get("a")!.map((r) => r.ts)).toEqual([3, 1])
  expect(m.get("b")!.length).toBe(1)
  expect(m.has("c")).toBe(false)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd km-crank && bun test test/check-output.test.ts`
Expected: FAIL — `Cannot find module '../src/check-output.ts'`

- [ ] **Step 3: Implement `km-crank/src/check-output.ts`**

```ts
/**
 * check-output.ts — PURE parsing/joining of the Phase 1 check-output
 * sidecar (`.km/check-output.ndjson`, emitted by
 * cc-gate-plugin/src/sidecar.ts on block rounds; spec
 * docs/superpowers/specs/2026-07-30-phase1-check-output-sidecar-design.md).
 *
 * Shape re-declared locally rather than imported cross-package — km-crank
 * stays standalone (same rule and rationale as scan.ts's SensorLine).
 * No fs here: crank.ts owns the whole-file read and calls in with strings.
 * The sidecar is host-local and NEVER exported to the evidence snapshot
 * (F2) — this module only feeds proposer evidence rendering.
 */

export interface CheckOutputRecord {
  ts: number
  sessionID: string
  round: number
  roundsMax: number
  check: string
  excerpt: string
  elidedChars?: number
}

function isCheckOutputRecord(v: unknown): v is CheckOutputRecord {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o["ts"] === "number" &&
    typeof o["sessionID"] === "string" &&
    typeof o["round"] === "number" &&
    typeof o["roundsMax"] === "number" &&
    typeof o["check"] === "string" &&
    typeof o["excerpt"] === "string"
  )
}

/** Parse ndjson text into records. Blank lines, malformed JSON, and lines
 * not matching the shape are silently skipped — never throws (degrade
 * gracefully, same contract as scan.ts's parseSensorLines). */
export function parseCheckOutputRecords(text: string): CheckOutputRecord[] {
  const out: CheckOutputRecord[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (isCheckOutputRecord(parsed)) out.push(parsed)
  }
  return out
}

/** Group records by sessionID, restricted to `sessionIDs`, each group
 * sorted ts DESC (latest round first — the renderer shows the most recent
 * failures). Sessions with no records are absent from the map. */
export function joinBySession(
  sessionIDs: string[],
  records: CheckOutputRecord[],
): Map<string, CheckOutputRecord[]> {
  const wanted = new Set(sessionIDs)
  const m = new Map<string, CheckOutputRecord[]>()
  for (const r of records) {
    if (!wanted.has(r.sessionID)) continue
    const arr = m.get(r.sessionID)
    if (arr) arr.push(r)
    else m.set(r.sessionID, [r])
  }
  for (const arr of m.values()) arr.sort((a, b) => b.ts - a.ts)
  return m
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd km-crank && bun test test/check-output.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add km-crank/src/check-output.ts km-crank/test/check-output.test.ts
git commit -m "feat(km-crank): check-output sidecar parser + session join (pure, Phase 1)"
```

---

### Task 3: evidence excerpt rendering + crank wiring + F2 guard test

**Files:**
- Modify: `km-crank/src/evidence.ts`
- Modify: `km-crank/src/crank.ts:214-219` (repoResults map)
- Modify: `km-crank/test/evidence.test.ts` (add excerpt-rendering tests)
- Modify: `km-crank/test/repos-parity.test.ts` (add F2 FILES-list guard test)

**Interfaces:**
- Consumes: `CheckOutputRecord`, `parseCheckOutputRecords`, `joinBySession` from Task 2 (exact signatures in Task 2's Produces block).
- Produces: `RepoEvidence` gains `excerptsBySession?: Map<string, CheckOutputRecord[]>` (optional — absent renders byte-identical to today).

- [ ] **Step 1: Write failing render tests** — append to `km-crank/test/evidence.test.ts` (follow that file's existing fixture style for `SensorLine`s; a minimal line fixture shown here):

```ts
import { parseCheckOutputRecords as _unused } from "../src/check-output.ts" // (only if not already imported)
import type { CheckOutputRecord } from "../src/check-output.ts"

function checkRec(over: Partial<CheckOutputRecord>): CheckOutputRecord {
  return {
    ts: 1000, sessionID: "sess-1", round: 1, roundsMax: 2,
    check: "bun test", excerpt: "FAIL: expected await", ...over,
  }
}

test("renders up to 2 excerpts per notable session, latest first, tilde-fenced", () => {
  const line = {
    ts: 1, sessionID: "sess-1", check: "bun test", accepted: true,
    gateExhausted: true, rounds: ["verify-failed", "verify-failed", "verify-failed"],
    interrupted: false, marker: false, durationMs: 5000, host: "h", app: "claude-code",
  }
  const md = renderEvidence(
    [{
      repo: "/r",
      newLines: [line],
      aggregate: aggregate([line]),
      notableLines: [line],
      excerptsBySession: new Map([[
        "sess-1",
        [checkRec({ ts: 30, round: 3, excerpt: "THIRD" }),
         checkRec({ ts: 20, round: 2, excerpt: "SECOND" }),
         checkRec({ ts: 10, round: 1, excerpt: "FIRST" })],
      ]]),
    }],
    0,
  )
  expect(md).toContain("THIRD")
  expect(md).toContain("SECOND")
  expect(md).not.toContain("FIRST") // budget: 2 per session
  expect(md).toContain("~~~") // tilde fence — check output may contain backticks
  expect(md.indexOf("THIRD")).toBeLessThan(md.indexOf("SECOND")) // latest first
})

test("render excerpt trimmed to last 1200 chars with leading elision marker", () => {
  const long = "A".repeat(500) + "Z".repeat(1200)
  const md = renderEvidence(
    [{
      repo: "/r",
      newLines: [],
      aggregate: aggregate([]),
      notableLines: [{
        ts: 1, sessionID: "sess-1", check: "c", accepted: true, gateExhausted: true,
        rounds: ["verify-failed"], interrupted: false, marker: false,
        durationMs: 1, host: "h", app: "claude-code",
      }],
      excerptsBySession: new Map([["sess-1", [checkRec({ excerpt: long })]]]),
    }],
    0,
  )
  expect(md).toContain("Z".repeat(1200))
  expect(md).not.toContain("A".repeat(500) + "Z") // head trimmed away
  expect(md).toContain("…") // trim marker
})

test("absent excerptsBySession renders byte-identical to pre-Phase-1 output", () => {
  const repo = {
    repo: "/r", newLines: [], aggregate: aggregate([]), notableLines: [],
  }
  const withField = { ...repo, excerptsBySession: new Map() }
  expect(renderEvidence([withField], 0)).toBe(renderEvidence([repo], 0))
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd km-crank && bun test test/evidence.test.ts`
Expected: new tests FAIL (`excerptsBySession` not rendered); pre-existing tests PASS.

- [ ] **Step 3: Implement rendering in `evidence.ts`**

Add import and constants at the top:

```ts
import type { CheckOutputRecord } from "./check-output.ts"

const MAX_EXCERPTS_PER_SESSION = 2
const EXCERPT_RENDER_CHARS = 1200
```

Extend `RepoEvidence`:

```ts
export interface RepoEvidence {
  repo: string
  newLines: SensorLine[]
  aggregate: Aggregate
  notableLines: SensorLine[]
  /** Phase 1 sidecar join (check-output.ts's joinBySession) — host-local
   * block-round excerpts keyed by sessionID, ts DESC. Optional: absent
   * (pre-Phase-1 data, kernel-emitted repos, missing sidecar file) must
   * render byte-identical to the pre-Phase-1 output. */
  excerptsBySession?: Map<string, CheckOutputRecord[]>
}
```

In `renderRepoSection`, inside the `for (const l of r.notableLines)` loop, after the existing `lines.push(...)` bullet, add:

```ts
      const recs = r.excerptsBySession?.get(l.sessionID) ?? []
      for (const rec of recs.slice(0, MAX_EXCERPTS_PER_SESSION)) {
        const tail =
          rec.excerpt.length > EXCERPT_RENDER_CHARS
            ? "…" + rec.excerpt.slice(-EXCERPT_RENDER_CHARS)
            : rec.excerpt
        // Tilde fence: check output routinely contains backticks; a
        // backtick fence would break the markdown mid-excerpt.
        lines.push(`  - check output, round ${rec.round}/${rec.roundsMax}:`, "", "~~~", tail, "~~~", "")
      }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd km-crank && bun test test/evidence.test.ts`
Expected: PASS (all pre-existing + 3 new)

- [ ] **Step 5: Write failing F2 guard test** — append to `km-crank/test/repos-parity.test.ts` (it already reads `scripts/km-sensors-sync.sh`; reuse its path resolution):

```ts
test("F2: check-output sidecar is NEVER in km-sensors-sync.sh's FILES export list", () => {
  // The snapshot is a one-way door (refuse-on-shrink dedup): a sidecar line
  // exported once can never be retroactively stripped. The sidecar carries
  // code-bearing check output and must stay host-local forever.
  const script = fs.readFileSync(SYNC_SCRIPT_PATH, "utf-8")
  const filesLine = script.split("\n").find((l) => l.trimStart().startsWith("FILES=("))
  expect(filesLine).toBeDefined()
  expect(filesLine!).not.toContain("check-output")
})
```

(Use the sync-script path constant/name already present in that file; if it is a local, mirror its resolution — `path.join(import.meta.dir, "..", "..", "scripts", "km-sensors-sync.sh")`.)

Run: `cd km-crank && bun test test/repos-parity.test.ts`
Expected: PASS immediately IF the FILES line is currently clean — this is a tripwire, not a red-first test; verify it by temporarily reading a doctored string if in doubt, but do NOT commit a doctored script.

- [ ] **Step 6: Wire `crank.ts`**

Replace `crank.ts:214-219`:

```ts
  const repoResults: RepoEvidence[] = scans.map((s) => ({
    repo: s.repo,
    newLines: s.newLines,
    aggregate: aggregate(s.newLines),
    notableLines: notable(s.newLines, 5),
  }))
```

with:

```ts
  const repoResults: RepoEvidence[] = scans.map((s) => {
    const notableLines = notable(s.newLines, 5)
    // Phase 1 sidecar (host-local, never exported — F2): whole-file read,
    // no byte-offset bookkeeping — the file grows slowly and the join
    // filters to notable sessionIDs anyway. Missing file -> no excerpts.
    let sidecarText = ""
    try {
      sidecarText = fs.readFileSync(path.join(s.repo, ".km", "check-output.ndjson"), "utf-8")
    } catch {
      // absent/unreadable sidecar is the normal pre-Phase-1 case
    }
    const excerptsBySession = joinBySession(
      notableLines.map((l) => l.sessionID),
      parseCheckOutputRecords(sidecarText),
    )
    return { repo: s.repo, newLines: s.newLines, aggregate: aggregate(s.newLines), notableLines, excerptsBySession }
  })
```

Add to imports:

```ts
import { joinBySession, parseCheckOutputRecords } from "./check-output.ts"
```

- [ ] **Step 7: Run full km-crank suite**

Run: `cd km-crank && bun test`
Expected: PASS, 189 pre-existing + new (3 check-output + 3 evidence + 1 parity)

- [ ] **Step 8: Commit**

```bash
git add km-crank/src/evidence.ts km-crank/src/crank.ts km-crank/test/evidence.test.ts km-crank/test/repos-parity.test.ts
git commit -m "feat(km-crank): render block-round excerpts beside counts in proposer evidence + F2 FILES-list tripwire (Phase 1)"
```

---

### Task 4: F1/F2 phase verification + suites + docs seal

**Files:**
- Modify: `docs/resume.md` (queue status only, if session continues past this)
- No source files.

**Interfaces:** none — verification-only task.

- [ ] **Step 1: F1 verification — MECHANISM_PATHS untouched across the whole phase**

Run:
```bash
git log --oneline f3bb362.. -- minimal/complete-gate.ts minimal/mutate.ts minimal/spec-probe.ts minimal/session2.ts cc-gate-plugin/src/core cc-gate-plugin/vendor
```
Expected: EMPTY output. Any commit listed = F1 violation — stop, revert that commit, escalate to user.

- [ ] **Step 2: F2 verification — sync script untouched**

Run: `git log --oneline f3bb362.. -- scripts/km-sensors-sync.sh`
Expected: EMPTY output.

- [ ] **Step 3: Full suites, both packages**

Run: `cd cc-gate-plugin && bun test && cd ../km-crank && bun test`
Expected: both PASS (394 / 196 — pre-existing + new counts from Tasks 1–3)

- [ ] **Step 4: Live smoke on this repo (meta-harness is armed via kkamak-dev)**

In a scratch tmp repo (NOT meta-harness — don't pollute the real kkamak-dev stream):
```bash
d=$(mktemp -d); cd "$d"
echo '{"check":"echo SMOKE_FAIL; exit 1","rounds":2}' > gate.json
mkdir -p .km/cc-gate
echo '{"v":1,"edited":true,"gating":false,"round":0,"outcomes":[],"cycleStartedAt":0,"failStreak":0,"updatedAt":0}' > .km/cc-gate/smoke.json
echo '{"session_id":"smoke","cwd":"'"$d"'"}' | bun /Users/yoo/z2/meta-harness/cc-gate-plugin/src/hook-cli.ts Stop
cat .km/check-output.ndjson
```
Expected: one ndjson record, `"sessionID":"smoke"`, excerpt contains `SMOKE_FAIL`. Clean up: `rm -rf "$d"`.

- [ ] **Step 5: Note — deployed-plugin refresh**

The live installed plugin (both hosts) still runs the pre-sidecar copy until `km-refresh.sh --force` is run. Do NOT run it inside this task without user go — flag it in the session SITREP instead (deploy = a spend/live-behavior decision).

- [ ] **Step 6: Commit (docs only, if any changed)**

```bash
git add docs/resume.md
git commit -m "docs(resume): Phase 1 sidecar built + verified (F1/F2 clean, suites green); deploy pending km-refresh"
```

---

## Self-Review (done at plan-write time)

1. **Spec coverage:** A (capture: Task 1) · B (consumption: Tasks 2–3) · C (guards: Task 1 F1 path test, Task 3 F2 tripwire, Task 4 git-log verification) · D (registration: spec committed `f3bb362`+amendment; HISTORY at session seal) · success criteria 1–3 (Tasks 1/3 tests), 4 (Task 4), 5 (Tasks 1/3/4). No gaps.
2. **Placeholder scan:** clean — every code step carries real code.
3. **Type consistency:** `CheckOutputRecord` field set identical in Task 1 (emitter) and Task 2 (re-declaration; deliberate duplication per standalone-package rule, verified name-by-name: ts/sessionID/round/roundsMax/check/excerpt/elidedChars). `joinBySession(sessionIDs, records)` signature matches Task 3's call. `excerptsBySession` name consistent across evidence.ts/crank.ts/tests.
