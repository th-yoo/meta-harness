import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdRoleRun, extractFinalPayload } from "../src/fleet/run.ts"
import { listPending, readPending } from "../src/fleet/pending.ts"
import { renderRole } from "../src/fleet/render.ts"
import { accountRoleRoot, createCandidate, writeActive } from "../src/harness-store.ts"
import { roleSpec } from "../src/fleet/roles.ts"
import { seedRenderedRole } from "./fleet-helpers.ts"

/** Renders an ADDITIONAL role's persona onto a project already seeded by
 * `seedRenderedRole` (which one-shot-writes the squad def) — skips the
 * squad-def write `seedRenderedRole` would otherwise repeat (that dies:
 * "squad def 'standard' already has an active version"). */
function seedExtraRenderedRole(project: string, role: string, body: string) {
  const agent = roleSpec(role).agent
  const root = accountRoleRoot(agent)
  createCandidate(root, "v1", body)
  writeActive(root, "v1", body, null, null, null, null)
  return renderRole(project, role)
}

const FIXTURES = join(import.meta.dir, "fixtures", "fleet")
const multiTurn = readFileSync(join(FIXTURES, "trace-multi-turn.ndjson"), "utf-8")
const singleTurn = readFileSync(join(FIXTURES, "trace-single-turn.ndjson"), "utf-8")

let home: string, project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-run-"))
  project = mkdtempSync(join(tmpdir(), "mh-run-proj-"))
  process.env.META_HARNESS_HOME = home
  // Seed: squad def + analyzer layer + render, so role-run's "rendered md exists" check passes.
  seedRenderedRole(project)
})
afterEach(() => {
  delete process.env.META_HARNESS_HOME
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe("role-run", () => {
  test("happy path: spawns argv, extracts real sessionID, writes pending, returns payload", async () => {
    let seenArgv: string[] = []
    const execFn = async (argv: string[]) => { seenArgv = argv; return { stdout: multiTurn, rc: 0 } }
    const res = await cmdRoleRun({ project, role: "analyzer", input: "add slugify()" }, execFn)
    expect(seenArgv.slice(0, 2)).toEqual(["opencode", "run"])
    expect(seenArgv).toContain("--agent"); expect(seenArgv).toContain("mh-analyzer")
    expect(res.id).toMatch(/^ses_/)                        // real sessionID from fixture
    expect(res.payload).toContain("## Use Cases")          // final-segment payload, fixture-defined
    const pending = readPending(project, res.id)
    expect(pending.renderStamp).toBeTruthy()
    expect(pending.turnCount).toBeGreaterThan(0)
  })

  test("0-turn output dies and writes nothing", async () => {
    const execFn = async () => ({ stdout: "", rc: 0 })
    await expect(cmdRoleRun({ project, role: "analyzer", input: "x" }, execFn)).rejects.toThrow(/0 turns|no events/)
    expect(listPending(project)).toEqual([])
  })

  test("missing rendered md dies with 'roles-render first'", async () => {
    const bare = mkdtempSync(join(tmpdir(), "mh-bare-"))
    await expect(cmdRoleRun({ project: bare, role: "analyzer", input: "x" }, async () => ({ stdout: multiTurn, rc: 0 })))
      .rejects.toThrow(/roles-render/)
    rmSync(bare, { recursive: true, force: true })
  })

  test("extractFinalPayload returns only the last step_finish segment", () => {
    const events = multiTurn.trim().split("\n").map((l) => JSON.parse(l))
    const payload = extractFinalPayload(events)
    expect(payload).toContain("## Use Cases")
    expect(payload).not.toContain("intermediate exploration") // earlier-turn text, fixture-defined
  })

  test("single-turn trace: payload is the sole pre-step_finish segment, sessionID still extracted", async () => {
    const execFn = async () => ({ stdout: singleTurn, rc: 0 })
    const res = await cmdRoleRun({ project, role: "analyzer", input: "greet" }, execFn)
    expect(res.id).toBe("ses_single0001")
    expect(res.payload).toContain("## Use Cases")
    expect(res.payload).toContain("## Functional Spec")
    expect(res.turnCount).toBe(1)
  })

  test("silent:true suppresses all console.log/console.error output", async () => {
    const execFn = async () => ({ stdout: multiTurn, rc: 0 })
    const logs: unknown[] = []
    const errs: unknown[] = []
    const origLog = console.log
    const origErr = console.error
    console.log = (...a: unknown[]) => { logs.push(a) }
    console.error = (...a: unknown[]) => { errs.push(a) }
    try {
      await cmdRoleRun({ project, role: "analyzer", input: "x", silent: true }, execFn)
    } finally {
      console.log = origLog
      console.error = origErr
    }
    expect(logs).toEqual([])
    expect(errs).toEqual([])
  })

  test("--json path emits an {id,payload,turnCount,toolUsage} envelope to stdout", async () => {
    const execFn = async () => ({ stdout: multiTurn, rc: 0 })
    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)
    try {
      await cmdRoleRun({ project, role: "analyzer", input: "x", json: true }, execFn)
    } finally {
      console.log = origLog
    }
    expect(logs).toHaveLength(1)
    const envelope = JSON.parse(logs[0]!)
    expect(envelope.id).toMatch(/^ses_/)
    expect(envelope.payload).toContain("## Use Cases")
    expect(envelope.turnCount).toBeGreaterThan(0)
    expect(envelope.toolUsage).toBeTruthy()
  })

  test("credential isolation: a bash:allow role (implementer) drive passes the remote-write deny-list as env", async () => {
    seedExtraRenderedRole(project, "implementer", "You are the implementer.\n## Implementation Report\ndone")
    let seenOpts: { timeoutSec: number; env?: Record<string, string> } | undefined
    const execFn = async (_argv: string[], opts: { timeoutSec: number; env?: Record<string, string> }) => {
      seenOpts = opts
      return { stdout: multiTurn, rc: 0 }
    }
    await cmdRoleRun({ project, role: "implementer", input: "do it" }, execFn)
    expect(seenOpts?.env).toEqual({
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      GIT_SSH_COMMAND: "/bin/false",
      SSH_AUTH_SOCK: "",
    })
  })

  test("credential isolation: a bash:deny role (analyzer) drive passes no env override — unaffected by the scrub", async () => {
    let seenOpts: { timeoutSec: number; env?: Record<string, string> } | undefined
    const execFn = async (_argv: string[], opts: { timeoutSec: number; env?: Record<string, string> }) => {
      seenOpts = opts
      return { stdout: multiTurn, rc: 0 }
    }
    await cmdRoleRun({ project, role: "analyzer", input: "x" }, execFn)
    expect(seenOpts?.env).toBeUndefined()
  })
})
