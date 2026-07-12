import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { ClaudeCodeHost } from "../src/adapters/claude-code/cc-host.ts"
import { promptHumanScore } from "../src/score.ts"

let home: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env["META_HARNESS_HOME"]
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cc-host-"))
  process.env["META_HARNESS_HOME"] = home
})
afterEach(() => {
  if (prevHome === undefined) delete process.env["META_HARNESS_HOME"]
  else process.env["META_HARNESS_HOME"] = prevHome
  fs.rmSync(home, { recursive: true, force: true })
})

test("platform + projectRoot", () => {
  const host = new ClaudeCodeHost("/some/project")
  expect(host.platform).toBe("claude-code")
  expect(host.projectRoot).toBe("/some/project")
})

test("score-inversion seam: setPendingScore then takePendingScore consumes once", () => {
  const host = new ClaudeCodeHost("/p")
  host.setPendingScore("s1", { passed: true, note: "nice" })
  expect(host.takePendingScore("s1")).toEqual({ passed: true, note: "nice" })
  // consumed — a second take is empty
  expect(host.takePendingScore("s1")).toBeUndefined()
})

test("promptHumanScore returns the staged verdict WITHOUT prompting (the inversion)", async () => {
  const host = new ClaudeCodeHost("/p")
  let prompted = false
  // spy: showScorePrompt must NOT be called when a verdict is staged
  host.showScorePrompt = async () => { prompted = true }
  host.setPendingScore("s2", { passed: false, note: "regression" })

  const result = await promptHumanScore(host, "s2")
  expect(result).toEqual({ passed: false, note: "regression" })
  expect(prompted).toBe(false)
})

test("runTaskAgent / runTextAgent degrade to null in Phase A (no throw — exit-0 safe)", async () => {
  const host = new ClaudeCodeHost("/p")
  expect(await host.runTaskAgent({ title: "t", prompt: "p" })).toBeNull()
  expect(await host.runTextAgent({ title: "t", system: "s", prompt: "p" })).toBeNull()
})

test("exec runs a shell command in projectRoot", async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cc-host-exec-"))
  try {
    const host = new ClaudeCodeHost(proj)
    const { stdout, exitCode } = await host.exec("echo hello-cc")
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe("hello-cc")
  } finally {
    fs.rmSync(proj, { recursive: true, force: true })
  }
})

test("log appends to the runtime logfile (best-effort durability)", () => {
  const host = new ClaudeCodeHost("/p")
  host.log("info", "hello-log-marker")
  const logFile = path.join(home, "runtime", "cc", "hook.log")
  expect(fs.readFileSync(logFile, "utf-8")).toContain("hello-log-marker")
})
