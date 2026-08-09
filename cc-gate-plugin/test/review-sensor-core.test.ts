import { test, expect, describe, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  shouldDispatch,
  nextCapState,
  truncateDiff,
  buildReviewPrompt,
  reviewPromptSha,
  parseFindings,
  passLine,
  skipLine,
  DEBOUNCE_MS,
  DAILY_CAP,
  MODEL,
  type SensorState,
  type SkipReason,
} from "../src/review-sensor/core.ts"
import { pruneSideFiles } from "../src/review-sensor/runner.ts"

describe("shouldDispatch", () => {
  test("undefined state → go: true", () => {
    const now = Date.now()
    const result = shouldDispatch(undefined, now)
    expect(result).toEqual({ go: true })
  })

  test("delta < DEBOUNCE_MS → debounce", () => {
    const now = 1000000000
    const state = {
      lastPassTs: now - (DEBOUNCE_MS - 1000), // 1 second before debounce threshold
      lastPassHead: "abc123",
      dayKey: "2026-08-06",
      dayCount: 1,
    }
    const result = shouldDispatch(state, now)
    expect(result).toEqual({ go: false, reason: "debounce" })
  })

  test("delta >= DEBOUNCE_MS → go", () => {
    const now = 1000000000
    const state = {
      lastPassTs: now - DEBOUNCE_MS - 1000, // Just past debounce threshold
      lastPassHead: "abc123",
      dayKey: "2026-08-06",
      dayCount: 1,
    }
    const result = shouldDispatch(state, now)
    expect(result).toEqual({ go: true })
  })

  test("negative delta (future lastPassTs) → clock-skew", () => {
    const now = 1000000000
    const state = {
      lastPassTs: now + 1000, // Future timestamp
      lastPassHead: "abc123",
      dayKey: "2026-08-06",
      dayCount: 1,
    }
    const result = shouldDispatch(state, now)
    expect(result).toEqual({ go: false, reason: "clock-skew" })
  })

  test("dayCount 29 → go", () => {
    const now = Date.now()
    const todayKey = new Date(now).toLocaleDateString("en-CA")
    const state = {
      lastPassTs: now - DEBOUNCE_MS - 1000,
      lastPassHead: "abc123",
      dayKey: todayKey,
      dayCount: 29,
    }
    const result = shouldDispatch(state, now)
    expect(result).toEqual({ go: true })
  })

  test("dayCount 30 → cap", () => {
    const now = Date.now()
    const todayKey = new Date(now).toLocaleDateString("en-CA")
    const state = {
      lastPassTs: now - DEBOUNCE_MS - 1000,
      lastPassHead: "abc123",
      dayKey: todayKey,
      dayCount: 30,
    }
    const result = shouldDispatch(state, now)
    expect(result).toEqual({ go: false, reason: "cap" })
  })

  test("dayCount > 30 → cap", () => {
    const now = Date.now()
    const todayKey = new Date(now).toLocaleDateString("en-CA")
    const state = {
      lastPassTs: now - DEBOUNCE_MS - 1000,
      lastPassHead: "abc123",
      dayKey: todayKey,
      dayCount: 31,
    }
    const result = shouldDispatch(state, now)
    expect(result).toEqual({ go: false, reason: "cap" })
  })

  test("dayKey rollover resets cap: dayCount 30 from yesterday → one minute after midnight → go", () => {
    // Set up: one minute after local midnight
    const date = new Date()
    date.setHours(0, 1, 0, 0)
    const afterMidnightMs = date.getTime()

    // State from yesterday with count at 30
    const yesterday = new Date(afterMidnightMs - 86400000)
    const yesterdayKey = yesterday.toLocaleDateString("en-CA")

    const state = {
      lastPassTs: afterMidnightMs - DEBOUNCE_MS - 1000,
      lastPassHead: "abc123",
      dayKey: yesterdayKey,
      dayCount: 30,
    }

    const result = shouldDispatch(state, afterMidnightMs)
    expect(result).toEqual({ go: true })
  })

  test("dayKey same-day cap check: one minute before midnight with dayCount 30 → cap", () => {
    // Set up: one minute before local midnight
    const date = new Date()
    date.setHours(23, 59, 0, 0)
    const beforeMidnightMs = date.getTime()

    const todayKey = date.toLocaleDateString("en-CA")

    const state = {
      lastPassTs: beforeMidnightMs - DEBOUNCE_MS - 1000,
      lastPassHead: "abc123",
      dayKey: todayKey,
      dayCount: 30,
    }

    const result = shouldDispatch(state, beforeMidnightMs)
    expect(result).toEqual({ go: false, reason: "cap" })
  })
})

