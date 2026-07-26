import { test, expect } from "bun:test"
import { parseGateConfig, makeGateHooks, type GateDeps } from "../src/core.ts"
import { HYGIENE_MARKER } from "../../minimal/session2.ts"

test("parseGateConfig: minimal valid config gets defaults", () => {
  const c = parseGateConfig(`{"check": "bun test"}`)
  expect(c).toEqual({ check: "bun test", rounds: 2, marker: false, sensor: ".meta-harness/gate-outcomes.ndjson" })
})
test("parseGateConfig: explicit fields respected", () => {
  const c = parseGateConfig(`{"check": "make verify", "rounds": 1, "marker": true, "sensor": "out.ndjson"}`)
  expect(c).toEqual({ check: "make verify", rounds: 1, marker: true, sensor: "out.ndjson" })
})
test("parseGateConfig: missing check → undefined", () => {
  expect(parseGateConfig(`{"rounds": 3}`)).toBeUndefined()
})
test("parseGateConfig: malformed JSON → undefined", () => {
  expect(parseGateConfig(`{nope`)).toBeUndefined()
})
test("parseGateConfig: non-string check → undefined", () => {
  expect(parseGateConfig(`{"check": 42}`)).toBeUndefined()
})

// ---------------------------------------------------------------------------
// makeGateHooks
// ---------------------------------------------------------------------------

interface FakeState {
  checks: string[]
  prompts: { sid: string; text: string }[]
  toasts: { message: string; variant: string }[]
  sensor: string[]
}

function fakeDeps(overrides: Partial<GateDeps> = {}): GateDeps & { state: FakeState } {
  const state: FakeState = { checks: [], prompts: [], toasts: [], sensor: [] }
  const deps: GateDeps & { state: FakeState } = {
    state,
    readGateConfig: () => '{"check":"bun test"}',
    runCheck: async (cmd: string) => {
      state.checks.push(cmd)
      return { code: 0, out: "ok" }
    },
    promptSession: async (sid: string, text: string) => {
      state.prompts.push({ sid, text })
      return true
    },
    toast: async (message: string, variant: "info" | "success" | "warning" | "error") => {
      state.toasts.push({ message, variant })
    },
    appendSensor: (relPath: string, line: string) => {
      state.sensor.push(line)
    },
    now: () => 1000,
    ...overrides,
  }
  return deps
}

// 1. no gate.json → no-op
test("sessionIdle: no gate.json → no-op", async () => {
  const deps = fakeDeps({ readGateConfig: () => undefined })
  const hooks = makeGateHooks(deps)
  hooks.toolExecuteAfter("edit", "s1")
  await hooks.sessionIdle("s1")
  expect(deps.state.checks.length).toBe(0)
  expect(deps.state.sensor.length).toBe(0)
})

// 2. gate.json present but session never edited → no-op
test("sessionIdle: gate.json present but no edits recorded → no-op", async () => {
  const deps = fakeDeps()
  const hooks = makeGateHooks(deps)
  await hooks.sessionIdle("s1")
  expect(deps.state.checks.length).toBe(0)
  expect(deps.state.sensor.length).toBe(0)
})

// 3. edit tool set exactness
test("toolExecuteAfter: edit tools mark session edited; bash/read do not", async () => {
  const deps = fakeDeps()
  const hooks = makeGateHooks(deps)
  hooks.toolExecuteAfter("bash", "s1")
  hooks.toolExecuteAfter("read", "s1")
  await hooks.sessionIdle("s1")
  expect(deps.state.checks.length).toBe(0) // not edited yet

  for (const tool of ["write", "edit", "patch", "multiedit"]) {
    const d2 = fakeDeps()
    const h2 = makeGateHooks(d2)
    h2.toolExecuteAfter(tool, "s1")
    await h2.sessionIdle("s1")
    expect(d2.state.checks.length).toBe(1)
  }
})

