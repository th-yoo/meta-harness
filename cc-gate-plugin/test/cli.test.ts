// test/cli.test.ts — integration tests that spawn the real hook-cli.ts
// process (bun src/hook-cli.ts <Event>) against hermetic tmp repos, exactly
// as Claude Code itself would invoke it. Pure-module behavior is already
// covered by the other test files; these tests exercise ONLY the adapter
// wiring: env guards, stdin parsing, path plumbing, persist-before-emit
// ordering, sensor appends, delivery modes, and fail-open behavior.
import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FileStateStore } from "../src/state.ts"
import { INITIAL_STATE, type CcGateState } from "../src/types.ts"

const HOOK_CLI = path.join(import.meta.dir, "..", "src", "hook-cli.ts")

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function runHook(opts: {
  event: string
  stdin: string
  env?: Record<string, string>
}): Promise<RunResult> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  // Never let this test process's own environment accidentally trip the
  // child-exclusion guard or delivery-mode seam for cases that don't intend it.
  delete env.MH_CHILD
  delete env.KM_CHILD
  delete env.KKAMAK_DELIVERY
  if (opts.env) Object.assign(env, opts.env)

  const proc = Bun.spawn(["bun", HOOK_CLI, opts.event], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new TextEncoder().encode(opts.stdin),
    env,
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])

  return { stdout, stderr, exitCode }
}

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-gate-cli-"))
}

function rmRepo(repo: string): void {
  fs.rmSync(repo, { recursive: true, force: true })
}

function writeGate(repo: string, cfg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify(cfg))
}

function stateFilePath(repo: string, sessionId: string): string {
  return path.join(repo, ".km", "cc-gate", `${sessionId}.json`)
}

function seedState(repo: string, sessionId: string, overrides: Partial<CcGateState>): void {
  const store = new FileStateStore(path.join(repo, ".km", "cc-gate"))
  store.save(sessionId, { ...INITIAL_STATE, ...overrides })
}

function loadState(repo: string, sessionId: string): CcGateState {
  const store = new FileStateStore(path.join(repo, ".km", "cc-gate"))
  return store.load(sessionId)
}

