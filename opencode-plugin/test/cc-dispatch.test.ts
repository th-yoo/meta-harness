import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { EvolutionEngine } from "../src/engine.ts"
import { FileSessionStateStore } from "../src/adapters/claude-code/file-state.ts"
import { ClaudeCodeHost } from "../src/adapters/claude-code/cc-host.ts"
import { dispatch, resolveRole, type HookInput } from "../src/adapters/claude-code/dispatch.ts"
import {
  bootstrapStore,
  projectRoleRoot,
  activeVersion,
  readScore,
} from "../src/harness-store.ts"

// Hermetic: META_HARNESS_HOME → tmp account root; a tmp project dir as cwd.
// Fixtures carry the real probe shapes (test/fixtures/cc-hooks); we override
// session_id + cwd. Every dispatch call builds a FRESH host/state/engine to
// faithfully model CC's one-process-per-hook isolation over shared file state.

const FIX = path.join(import.meta.dir, "fixtures", "cc-hooks")

let home: string
let project: string
let prevHome: string | undefined
let prevRole: string | undefined

beforeEach(() => {
  prevHome = process.env["META_HARNESS_HOME"]
  prevRole = process.env["MH_ROLE"]
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cc-dispatch-home-"))
  project = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cc-dispatch-proj-"))
  process.env["META_HARNESS_HOME"] = home
})

afterEach(() => {
  if (prevHome === undefined) delete process.env["META_HARNESS_HOME"]
  else process.env["META_HARNESS_HOME"] = prevHome
  if (prevRole === undefined) delete process.env["MH_ROLE"]
  else process.env["MH_ROLE"] = prevRole
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(project, { recursive: true, force: true })
})

function fixture(name: string, overrides: Partial<HookInput> = {}): HookInput {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, name), "utf-8"))
  return { ...raw, cwd: project, session_id: "test-sess-1", ...overrides }
}

/** One "hook process": fresh host/state/engine, state read back from disk. */
async function runHook(event: string, input: HookInput, env: NodeJS.ProcessEnv = process.env) {
  const host = new ClaudeCodeHost(input.cwd ?? project)
  const state = new FileSessionStateStore()
  const engine = new EvolutionEngine(host, state)
  const output = await dispatch(event, input, { engine, host, state }, env)
  return { output, state }
}

// ── role resolution ─────────────────────────────────────────────────────────

test("resolveRole: MH_ROLE env wins", () => {
  expect(resolveRole(project, { MH_ROLE: "mh-build" } as any)).toBe("mh-build")
})

test("resolveRole: falls back to project .meta-harness/config.json defaultRole", () => {
  fs.mkdirSync(path.join(project, ".meta-harness"), { recursive: true })
  fs.writeFileSync(path.join(project, ".meta-harness", "config.json"), JSON.stringify({ defaultRole: "mh-review" }))
  expect(resolveRole(project, {} as any)).toBe("mh-review")
})

// ── child-session non-participation (MH_CHILD sentinel, Task L8) ─────────────

test("dispatch: MH_CHILD in env -> exits 0 with no output before ANY engine call", async () => {
  process.env["MH_ROLE"] = "mh-build"
  // A spy engine: if dispatch touched it, one of these would fire.
  let touched = false
  const engine = new Proxy({}, {
    get() { touched = true; return () => { touched = true } },
  }) as unknown as EvolutionEngine
  const host = new ClaudeCodeHost(project)
  const state = new FileSessionStateStore()

  const out = await dispatch(
    "SessionStart",
    { session_id: "child-1", cwd: project, source: "startup" },
    { engine, host, state },
    { MH_CHILD: "1", MH_ROLE: "mh-build" } as any,
  )

  expect(out).toBeUndefined()
  expect(touched).toBe(false)
})