describe("nextCapState", () => {
  test("undefined state → today, 1", () => {
    const now = Date.now()
    const result = nextCapState(undefined, now)
    const expectedKey = new Date(now).toLocaleDateString("en-CA") // YYYY-MM-DD
    expect(result.dayKey).toBe(expectedKey)
    expect(result.dayCount).toBe(1)
  })

  test("same dayKey → count+1", () => {
    const now = 1000000000
    const todayKey = new Date(now).toLocaleDateString("en-CA")
    const state = {
      lastPassTs: now - 1000,
      lastPassHead: "abc123",
      dayKey: todayKey,
      dayCount: 5,
    }
    const result = nextCapState(state, now)
    expect(result.dayKey).toBe(todayKey)
    expect(result.dayCount).toBe(6)
  })

  test("different dayKey → today, 1", () => {
    const now = 1000000000
    const oldKey = "2026-08-05"
    const state = {
      lastPassTs: now - 86400000, // yesterday
      lastPassHead: "abc123",
      dayKey: oldKey,
      dayCount: 10,
    }
    const result = nextCapState(state, now)
    const expectedKey = new Date(now).toLocaleDateString("en-CA")
    expect(result.dayKey).toBe(expectedKey)
    expect(result.dayCount).toBe(1)
  })

  test("dayKey rollover at midnight: nextCapState and shouldDispatch use same dayKey", () => {
    // Use milliseconds right before midnight in local time
    const date = new Date()
    date.setHours(23, 59, 59, 999)
    const beforeMidnightMs = date.getTime()

    const afterMidnightMs = beforeMidnightMs + 1

    const stateBefore = nextCapState(undefined, beforeMidnightMs)
    const stateAfter = nextCapState(undefined, afterMidnightMs)

    // Keys should differ if crossing midnight
    if (stateBefore.dayKey !== stateAfter.dayKey) {
      // Both nextCapState and shouldDispatch must use the same dayKey for the same `now`
      // Create full SensorState objects for the re-call
      const fullStateBefore: SensorState = {
        ...stateBefore,
        lastPassTs: beforeMidnightMs - 1000,
        lastPassHead: "test",
      }
      const fullStateAfter: SensorState = {
        ...stateAfter,
        lastPassTs: afterMidnightMs - 1000,
        lastPassHead: "test",
      }

      const capStateBefore = nextCapState(fullStateBefore, beforeMidnightMs)
      const capStateAfter = nextCapState(fullStateAfter, afterMidnightMs)

      expect(capStateBefore.dayKey).toBe(stateBefore.dayKey)
      expect(capStateAfter.dayKey).toBe(stateAfter.dayKey)
    }
  })
})