function sensorLines(repo: string): Record<string, unknown>[] {
  const p = path.join(repo, ".km", "gate-outcomes.ndjson")
  return fs
    .readFileSync(p, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

test("unknown event arg -> exit 0, empty stdout", async () => {
  const repo = mkRepo()
  try {
    const r = await runHook({
      event: "TotallyBogusEvent",
      stdin: JSON.stringify({ session_id: "s1", cwd: repo }),
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  } finally {
    rmRepo(repo)
  }
})

test("malformed stdin JSON -> exit 0", async () => {
  const r = await runHook({ event: "Stop", stdin: "{not valid json" })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toBe("")
})

test("MH_CHILD set -> exit 0 instantly, no state file created even with a blocking gate.json", async () => {
  const repo = mkRepo()
  try {
    writeGate(repo, { check: "exit 1" })
    const r = await runHook({
      event: "Stop",
      stdin: JSON.stringify({ session_id: "s1", cwd: repo }),
      env: { MH_CHILD: "1" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
    // No IO before the guard: not even the .km directory should exist.
    expect(fs.existsSync(path.join(repo, ".km"))).toBe(false)
  } finally {
    rmRepo(repo)
  }
})

test("KM_CHILD set -> exit 0 instantly, no state file created even with a blocking gate.json", async () => {
  const repo = mkRepo()
  try {
    writeGate(repo, { check: "exit 1" })
    const r = await runHook({
      event: "Stop",
      stdin: JSON.stringify({ session_id: "s1", cwd: repo }),
      env: { KM_CHILD: "1" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
    expect(fs.existsSync(path.join(repo, ".km"))).toBe(false)
  } finally {
    rmRepo(repo)
  }
})

test("Stop in a repo with NO gate.json and no prior state -> exit 0 AND no .km/ directory created", async () => {
  const repo = mkRepo()
  try {
    const r = await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "s1", cwd: repo }) })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
    // Nothing ever armed the gate here: Stop's unconditional sweep() must
    // not litter an untouched cwd with .km/cc-gate/.last-swept.
    expect(fs.existsSync(path.join(repo, ".km"))).toBe(false)
  } finally {
    rmRepo(repo)
  }
})

test("PostToolUse Write -> state file exists with edited:true", async () => {
  const repo = mkRepo()
  try {
    const r = await runHook({
      event: "PostToolUse",
      stdin: JSON.stringify({ session_id: "s1", cwd: repo, tool_name: "Write" }),
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
    expect(fs.existsSync(stateFilePath(repo, "s1"))).toBe(true)
    expect(loadState(repo, "s1").edited).toBe(true)
  } finally {
    rmRepo(repo)
  }
})

test("PostToolUse Bash -> no state file created", async () => {
  const repo = mkRepo()
  try {
    const r = await runHook({
      event: "PostToolUse",
      stdin: JSON.stringify({ session_id: "s1", cwd: repo, tool_name: "Bash" }),
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
    expect(fs.existsSync(stateFilePath(repo, "s1"))).toBe(false)
  } finally {
    rmRepo(repo)
  }
})

test("Stop end-to-end BLOCK: seeded edited + failing check -> block decision, state advanced to gating round 1", async () => {
  const repo = mkRepo()
  try {
    writeGate(repo, { check: "exit 1" })
    seedState(repo, "s1", { edited: true })

    const r = await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "s1", cwd: repo }) })

    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.decision).toBe("block")
    expect(typeof out.reason).toBe("string")

    // persist-before-emit: state advanced BEFORE the block was emitted.
    const state = loadState(repo, "s1")
    expect(state.gating).toBe(true)
    expect(state.round).toBe(1)
  } finally {
    rmRepo(repo)
  }
})

test("Stop end-to-end ACCEPT with marker: additionalContext present, state deleted, sensor line written under a fresh .km/", async () => {
  const repo = mkRepo()
  try {
    writeGate(repo, { check: "true", marker: true })
    seedState(repo, "s1", { edited: true }) // creates .km/cc-gate as a side effect only

    const r = await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "s1", cwd: repo }) })

    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput?.hookEventName).toBe("Stop")
    expect(typeof out.hookSpecificOutput?.additionalContext).toBe("string")
    expect((out.hookSpecificOutput.additionalContext as string).length).toBeGreaterThan(0)

    // initial-equivalent state -> deleted, not written.
    expect(fs.existsSync(stateFilePath(repo, "s1"))).toBe(false)

    // sensor file written (mkdir-recursive proven: gate-outcomes.ndjson's own
    // dirname is created independently of the sensor content itself).
    const sensorPath = path.join(repo, ".km", "gate-outcomes.ndjson")
    expect(fs.existsSync(sensorPath)).toBe(true)
    const lines = sensorLines(repo)
    expect(lines.length).toBe(1)
    expect(lines[0]!.app).toBe("claude-code")
    expect(lines[0]!.accepted).toBe(true)
    expect(lines[0]!.marker).toBe(true)
  } finally {
    rmRepo(repo)
  }
})

test("Stop EXHAUSTED end-to-end: systemMessage emitted, sensor line has gateExhausted:true", async () => {
  const repo = mkRepo()
  try {
    writeGate(repo, { check: "exit 1", rounds: 2 })
    seedState(repo, "s1", {
      edited: true,
      gating: true,
      round: 2,
      outcomes: ["verify-failed", "verify-failed"],
      cycleStartedAt: Date.now() - 500,
    })

    const r = await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "s1", cwd: repo }) })

    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(typeof out.systemMessage).toBe("string")

    const lines = sensorLines(repo)
    expect(lines.length).toBe(1)
    expect(lines[0]!.gateExhausted).toBe(true)
    expect(lines[0]!.rounds).toEqual(["verify-failed", "verify-failed", "verify-failed"])

    // Exhausted cycle resets to initial state -> file deleted.
    expect(fs.existsSync(stateFilePath(repo, "s1"))).toBe(false)
  } finally {
    rmRepo(repo)
  }
})

