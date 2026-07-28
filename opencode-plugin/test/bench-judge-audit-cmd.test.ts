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
  const sinkPath = path.join(metaRoot, ".kkamak", "meta-metrics.jsonl")
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

// ── stratified sampling (balanced across verifier classes) ─────────────────
// Ported from this task's brief (task-judge-stratify-brief.md), NOT from
// runner.py — cmd_judge_audit's Python original samples first-N (deliberately
// left as-is, Python is deprecated). Sids are fixed-width zero-padded
// ("pass-01".."pass-20" / "fail-01".."fail-20") so no sid is a substring
// prefix of another — required for the `prompt.includes(sid)` matcher below.

function padSids(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(2, "0")}`)
}

/** Seed `nPass` passing + `nFail` failing sessions, each with a minimal
 * trajectory, all sharing one candidate v1. */
function seedBalancedStore(metaRoot: string, nPass: number, nFail: number): { passSids: string[]; failSids: string[] } {
  const traj: TrajEvent[] = [{ t: "text", text: "done" }]
  const passSids = padSids("pass", nPass)
  const failSids = padSids("fail", nFail)
  const recs: [string, boolean, TrajEvent[] | null][] = [
    ...passSids.map((sid): [string, boolean, TrajEvent[] | null] => [sid, true, traj]),
    ...failSids.map((sid): [string, boolean, TrajEvent[] | null] => [sid, false, traj]),
  ]
  seedStore(metaRoot, recs)
  return { passSids, failSids }
}

/** A runJudge stub that always agrees with ground truth (verdict === truth
 * implied by the caller construction) and records which sid each call was
 * for, in call order — via the sid literal embedded in the prompt's
 * `## Task` section (note=sid in seedStore/seedBalancedStore). */
function sidRecordingJudge(allSids: string[], verdictFor: (sid: string) => boolean = (sid) => sid.startsWith("pass")) {
  const called: string[] = []
  const runJudge = async (prompt: string) => {
    const sid = allSids.find((s) => prompt.includes(s))
    if (!sid) throw new Error("prompt matched no known sid — test bug")
    called.push(sid)
    return JSON.stringify({ passed: verdictFor(sid), confidence: 0.9, reasoning: "ok" })
  }
  return { runJudge, called }
}

test("cmd_judge_audit: balanced pool (8 pass + 8 fail, limit 10) -> 5 fail + 5 pass, first-N per class", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  const { passSids, failSids } = seedBalancedStore(metaRoot, 8, 8)
  const { runJudge, called } = sidRecordingJudge([...passSids, ...failSids])

  const logs: string[] = []
  const logSpy = spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")))
  const errSpy = spyOn(console, "error").mockImplementation((...a) => logs.push(a.join(" ")))
  try {
    await cmdJudgeAudit(paths, args({ limit: 10 }), runJudge)
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }

  expect(called.length).toBe(10)
  const calledPass = called.filter((s) => s.startsWith("pass-")).sort()
  const calledFail = called.filter((s) => s.startsWith("fail-")).sort()
  expect(calledPass).toEqual(passSids.slice(0, 5))
  expect(calledFail).toEqual(failSids.slice(0, 5))
  expect(logs.join("\n")).toContain("sampling 5 pass / 5 fail (of 8 pass / 8 fail eligible)")
})

test("cmd_judge_audit: pass-limited pool (2 pass + 20 fail, limit 10) -> 2 pass + 8 fail (backfill)", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  const { passSids, failSids } = seedBalancedStore(metaRoot, 2, 20)
  const { runJudge, called } = sidRecordingJudge([...passSids, ...failSids])

  const logs: string[] = []
  const logSpy = spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")))
  const errSpy = spyOn(console, "error").mockImplementation((...a) => logs.push(a.join(" ")))
  try {
    await cmdJudgeAudit(paths, args({ limit: 10 }), runJudge)
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }

  expect(called.length).toBe(10)
  const calledPass = called.filter((s) => s.startsWith("pass-")).sort()
  const calledFail = called.filter((s) => s.startsWith("fail-")).sort()
  expect(calledPass).toEqual(passSids) // all 2 passers used
  expect(calledFail).toEqual(failSids.slice(0, 8)) // backfilled with 8 first failers
  expect(logs.join("\n")).toContain("sampling 2 pass / 8 fail (of 2 pass / 20 fail eligible)")
})

test("cmd_judge_audit: fail-limited pool (20 pass + 1 fail, limit 10) -> 1 fail + 9 pass (backfill)", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  const { passSids, failSids } = seedBalancedStore(metaRoot, 20, 1)
  const { runJudge, called } = sidRecordingJudge([...passSids, ...failSids])

  const logs: string[] = []
  const logSpy = spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")))
  const errSpy = spyOn(console, "error").mockImplementation((...a) => logs.push(a.join(" ")))
  try {
    await cmdJudgeAudit(paths, args({ limit: 10 }), runJudge)
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }

  expect(called.length).toBe(10)
  const calledPass = called.filter((s) => s.startsWith("pass-")).sort()
  const calledFail = called.filter((s) => s.startsWith("fail-")).sort()
  expect(calledFail).toEqual(failSids) // the only failer, always included
  expect(calledPass).toEqual(passSids.slice(0, 9)) // backfilled with 9 first passers
  expect(logs.join("\n")).toContain("sampling 9 pass / 1 fail (of 20 pass / 1 fail eligible)")
})