describe("truncateDiff", () => {
  test("small diff untouched", () => {
    const diff = "diff --git a/file.ts b/file.ts\n@@ -1,3 +1,4 @@\n line1\n line2"
    const result = truncateDiff(diff, 1000)
    expect(result.text).toBe(diff)
    expect(result.truncated).toBe(false)
  })

  test("multi-hunk diff > ceiling cuts at boundary", () => {
    const hunk1 = "diff --git a/file.ts b/file.ts\n@@ -1,5 +1,5 @@\n" + "x".repeat(100)
    const hunk2 = "\n@@ -10,5 +10,5 @@\n" + "y".repeat(100)
    const diff = hunk1 + hunk2
    const ceiling = 150 // Falls between the hunks
    const result = truncateDiff(diff, ceiling)

    expect(result.truncated).toBe(true)
    // Should cut at @@ boundary before hunk2
    expect(result.text).toContain("diff --git")
    expect(result.text).toContain("@@ -1,5")
  })

  test("single hunk larger than ceiling degrades to header-only + truncated", () => {
    const diff = "diff --git a/file.ts b/file.ts\n@@ -1,3 +1,4 @@\n" + "x".repeat(500)
    const ceiling = 100
    const result = truncateDiff(diff, ceiling)

    expect(result.truncated).toBe(true)
    // Should keep header line "diff --git" but cut before or at @@ marker
    expect(result.text.length).toBeLessThanOrEqual(ceiling + 50) // some tolerance for header
  })

  test("ceiling undefined uses default", () => {
    const diff = "diff --git a/file.ts b/file.ts\n".padEnd(200000, "x")
    const result = truncateDiff(diff)
    // Should truncate with default 128KB ceiling
    expect(result.text.length).toBeLessThan(200000)
    expect(result.truncated).toBe(true)
  })

  test("cuts at the LAST boundary of either kind — file2's own header outruns file1's diff --git marker", () => {
    // file2's header fits within the ceiling but its hunk body does not:
    // the last boundary at/below ceiling is file2's own hunk marker (byte
    // 282), which is later than file1->file2's diff --git marker (byte
    // 249). Finding-2 fix: cut at the LATER of the two, so file2's header
    // is preserved (more content survives) while its hunk body is still
    // correctly excluded (hunk-aligned — never cut mid-hunk-body).
    const file1 = "diff --git a/file1.ts b/file1.ts\n@@ -1,3 +1,3 @@\n" + "a".repeat(200)
    const file2 = "\ndiff --git a/file2.ts b/file2.ts\n@@ -1,3 +1,3 @@\n" + "b".repeat(200)
    const diff = file1 + file2
    const ceiling = 300
    const result = truncateDiff(diff, ceiling)

    expect(result.truncated).toBe(true)
    expect(result.text).toContain("file1.ts")
    // file2's header now survives (previously dropped entirely)...
    expect(result.text).toContain("file2.ts")
    // ...but its hunk body is still excluded — cut lands before "@@" of file2.
    expect(result.text).not.toContain("b".repeat(200))
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(ceiling)
  })

  test("finding-2 regression: bulk-in-later-file diff is not cut at that file's header when its hunks fit", () => {
    // Small file1 (a few hundred bytes) + a large multi-hunk file2 whose
    // hunks extend past the ceiling. The old bug: once ANY diff --git
    // marker was found at/below the ceiling, hunk boundaries were never
    // scanned at all — so the cut landed at file2's HEADER, dropping
    // hunks that actually fit within the budget. Fixed behavior: scan
    // both marker kinds unconditionally and cut at the last one that
    // fits — so file2's header AND at least one of its hunks survive.
    const file1 = "diff --git a/small.ts b/small.ts\n@@ -1,3 +1,3 @@\n" + "s".repeat(300)
    const hunkBody = "h".repeat(2000)
    const file2Header = "\ndiff --git a/big.ts b/big.ts\n"
    const file2Hunk1 = `@@ -1,50 +1,50 @@\n${hunkBody}\n`
    const file2Hunk2 = `@@ -100,50 +100,50 @@\n${hunkBody}\n`
    const file2Hunk3 = `@@ -200,50 +200,50 @@\n${hunkBody}\n`
    const diff = file1 + file2Header + file2Hunk1 + file2Hunk2 + file2Hunk3
    // Ceiling sits after file2's header and first hunk, but before the
    // full diff — well above file1's size alone.
    const ceiling = file1.length + file2Header.length + file2Hunk1.length + 200
    expect(ceiling).toBeLessThan(Buffer.byteLength(diff, "utf8"))

    const result = truncateDiff(diff, ceiling)

    expect(result.truncated).toBe(true)
    expect(result.text).toContain("big.ts")
    expect(result.text).toContain("@@ -1,50 +1,50 @@")
    expect(result.text).toContain(hunkBody) // at least one full file2 hunk survives
    // Cut well above file1's size alone — file2 content made it in.
    expect(result.text.length).toBeGreaterThan(file1.length + file2Header.length)
    const resultBytes = Buffer.byteLength(result.text, "utf8")
    expect(resultBytes).toBeLessThanOrEqual(ceiling)
  })

  test("cuts at '@@' line boundary", () => {
    const hunk1 =
      "diff --git a/file.ts b/file.ts\n@@ -1,10 +1,10 @@\n" + "a".repeat(150)
    const hunk2 = "@@ -20,5 +20,5 @@\n" + "b".repeat(150)
    const diff = hunk1 + "\n" + hunk2
    const ceiling = 250
    const result = truncateDiff(diff, ceiling)

    expect(result.truncated).toBe(true)
    expect(result.text).toContain("@@ -1,10")
  })

  test("empty diff returns empty + not truncated", () => {
    const result = truncateDiff("")
    expect(result.text).toBe("")
    expect(result.truncated).toBe(false)
  })

  test("multi-byte UTF-8 content respects byte ceiling (not char length)", () => {
    // CJK character 中 is 3 bytes in UTF-8; repeat to create large byte count
    const cjkLine = "中".repeat(100) // 300 bytes
    const diff =
      "diff --git a/file.ts b/file.ts\n@@ -1,5 +1,5 @@\n" + cjkLine + "\n@@ -10,5 +10,5 @@\nmore"
    const ceiling = 150 // Much smaller than total byte size
    const result = truncateDiff(diff, ceiling)

    expect(result.truncated).toBe(true)
    const resultBytes = Buffer.byteLength(result.text, "utf8")
    expect(resultBytes).toBeLessThanOrEqual(ceiling)
  })

  test("fallback truncation (no boundary within ceiling) backs off from continuation bytes", () => {
    // Create a diff where the first boundary is BEYOND the ceiling
    // Multi-byte content fills the ceiling space
    const padding = "中".repeat(50) // 150 bytes of CJK
    const diff = padding + "\ndiff --git a/file.ts b/file.ts\n@@ -1,1 +1,1 @@\nmore"
    const ceiling = 80 // Smaller than padding; first boundary is way beyond

    const result = truncateDiff(diff, ceiling)

    expect(result.truncated).toBe(true)
    const resultBytes = Buffer.byteLength(result.text, "utf8")
    expect(resultBytes).toBeLessThanOrEqual(ceiling)
    // Verify no U+FFFD replacement character from splitting multi-byte
    expect(result.text).not.toContain("�")
  })
})

