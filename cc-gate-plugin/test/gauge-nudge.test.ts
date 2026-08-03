// cc-gate-plugin/test/gauge-nudge.test.ts
import { describe, test, expect } from "bun:test"
import { shouldConsiderPrompt, buildNudgeContext } from "../src/gauge/nudge.ts"
import { parseGateConfig } from "../src/config.ts"

describe("shouldConsiderPrompt (spec §5 prefilter, frozen at first firing)", () => {
  test("short prompts and slash commands never trigger", () => {
    expect(shouldConsiderPrompt("hi")).toBe(false)
    expect(shouldConsiderPrompt("/compact")).toBe(false)
    expect(shouldConsiderPrompt("/goal " + "x".repeat(200))).toBe(false)
  })
  test("long task-shaped prompts pass the prefilter", () => {
    expect(shouldConsiderPrompt("please improve the overall quality of the data layer and make everything nicer across the app somehow".padEnd(120, "."))).toBe(true)
  })
})

describe("buildNudgeContext", () => {
  test("nudge asks for a measurable exit and names the channel ladder, never blocks", () => {
    const t = buildNudgeContext("C4")
    expect(t).toContain("measurable")
    expect(t).toContain("verifiable")
    expect(t.toLowerCase()).not.toContain("refuse")
    expect(t.toLowerCase()).not.toContain("block")
  })
})

describe("parseGateConfig: channelNudge flag (inert-by-default)", () => {
  test("explicit true parses to true", () => {
    const c = parseGateConfig(`{"check": "bun test", "channelNudge": true}`)
    expect(c!.channelNudge).toBe(true)
  })
  test("absent parses to undefined (flag off — existing behavior untouched)", () => {
    const c = parseGateConfig(`{"check": "bun test"}`)
    expect(c!.channelNudge).toBeUndefined()
  })
  test("non-boolean values are ignored (tolerant parse)", () => {
    const c = parseGateConfig(`{"check": "bun test", "channelNudge": "yes"}`)
    expect(c!.channelNudge).toBeUndefined()
  })
})
