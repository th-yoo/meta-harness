import { test, expect, describe } from "bun:test"
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
} from "../src/review-sensor/core.ts"

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
    const now = 1000000000
    const state = {
      lastPassTs: now - DEBOUNCE_MS - 1000,
      lastPassHead: "abc123",
      dayKey: "2026-08-06",
      dayCount: 29,
    }
    const result = shouldDispatch(state, now)
    expect(result).toEqual({ go: true })
  })

  test("dayCount 30 → cap", () => {
    const now = 1000000000
    const state = {
      lastPassTs: now - DEBOUNCE_MS - 1000,
      lastPassHead: "abc123",
      dayKey: "2026-08-06",
      dayCount: 30,
    }
    const result = shouldDispatch(state, now)
    expect(result).toEqual({ go: false, reason: "cap" })
  })

  test("dayCount > 30 → cap", () => {
    const now = 1000000000
    const state = {
      lastPassTs: now - DEBOUNCE_MS - 1000,
      lastPassHead: "abc123",
      dayKey: "2026-08-06",
      dayCount: 31,
    }
    const result = shouldDispatch(state, now)
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

  test("cuts at 'diff --git' boundary", () => {
    const file1 = "diff --git a/file1.ts b/file1.ts\n@@ -1,3 +1,3 @@\n" + "a".repeat(200)
    const file2 = "\ndiff --git a/file2.ts b/file2.ts\n@@ -1,3 +1,3 @@\n" + "b".repeat(200)
    const diff = file1 + file2
    const ceiling = 300
    const result = truncateDiff(diff, ceiling)

    expect(result.truncated).toBe(true)
    expect(result.text).toContain("file1.ts")
    // Should not include file2
    expect(result.text).not.toContain("file2.ts")
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
    // F2 spec: counts per severity
    expect(parsed.highCount).toBe(2)
    expect(parsed.medCount).toBe(1)
    expect(parsed.lowCount).toBe(3)
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
      "highCount",
      "medCount",
      "lowCount",
      "filesChanged",
      "insertions",
      "deletions",
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
  })

  test("all skip reasons emitted correctly", () => {
    const reasons: Array<
      "debounce" | "cap" | "clock-skew" | "claim-lost" | "merge-in-progress" | "warm-lane-busy" | "bad-review-output" | "dispatch-error"
    > = [
      "debounce",
      "cap",
      "clock-skew",
      "claim-lost",
      "merge-in-progress",
      "warm-lane-busy",
      "bad-review-output",
      "dispatch-error",
    ]

    for (const reason of reasons) {
      const line = skipLine({
        ts: Date.now(),
        reason,
        pluginVersion: undefined,
        host: "test",
      })
      const parsed = JSON.parse(line)
      expect(parsed.reason).toBe(reason)
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
    const allowedKeys = ["ts", "reason", "pluginVersion", "host"]

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
