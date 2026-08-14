/**
 * proposer-worker.test.ts — TDD contract for
 * src/adapters/claude-code/proposer-worker.ts (daemon carrier migration,
 * plan T5 against T2's worker + T0's frozen contracts).
 *
 * Hermetic: NO real daemon, NO model spend — every cycle runs via injected
 * fake {ensure, call, close} deps (the same seam pattern as
 * test/p2-a4-review.test.ts / the cc-host judge tests). Staged files are
 * REAL writes into a per-test temp dir (writeTextAtomic is not mocked), so
 * the per-kind file-set assertions cover exactly what applyPendingArtifacts
 * will see on disk.
 *
 * F2 note: all prompts/replies below are synthetic fixtures invented for
 * this test, never a real proposer transcript.
 */
import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { createHash } from "node:crypto"
import type { DaemonOutcome } from "@th-yoo/cc-api-daemon"
import { runWorkerCycle, parseReplyJson, type WorkerDeps } from "../src/adapters/claude-code/proposer-worker.ts"
import { WORKER_DEADLINE_MARGIN_MS, type WorkerArgs, type WorkerStagingPaths } from "../src/adapters/claude-code/daemon-seat.ts"

let stagingDir: string

beforeEach(() => {
  stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-worker-"))
})
afterEach(() => {
  fs.rmSync(stagingDir, { recursive: true, force: true })
})

// ── fixtures ─────────────────────────────────────────────────────────────

const MODEL = "claude-opus-5" // agent lane — seatMaxTokens must stay undefined

function proposePaths(playbookMode: boolean): WorkerStagingPaths {
  return {
    kind: "propose",
    playbookMode,
    system: path.join(stagingDir, "project-role-v9-system.md"),
    tools: path.join(stagingDir, "project-role-v9-tools.md"),
    diagnosis: path.join(stagingDir, "project-role-v9-diagnosis.json"),
    ops: path.join(stagingDir, "project-role-v9-ops.json"),
    agentConfig: path.join(stagingDir, "project-role-v9-agent-config.json"),
    envPolicy: path.join(stagingDir, "project-role-v9-env-policy.json"),
    provenance: path.join(stagingDir, "project-role-v9-provenance.json"),
  }
}

function promotePaths(): WorkerStagingPaths {
  return {
    kind: "promote",
    system: path.join(stagingDir, "promote-role-v3-system.md"),
    tools: path.join(stagingDir, "promote-role-v3-tools.md"),
    provenance: path.join(stagingDir, "promote-role-v3-provenance.json"),
  }
}

function curatePaths(): WorkerStagingPaths {
  return {
    kind: "curate",
    ops: path.join(stagingDir, "curate-role-v4-ops.json"),
    provenance: path.join(stagingDir, "curate-role-v4-provenance.json"),
  }
}

function workerArgs(kind: WorkerArgs["kind"], stagingPaths: WorkerStagingPaths, over: Partial<WorkerArgs> = {}): WorkerArgs {
  return {
    kind,
    prompt: "improve the playbook",
    systemPrompt: "you are the proposer",
    model: MODEL,
    stagingPaths,
    timeoutMs: 600_000,
    spawnedAt: Date.now(),
    artifactId: "artifact-1",
    ...over,
  }
}

type OkOutcome = Extract<DaemonOutcome, { kind: "ok" }>

function okOutcome(text: string, over: Partial<OkOutcome> = {}): DaemonOutcome {
  return { kind: "ok", text, model: MODEL, canonicalModel: MODEL, sessionId: "sess-1", ...over }
}

const PROPOSE_PLAYBOOK_REPLY = {
  diagnosis: { failureMode: "vague completions" },
  ops: { ops: [{ op: "add", text: "always run the check" }, { op: "delete", id: "b7" }] },
  tools: "tool notes",
  agentConfig: { maxTurns: 30 },
  envPolicy: { network: "off" },
  explanation: "adds a check bullet",
}

const PROMOTE_REPLY = { system: "the promoted system text", tools: "promoted tools" }
const CURATE_REPLY = { ops: { ops: [{ op: "update", id: "b1", text: "merged bullet" }, { op: "delete", id: "b2" }] } }

/** Captures every call/close; replies are consumed in order (last repeats). */
interface Capture {
  ensures: { waitMs?: number }[]
  calls: { prompt: string; model: string; opts: { budgetMs?: number; maxTokens?: number; isolation: { systemPrompt: string; title: string } } }[]
  closed: string[]
}