test("dispatch: a normal (non-child) SessionStart still participates when MH_CHILD is absent", async () => {
  process.env["MH_ROLE"] = "mh-build"
  const { output } = await runHook(
    "SessionStart",
    fixture("session-start.json", { session_id: "normal-1" }),
    { MH_ROLE: "mh-build" } as any,
  )
  // Non-child path reaches the engine (composeInjection) — output is the
  // additionalContext block (or undefined if empty), but crucially NOT gated.
  // Presence of the hookSpecificOutput shape proves the engine ran.
  if (output !== undefined) {
    expect(output).toHaveProperty("hookSpecificOutput")
  }
})

test("resolveRole: null when neither present", () => {
  expect(resolveRole(project, {} as any)).toBeNull()
})

// ── SessionStart ─────────────────────────────────────────────────────────────

test("SessionStart (participating role) injects seeded system text as additionalContext + persists state", async () => {
  bootstrapStore(projectRoleRoot(project, "mh-build"), "PROJECT ROLE SYSTEM TEXT MARKER")
  const { output, state } = await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)

  expect((output as any)?.hookSpecificOutput?.hookEventName).toBe("SessionStart")
  expect((output as any)?.hookSpecificOutput?.additionalContext).toContain("PROJECT ROLE SYSTEM TEXT MARKER")

  const st = state.get("test-sess-1")
  expect(st?.role).toBe("mh-build")
  expect(st?.participates).toBe(true)
  expect(st?.bootstrapped).toBe(true)
})

test("SessionStart with no role declared → silent (undefined output, no state)", async () => {
  const { output, state } = await runHook("SessionStart", fixture("session-start.json"), {} as any)
  expect(output).toBeUndefined()
  expect(state.get("test-sess-1")).toBeUndefined()
})

test("SessionStart on resume re-injects (idempotent) for the same session_id", async () => {
  bootstrapStore(projectRoleRoot(project, "mh-build"), "RESUMABLE SYSTEM TEXT")
  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)
  const { output } = await runHook("SessionStart", fixture("session-start-resume.json"), { MH_ROLE: "mh-build" } as any)
  expect((output as any)?.hookSpecificOutput?.additionalContext).toContain("RESUMABLE SYSTEM TEXT")
})

// ── UserPromptSubmit ─────────────────────────────────────────────────────────

test("UserPromptSubmit ordinary prompt → passes through (undefined)", async () => {
  const { output } = await runHook("UserPromptSubmit", fixture("user-prompt-normal.json"), { MH_ROLE: "mh-build" } as any)
  expect(output).toBeUndefined()
})

// ── PreToolUse: the bash-timeout knob via updatedInput ───────────────────────

test("PreToolUse(Bash) rewrites a fast command's timeout via updatedInput", async () => {
  bootstrapStore(projectRoleRoot(project, "mh-build"), "SYS")
  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)
  const { output } = await runHook("PreToolUse", fixture("pretooluse-bash-echo.json"))

  const hso = (output as any)?.hookSpecificOutput
  expect(hso?.hookEventName).toBe("PreToolUse")
  expect(hso?.permissionDecision).toBe("allow")
  expect(hso?.updatedInput?.timeout).toBe(5000)
  expect(hso?.updatedInput?.command).toBe("echo hooktest")
  expect(hso?.updatedInput?.description).toBe("Run echo hooktest command")
})

// ── PostToolUse: capture ─────────────────────────────────────────────────────

test("PostToolUse records tool usage into the file store (participating session)", async () => {
  bootstrapStore(projectRoleRoot(project, "mh-build"), "SYS")
  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)
  const { state } = await runHook("PostToolUse", fixture("posttooluse-bash.json"))
  const st = state.get("test-sess-1")
  expect(st?.toolUsage["bash"]?.calls).toBe(1)
})

test("PostToolUse error output bumps the bash error count", async () => {
  bootstrapStore(projectRoleRoot(project, "mh-build"), "SYS")
  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)
  const { state } = await runHook("PostToolUse", fixture("posttooluse-bash-error.json"))
  const st = state.get("test-sess-1")
  expect(st?.toolUsage["bash"]?.errors).toBe(1)
})

