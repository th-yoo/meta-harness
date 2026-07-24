import { test, expect } from "bun:test"
import { runCompletionGate, type GateIO } from "../../minimal/complete-gate.ts"

const ARTIFACT = `async def f():
    if a < b:
        await g()
`

function fakeIO(over: Partial<GateIO> = {}): GateIO & { log: string[] } {
  const log: string[] = []
  const io: GateIO & { log: string[] } = {
    log,
    verifyExists: () => true,
    runVerify: () => ({ code: 0, out: "ok" }),
    readArtifact: () => ARTIFACT,
    writeArtifact: (content: string) => {
      log.push(`write:${content.length}`)
      return true
    },
    restoreArtifact: () => {
      log.push("restore")
      return true
    },
    syntaxOk: () => true,
    reinject: (msg: string) => {
      log.push(`reinject:${msg.slice(0, 400)}`)
      return true
    },
    ...over,
  }
  return io
}

test("accepts when verify exists, passes, and every mutant is killed", async () => {
  const io = fakeIO({
    // verify fails on every mutant (i.e., kills them all)
    runVerify: (onMutant?: boolean) => (onMutant ? { code: 1, out: "caught" } : { code: 0, out: "ok" }),
  })
  const r = await runCompletionGate(io, { rounds: 2, mutants: 3 })
  expect(r.accepted).toBe(true)
  expect(r.gateExhausted).toBe(false)
  expect(r.rounds.length).toBe(1)
  expect(io.log.filter((l) => l.startsWith("reinject")).length).toBe(0)
  expect(io.log).toContain("restore")
})

test("reinjects when verify.sh is missing", async () => {
  let exists = false
  const io = fakeIO({
    verifyExists: () => {
      const v = exists
      exists = true // appears on round 2
      return v
    },
    runVerify: (onMutant?: boolean) => (onMutant ? { code: 1, out: "caught" } : { code: 0, out: "ok" }),
  })
  const r = await runCompletionGate(io, { rounds: 2, mutants: 2 })
  expect(r.accepted).toBe(true)
  expect(r.rounds[0]!.outcome).toBe("no-verify")
  expect(io.log.some((l) => l.startsWith("reinject:"))).toBe(true)
})

test("reinjects with output tail when verify fails", async () => {
  let call = 0
  const io = fakeIO({
    runVerify: (onMutant?: boolean) => {
      if (onMutant) return { code: 1, out: "caught" }
      return call++ === 0 ? { code: 2, out: "AssertionError: cleanup" } : { code: 0, out: "ok" }
    },
  })
  const r = await runCompletionGate(io, { rounds: 2, mutants: 2 })
  expect(r.accepted).toBe(true)
  expect(r.rounds[0]!.outcome).toBe("verify-failed")
  expect(io.log.find((l) => l.startsWith("reinject:"))).toContain("AssertionError")
})

test("reinjects with mutant diff when a mutant survives, then accepts when fixed", async () => {
  let round = 0
  const io = fakeIO({
    runVerify: (onMutant?: boolean) => {
      if (!onMutant) return { code: 0, out: "ok" }
      // round 0: mutants survive (verify stays green); round 1: killed
      return round === 0 ? { code: 0, out: "still green" } : { code: 1, out: "caught" }
    },
    reinject: (msg: string) => {
      round++
      fake.log.push(`reinject:${msg.slice(0, 400)}`)
      return true
    },
  })
  const fake = io
  const r = await runCompletionGate(io, { rounds: 2, mutants: 2 })
  expect(r.accepted).toBe(true)
  expect(r.rounds[0]!.outcome).toBe("mutant-survived")
  expect(r.rounds[0]!.mutantsSurvived).toBeGreaterThan(0)
  expect(io.log.find((l) => l.startsWith("reinject:"))).toContain("@@")
})

test("accepts with gateExhausted after R failing rounds", async () => {
  const io = fakeIO({ verifyExists: () => false })
  const r = await runCompletionGate(io, { rounds: 2, mutants: 2 })
  expect(r.accepted).toBe(true)
  expect(r.gateExhausted).toBe(true)
  expect(r.rounds.length).toBe(3) // R reinjection rounds + final check
})

test("restores the artifact after probing even when a mutant survives", async () => {
  const io = fakeIO({
    runVerify: () => ({ code: 0, out: "green" }), // survives everything
  })
  await runCompletionGate(io, { rounds: 1, mutants: 2 })
  const writes = io.log.filter((l) => l.startsWith("write:")).length
  const restores = io.log.filter((l) => l === "restore").length
  expect(writes).toBeGreaterThan(0)
  expect(restores).toBeGreaterThan(0)
})

test("artifact with no mutable sites passes the probe vacuously", async () => {
  const io = fakeIO({ readArtifact: () => "x = 1\n" })
  const r = await runCompletionGate(io, { rounds: 2, mutants: 3 })
  expect(r.accepted).toBe(true)
  expect(r.rounds[0]!.mutantsTried).toBe(0)
})