function fakeDeps(outcomes: DaemonOutcome[], over: WorkerDeps = {}): { deps: WorkerDeps; cap: Capture } {
  const cap: Capture = { ensures: [], calls: [], closed: [] }
  let i = 0
  const deps: WorkerDeps = {
    ensure: (async (_env: unknown, opts?: { waitMs?: number }) => {
      cap.ensures.push({ waitMs: opts?.waitMs })
      return true
    }) as WorkerDeps["ensure"],
    call: (async (prompt: string, model: string, _env: unknown, opts: unknown) => {
      cap.calls.push({ prompt, model, opts: opts as Capture["calls"][number]["opts"] })
      const o = outcomes[Math.min(i, outcomes.length - 1)]
      i++
      return o
    }) as WorkerDeps["call"],
    close: (async (sessionId: string) => { cap.closed.push(sessionId) }) as WorkerDeps["close"],
    ...over,
  }
  return { deps, cap }
}

function stagedFiles(): string[] {
  return fs.readdirSync(stagingDir).sort()
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>
}

// ── parseReplyJson ───────────────────────────────────────────────────────

test("parseReplyJson: bare JSON object", () => {
  expect(parseReplyJson(`{"a": 1}`)).toEqual({ a: 1 })
})

test("parseReplyJson: tolerates a ```json fence", () => {
  expect(parseReplyJson("```json\n{\"a\": 1}\n```")).toEqual({ a: 1 })
})

test("parseReplyJson: tolerates a bare ``` fence", () => {
  expect(parseReplyJson("```\n{\"a\": 1}\n```\n")).toEqual({ a: 1 })
})

test("parseReplyJson: garbage -> undefined", () => {
  expect(parseReplyJson("I think the playbook should…")).toBeUndefined()
})

// ── happy paths, per kind ────────────────────────────────────────────────

test("propose playbook mode: exit 0, full file set, ops as primary, no system.md, provenance content", async () => {
  const args = workerArgs("propose", proposePaths(true))
  const { deps, cap } = fakeDeps([okOutcome(JSON.stringify(PROPOSE_PLAYBOOK_REPLY))])

  const code = await runWorkerCycle(args, {}, deps)

  expect(code).toBe(0)
  expect(stagedFiles()).toEqual([
    "project-role-v9-agent-config.json",
    "project-role-v9-diagnosis.json",
    "project-role-v9-env-policy.json",
    "project-role-v9-ops.json",
    "project-role-v9-provenance.json",
    "project-role-v9-tools.md",
  ]) // playbook mode: NO system.md
  const sp = args.stagingPaths as Extract<WorkerStagingPaths, { kind: "propose" }>
  expect(readJson(sp.ops)).toEqual(PROPOSE_PLAYBOOK_REPLY.ops)
  expect(readJson(sp.diagnosis)).toEqual(PROPOSE_PLAYBOOK_REPLY.diagnosis)
  expect(fs.readFileSync(sp.tools, "utf8")).toBe("tool notes")
  const prov = readJson(sp.provenance)
  expect(prov.artifactId).toBe("artifact-1")
  expect(prov.kind).toBe("propose")
  expect(prov.model).toBe(MODEL)
  expect(prov.retried).toBe(false)
  expect(prov.promptSha256).toBe(createHash("sha256").update(args.prompt).digest("hex"))
  // Seat wiring: our system prompt + proposer title, agent lane -> NO maxTokens.
  expect(cap.calls[0]!.opts.isolation.systemPrompt).toBe("you are the proposer")
  expect(cap.calls[0]!.opts.isolation.title).toBe("kkamak-proposer")
  expect(cap.calls[0]!.opts.maxTokens).toBeUndefined()
  expect(cap.closed).toEqual(["sess-1"])
})

test("propose legacy (system.md) mode: system is primary, ops.json NOT written", async () => {
  const args = workerArgs("propose", proposePaths(false))
  const reply = { diagnosis: { d: 1 }, system: "the improved system text" }
  const { deps } = fakeDeps([okOutcome(JSON.stringify(reply))])

  const code = await runWorkerCycle(args, {}, deps)

  expect(code).toBe(0)
  const sp = args.stagingPaths as Extract<WorkerStagingPaths, { kind: "propose" }>
  expect(fs.readFileSync(sp.system, "utf8")).toBe("the improved system text")
  expect(fs.existsSync(sp.ops)).toBe(false)
  // optional replies absent -> optional files absent
  expect(fs.existsSync(sp.tools)).toBe(false)
  expect(fs.existsSync(sp.agentConfig)).toBe(false)
  expect(fs.existsSync(sp.envPolicy)).toBe(false)
})