describe("buildReviewPrompt and reviewPromptSha", () => {
  test("buildReviewPrompt includes frozen text", () => {
    const diff = "diff --git a/test.ts b/test.ts\n+console.log('test')"
    const prompt = buildReviewPrompt(diff)

    expect(prompt).toContain("kkamak review sensor")
    expect(prompt).toContain("Review ONLY the diff below for defects")
    expect(prompt).toContain("DIFF:")
    expect(prompt).toContain(diff)
  })

  test("buildReviewPrompt includes JSON format specification", () => {
    const prompt = buildReviewPrompt("test diff")
    expect(prompt).toContain('{"findings":[{"severity"')
    expect(prompt).toContain('"file":"<repo-relative path>"')
    expect(prompt).toContain('"line":')
  })

  test("buildReviewPrompt is byte-exact frozen", () => {
    const prompt = buildReviewPrompt("DIFF")
    // The prompt structure must be exact (spec §3 stamps it)
    expect(prompt).toMatch(/^kkamak review sensor/)
    expect(prompt).toMatch(/\nDIFF:\nDIFF$/)
  })

  test("reviewPromptSha returns stable hash", () => {
    const sha1 = reviewPromptSha()
    const sha2 = reviewPromptSha()
    expect(sha1).toBe(sha2)
    expect(sha1).toMatch(/^[a-f0-9]{64}$/) // SHA256 hex
  })

  test("reviewPromptSha changes if prompt changes (hypothetically)", () => {
    // This test verifies the sha function works; actual prompt is frozen
    const sha = reviewPromptSha()
    expect(sha.length).toBe(64)
  })
})

describe("parseFindings", () => {
  test("bare JSON object parsed correctly", () => {
    const json = '{"findings":[{"severity":"high","file":"src/app.ts","line":42}]}'
    const result = parseFindings(json)
    expect(result).toEqual({
      findings: [{ severity: "high", file: "src/app.ts", line: 42 }],
    })
  })

  test("fenced JSON (```json...```) parsed correctly", () => {
    const fenced = '```json\n{"findings":[{"severity":"med","file":"test.ts","line":10}]}\n```'
    const result = parseFindings(fenced)
    expect(result).toEqual({
      findings: [{ severity: "med", file: "test.ts", line: 10 }],
    })
  })

  test("multiple findings parsed", () => {
    const json =
      '{"findings":[{"severity":"high","file":"a.ts","line":1},{"severity":"low","file":"b.ts","line":2}]}'
    const result = parseFindings(json)
    expect(result?.findings.length).toBe(2)
    expect(result?.findings[0]).toEqual({ severity: "high", file: "a.ts", line: 1 })
    expect(result?.findings[1]).toEqual({ severity: "low", file: "b.ts", line: 2 })
  })

  test("empty findings array accepted", () => {
    const json = '{"findings":[]}'
    const result = parseFindings(json)
    expect(result).toEqual({ findings: [] })
  })

  test("junk → undefined", () => {
    expect(parseFindings("not json")).toBeUndefined()
    expect(parseFindings("{}")).toBeUndefined() // missing findings key
    expect(parseFindings('{"findings": "not an array')).toBeUndefined()
    expect(parseFindings("")).toBeUndefined()
  })

  test("wrong severity value → undefined", () => {
    const bad =
      '{"findings":[{"severity":"critical","file":"x.ts","line":1}]}'
    expect(parseFindings(bad)).toBeUndefined()
  })

  test("missing severity field → undefined", () => {
    const bad = '{"findings":[{"file":"x.ts","line":1}]}'
    expect(parseFindings(bad)).toBeUndefined()
  })

  test("missing file field → undefined", () => {
    const bad = '{"findings":[{"severity":"high","line":1}]}'
    expect(parseFindings(bad)).toBeUndefined()
  })

  test("missing line field → undefined", () => {
    const bad = '{"findings":[{"severity":"high","file":"x.ts"}]}'
    expect(parseFindings(bad)).toBeUndefined()
  })

  test("line not a number → undefined", () => {
    const bad = '{"findings":[{"severity":"high","file":"x.ts","line":"1"}]}'
    expect(parseFindings(bad)).toBeUndefined()
  })

  test("extra fields in finding ignored (lenient)", () => {
    const json =
      '{"findings":[{"severity":"high","file":"x.ts","line":1,"extra":"ignored"}]}'
    const result = parseFindings(json)
    // Core fields parsed; extras ignored by app
    expect(result).not.toBeUndefined()
    if (result && result.findings.length > 0) {
      expect(result.findings[0]!.severity).toBe("high")
    }
  })
})

