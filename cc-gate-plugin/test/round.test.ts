import { test, expect } from "bun:test"
import { runSingleRound } from "../src/core/round.ts"

test("runSingleRound: failing check -> verify-failed with evidence tail", async () => {
  let calls = 0
  let seenCheck: string | undefined
  const runCheck = async (cmd: string) => {
    calls++
    seenCheck = cmd
    return { code: 1, out: "boom" }
  }

  const result = await runSingleRound(runCheck, "bun test")

  expect(result.outcome).toBe("verify-failed")
  expect(typeof result.evidence).toBe("string")
  expect(result.evidence).toContain("boom")
  expect(calls).toBe(1)
  expect(seenCheck).toBe("bun test")
})

test("runSingleRound: passing check -> accepted with no evidence", async () => {
  let calls = 0
  let seenCheck: string | undefined
  const runCheck = async (cmd: string) => {
    calls++
    seenCheck = cmd
    return { code: 0, out: "" }
  }

  const result = await runSingleRound(runCheck, "bun test")

  expect(result.outcome).toBe("accepted")
  expect(result.evidence).toBeUndefined()
  expect(calls).toBe(1)
  expect(seenCheck).toBe("bun test")
})

test("runSingleRound: runCheck called exactly once with the check string verbatim", async () => {
  let calls = 0
  const seen: string[] = []
  const runCheck = async (cmd: string) => {
    calls++
    seen.push(cmd)
    return { code: 0, out: "" }
  }

  await runSingleRound(runCheck, "make verify --strict")

  expect(calls).toBe(1)
  expect(seen).toEqual(["make verify --strict"])
})

test("runSingleRound: runCheck rejection propagates as a thrown error", async () => {
  const runCheck = async (_cmd: string): Promise<{ code: number; out: string }> => {
    throw new Error("spawn failed")
  }

  await expect(runSingleRound(runCheck, "bun test")).rejects.toThrow("spawn failed")
})

// ── rawOut tee (composition design) ──────────────────────────────────────

test("verify-failed round: rawOut equals the raw check output", async () => {
  const r = await runSingleRound(async () => ({ code: 1, out: "raw failure text" }), "cmd")
  expect(r.outcome).toBe("verify-failed")
  expect(r.rawOut).toBe("raw failure text")
})

test("accepted round: rawOut absent (outcome-gated)", async () => {
  const r = await runSingleRound(async () => ({ code: 0, out: "all good" }), "cmd")
  expect(r.outcome).toBe("accepted")
  expect(r.rawOut).toBeUndefined()
})