test("promote: exit 0, exactly {system, tools, provenance} — never a proposer-shaped file", async () => {
  const args = workerArgs("promote", promotePaths())
  const { deps, cap } = fakeDeps([okOutcome(JSON.stringify(PROMOTE_REPLY))])

  const code = await runWorkerCycle(args, {}, deps)

  expect(code).toBe(0)
  expect(stagedFiles()).toEqual([
    "promote-role-v3-provenance.json",
    "promote-role-v3-system.md",
    "promote-role-v3-tools.md",
  ])
  const sp = args.stagingPaths as Extract<WorkerStagingPaths, { kind: "promote" }>
  expect(fs.readFileSync(sp.system, "utf8")).toBe("the promoted system text")
  expect(cap.calls[0]!.opts.isolation.title).toBe("kkamak-promoter")
})

test("promote without tools in the reply: tools file absent", async () => {
  const args = workerArgs("promote", promotePaths())
  const { deps } = fakeDeps([okOutcome(JSON.stringify({ system: "sys only" }))])

  const code = await runWorkerCycle(args, {}, deps)

  expect(code).toBe(0)
  expect(stagedFiles()).toEqual(["promote-role-v3-provenance.json", "promote-role-v3-system.md"])
})

test("curate: exit 0, exactly {ops, provenance}", async () => {
  const args = workerArgs("curate", curatePaths())
  const { deps, cap } = fakeDeps([okOutcome(JSON.stringify(CURATE_REPLY))])

  const code = await runWorkerCycle(args, {}, deps)

  expect(code).toBe(0)
  expect(stagedFiles()).toEqual(["curate-role-v4-ops.json", "curate-role-v4-provenance.json"])
  const sp = args.stagingPaths as Extract<WorkerStagingPaths, { kind: "curate" }>
  expect(readJson(sp.ops)).toEqual(CURATE_REPLY.ops)
  expect(cap.calls[0]!.opts.isolation.title).toBe("kkamak-curator")
})

// ── repair retry ─────────────────────────────────────────────────────────

test("invalid JSON then valid: ONE repair retry (## Repair + original prompt), exit 0, provenance retried=true", async () => {
  const args = workerArgs("promote", promotePaths())
  const { deps, cap } = fakeDeps([
    okOutcome("not json at all", { sessionId: "sess-a" }),
    okOutcome(JSON.stringify(PROMOTE_REPLY), { sessionId: "sess-b" }),
  ])

  const code = await runWorkerCycle(args, {}, deps)

  expect(code).toBe(0)
  expect(cap.calls.length).toBe(2)
  expect(cap.calls[0]!.prompt).toBe(args.prompt)
  expect(cap.calls[1]!.prompt).toContain("## Repair")
  expect(cap.calls[1]!.prompt).toContain(args.prompt)
  const sp = args.stagingPaths as Extract<WorkerStagingPaths, { kind: "promote" }>
  expect(readJson(sp.provenance).retried).toBe(true)
  // both served sessions closed
  expect(cap.closed.sort()).toEqual(["sess-a", "sess-b"])
})

test("invalid twice: exit 1, NO files staged, exactly two calls", async () => {
  const args = workerArgs("curate", curatePaths())
  const { deps, cap } = fakeDeps([okOutcome("junk"), okOutcome("{\"still\": \"wrong\"}")])

  const code = await runWorkerCycle(args, {}, deps)

  expect(code).toBe(1)
  expect(cap.calls.length).toBe(2)
  expect(stagedFiles()).toEqual([])
})

test("curate reply with an add op is invalid (consolidate, don't invent) — repair then fail -> exit 1, nothing staged", async () => {
  const args = workerArgs("curate", curatePaths())
  const addReply = JSON.stringify({ ops: { ops: [{ op: "add", text: "brand new rule" }] } })
  const { deps, cap } = fakeDeps([okOutcome(addReply)])

  const code = await runWorkerCycle(args, {}, deps)

  expect(code).toBe(1)
  expect(cap.calls.length).toBe(2)
  expect(cap.calls[1]!.prompt).toContain("## Repair")
  expect(stagedFiles()).toEqual([])
})

// ── daemon failure paths ─────────────────────────────────────────────────

test("ensure returns false (daemon unreachable, spawn failed): exit 1, call never made", async () => {
  const args = workerArgs("promote", promotePaths())
  const { deps, cap } = fakeDeps([okOutcome(JSON.stringify(PROMOTE_REPLY))], {
    ensure: (async () => false) as WorkerDeps["ensure"],
  })

  const code = await runWorkerCycle(args, {}, deps)

  expect(code).toBe(1)
  expect(cap.calls.length).toBe(0)
  expect(stagedFiles()).toEqual([])
})

test("no-call outcome: exit 1, no retry, nothing staged", async () => {
  const args = workerArgs("promote", promotePaths())
  const { deps, cap } = fakeDeps([{ kind: "no-call" }])
  const code = await runWorkerCycle(args, {}, deps)
  expect(code).toBe(1)
  expect(cap.calls.length).toBe(1)
  expect(stagedFiles()).toEqual([])
})

