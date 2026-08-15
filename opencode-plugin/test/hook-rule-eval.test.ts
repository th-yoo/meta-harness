import { describe, expect, test } from "bun:test"
import { evalHookRules } from "../src/adapters/claude-code/hook-rule-eval"

function table(rules: object[], killSwitch = false): string {
  return JSON.stringify({ version: 1, writtenTs: 1, killSwitch, rules })
}
const shadowNpm = { id: "b1", event: "PreToolUse", toolMatcher: "Bash", inputPattern: "^npm ", feedback: "use bun", mode: "shadow" }
const denyDocker = { id: "b2", event: "PreToolUse", toolMatcher: "Bash", inputPattern: "^docker ", feedback: "use podman", mode: "deny" }
const warnSed = { id: "b3", event: "PreToolUse", toolMatcher: "Bash", inputPattern: "^sed +-i ", feedback: "use Edit tool", mode: "warn" }
const editEtc = { id: "b4", event: "PreToolUse", toolMatcher: "Edit", inputPattern: "^/etc/", feedback: "no system edits", mode: "shadow" }

describe("evalHookRules", () => {
  test("fail-open: null, garbage, and empty tables all allow", () => {
    for (const t of [null, "not json", "{}", table([])]) {
      const d = evalHookRules(t, "Bash", { command: "npm install x" })
      expect(d.decision).toBe("allow")
    }
  })

  test("shadow match: decision allow, outcome recorded", () => {
    const d = evalHookRules(table([shadowNpm]), "Bash", { command: "npm install left-pad" })
    expect(d.decision).toBe("allow")
    expect(d.outcomes.length).toBe(1)
    expect(d.outcomes[0]!.id).toBe("b1")
    expect(d.outcomes[0]!.mode).toBe("shadow")
    expect(typeof d.outcomes[0]!.ms).toBe("number")
  })

  test("deny match: decision deny with feedback", () => {
    const d = evalHookRules(table([shadowNpm, denyDocker]), "Bash", { command: "docker run x" })
    expect(d.decision).toBe("deny")
    expect(d.feedback).toBe("use podman")
  })

  test("severest wins: deny over warn over shadow", () => {
    const both = table([
      { ...warnSed, inputPattern: "^x" },
      { ...denyDocker, inputPattern: "^x" },
      { ...shadowNpm, inputPattern: "^x" },
    ])
    const d = evalHookRules(both, "Bash", { command: "x anything" })
    expect(d.decision).toBe("deny")
    expect(d.feedback).toBe("use podman")
    expect(d.outcomes.length).toBe(3)
  })

  test("killSwitch demotes deny to warn", () => {
    const d = evalHookRules(table([denyDocker], true), "Bash", { command: "docker run x" })
    expect(d.decision).toBe("warn")
    expect(d.degraded).toBe("killSwitch")
  })

  test("Edit matches on file_path; Bash rules ignored for Edit tool", () => {
    const d = evalHookRules(table([shadowNpm, editEtc]), "Edit", { file_path: "/etc/hosts" })
    expect(d.outcomes.length).toBe(1)
    expect(d.outcomes[0]!.id).toBe("b4")
  })

  test("Grep matches on serialized input", () => {
    const grepRule = { id: "b5", event: "PreToolUse", toolMatcher: "Grep", inputPattern: "^.*secret", feedback: "f", mode: "shadow" }
    const d = evalHookRules(table([grepRule]), "Grep", { pattern: "secret", path: "/x" })
    expect(d.outcomes.length).toBe(1)
  })

  test("non-matching command: no outcomes, allow", () => {
    const d = evalHookRules(table([shadowNpm, denyDocker]), "Bash", { command: "ls -la" })
    expect(d.decision).toBe("allow")
    expect(d.outcomes.length).toBe(0)
  })

  test("zero budget: deadline degrade, fail-open allow, skip logged", () => {
    const d = evalHookRules(table([denyDocker]), "Bash", { command: "docker run x" }, 0)
    expect(d.decision).toBe("allow")
    expect(d.degraded).toBe("deadline")
  })

  test("rule with invalid regex in table is skipped, not fatal", () => {
    const bad = { ...shadowNpm, id: "b9", inputPattern: "^(unclosed" }
    const d = evalHookRules(table([bad, denyDocker]), "Bash", { command: "docker x" })
    expect(d.decision).toBe("deny")
  })
})
