import { test, expect } from "bun:test"
import { HYGIENE_MARKER, bInstruction, mergeThen } from "../../minimal/session2.ts"

// C2 experiment support (docs/2026-07-25-gate-session-hygiene.md §3):
// multi-task-session mode chains task B into task A's opencode session.

test("HYGIENE_MARKER: countermand content pinned (obsolete + do-not-apply)", () => {
  expect(HYGIENE_MARKER).toContain("obsolete")
  expect(HYGIENE_MARKER).toContain("do not apply")
})

test("bInstruction: verbatim passthrough — gate contract applies to task A only", () => {
  const raw = "Count the tokens in /app/data and write the total to /app/out.txt."
  const out = bInstruction(raw)
  expect(out).toBe(raw)
  // The A-side gate contract phrase must NOT ride B's instruction.
  expect(out).not.toContain("leave a runnable verification script")
})

test("mergeThen: adds thenB without mutating the input trial or other fields", () => {
  const trial = { attempt: 1, reward: 1, turns: 5, trajFile: "x.ndjson" }
  const t = { rewardB: 0 as const, turnsB: 3, elapsedSecB: 12.5, markerUsed: true }
  const merged = mergeThen(trial, t)
  expect(merged["thenB"]).toEqual(t)
  expect(merged["attempt"]).toBe(1)
  expect(merged["reward"]).toBe(1)
  expect(merged["turns"]).toBe(5)
  expect(merged["trajFile"]).toBe("x.ndjson")
  // purity: input untouched
  expect("thenB" in trial).toBe(false)
  expect(trial).toEqual({ attempt: 1, reward: 1, turns: 5, trajFile: "x.ndjson" })
})