test("cmd_judge_audit: zero passers -> all failers, no crash, split logged", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  const { passSids, failSids } = seedBalancedStore(metaRoot, 0, 5)
  expect(passSids.length).toBe(0)
  const { runJudge, called } = sidRecordingJudge([...passSids, ...failSids])

  const logs: string[] = []
  const logSpy = spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")))
  const errSpy = spyOn(console, "error").mockImplementation((...a) => logs.push(a.join(" ")))
  let rc: number
  try {
    rc = await cmdJudgeAudit(paths, args({ limit: 10 }), runJudge)
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }

  expect(rc).toBe(0)
  expect(called.sort()).toEqual(failSids)
  expect(logs.join("\n")).toContain("sampling 0 pass / 5 fail (of 0 pass / 5 fail eligible)")
})

test("cmd_judge_audit: per-class agreement (pass 1/2, fail 3/3) -> passAgreement=0.5, failAgreement=1.0, overall=4/5, meta-metric carries all four", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  const { passSids, failSids } = seedBalancedStore(metaRoot, 2, 3)
  // pass class (truth=true): agree on pass-01 (judge PASS=true), disagree on pass-02 (judge FAIL=false) -> 1/2
  // fail class (truth=false): agree on all 3 (judge FAIL=false) -> 3/3
  const runJudge = async (prompt: string) => {
    const allSids = [...passSids, ...failSids]
    const sid = allSids.find((s) => prompt.includes(s))
    if (!sid) throw new Error("prompt matched no known sid — test bug")
    const judged = sid === "pass-02" ? false : sid.startsWith("pass") ? true : false
    return JSON.stringify({ passed: judged, confidence: 0.9, reasoning: "x" })
  }

  const logs: string[] = []
  const logSpy = spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")))
  const errSpy = spyOn(console, "error").mockImplementation((...a) => logs.push(a.join(" ")))
  let rc: number
  try {
    rc = await cmdJudgeAudit(paths, args({ limit: 5 }), runJudge)
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }

  expect(rc).toBe(0) // overall 4/5 = 0.8, not below threshold
  const m = metrics(metaRoot)
  expect(m.length).toBe(1)
  expect(m[0]!["n"]).toBe(5)
  expect(m[0]!["agreement"]).toBe(0.8)
  expect(m[0]!["nPass"]).toBe(2)
  expect(m[0]!["nFail"]).toBe(3)
  expect(m[0]!["passAgreement"]).toBe(0.5)
  expect(m[0]!["failAgreement"]).toBe(1.0)
  const out = logs.join("\n")
  expect(out).toContain("pass=50.0%")
  expect(out).toContain("fail=100.0%")
})

test("cmd_judge_audit: zero-scored class -> meta-metric persists passAgreement=null (not 0), prints n/a", async () => {
  // "no pass-sessions sampled" must be recorded as null, never 0 — a 0 would
  // read as 0% pass agreement in the historical record (catastrophic
  // miscalibration) when the truth is simply "no data for this class".
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  const { failSids } = seedBalancedStore(metaRoot, 0, 3)
  // fail class: judge agrees on all 3; pass class: empty.
  const runJudge = async (prompt: string) => {
    const sid = failSids.find((s) => prompt.includes(s))
    if (!sid) throw new Error("prompt matched no known sid — test bug")
    return JSON.stringify({ passed: false, confidence: 0.9, reasoning: "x" })
  }

  const logs: string[] = []
  const logSpy = spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")))
  const errSpy = spyOn(console, "error").mockImplementation((...a) => logs.push(a.join(" ")))
  let rc: number
  try {
    rc = await cmdJudgeAudit(paths, args({ limit: 3 }), runJudge)
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }

  expect(rc).toBe(0) // overall 3/3 = 1.0
  const m = metrics(metaRoot)
  expect(m.length).toBe(1)
  expect(m[0]!["nPass"]).toBe(0)
  expect(m[0]!["nFail"]).toBe(3)
  expect(m[0]!["passAgreement"]).toBeNull()
  expect(m[0]!["failAgreement"]).toBe(1.0)
  const out = logs.join("\n")
  expect(out).toContain("pass=n/a")
  expect(out).toContain("fail=100.0%")
})

test("cmd_judge_audit: exit code keyed on OVERALL agreement -> exit 1 even if one class is perfect", async () => {
  const metaRoot = tmpDir()
  const paths = fakeBenchPaths(metaRoot)
  const { passSids, failSids } = seedBalancedStore(metaRoot, 3, 7)
  // fail class: 7/7 agree (perfect). pass class: 0/3 agree (all disagree).
  // overall = 7/10 = 0.7 < 0.8 threshold -> alarm, even though fail class is perfect.
  const runJudge = async (prompt: string) => {
    const allSids = [...passSids, ...failSids]
    const sid = allSids.find((s) => prompt.includes(s))
    if (!sid) throw new Error("prompt matched no known sid — test bug")
    // pass-*: truth=true, judge always says FAIL (false) -> disagree
    // fail-*: truth=false, judge always says FAIL (false) -> agree
    const judged = false
    return JSON.stringify({ passed: judged, confidence: 0.9, reasoning: "x" })
  }

  const logs: string[] = []
  const logSpy = spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")))
  const errSpy = spyOn(console, "error").mockImplementation((...a) => logs.push(a.join(" ")))
  let rc: number
  try {
    rc = await cmdJudgeAudit(paths, args({ limit: 10 }), runJudge)
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }

  expect(rc).toBe(1)
  expect(logs.join("\n")).toContain("ALARM")
  const m = metrics(metaRoot)
  expect(m[0]!["nPass"]).toBe(3)
  expect(m[0]!["nFail"]).toBe(7)
  expect(m[0]!["passAgreement"]).toBe(0)
  expect(m[0]!["failAgreement"]).toBe(1.0)
})
