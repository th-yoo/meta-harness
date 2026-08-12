import { test, expect } from "bun:test"
import { handlePostToolUse } from "../src/core/edits.ts"
import { INITIAL_STATE } from "../src/types.ts"
import type { CcGateState } from "../src/types.ts"

test("Edit tool sets edited to true", () => {
  const state = INITIAL_STATE
  const result = handlePostToolUse(state, "Edit")
  expect(result.edited).toBe(true)
  expect(result).not.toBe(state) // new object
})

test("MultiEdit tool sets edited to true", () => {
  const state = INITIAL_STATE
  const result = handlePostToolUse(state, "MultiEdit")
  expect(result.edited).toBe(true)
  expect(result).not.toBe(state)
})

test("Write tool sets edited to true", () => {
  const state = INITIAL_STATE
  const result = handlePostToolUse(state, "Write")
  expect(result.edited).toBe(true)
  expect(result).not.toBe(state)
})

test("NotebookEdit tool sets edited to true", () => {
  const state = INITIAL_STATE
  const result = handlePostToolUse(state, "NotebookEdit")
  expect(result.edited).toBe(true)
  expect(result).not.toBe(state)
})

test("lowercase 'edit' does NOT set edited (case-sensitive)", () => {
  const state = INITIAL_STATE
  const result = handlePostToolUse(state, "edit")
  expect(result.edited).toBe(false)
  expect(result).toBe(state) // unchanged reference
})

test("Bash tool does NOT set edited", () => {
  const state = INITIAL_STATE
  const result = handlePostToolUse(state, "Bash")
  expect(result.edited).toBe(false)
  expect(result).toBe(state)
})

test("Read tool does NOT set edited", () => {
  const state = INITIAL_STATE
  const result = handlePostToolUse(state, "Read")
  expect(result.edited).toBe(false)
  expect(result).toBe(state)
})

test("Grep tool does NOT set edited", () => {
  const state = INITIAL_STATE
  const result = handlePostToolUse(state, "Grep")
  expect(result.edited).toBe(false)
  expect(result).toBe(state)
})

test("Task tool does NOT set edited", () => {
  const state = INITIAL_STATE
  const result = handlePostToolUse(state, "Task")
  expect(result.edited).toBe(false)
  expect(result).toBe(state)
})

test("unknown tool does NOT set edited", () => {
  const state = INITIAL_STATE
  const result = handlePostToolUse(state, "UnknownTool")
  expect(result.edited).toBe(false)
  expect(result).toBe(state)
})

test("already-edited state stays edited when processing non-edit tool", () => {
  const state: CcGateState = {
    ...INITIAL_STATE,
    edited: true,
  }
  const result = handlePostToolUse(state, "Read")
  expect(result.edited).toBe(true)
  expect(result).toBe(state) // unchanged reference
})

test("already-edited state stays edited when processing edit tool", () => {
  const state: CcGateState = {
    ...INITIAL_STATE,
    edited: true,
  }
  const result = handlePostToolUse(state, "Edit")
  expect(result.edited).toBe(true)
})

test("non-edit tool on edited state doesn't clear edited", () => {
  const state: CcGateState = {
    ...INITIAL_STATE,
    edited: true,
  }
  const result = handlePostToolUse(state, "Bash")
  expect(result.edited).toBe(true)
})

test("other fields remain untouched when Edit is called", () => {
  const state: CcGateState = {
    v: 1,
    edited: false,
    gating: true,
    round: 5,
    outcomes: ["accepted"],
    cycleStartedAt: 1000,
    failStreak: 2,
    updatedAt: 2000,
  }
  const result = handlePostToolUse(state, "Edit")
  expect(result.v).toBe(1)
  expect(result.gating).toBe(true)
  expect(result.round).toBe(5)
  expect(result.outcomes).toEqual(["accepted"])
  expect(result.cycleStartedAt).toBe(1000)
  expect(result.failStreak).toBe(2)
  expect(result.updatedAt).toBe(2000)
  expect(result.edited).toBe(true)
})

test("other fields remain untouched when non-edit tool is called on complex state", () => {
  const state: CcGateState = {
    v: 1,
    edited: false,
    gating: true,
    round: 3,
    outcomes: ["verify-failed", "accepted"],
    cycleStartedAt: 5000,
    failStreak: 1,
    updatedAt: 6000,
  }
  const result = handlePostToolUse(state, "Read")
  expect(result).toBe(state) // returns same reference
  expect(result.v).toBe(1)
  expect(result.gating).toBe(true)
  expect(result.round).toBe(3)
  expect(result.outcomes).toEqual(["verify-failed", "accepted"])
  expect(result.cycleStartedAt).toBe(5000)
  expect(result.failStreak).toBe(1)
  expect(result.updatedAt).toBe(6000)
  expect(result.edited).toBe(false)
})