test(
  "check timeout resolves as a blocked round well under the sleep duration, evidence mentions the timeout",
  async () => {
    const repo = mkRepo()
    try {
      writeGate(repo, { check: "sleep 5", checkTimeoutMs: 300 })
      seedState(repo, "s1", { edited: true })

      const started = Date.now()
      const r = await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "s1", cwd: repo }) })
      const elapsedMs = Date.now() - started

      expect(elapsedMs).toBeLessThan(4000) // well under the 5s sleep
      expect(r.exitCode).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.decision).toBe("block")
      expect((out.reason as string)).toContain("timed out")

      const state = loadState(repo, "s1")
      expect(state.gating).toBe(true)
      expect(state.round).toBe(1)
    } finally {
      rmRepo(repo)
    }
  },
  10_000,
)

test(
  "compound check leaves a pipe-holding grandchild after SIGTERM -> CLI still completes well under 10s with a block/timeout decision",
  async () => {
    const repo = mkRepo()
    try {
      // `bash -c 'sleep 30 & sleep 30'` backgrounds one sleep and holds the
      // pipes open with the other; SIGTERM to the outer bash process does
      // not reach either child, so the stdout/stderr text promises would
      // never settle without the grace-timer race + SIGKILL escalation.
      writeGate(repo, { check: "bash -c 'sleep 30 & sleep 30'", checkTimeoutMs: 300 })
      seedState(repo, "s1", { edited: true })

      const started = Date.now()
      const r = await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "s1", cwd: repo }) })
      const elapsedMs = Date.now() - started

      expect(elapsedMs).toBeLessThan(9000)
      expect(r.exitCode).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.decision).toBe("block")
      expect((out.reason as string)).toContain("timed out")
    } finally {
      rmRepo(repo)
    }
  },
  10_000,
)

test("gate.json with an absolute sensor path writes there directly, not re-rooted under cwd", async () => {
  const repo = mkRepo()
  const sensorDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gate-sensor-"))
  const absSensor = path.join(sensorDir, "outcomes.ndjson")
  try {
    writeGate(repo, { check: "true", marker: true, sensor: absSensor })
    seedState(repo, "s1", { edited: true })

    const r = await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "s1", cwd: repo }) })
    expect(r.exitCode).toBe(0)

    // Written to the absolute path itself...
    expect(fs.existsSync(absSensor)).toBe(true)
    // ...and NOT re-rooted under <repo>/<absSensor> (the path.join(cwd, sensor) bug).
    const wrongPath = path.join(repo, absSensor)
    expect(fs.existsSync(wrongPath)).toBe(false)
  } finally {
    rmRepo(repo)
    fs.rmSync(sensorDir, { recursive: true, force: true })
  }
})

test.skipIf((process.getuid?.() ?? -1) === 0)(
  "unwritable state dir -> fail-open: exit 0, decision allow, no block on an unrecorded round",
  async () => {
    const repo = mkRepo()
    try {
      writeGate(repo, { check: "exit 1" })
      seedState(repo, "s1", { edited: true }) // readable non-initial state to seed the write path

      const stateDir = path.join(repo, ".km", "cc-gate")
      // Read+execute only: load() can still open+read the existing file, but
      // writing the new (non-initial, "gating") state's tmp file into this
      // dir must fail — this is the save()-throws fail-open path, distinct
      // from the initial-equivalent delete path (which state.ts swallows).
      fs.chmodSync(stateDir, 0o500)

      try {
        const r = await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "s1", cwd: repo }) })
        expect(r.exitCode).toBe(0)
        expect(r.stdout).toBe("") // "allow" emits no stdout at all
      } finally {
        fs.chmodSync(stateDir, 0o700) // restore so cleanup can remove it
      }
    } finally {
      rmRepo(repo)
    }
  },
)

test("KKAMAK_DELIVERY=exit2-stderr on a block -> exit 2, evidence on stderr, empty stdout", async () => {
  const repo = mkRepo()
  try {
    writeGate(repo, { check: "exit 1" })
    seedState(repo, "s1", { edited: true })

    const r = await runHook({
      event: "Stop",
      stdin: JSON.stringify({ session_id: "s1", cwd: repo }),
      env: { KKAMAK_DELIVERY: "exit2-stderr" },
    })

    expect(r.exitCode).toBe(2)
    expect(r.stdout).toBe("")
    expect(r.stderr.length).toBeGreaterThan(0)
  } finally {
    rmRepo(repo)
  }
})

// ── §4.4 composed v1 E2E (composition design; forced arm) ────────────────

