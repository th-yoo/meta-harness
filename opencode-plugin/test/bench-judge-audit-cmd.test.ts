import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { BenchPaths } from "../src/bench/paths.ts"
import { cmdJudgeAudit, type JudgeAuditArgs } from "../src/bench/judge-audit.ts"
import { recordSession, writeTrajectory, projectGlobalRoot, readLastMetric } from "../src/harness-store.ts"
import type { TrajEvent, SessionRecord } from "../src/harness-store.ts"
import { BenchError } from "../src/bench/util.ts"

// Ported from term-bench2/test_judge_audit.py's cmd_judge_audit control-flow
// vectors (the ones that file's docstring deferred to P6) — see that file
// for the original Python assertions this mirrors line-for-line.

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-judge-audit-cmd-"))
}

function fakeBenchPaths(metaRoot: string): BenchPaths {
  const termBenchDir = path.join(metaRoot, "term-bench2")
  return {
    metaRoot,
    termBenchDir,
    tbRoot: path.join(termBenchDir, "tb-root-unused"),
    resultsDir: path.join(termBenchDir, "results"),
    patchesDir: path.join(termBenchDir, "patches"),
    baselineTasksFile: path.join(termBenchDir, "baseline-tasks.txt"),
    splitsFile: path.join(termBenchDir, "splits.json"),
  }
}

/** Write score.json + traces/ (recordSession) and traj/ (writeTrajectory)
 * for candidate v1 of the project-global layer, entirely under tmpRoot —
 * mirrors test_judge_audit.py's `_seed_store`. */
function seedStore(
  metaRoot: string,
  recordsAndTraj: [string, boolean, TrajEvent[] | null][],
): string {
  const storeRoot = projectGlobalRoot(metaRoot)
  for (const [sid, passed, traj] of recordsAndTraj) {
    const rec: SessionRecord = {
      sessionID: sid,
      passed,
      note: `bench:${sid}`,
      turnCount: 3,
      timestamp: "2026-07-09T00:00:00+00:00",
      summary: sid,
      model: "anthropic/claude-x",
      variant: "",
      toolUsage: {},
      env: {},
    }
    recordSession(storeRoot, "v1", rec)
    if (traj !== null) writeTrajectory(storeRoot, "v1", sid, traj)
  }
  return storeRoot
}

function args(overrides: Partial<JudgeAuditArgs> = {}): JudgeAuditArgs {
  return { layer: "project-global", candidate: "v1", model: "fake-judge", limit: 10, agent: "", ...overrides }
}

function metrics(metaRoot: string): Record<string, unknown>[] {
  const sinkPath = path.join(metaRoot, ".meta-harness", "meta-metrics.jsonl")
  if (!fs.existsSync(sinkPath)) return []
  return fs
    .readFileSync(sinkPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e["event"] === "judge-audit")
}

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  return fn().finally(() => {
    errSpy.mockRestore()
    logSpy.mockRestore()
  })
}

test("cmd_judge_audit: full agreement exits cleanly (0), agreement=100.0%, one metric event", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  const traj: TrajEvent[] = [{ t: "tool", tool: "bash", args: "echo hi", output: "hi", error: false }]
  seedStore(metaRoot, [
    ["s1", true, traj],
    ["s2", false, traj],
  ])

  const verdicts: Record<string, boolean> = { s1: true, s2: false } // judge agrees on both
  const runJudge = async (prompt: string) => {
    for (const [sid, v] of Object.entries(verdicts)) {
      if (prompt.includes(sid)) return JSON.stringify({ passed: v, confidence: 0.9, reasoning: "ok" })
    }
    return null
  }

  const logs: string[] = []
  const logSpy = spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")))
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let rc: number
  try {
    rc = await cmdJudgeAudit(paths, args(), runJudge)
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }

  expect(rc).toBe(0)
  const out = logs.join("\n")
  expect(out).toContain("agreement=100.0%")
  expect(out).not.toContain("ALARM")
  const m = metrics(metaRoot)
  expect(m.length).toBe(1)
  expect(m[0]!["n"]).toBe(2)
  expect(m[0]!["agreement"]).toBe(1.0)
  expect(m[0]!["model"]).toBe("fake-judge")
  expect(m[0]!["layer"]).toBe("project-global")
  expect(m[0]!["candidate"]).toBe("v1")
})

