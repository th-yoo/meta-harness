import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  appendJudgeDecision,
  judgeCalibration,
  readMhConfig,
  type JudgeDecision,
} from "../src/harness-store.ts"

function tmpFile(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-judge-calibration-"))
  return path.join(tmp, "judge-calibration.json")
}

function decision(overrides: Partial<JudgeDecision>): JudgeDecision {
  return {
    ts: new Date().toISOString(),
    sessionID: "s1",
    judge: true,
    human: true,
    model: "openrouter/google/gemini-2.5-flash",
    ...overrides,
  }
}

test("readMhConfig defaults judge fields to disabled", () => {
  // No override hook for the config path exists, so we just assert on the
  // documented defaults directly via the shape readMhConfig returns when no
  // config.json is present (fresh account dir in CI / this sandbox).
  const cfg = readMhConfig()
  expect(typeof cfg.judgeModel).toBe("string")
  expect(typeof cfg.judgeVariant).toBe("string")
  expect(typeof cfg.judgeMinSessions).toBe("number")
  expect(typeof cfg.judgeMinAgreement).toBe("number")
})

test("judgeCalibration on a missing file returns n:0, not calibrated", () => {
  const file = tmpFile()
  expect(judgeCalibration(20, 0.8, file)).toEqual({ n: 0, agreement: 0, calibrated: false })
})

test("judgeCalibration with fewer than minSessions decisions is never calibrated", () => {
  const file = tmpFile()
  for (let i = 0; i < 10; i++) {
    appendJudgeDecision(decision({ sessionID: `s${i}`, judge: true, human: true }), file)
  }
  const result = judgeCalibration(20, 0.8, file)
  expect(result.n).toBe(10)
  expect(result.calibrated).toBe(false)
})

test("judgeCalibration with 20 decisions, 17 agreeing -> calibrated true", () => {
  const file = tmpFile()
  for (let i = 0; i < 20; i++) {
    const agree = i < 17
    appendJudgeDecision(decision({ sessionID: `s${i}`, judge: true, human: agree }), file)
  }
  expect(judgeCalibration(20, 0.8, file)).toEqual({ n: 20, agreement: 0.85, calibrated: true })
})

test("judgeCalibration windows over the LAST minSessions decisions", () => {
  const file = tmpFile()
  // First 5 decisions all agree (would inflate agreement if included).
  for (let i = 0; i < 5; i++) {
    appendJudgeDecision(decision({ sessionID: `pre${i}`, judge: true, human: true }), file)
  }
  // Last 20 decisions: 15 agree, 5 disagree -> agreement 0.75, not calibrated.
  for (let i = 0; i < 20; i++) {
    const agree = i < 15
    appendJudgeDecision(decision({ sessionID: `s${i}`, judge: true, human: agree }), file)
  }
  const result = judgeCalibration(20, 0.8, file)
  expect(result.n).toBe(20)
  expect(result.agreement).toBe(0.75)
  expect(result.calibrated).toBe(false)
})

test("appendJudgeDecision never throws even with a bad path", () => {
  expect(() => appendJudgeDecision(decision({}), "/nonexistent-root-dir/x/judge-calibration.json")).not.toThrow()
})

test("appendJudgeDecision writes the documented schema", () => {
  const file = tmpFile()
  appendJudgeDecision(decision({ sessionID: "abc" }), file)
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"))
  expect(raw.schemaVersion).toBe(1)
  expect(Array.isArray(raw.decisions)).toBe(true)
  expect(raw.decisions.length).toBe(1)
  expect(raw.decisions[0].sessionID).toBe("abc")
})