test("forced v1: composed block message — raw output present, kernel closing sentence absent", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "echo KM_E2E_FAILURE_MARKER; false", rounds: 2 })
  seedState(repo, "sid-v1", { edited: true })
  const r = await runHook({
    event: "Stop",
    stdin: JSON.stringify({ session_id: "sid-v1", cwd: repo }),
    env: { KKAMAK_REINJECT: "v1" },
  })
  const payload = JSON.parse(r.stdout)
  expect(payload.decision).toBe("block")
  expect(payload.reason).toContain("KM_E2E_FAILURE_MARKER")
  expect(payload.reason).not.toContain("re-run it")
  expect(payload.reason).toContain("gate.json")
  rmRepo(repo)
})

test("forced v1 + check timeout: timeout marker survives the composed tail", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "sleep 5", rounds: 2, checkTimeoutMs: 300 })
  seedState(repo, "sid-v1t", { edited: true })
  const r = await runHook({
    event: "Stop",
    stdin: JSON.stringify({ session_id: "sid-v1t", cwd: repo }),
    env: { KKAMAK_REINJECT: "v1" },
  })
  const payload = JSON.parse(r.stdout)
  expect(payload.decision).toBe("block")
  expect(payload.reason).toContain("[kkamak: check timed out]")
  expect(payload.reason).not.toContain("re-run it")
  rmRepo(repo)
})

// ── §4.3 amendment (Task 1 of §11 item 6): forced + pluginVersion ────────

test("KKAMAK_REINJECT=v1 (forced) -> sensor line carries forced:true", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true" })
  seedState(repo, "sid-forced", { edited: true })
  await runHook({
    event: "Stop",
    stdin: JSON.stringify({ session_id: "sid-forced", cwd: repo }),
    env: { KKAMAK_REINJECT: "v1" },
  })
  const lines = sensorLines(repo)
  expect(lines[0]!.forced).toBe(true)
  rmRepo(repo)
})

test("no KKAMAK_REINJECT override (salted arm) -> sensor line has forced absent, not false", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true" })
  seedState(repo, "sid-unforced", { edited: true })
  await runHook({
    event: "Stop",
    stdin: JSON.stringify({ session_id: "sid-unforced", cwd: repo }),
  })
  const lines = sensorLines(repo)
  expect("forced" in lines[0]!).toBe(false)
  rmRepo(repo)
})

test("invalid KKAMAK_REINJECT value -> not treated as forced", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true" })
  seedState(repo, "sid-bogus-reinject", { edited: true })
  await runHook({
    event: "Stop",
    stdin: JSON.stringify({ session_id: "sid-bogus-reinject", cwd: repo }),
    env: { KKAMAK_REINJECT: "bogus" },
  })
  const lines = sensorLines(repo)
  expect("forced" in lines[0]!).toBe(false)
  rmRepo(repo)
})

test("pluginVersion is stamped on the Stop sensor line, matching .claude-plugin/plugin.json", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true" })
  seedState(repo, "sid-version", { edited: true })
  await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "sid-version", cwd: repo }) })
  const lines = sensorLines(repo)
  const manifest = JSON.parse(
    fs.readFileSync(path.join(import.meta.dir, "..", ".claude-plugin", "plugin.json"), "utf-8"),
  )
  expect(lines[0]!.pluginVersion).toBe(manifest.version)
  rmRepo(repo)
})

test("pluginVersion is stamped on the UserPromptSubmit sensor line too (every emitted line)", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true" })
  seedState(repo, "sid-ups-version", { gating: true, edited: true, round: 1, outcomes: ["verify-failed"] })
  await runHook({
    event: "UserPromptSubmit",
    stdin: JSON.stringify({ session_id: "sid-ups-version", cwd: repo, prompt: "hi" }),
  })
  const lines = sensorLines(repo)
  expect(lines.length).toBe(1)
  const manifest = JSON.parse(
    fs.readFileSync(path.join(import.meta.dir, "..", ".claude-plugin", "plugin.json"), "utf-8"),
  )
  expect(lines[0]!.pluginVersion).toBe(manifest.version)
  rmRepo(repo)
})

// ── Task 1 (fix-them-serialized-teacup plan): skipped-Stop boundary e2e ────