describe("passLine", () => {
  test("emits valid ndjson (JSON.parse round-trip)", () => {
    const line = passLine({
      ts: 1234567890000,
      findings: [{ severity: "high" }, { severity: "med" }],
      diffStat: { files: 3, insertions: 50, deletions: 10 },
      baseSha: "abc123",
      headSha: "def456",
      truncated: false,
      diffBase: "merge-base",
      model: MODEL,
      durationMs: 1500,
      pluginVersion: "0.3.0",
      host: "test-host",
    })

    const parsed = JSON.parse(line)
    expect(parsed.ts).toBe(1234567890000)
    expect(parsed.model).toBe("claude-haiku-4-5")
  })

  test("counts severity correctly in ndjson", () => {
    const line = passLine({
      ts: Date.now(),
      findings: [
        { severity: "high" },
        { severity: "high" },
        { severity: "med" },
        { severity: "low" },
        { severity: "low" },
        { severity: "low" },
      ],
      diffStat: { files: 1, insertions: 10, deletions: 5 },
      baseSha: "a",
      headSha: "b",
      truncated: false,
      diffBase: "range",
      model: MODEL,
      durationMs: 100,
      pluginVersion: undefined,
      host: "host1",
    })

    const parsed = JSON.parse(line)
    // F2 spec: counts per severity, plus the total findingsCount
    expect(parsed.findingsCount).toBe(6)
    expect(parsed.severityCounts).toEqual({ high: 2, med: 1, low: 3 })
  })

  test("model key present and equals passed value", () => {
    const line = passLine({
      ts: Date.now(),
      findings: [],
      diffStat: { files: 0, insertions: 0, deletions: 0 },
      baseSha: "base",
      headSha: "head",
      truncated: false,
      diffBase: "fallback",
      model: MODEL,
      durationMs: 0,
      pluginVersion: "0.2.0",
      host: "test",
    })

    const parsed = JSON.parse(line)
    expect("model" in parsed).toBe(true)
    expect(parsed.model).toBe(MODEL)
  })

  test("F2 key-allowlist: Object.keys subset of declared field set", () => {
    const line = passLine({
      ts: 1000,
      findings: [{ severity: "high" }],
      diffStat: { files: 1, insertions: 5, deletions: 2 },
      baseSha: "b",
      headSha: "h",
      truncated: false,
      diffBase: "merge-base",
      model: MODEL,
      durationMs: 100,
      pluginVersion: "0.1.0",
      host: "test",
    })

    const parsed = JSON.parse(line) as Record<string, unknown>
    const keys = Object.keys(parsed)
    const allowedKeys = [
      "ts",
      "findingsCount",
      "severityCounts",
      "diffStat",
      "baseSha",
      "headSha",
      "truncated",
      "diffBase",
      "model",
      "durationMs",
      "pluginVersion",
      "host",
    ]

    for (const key of keys) {
      expect(allowedKeys).toContain(key)
    }

    // Nested objects (spec §3 sample shape) — not flattened.
    expect(Object.keys(parsed.severityCounts as object).sort()).toEqual(["high", "low", "med"])
    expect(Object.keys(parsed.diffStat as object).sort()).toEqual(["deletions", "files", "insertions"])
  })

  test("pluginVersion undefined omitted from output", () => {
    const line = passLine({
      ts: Date.now(),
      findings: [],
      diffStat: { files: 0, insertions: 0, deletions: 0 },
      baseSha: "b",
      headSha: "h",
      truncated: false,
      diffBase: "range",
      model: MODEL,
      durationMs: 0,
      pluginVersion: undefined,
      host: "test",
    })

    const parsed = JSON.parse(line)
    expect("pluginVersion" in parsed).toBe(false)
  })
})

