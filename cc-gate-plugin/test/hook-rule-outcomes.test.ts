import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readAndConsumeHookRuleOutcomes } from "../src/hook-rule-outcomes"

let cwd: string
const SID = "sess-abc"

function accPath(sessionID: string): string {
  return join(cwd, ".km", `hook-rule-outcomes-${sessionID}.ndjson`)
}
function writeAcc(sessionID: string, lines: string[]): void {
  mkdirSync(join(cwd, ".km"), { recursive: true })
  writeFileSync(accPath(sessionID), lines.join("\n") + "\n")
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hro-"))
})
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe("readAndConsumeHookRuleOutcomes", () => {
  test("flattens multi-line outcomes in order and unlinks the file", () => {
    writeAcc(SID, [
      JSON.stringify({ ts: 1, outcomes: [{ id: "b1", matched: true, mode: "shadow", ms: 0.1 }] }),
      JSON.stringify({ ts: 2, outcomes: [{ id: "b2", matched: true, mode: "warn", ms: 0.2 }, { id: "b3", matched: true, mode: "shadow", ms: 0.3 }] }),
    ])
    const out = readAndConsumeHookRuleOutcomes(cwd, SID)
    expect(out?.map((o) => o.id)).toEqual(["b1", "b2", "b3"])
    expect(existsSync(accPath(SID))).toBe(false)
  })

  test("absent file returns null without throwing", () => {
    expect(readAndConsumeHookRuleOutcomes(cwd, SID)).toBeNull()
  })

  test("malformed lines are skipped, valid lines survive", () => {
    writeAcc(SID, [
      "NOT JSON {",
      JSON.stringify({ ts: 1, outcomes: [{ id: "b1", matched: true, mode: "shadow", ms: 0.1 }] }),
      JSON.stringify({ outcomes: "not-an-array" }),
    ])
    const out = readAndConsumeHookRuleOutcomes(cwd, SID)
    expect(out?.length).toBe(1)
    expect(out?.[0]?.id).toBe("b1")
  })

  test("empty/all-malformed file yields null (absent key is the cleaner line) and unlinks", () => {
    writeAcc(SID, ["NOT JSON"])
    expect(readAndConsumeHookRuleOutcomes(cwd, SID)).toBeNull()
    expect(existsSync(accPath(SID))).toBe(false)
  })

  test("caps at 200 entries, dropping the tail", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({ ts: i, outcomes: Array.from({ length: 10 }, (_, j) => ({ id: `b${i}-${j}`, matched: true, mode: "shadow", ms: 0.1 })) }),
    )
    writeAcc(SID, lines)
    const out = readAndConsumeHookRuleOutcomes(cwd, SID)
    expect(out?.length).toBe(200)
    expect(out?.[0]?.id).toBe("b0-0")
  })

  test("another session's accumulator is untouched", () => {
    writeAcc(SID, [JSON.stringify({ ts: 1, outcomes: [{ id: "b1", matched: true, mode: "shadow", ms: 0.1 }] })])
    writeAcc("other-sess", [JSON.stringify({ ts: 1, outcomes: [{ id: "b9", matched: true, mode: "deny", ms: 0.1 }] })])
    readAndConsumeHookRuleOutcomes(cwd, SID)
    expect(existsSync(accPath("other-sess"))).toBe(true)
  })
})