test("cmd_judge_audit: low agreement (1/3) alarms, exits 1", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  const traj: TrajEvent[] = [{ t: "text", text: "done" }]
  seedStore(metaRoot, [
    ["s1", true, traj],
    ["s2", false, traj],
    ["s3", true, traj],
  ])

  // Judge disagrees on 2 of 3 -> agreement 1/3 ~= 33% < 80% threshold
  const verdicts: Record<string, boolean> = { s1: false, s2: true, s3: true }
  const runJudge = async (prompt: string) => {
    for (const [sid, v] of Object.entries(verdicts)) {
      if (prompt.includes(sid)) return JSON.stringify({ passed: v, confidence: 0.5, reasoning: "x" })
    }
    return null
  }

  const logs: string[] = []
  const logSpy = spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")))
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let rc: number
  try {
    rc = await cmdJudgeAudit(paths, args(), runJudge)
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }
  expect(rc).toBe(1)
  expect(logs.join("\n")).toContain("ALARM")
})

test("cmd_judge_audit: skips failed judge calls without crashing", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  const traj: TrajEvent[] = [{ t: "text", text: "done" }]
  seedStore(metaRoot, [
    ["s1", true, traj],
    ["s2", false, traj],
  ])

  const runJudge = async (prompt: string) => {
    if (prompt.includes("s1")) return null // simulate judge call failing after retries -> skip
    return JSON.stringify({ passed: false, confidence: 0.9, reasoning: "ok" })
  }

  let rc: number
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logs: string[] = []
  const logSpy = spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")))
  try {
    rc = await cmdJudgeAudit(paths, args(), runJudge)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  // only s2 scored & agrees -> no alarm, no crash
  expect(rc).toBe(0)
  expect(logs.join("\n")).toContain("1 skipped")
  const m = metrics(metaRoot)
  expect(m[0]!["n"]).toBe(1)
  expect(m[0]!["agreement"]).toBe(1.0)
})

test("cmd_judge_audit: all judge calls fail -> exit 2 (could-not-assess), NOT an alarm", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  const traj: TrajEvent[] = [{ t: "text", text: "done" }]
  seedStore(metaRoot, [
    ["s1", true, traj],
    ["s2", false, traj],
  ])

  let rc: number
  const logs: string[] = []
  const logSpy = spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")))
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    rc = await cmdJudgeAudit(paths, args(), async () => null)
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }
  expect(rc).toBe(2)
  const m = metrics(metaRoot)
  expect(m[0]!["n"]).toBe(0)
  expect(m[0]!["agreement"]).toBe(0.0)
  expect(logs.join("\n")).toContain("2 skipped")
  expect(logs.join("\n")).not.toContain("ALARM")
})

test("cmd_judge_audit: no eligible sessions is a clean no-op — never calls the judge at all", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  seedStore(metaRoot, [["s1", true, null]]) // trace but no traj -> not eligible

  let judgeCalled = false
  const logs: string[] = []
  const logSpy = spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")))
  const errSpy = spyOn(console, "error").mockImplementation((...a) => logs.push(a.join(" ")))
  let rc: number
  try {
    rc = await cmdJudgeAudit(paths, args(), async () => {
      judgeCalled = true
      return null
    })
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }
  expect(rc).toBe(0)
  expect(judgeCalled).toBe(false)
  expect(logs.join("\n")).toContain("nothing to audit")
})

test("cmd_judge_audit: no sessions recorded at all is a clean no-op", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  const root = projectGlobalRoot(metaRoot)
  const { createCandidate } = await import("../src/harness-store.ts")
  createCandidate(root, "v1", "sys")

  const logs: string[] = []
  const logSpy = spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")))
  const errSpy = spyOn(console, "error").mockImplementation((...a) => logs.push(a.join(" ")))
  let rc: number
  try {
    rc = await cmdJudgeAudit(paths, args(), async () => null)
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }
  expect(rc).toBe(0)
  expect(logs.join("\n")).toContain("nothing to audit")
})

test("cmd_judge_audit: nonexistent candidate dies (BenchError)", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  await expect(cmdJudgeAudit(paths, args({ candidate: "v99" }), async () => null)).rejects.toThrow(BenchError)
})

test("cmd_judge_audit: --candidate not vN dies (BenchError)", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  await expect(cmdJudgeAudit(paths, args({ candidate: "bogus" }), async () => null)).rejects.toThrow(BenchError)
})

test("cmd_judge_audit: role layer without --agent dies", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  await expect(cmdJudgeAudit(paths, args({ layer: "project-role" }), async () => null)).rejects.toThrow(BenchError)
})