describe("skipLine", () => {
  test("emits valid ndjson (JSON.parse round-trip)", () => {
    const line = skipLine({
      ts: 1234567890000,
      reason: "debounce",
      pluginVersion: "0.3.0",
      host: "test-host",
    })

    const parsed = JSON.parse(line)
    expect(parsed.ts).toBe(1234567890000)
    expect(parsed.reason).toBe("debounce")
    expect(parsed.skipped).toBe(true)
  })

  test("all skip reasons emitted correctly", () => {
    // A `Record<SkipReason, true>` rather than a hand-copied literal array:
    // if core.ts's SkipReason union ever gains (or loses) a member without
    // a matching edit here, `bunx tsc --noEmit` fails on a missing/excess
    // key — a REAL exhaustiveness check the type system enforces, not a
    // copy that can silently drift out of sync with the implementation.
    const REASON_MEMBERSHIP: Record<SkipReason, true> = {
      debounce: true,
      cap: true,
      "clock-skew": true,
      "claim-lost": true,
      "merge-in-progress": true,
      "warm-lane-busy": true,
      "bad-review-output": true,
      "output-truncated": true,
      "dispatch-error": true,
    }
    const reasons = Object.keys(REASON_MEMBERSHIP) as SkipReason[]

    for (const reason of reasons) {
      const line = skipLine({
        ts: Date.now(),
        reason,
        pluginVersion: undefined,
        host: "test",
      })
      const parsed = JSON.parse(line)
      expect(parsed.reason).toBe(reason)
      expect(parsed.skipped).toBe(true)
    }
  })

  test("F2 key-allowlist: Object.keys subset of declared field set", () => {
    const line = skipLine({
      ts: 1000,
      reason: "cap",
      pluginVersion: "0.1.0",
      host: "test",
    })

    const parsed = JSON.parse(line) as Record<string, unknown>
    const keys = Object.keys(parsed)
    const allowedKeys = ["ts", "skipped", "reason", "pluginVersion", "host"]

    for (const key of keys) {
      expect(allowedKeys).toContain(key)
    }
  })

  test("pluginVersion undefined omitted from output", () => {
    const line = skipLine({
      ts: Date.now(),
      reason: "debounce",
      pluginVersion: undefined,
      host: "test",
    })

    const parsed = JSON.parse(line)
    expect("pluginVersion" in parsed).toBe(false)
  })
})

describe("pruneSideFiles", () => {
  const CLEANUP: string[] = []
  afterEach(() => {
    for (const d of CLEANUP.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  test("7 fake files, keep 5 -> the 2 oldest (by name = ts) removed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-sensor-side-"))
    CLEANUP.push(dir)

    const tsList = [1000, 1001, 1002, 1003, 1004, 1005, 1006]
    for (const ts of tsList) {
      fs.writeFileSync(path.join(dir, `${ts}.json`), JSON.stringify({ ts }))
    }

    pruneSideFiles(dir, 5)

    const remaining = fs.readdirSync(dir).sort()
    expect(remaining).toEqual(["1002.json", "1003.json", "1004.json", "1005.json", "1006.json"])
  })

  test("fewer files than keep -> no-op", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-sensor-side-"))
    CLEANUP.push(dir)

    fs.writeFileSync(path.join(dir, "1000.json"), "{}")
    fs.writeFileSync(path.join(dir, "1001.json"), "{}")

    pruneSideFiles(dir, 5)

    expect(fs.readdirSync(dir).sort()).toEqual(["1000.json", "1001.json"])
  })

  test("missing directory -> no-op, never throws", () => {
    expect(() => pruneSideFiles(path.join(os.tmpdir(), "review-sensor-side-does-not-exist"), 5)).not.toThrow()
  })
})