test("UserPromptSubmit while edited:true, gating:false (queued-prompt boundary loss) -> a skippedStop sensor line is appended and edited survives", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true" })
  seedState(repo, "sid-skipped-stop", { edited: true, gating: false })
  const r = await runHook({
    event: "UserPromptSubmit",
    stdin: JSON.stringify({ session_id: "sid-skipped-stop", cwd: repo, prompt: "another edit please" }),
  })
  expect(r.exitCode).toBe(0)

  const lines = sensorLines(repo)
  expect(lines.length).toBe(1)
  expect(lines[0]!.skippedStop).toBe(true)
  expect(lines[0]!.rounds).toEqual([])
  expect(lines[0]!.accepted).toBe(true)
  expect(lines[0]!.gateExhausted).toBe(false)
  expect(lines[0]!.interrupted).toBe(false)

  // Marker, not measurement: edited survives for the next real Stop.
  const state = loadState(repo, "sid-skipped-stop")
  expect(state.edited).toBe(true)
  expect(state.gating).toBe(false)
  rmRepo(repo)
})

test("UserPromptSubmit while edited:false, gating:false -> no sensor line (nothing unmeasured)", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true" })
  const r = await runHook({
    event: "UserPromptSubmit",
    stdin: JSON.stringify({ session_id: "sid-no-skipped-stop", cwd: repo, prompt: "hi" }),
  })
  expect(r.exitCode).toBe(0)
  expect(fs.existsSync(path.join(repo, ".km", "gate-outcomes.ndjson"))).toBe(false)
  rmRepo(repo)
})

// ── Task 1: check-output sidecar wiring ──────────────────────────────────

function sidecarRecords(repo: string): Record<string, unknown>[] {
  const p = path.join(repo, ".km", "check-output.ndjson")
  return fs
    .readFileSync(p, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

test("Stop block round appends one check-output sidecar record with pre-reinject raw output", async () => {
  const repo = mkRepo()
  try {
    writeGate(repo, { check: "echo COMPILE_HEAD; echo TEST_TAIL; exit 1", rounds: 2 })
    seedState(repo, "sc1", { edited: true })
    const r = await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "sc1", cwd: repo }) })
    expect(r.exitCode).toBe(0) // block-json delivery: decision on stdout
    const recs = sidecarRecords(repo)
    expect(recs.length).toBe(1)
    expect(recs[0]).toMatchObject({ sessionID: "sc1", round: 1, roundsMax: 2 })
    expect(recs[0]!.excerpt as string).toContain("COMPILE_HEAD")
    expect(recs[0]!.excerpt as string).toContain("TEST_TAIL")
    expect(typeof recs[0]!.ts).toBe("number")
  } finally {
    rmRepo(repo)
  }
})

test("Stop accepted round appends NO sidecar record", async () => {
  const repo = mkRepo()
  try {
    writeGate(repo, { check: "true", rounds: 2 })
    seedState(repo, "sc2", { edited: true })
    await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "sc2", cwd: repo }) })
    expect(fs.existsSync(path.join(repo, ".km", "check-output.ndjson"))).toBe(false)
  } finally {
    rmRepo(repo)
  }
})

test("sidecar write failure changes nothing about the emitted block decision", async () => {
  const repo = mkRepo()
  try {
    writeGate(repo, { check: "echo NOPE; exit 1", rounds: 2 })
    // Baseline run in a healthy twin repo for comparison.
    const twin = mkRepo()
    writeGate(twin, { check: "echo NOPE; exit 1", rounds: 2 })
    seedState(twin, "sc3", { edited: true })
    const healthy = await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "sc3", cwd: twin }) })
    // Sabotage: sidecar path is a directory -> append fails (EISDIR).
    fs.mkdirSync(path.join(repo, ".km", "check-output.ndjson"), { recursive: true })
    seedState(repo, "sc3", { edited: true })
    const sabotaged = await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: "sc3", cwd: repo }) })
    expect(sabotaged.exitCode).toBe(healthy.exitCode)
    expect(sabotaged.stdout).toBe(healthy.stdout)
    expect(sabotaged.stderr).toContain("check-output")
    rmRepo(twin)
  } finally {
    rmRepo(repo)
  }
})