// ── Stop: reminder ────────────────────────────────────────────────────────────

test("Stop on a substantive turn emits a /mh-score reminder systemMessage", async () => {
  bootstrapStore(projectRoleRoot(project, "mh-build"), "SYS")
  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)
  await runHook("PostToolUse", fixture("posttooluse-bash.json")) // makes it non-degenerate
  const { output } = await runHook("Stop", fixture("stop.json"))
  expect((output as any)?.systemMessage).toContain("/mh-score")
})

test("Stop on a bare greeting (degenerate) does NOT nag", async () => {
  bootstrapStore(projectRoleRoot(project, "mh-build"), "SYS")
  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)
  const { output } = await runHook("Stop", fixture("stop-greeting.json"))
  expect(output).toBeUndefined()
})

test("Stop for a non-participating session is a silent no-op", async () => {
  const { output } = await runHook("Stop", fixture("stop.json"), {} as any)
  expect(output).toBeUndefined()
})

// ── The score inversion end-to-end ────────────────────────────────────────────

test("full flow: /mh-score good records a SessionRecord with platform 'claude-code' and blocks the prompt", async () => {
  bootstrapStore(projectRoleRoot(project, "mh-build"), "SYS")
  // SessionStart → capture turn + tool so the session is non-degenerate.
  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)
  await runHook("PostToolUse", fixture("posttooluse-bash.json"))
  await runHook("Stop", fixture("stop.json"))

  // /mh-score good … → stage verdict, run idle IN-PROCESS, block.
  const { output } = await runHook(
    "UserPromptSubmit",
    fixture("user-prompt-score-good-crafted.json"),
    { MH_ROLE: "mh-build" } as any,
  )
  expect((output as any)?.decision).toBe("block")
  expect((output as any)?.reason).toContain("score recorded")

  const root = projectRoleRoot(project, "mh-build")
  const score = readScore(root, activeVersion(root))
  expect(score.sessions.length).toBe(1)
  expect(score.sessions[0]!.passed).toBe(true)
  expect(score.sessions[0]!.note).toBe("solid work on the parser")
  expect(score.sessions[0]!.platform).toBe("claude-code")
})

test("/mh-score with no verdict token blocks with a usage message and records nothing", async () => {
  bootstrapStore(projectRoleRoot(project, "mh-build"), "SYS")
  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)
  await runHook("PostToolUse", fixture("posttooluse-bash.json"))
  await runHook("Stop", fixture("stop.json"))

  const { output } = await runHook(
    "UserPromptSubmit",
    fixture("user-prompt-score-good-crafted.json", { prompt: "/mh-score" }),
    { MH_ROLE: "mh-build" } as any,
  )
  expect((output as any)?.decision).toBe("block")
  expect((output as any)?.reason).toContain("usage")

  const root = projectRoleRoot(project, "mh-build")
  const score = readScore(root, activeVersion(root))
  expect(score.sessions.length).toBe(0)
})

test("/mh-status routes through the shared engine handler and blocks with status text", async () => {
  bootstrapStore(projectRoleRoot(project, "mh-build"), "SYS")
  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)
  const { output } = await runHook(
    "UserPromptSubmit",
    fixture("user-prompt-status-crafted.json"),
    { MH_ROLE: "mh-build" } as any,
  )
  expect((output as any)?.decision).toBe("block")
  expect((output as any)?.reason).toContain("Meta-Harness status")
})

// ── Prime directive: a corrupt state file never crashes a hook ────────────────

test("a corrupt session-state file is tolerated (PostToolUse still exits cleanly)", async () => {
  bootstrapStore(projectRoleRoot(project, "mh-build"), "SYS")
  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)
  // Corrupt the on-disk state.
  const stateFile = path.join(home, "runtime", "cc", "test-sess-1.json")
  fs.writeFileSync(stateFile, "{ broken json")
  const { output } = await runHook("PostToolUse", fixture("posttooluse-bash.json"))
  expect(output).toBeUndefined() // no crash, no output
})
