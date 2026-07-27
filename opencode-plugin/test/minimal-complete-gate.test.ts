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

// --- grip-fix design S3 (docs/2026-07-27-probe-grip-fix-design.md): the
// round passes when >=1 mutant is killed — equivalent/unreachable stragglers
// no longer poison it; only a zero-kill probe (junk verification) fails. ---

test("accepts when at least one mutant is killed even if another survives", async () => {
  let mutantCall = 0
  const io = fakeIO({
    runVerify: (onMutant?: boolean) => {
      if (!onMutant) return { code: 0, out: "ok" }
      return mutantCall++ === 0 ? { code: 1, out: "caught" } : { code: 0, out: "still green" }
    },
  })
  const r = await runCompletionGate(io, { rounds: 2, mutants: 2 })
  expect(r.accepted).toBe(true)
  expect(r.gateExhausted).toBe(false)
  expect(r.rounds.length).toBe(1)
  expect(r.rounds[0]!.outcome).toBe("accepted")
  expect(r.rounds[0]!.mutantsKilled).toBe(1)
  expect(r.rounds[0]!.mutantsSurvived).toBe(1)
})

test("zero kills still fails the round and reports the kill count", async () => {
  const io = fakeIO({
    runVerify: (onMutant?: boolean) => ({ code: 0, out: onMutant ? "still green" : "ok" }),
  })
  const r = await runCompletionGate(io, { rounds: 1, mutants: 2 })
  expect(r.rounds[0]!.outcome).toBe("mutant-survived")
  expect(r.rounds[0]!.mutantsKilled).toBe(0)
  expect(io.log.find((l) => l.startsWith("reinject:"))).toContain("@@")
})

// --- S1 in the round: coveredLines (optional, fail-open) restricts sites. ---

test("coveredLines filters mutation sites to executed lines", async () => {
  const io = fakeIO({
    coveredLines: () => new Set([3]), // only "await g()" executed
    runVerify: (onMutant?: boolean) => (onMutant ? { code: 1, out: "caught" } : { code: 0, out: "ok" }),
  })
  const r = await runCompletionGate(io, { rounds: 1, mutants: 4 })
  expect(r.rounds[0]!.coverage).toBe("filtered")
  expect(r.rounds[0]!.mutantsTried).toBe(1) // remove-await only; line-2 sites excluded
  expect(r.accepted).toBe(true)
})

test("falls back to static sites when coverage empties the site list", async () => {
  const io = fakeIO({
    coveredLines: () => new Set([99]), // nothing the operators can hit
    runVerify: (onMutant?: boolean) => (onMutant ? { code: 1, out: "caught" } : { code: 0, out: "ok" }),
  })
  const r = await runCompletionGate(io, { rounds: 1, mutants: 4 })
  expect(r.rounds[0]!.coverage).toBe("fallback-static")
  expect(r.rounds[0]!.mutantsTried).toBeGreaterThan(0)
})

test("coverage is off when coveredLines is absent or returns undefined", async () => {
  const absent = fakeIO({
    runVerify: (onMutant?: boolean) => (onMutant ? { code: 1, out: "caught" } : { code: 0, out: "ok" }),
  })
  const ra = await runCompletionGate(absent, { rounds: 1, mutants: 2 })
  expect(ra.rounds[0]!.coverage).toBe("off")
  const failedTrace = fakeIO({
    coveredLines: () => undefined, // tracing unavailable — fail-open
    runVerify: (onMutant?: boolean) => (onMutant ? { code: 1, out: "caught" } : { code: 0, out: "ok" }),
  })
  const rf = await runCompletionGate(failedTrace, { rounds: 1, mutants: 2 })
  expect(rf.rounds[0]!.coverage).toBe("off")
  expect(rf.rounds[0]!.mutantsTried).toBeGreaterThan(0)
})

// --- S2 in the round: spec-coverage probe (false-accept L1) — verify.sh must
// exercise every requirement instruction (markers in script, not comments). ---

import { type Requirement } from "../../minimal/spec-probe.ts"

const REQS: Requirement[] = [
  { id: "R-a", text: "does A", markers: ["scenario_a"] },
  { id: "R-b", text: "does B", markers: ["scenario_b"] },
]

test("spec probe fails the round and names uncovered requirements", async () => {
  const io = fakeIO({
    readVerify: () => "run scenario_a only\n",
    runVerify: (onMutant?: boolean) => (onMutant ? { code: 1, out: "caught" } : { code: 0, out: "ok" }),
  })
  const r = await runCompletionGate(io, { rounds: 1, mutants: 2, requirements: REQS })
  expect(r.rounds[0]!.outcome).toBe("requirement-untested")
  expect(r.rounds[0]!.uncoveredReqs).toEqual(["R-b"])
  const msg = io.log.find((l) => l.startsWith("reinject:"))!
  expect(msg).toContain("does B")
  expect(msg).toContain("R-b")
})

test("spec probe passes through when verify covers all requirements", async () => {
  const io = fakeIO({
    readVerify: () => "scenario_a then scenario_b\n",
    runVerify: (onMutant?: boolean) => (onMutant ? { code: 1, out: "caught" } : { code: 0, out: "ok" }),
  })
  const r = await runCompletionGate(io, { rounds: 1, mutants: 2, requirements: REQS })
  expect(r.rounds[0]!.outcome).toBe("accepted")
  expect(r.rounds[0]!.uncoveredReqs).toBeUndefined()
})

test("spec probe is fail-open: no requirements, no readVerify, or unreadable verify", async () => {
  const noReqs = fakeIO({ runVerify: (m?: boolean) => (m ? { code: 1, out: "x" } : { code: 0, out: "ok" }) })
  expect((await runCompletionGate(noReqs, { rounds: 1, mutants: 2 })).rounds[0]!.outcome).toBe("accepted")
  const unreadable = fakeIO({
    readVerify: () => undefined,
    runVerify: (m?: boolean) => (m ? { code: 1, out: "x" } : { code: 0, out: "ok" }),
  })
  expect(
    (await runCompletionGate(unreadable, { rounds: 1, mutants: 2, requirements: REQS })).rounds[0]!.outcome,
  ).toBe("accepted")
})