test("call-consumed outcome: exit 1, no retry (double-spend guard), nothing staged", async () => {
  const args = workerArgs("promote", promotePaths())
  const { deps, cap } = fakeDeps([{ kind: "call-consumed", sessionId: "sess-x" }])
  const code = await runWorkerCycle(args, {}, deps)
  expect(code).toBe(1)
  expect(cap.calls.length).toBe(1)
  expect(stagedFiles()).toEqual([])
  // a session served on the failed path is still closed
  expect(cap.closed).toEqual(["sess-x"])
})

test("model-proof failure: exit 1, session STILL closed, nothing staged", async () => {
  const args = workerArgs("promote", promotePaths())
  const { deps, cap } = fakeDeps([
    okOutcome(JSON.stringify(PROMOTE_REPLY), { model: "claude-haiku-4-5", canonicalModel: "claude-haiku-4-5" }),
  ])
  const code = await runWorkerCycle(args, {}, deps)
  expect(code).toBe(1)
  expect(cap.closed).toEqual(["sess-1"])
  expect(stagedFiles()).toEqual([])
})

test("max_tokens truncation: exit 1, no retry (a retry would truncate identically), nothing staged", async () => {
  const args = workerArgs("promote", promotePaths())
  const { deps, cap } = fakeDeps([okOutcome("cut off mid…", { stopReason: "max_tokens" })])
  const code = await runWorkerCycle(args, {}, deps)
  expect(code).toBe(1)
  expect(cap.calls.length).toBe(1)
  expect(stagedFiles()).toEqual([])
})

test("call throws: exit 1 (never throws), session list empty -> close not called, nothing staged", async () => {
  const args = workerArgs("promote", promotePaths())
  const { deps, cap } = fakeDeps([okOutcome("unused")], {
    call: (async () => { throw new Error("wire EPIPE") }) as WorkerDeps["call"],
  })
  const code = await runWorkerCycle(args, {}, deps)
  expect(code).toBe(1)
  expect(cap.closed).toEqual([])
  expect(stagedFiles()).toEqual([])
})

// ── deadline discipline ──────────────────────────────────────────────────

test("spawnedAt far past (deadline blown): exit 1 WITHOUT touching the daemon or disk", async () => {
  const args = workerArgs("promote", promotePaths(), {
    spawnedAt: Date.now() - 700_000, // deadline = spawnedAt + 600_000 - margin, long gone
  })
  const { deps, cap } = fakeDeps([okOutcome(JSON.stringify(PROMOTE_REPLY))])

  const code = await runWorkerCycle(args, {}, deps)

  expect(code).toBe(1)
  expect(cap.ensures.length).toBe(0)
  expect(cap.calls.length).toBe(0)
  expect(stagedFiles()).toEqual([])
})

test("attempt-1 budget is bounded by timeoutMs/2 and the remaining deadline", async () => {
  const args = workerArgs("promote", promotePaths())
  const { deps, cap } = fakeDeps([okOutcome(JSON.stringify(PROMOTE_REPLY))])

  await runWorkerCycle(args, {}, deps)

  const budget = cap.calls[0]!.opts.budgetMs!
  expect(budget).toBeGreaterThan(0)
  expect(budget).toBeLessThanOrEqual(args.timeoutMs / 2)
  expect(budget).toBeLessThanOrEqual(args.timeoutMs - WORKER_DEADLINE_MARGIN_MS)
})

test("ensure wait is clamped to the remaining deadline (never a blind 30s past it)", async () => {
  const args = workerArgs("promote", promotePaths(), {
    // ~40s of usable budget: remaining = 640_000 - 600_000 - 30_000 ≈ 10s
    timeoutMs: 640_000,
    spawnedAt: Date.now() - 600_000,
  })
  const { deps, cap } = fakeDeps([okOutcome(JSON.stringify(PROMOTE_REPLY))])

  const code = await runWorkerCycle(args, {}, deps)

  expect(code).toBe(0)
  expect(cap.ensures.length).toBe(1)
  expect(cap.ensures[0]!.waitMs!).toBeLessThanOrEqual(30_000)
  expect(cap.ensures[0]!.waitMs!).toBeLessThanOrEqual(11_000) // ≈ remaining, not the 30s ceiling
})

test("close failure never changes the cycle outcome", async () => {
  const args = workerArgs("promote", promotePaths())
  const { deps } = fakeDeps([okOutcome(JSON.stringify(PROMOTE_REPLY))], {
    close: (async () => { throw new Error("socket gone") }) as WorkerDeps["close"],
  })
  const code = await runWorkerCycle(args, {}, deps)
  expect(code).toBe(0)
})