// 4. happy path
test("happy path: edited + check passes → accepted, sensor line, success toast, no marker prompt", async () => {
  const deps = fakeDeps()
  const hooks = makeGateHooks(deps)
  hooks.toolExecuteAfter("edit", "s1")
  await hooks.sessionIdle("s1")

  expect(deps.state.checks).toEqual(["bun test"])
  expect(deps.state.prompts.length).toBe(0) // marker off by default, no reinject needed
  expect(deps.state.sensor.length).toBe(1)
  const rec = JSON.parse(deps.state.sensor[0]!)
  expect(rec).toMatchObject({
    ts: 1000,
    sessionID: "s1",
    check: "bun test",
    accepted: true,
    gateExhausted: false,
  })
  expect(Array.isArray(rec.rounds)).toBe(true)
  expect(typeof rec.durationMs).toBe("number")
  expect(deps.state.toasts.some((t) => t.variant === "success")).toBe(true)
})

// 5. fail→fix path
test("fail then fix: one reinject prompt with output tail, accepted, sensor records 2 rounds", async () => {
  let call = 0
  const deps = fakeDeps({
    runCheck: async (cmd: string) => {
      deps.state.checks.push(cmd)
      call++
      return call === 1 ? { code: 1, out: "AssertionError: boom" } : { code: 0, out: "ok" }
    },
  })
  const hooks = makeGateHooks(deps)
  hooks.toolExecuteAfter("edit", "s1")
  await hooks.sessionIdle("s1")

  expect(deps.state.checks.length).toBe(2)
  expect(deps.state.prompts.length).toBe(1)
  expect(deps.state.prompts[0]!.text).toContain("AssertionError: boom")
  const rec = JSON.parse(deps.state.sensor[0]!)
  expect(rec.accepted).toBe(true)
  expect(rec.gateExhausted).toBe(false)
  expect(rec.rounds.length).toBe(2)
})

// 6. exhaustion
test("exhaustion: always fails, rounds:1 → reinject once, accept-anyway, warning toast", async () => {
  const deps = fakeDeps({
    readGateConfig: () => '{"check":"bun test","rounds":1}',
    runCheck: async (cmd: string) => {
      deps.state.checks.push(cmd)
      return { code: 1, out: "still broken" }
    },
  })
  const hooks = makeGateHooks(deps)
  hooks.toolExecuteAfter("edit", "s1")
  await hooks.sessionIdle("s1")

  expect(deps.state.prompts.length).toBe(1) // reinject once
  const rec = JSON.parse(deps.state.sensor[0]!)
  expect(rec.accepted).toBe(true)
  expect(rec.gateExhausted).toBe(true)
  expect(deps.state.toasts.some((t) => t.variant === "warning")).toBe(true)
})

// 7. marker
test("marker: config marker:true + acceptance → extra promptSession with HYGIENE_MARKER verbatim", async () => {
  const deps = fakeDeps({ readGateConfig: () => '{"check":"bun test","marker":true}' })
  const hooks = makeGateHooks(deps)
  hooks.toolExecuteAfter("edit", "s1")
  await hooks.sessionIdle("s1")

  expect(deps.state.prompts.length).toBe(1)
  expect(deps.state.prompts[0]!.text).toBe(HYGIENE_MARKER)
})

test("marker: marker:false (default) → no marker prompt on acceptance", async () => {
  const deps = fakeDeps()
  const hooks = makeGateHooks(deps)
  hooks.toolExecuteAfter("edit", "s1")
  await hooks.sessionIdle("s1")
  expect(deps.state.prompts.length).toBe(0)
})

test("marker: marker:true but gate exhausted → no marker prompt", async () => {
  const deps = fakeDeps({
    readGateConfig: () => '{"check":"bun test","rounds":1,"marker":true}',
    runCheck: async (cmd: string) => {
      deps.state.checks.push(cmd)
      return { code: 1, out: "still broken" }
    },
  })
  const hooks = makeGateHooks(deps)
  hooks.toolExecuteAfter("edit", "s1")
  await hooks.sessionIdle("s1")
  // only the reinject prompt (1), NOT a marker prompt
  expect(deps.state.prompts.length).toBe(1)
  expect(deps.state.prompts[0]!.text).not.toBe(HYGIENE_MARKER)
})