test("Edit tool creates new object (shallow spread)", () => {
  const state: CcGateState = {
    ...INITIAL_STATE,
    gating: true,
    outcomes: ["accepted"],
  }
  const result = handlePostToolUse(state, "Edit")
  expect(result).not.toBe(state)
  expect(result.outcomes).toBe(state.outcomes) // shallow copy (shared reference)
})

test("non-edit tool returns exact same object reference", () => {
  const state = INITIAL_STATE
  const result = handlePostToolUse(state, "Bash")
  expect(result).toBe(state)
})

test("case sensitivity: 'edit' is different from 'Edit'", () => {
  const state = INITIAL_STATE
  const result1 = handlePostToolUse(state, "edit")
  const result2 = handlePostToolUse(state, "Edit")
  expect(result1.edited).toBe(false)
  expect(result2.edited).toBe(true)
})

test("case sensitivity: 'EDIT' is different from 'Edit'", () => {
  const state = INITIAL_STATE
  const result = handlePostToolUse(state, "EDIT")
  expect(result.edited).toBe(false)
})

test("empty string tool name does NOT set edited", () => {
  const state = INITIAL_STATE
  const result = handlePostToolUse(state, "")
  expect(result.edited).toBe(false)
  expect(result).toBe(state)
})

test("whitespace variations do NOT match (e.g. ' Edit')", () => {
  const state = INITIAL_STATE
  const result = handlePostToolUse(state, " Edit")
  expect(result.edited).toBe(false)
  expect(result).toBe(state)
})

test("all EDIT_TOOLS trigger edited:true", () => {
  const tools = ["Edit", "MultiEdit", "Write", "NotebookEdit"]
  for (const tool of tools) {
    const state = INITIAL_STATE
    const result = handlePostToolUse(state, tool)
    expect(result.edited).toBe(true)
  }
})

// -- A1 cycle-tagging: touched-path accumulation (2026-08-13) ------------

import { TOUCHED_PATHS_CAP } from "../src/types.ts"

test("edit with path records it in touchedPaths", () => {
  const r = handlePostToolUse(INITIAL_STATE, "Write", "/repo/src/a.ts")
  expect(r.edited).toBe(true)
  expect(r.touchedPaths).toEqual(["/repo/src/a.ts"])
  expect(r.touchedTruncated).toBeUndefined()
})

test("edit without path still arms, records nothing", () => {
  const r = handlePostToolUse(INITIAL_STATE, "Edit")
  expect(r.edited).toBe(true)
  expect(r.touchedPaths).toBeUndefined()
})

test("non-edit tool with path records nothing and does not arm", () => {
  const r = handlePostToolUse(INITIAL_STATE, "Bash", "/repo/src/a.ts")
  expect(r).toBe(INITIAL_STATE)
})

test("duplicate path is not re-added", () => {
  const s1 = handlePostToolUse(INITIAL_STATE, "Edit", "/repo/a.ts")
  const s2 = handlePostToolUse(s1, "Edit", "/repo/a.ts")
  expect(s2.touchedPaths).toEqual(["/repo/a.ts"])
})

test("cap: path #201 is dropped and touchedTruncated is set", () => {
  let s: CcGateState = { ...INITIAL_STATE }
  for (let i = 0; i < TOUCHED_PATHS_CAP; i++) {
    s = handlePostToolUse(s, "Edit", `/repo/f${i}.ts`)
  }
  expect(s.touchedPaths?.length).toBe(TOUCHED_PATHS_CAP)
  expect(s.touchedTruncated).toBeUndefined()
  const over = handlePostToolUse(s, "Edit", "/repo/overflow.ts")
  expect(over.touchedPaths?.length).toBe(TOUCHED_PATHS_CAP)
  expect(over.touchedPaths).not.toContain("/repo/overflow.ts")
  expect(over.touchedTruncated).toBe(true)
  // truncation is sticky and idempotent
  const again = handlePostToolUse(over, "Edit", "/repo/overflow2.ts")
  expect(again.touchedTruncated).toBe(true)
  expect(again.touchedPaths?.length).toBe(TOUCHED_PATHS_CAP)
})

test("legacy state without touched fields still accumulates from scratch", () => {
  const legacy = { ...INITIAL_STATE, edited: true } as CcGateState
  delete (legacy as unknown as Record<string, unknown>).touchedPaths
  const r = handlePostToolUse(legacy, "Write", "/repo/x.ts")
  expect(r.touchedPaths).toEqual(["/repo/x.ts"])
})