// 8. re-entrancy
test("re-entrancy: concurrent sessionIdle calls for a gating session run check once", async () => {
  let resolveCheck: (v: { code: number; out: string }) => void
  const pending = new Promise<{ code: number; out: string }>((res) => {
    resolveCheck = res
  })
  const deps = fakeDeps({
    runCheck: async (cmd: string) => {
      deps.state.checks.push(cmd)
      return pending
    },
  })
  const hooks = makeGateHooks(deps)
  hooks.toolExecuteAfter("edit", "s1")

  const p1 = hooks.sessionIdle("s1")
  const p2 = hooks.sessionIdle("s1") // should return immediately, no-op
  await p2
  expect(deps.state.checks.length).toBe(1)
  resolveCheck!({ code: 0, out: "ok" })
  await p1
  expect(deps.state.checks.length).toBe(1)
})

// 9. post-gate idle
test("post-gate idle: next sessionIdle with no new edits is a no-op; a new edit re-arms", async () => {
  const deps = fakeDeps()
  const hooks = makeGateHooks(deps)
  hooks.toolExecuteAfter("edit", "s1")
  await hooks.sessionIdle("s1")
  expect(deps.state.checks.length).toBe(1)

  await hooks.sessionIdle("s1") // no new edits → no-op
  expect(deps.state.checks.length).toBe(1)

  hooks.toolExecuteAfter("edit", "s1") // re-arm
  await hooks.sessionIdle("s1")
  expect(deps.state.checks.length).toBe(2)
})

// 10. human interrupt
test("human interrupt: chatMessage during gating refuses next reinject; sensor still written with interrupted:true", async () => {
  let call = 0
  let hooks: ReturnType<typeof makeGateHooks>
  const deps = fakeDeps({
    runCheck: async (cmd: string) => {
      deps.state.checks.push(cmd)
      call++
      if (call === 1) {
        // simulate a human typing mid-gate, right after the first (failing) check
        hooks.chatMessage("s1")
      }
      return { code: 1, out: "still failing" }
    },
    readGateConfig: () => '{"check":"bun test","rounds":2}',
  })
  hooks = makeGateHooks(deps)
  hooks.toolExecuteAfter("edit", "s1")
  await hooks.sessionIdle("s1")

  expect(deps.state.prompts.length).toBe(0) // reinject refused
  expect(deps.state.sensor.length).toBe(1)
  const rec = JSON.parse(deps.state.sensor[0]!)
  expect(rec.interrupted).toBe(true)
  expect(rec.gateExhausted).toBe(true)
})

test("chatMessage when idle just re-arms (clears gated flag)", async () => {
  const deps = fakeDeps()
  const hooks = makeGateHooks(deps)
  hooks.toolExecuteAfter("edit", "s1")
  await hooks.sessionIdle("s1")
  expect(deps.state.checks.length).toBe(1)

  hooks.chatMessage("s1") // idle interrupt clears "gated" without a new edit
  await hooks.sessionIdle("s1")
  // gated cleared but edited was also cleared by acceptance and never re-set,
  // so this should still be a no-op (no edits since last gate)
  expect(deps.state.checks.length).toBe(1)
})

// 11. edits during gating do not mark session edited
test("edits performed during gating do not mark session edited (no infinite re-gate)", async () => {
  let hooks: ReturnType<typeof makeGateHooks>
  let injectedEditOnce = false
  const deps = fakeDeps({
    runCheck: async (cmd: string) => {
      deps.state.checks.push(cmd)
      if (!injectedEditOnce) {
        injectedEditOnce = true
        hooks.toolExecuteAfter("edit", "s1") // simulate reinjected agent editing mid-gate
      }
      return { code: 0, out: "ok" }
    },
  })
  hooks = makeGateHooks(deps)
  hooks.toolExecuteAfter("edit", "s1")
  await hooks.sessionIdle("s1")
  expect(deps.state.checks.length).toBe(1)

  await hooks.sessionIdle("s1") // should be no-op: the mid-gate edit must not have armed it
  expect(deps.state.checks.length).toBe(1)
})

// 12. runCheck receives cfg.check verbatim
test("runCheck receives cfg.check verbatim", async () => {
  const deps = fakeDeps({ readGateConfig: () => '{"check":"make verify --strict"}' })
  const hooks = makeGateHooks(deps)
  hooks.toolExecuteAfter("edit", "s1")
  await hooks.sessionIdle("s1")
  expect(deps.state.checks).toEqual(["make verify --strict"])
})
