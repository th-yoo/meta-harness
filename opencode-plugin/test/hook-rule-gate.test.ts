/**
 * hook-rule-gate.test.ts — TDD for src/bench/hook-rule-gate.ts (hook-rule P1
 * plan, Task 7) plus the cmd-run.ts copy-in/readback wiring (Task 8). Written
 * FIRST, failing (src/bench/hook-rule-gate.ts did not exist yet).
 *
 * `buildHookRuleEvalScript`'s output is REAL bash, spawned locally via
 * `Bun.spawnSync(["/bin/bash", scriptPath])` (3.2 on macOS hosts — the
 * bash-compat floor) against a temp `HOOK_RULE_GATE_DIR` — no fakes, no
 * mocked exec, mirroring rule-gate.test.ts's spawn pattern.
 *
 * Wiring tests live HERE (not bench-cmd-run.test.ts) — lane file-set
 * discipline: the P1 plan assigns this peer only hook-rule-gate/rule-gate/
 * cmd-run sources plus this new test file and rule-gate.test.ts.
 */
import { test, expect, spyOn, mock } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { BenchPaths } from "../src/bench/paths.ts"
import { runTaskOnce, type RunTaskResult } from "../src/bench/cmd-run.ts"
import type { AgentAuthMounts } from "../src/bench/agent-auth.ts"
import { claudeCodeDriver } from "../src/bench/drivers/claude-code.ts"
import * as verifierReal from "../src/bench/verifier.ts"
import {
  HOOK_RULE_GATE_DIR,
  buildHookRuleEvalScript,
  readHookRuleOutcomesArgs,
  type HookRuleSpec,
} from "../src/bench/hook-rule-gate.ts"

// ── evaluator-script harness (rule-gate.test.ts:25-54 pattern) ───────────

function writeEval(rules: HookRuleSpec[], killSwitch = false): { scriptPath: string; hrDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-rule-gate-test-"))
  const scriptPath = path.join(dir, "eval.sh")
  fs.writeFileSync(scriptPath, buildHookRuleEvalScript(rules, killSwitch))
  return { scriptPath, hrDir: path.join(dir, "hr") }
}

function run(scriptPath: string, hrDir: string, stdin: string): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["/bin/bash", scriptPath], {
    env: { ...process.env, HOOK_RULE_GATE_DIR: hrDir },
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  })
  return { exitCode: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

function outcomesLines(hrDir: string): string[] {
  const p = path.join(hrDir, "outcomes.log")
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
}

const bashInput = (cmd: string): string =>
  JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: cmd } })

const SHADOW: HookRuleSpec = {
  id: "b1",
  toolMatcher: "Bash",
  inputPattern: "^npm +(install|add)( |$)",
  feedback: "This repo uses bun.",
  mode: "shadow",
}
const DENY: HookRuleSpec = {
  id: "b2",
  toolMatcher: "Bash",
  inputPattern: "^docker ",
  feedback: "Use podman, don't use docker.",
  mode: "deny",
}
const WARN: HookRuleSpec = {
  id: "b3",
  toolMatcher: "Bash",
  inputPattern: "^git +push +.*--force",
  feedback: "No force pushes on this repo.",
  mode: "warn",
}
const EDIT_RULE: HookRuleSpec = {
  id: "b4",
  toolMatcher: "Edit",
  inputPattern: "^/etc/",
  feedback: "Do not edit /etc files.",
  mode: "shadow",
}

// ── constants ────────────────────────────────────────────────────────────

test("HOOK_RULE_GATE_DIR / readHookRuleOutcomesArgs are the pinned values", () => {
  expect(HOOK_RULE_GATE_DIR).toBe("/app/.hookrule-gate")
  expect(readHookRuleOutcomesArgs()).toEqual(["cat", "/app/.hookrule-gate/outcomes.log"])
})

// ── shadow: outcome logged, zero output (inert) ──────────────────────────

test("shadow match: exit 0, NO stdout, outcomes.log gets `id mode epoch` line", () => {
  const { scriptPath, hrDir } = writeEval([SHADOW])
  const r = run(scriptPath, hrDir, bashInput("npm install left-pad"))
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toBe("")
  const lines = outcomesLines(hrDir)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatch(/^b1 shadow \d+$/)
})

// ── deny: P0 deny-hook JSON shape ────────────────────────────────────────

test("deny match: stdout is the PreToolUse deny JSON with the rule's feedback, exit 0", () => {
  const { scriptPath, hrDir } = writeEval([DENY])
  const r = run(scriptPath, hrDir, bashInput("docker run -it ubuntu"))
  expect(r.exitCode).toBe(0)
  const parsed = JSON.parse(r.stdout) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string }
  }
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse")
  expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny")
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe("Use podman, don't use docker.")
  expect(outcomesLines(hrDir)[0]).toMatch(/^b2 deny \d+$/)
})

test("deny under killSwitch: demoted to the additionalContext (warn) JSON instead", () => {
  const { scriptPath, hrDir } = writeEval([DENY], true)
  const r = run(scriptPath, hrDir, bashInput("docker ps"))
  expect(r.exitCode).toBe(0)
  const parsed = JSON.parse(r.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext?: string; permissionDecision?: string }
  }
  expect(parsed.hookSpecificOutput.additionalContext).toBe("Use podman, don't use docker.")
  expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined()
})

// ── warn: additionalContext JSON ─────────────────────────────────────────

test("warn match: stdout is the additionalContext JSON, exit 0", () => {
  const { scriptPath, hrDir } = writeEval([WARN])
  const r = run(scriptPath, hrDir, bashInput("git push origin main --force"))
  expect(r.exitCode).toBe(0)
  const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse")
  expect(parsed.hookSpecificOutput.additionalContext).toBe("No force pushes on this repo.")
})

// ── severest-mode-wins, every match logged ───────────────────────────────

test("deny+warn+shadow all matching: deny wins the single output; ALL matches logged", () => {
  const all: HookRuleSpec[] = [
    { ...SHADOW, inputPattern: "^docker " },
    { ...WARN, inputPattern: "^docker " },
    { ...DENY },
  ]
  const { scriptPath, hrDir } = writeEval(all)
  const r = run(scriptPath, hrDir, bashInput("docker build ."))
  expect(r.exitCode).toBe(0)
  const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string } }
  expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny")
  const lines = outcomesLines(hrDir)
  expect(lines).toHaveLength(3)
  expect(lines.map((l) => l.split(" ")[0])).toEqual(["b1", "b3", "b2"])
})

// ── no match / malformed stdin: silent fail-open ─────────────────────────

test("no rule matches: silent exit 0, no outcomes.log", () => {
  const { scriptPath, hrDir } = writeEval([SHADOW, DENY])
  const r = run(scriptPath, hrDir, bashInput("bun add left-pad"))
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toBe("")
  expect(outcomesLines(hrDir)).toHaveLength(0)
})

test("malformed stdin (not JSON): silent exit 0 — fail-open", () => {
  const { scriptPath, hrDir } = writeEval([SHADOW, DENY])
  const r = run(scriptPath, hrDir, "this is {{{ not json")
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toBe("")
  expect(r.stderr).toBe("")
})

test("empty rules array: silent exit 0 on any input (bash 3.2 zero-length array safety)", () => {
  const { scriptPath, hrDir } = writeEval([])
  const r = run(scriptPath, hrDir, bashInput("docker run x"))
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toBe("")
})

// ── toolMatcher filter + canonical fields ────────────────────────────────

test("toolMatcher filter: an Edit rule ignores a Bash call whose command would match the pattern", () => {
  const { scriptPath, hrDir } = writeEval([EDIT_RULE])
  const r = run(scriptPath, hrDir, bashInput("/etc/init.d/foo restart"))
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toBe("")
  expect(outcomesLines(hrDir)).toHaveLength(0)
})

test("Edit call matches an Edit rule on file_path", () => {
  const { scriptPath, hrDir } = writeEval([EDIT_RULE])
  const stdin = JSON.stringify({
    session_id: "s1",
    tool_name: "Edit",
    tool_input: { file_path: "/etc/hosts", old_string: "a", new_string: "b" },
  })
  const r = run(scriptPath, hrDir, stdin)
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toBe("")
  expect(outcomesLines(hrDir)[0]).toMatch(/^b4 shadow \d+$/)
})

test("Grep call matches on the JSON-serialized tool input", () => {
  const grepRule: HookRuleSpec = {
    id: "b5",
    toolMatcher: "Grep",
    inputPattern: '^\\{"pattern":"secret"',
    feedback: "no grepping for secrets",
    mode: "shadow",
  }
  const { scriptPath, hrDir } = writeEval([grepRule])
  const stdin = JSON.stringify({ session_id: "s1", tool_name: "Grep", tool_input: { pattern: "secret" } })
  const r = run(scriptPath, hrDir, stdin)
  expect(r.exitCode).toBe(0)
  expect(outcomesLines(hrDir)[0]).toMatch(/^b5 shadow \d+$/)
})

// ── adversarial extraction (P4-prep: the two documented sed holes) ───────
// (a) escaped quotes / backslashes in the value must decode, not truncate;
// (b) key binding must be FIRST occurrence at the right nesting level —
//     a later nested object carrying the same key name must not shadow it.

test("hole (a): command containing escaped quotes decodes fully — deny rule on the full text fires", () => {
  const quoted: HookRuleSpec = {
    id: "b10",
    toolMatcher: "Bash",
    inputPattern: '^echo "hi" && docker ',
    feedback: "no docker after echo",
    mode: "deny",
  }
  const { scriptPath, hrDir } = writeEval([quoted])
  const r = run(scriptPath, hrDir, bashInput('echo "hi" && docker ps'))
  expect(r.exitCode).toBe(0)
  const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string } }
  expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny")
  expect(outcomesLines(hrDir)[0]).toMatch(/^b10 deny \d+$/)
})

test("hole (a): backslash in the value decodes to a single backslash", () => {
  const bs: HookRuleSpec = {
    id: "b11",
    toolMatcher: "Bash",
    inputPattern: "^grep \\\\ file$",
    feedback: "backslash grep",
    mode: "shadow",
  }
  const { scriptPath, hrDir } = writeEval([bs])
  const r = run(scriptPath, hrDir, bashInput("grep \\ file"))
  expect(r.exitCode).toBe(0)
  expect(outcomesLines(hrDir)[0]).toMatch(/^b11 shadow \d+$/)
})

test("hole (a): Edit file_path with spaces and embedded quotes matches its rule", () => {
  const editRule: HookRuleSpec = {
    id: "b12",
    toolMatcher: "Edit",
    inputPattern: '^/tmp/my "quoted" dir/',
    feedback: "quoted dir",
    mode: "shadow",
  }
  const { scriptPath, hrDir } = writeEval([editRule])
  const stdin = JSON.stringify({
    session_id: "s1",
    tool_name: "Edit",
    tool_input: { file_path: '/tmp/my "quoted" dir/file.txt', old_string: "a", new_string: "b" },
  })
  const r = run(scriptPath, hrDir, stdin)
  expect(r.exitCode).toBe(0)
  expect(outcomesLines(hrDir)[0]).toMatch(/^b12 shadow \d+$/)
})

test("hole (b): a later nested object with a `command` key does not shadow the real one (false negative)", () => {
  const { scriptPath, hrDir } = writeEval([DENY])
  const stdin = JSON.stringify({
    session_id: "s1",
    tool_name: "Bash",
    tool_input: { command: "docker ps" },
    later_metadata: { command: "bun safe" },
  })
  const r = run(scriptPath, hrDir, stdin)
  expect(r.exitCode).toBe(0)
  const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string } }
  expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny")
})

test("hole (b): a later nested `command` key matching the pattern does not fire when the real command is clean (false positive)", () => {
  const { scriptPath, hrDir } = writeEval([DENY])
  const stdin = JSON.stringify({
    session_id: "s1",
    tool_name: "Bash",
    tool_input: { command: "bun test" },
    later_metadata: { command: "docker ps" },
  })
  const r = run(scriptPath, hrDir, stdin)
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toBe("")
  expect(outcomesLines(hrDir)).toHaveLength(0)
})

test("hole (b): a nested `tool_name` decoy does not shadow the real top-level tool_name", () => {
  const { scriptPath, hrDir } = writeEval([EDIT_RULE])
  const stdin = JSON.stringify({
    session_id: "s1",
    tool_name: "Edit",
    tool_input: { file_path: "/etc/hosts", meta: { tool_name: "Bash" } },
  })
  const r = run(scriptPath, hrDir, stdin)
  expect(r.exitCode).toBe(0)
  expect(outcomesLines(hrDir)[0]).toMatch(/^b4 shadow \d+$/)
})

// ── embedding survives quotes (shQuote + build-time JSON escaping) ───────

test("single quotes in pattern/feedback survive script generation end-to-end", () => {
  const quoted: HookRuleSpec = {
    id: "b6",
    toolMatcher: "Bash",
    inputPattern: "^rm -rf /(bin|etc)( |$)",
    feedback: "Don't do that — it's destructive.",
    mode: "deny",
  }
  const { scriptPath, hrDir } = writeEval([quoted])
  const r = run(scriptPath, hrDir, bashInput("rm -rf /etc "))
  expect(r.exitCode).toBe(0)
  const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe("Don't do that — it's destructive.")
})

// ═════════════════════════════════════════════════════════════════════════
// Task 8 wiring: runTaskOnce copy-in + readback (bench-cmd-run.test.ts's
// fake-exec harness pattern, replicated here for lane file-set discipline).
// ═════════════════════════════════════════════════════════════════════════

// Snapshot the REAL verifier.ts exports before any mock.module (same
// capture-then-restore discipline as bench-cmd-run.test.ts:79-83 — verifier
// hardcodes the real podman funnel, so wiring tests must mock it out for
// their critical section and restore it after).
const realCopyTests = verifierReal.copyTests
const realRunVerifier = verifierReal.runVerifier
function restoreVerifier(): void {
  mock.module("../src/bench/verifier.ts", () => ({ copyTests: realCopyTests, runVerifier: realRunVerifier }))
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-hook-rule-wiring-"))
}

function fakeBenchPaths(dir: string): BenchPaths {
  const termBenchDir = path.join(dir, "tb")
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "do the thing")
  return {
    metaRoot: dir,
    termBenchDir,
    tbRoot,
    resultsDir: path.join(termBenchDir, "results"),
    patchesDir: path.join(termBenchDir, "patches"),
    baselineTasksFile: path.join(termBenchDir, "baseline-tasks.txt"),
    splitsFile: path.join(termBenchDir, "splits.json"),
  }
}

function fakeAuthMounts(): () => AgentAuthMounts {
  return () => ({ mounts: [], cleanup: () => {} })
}

const TABLE = { rules: [{ ...SHADOW }], killSwitch: false }

test("runTaskOnce: hook-rule table with rules injects eval.sh + PreToolUse settings, reads back outcomes.log", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(dir)

  const calls: string[][] = []
  let settingsContent = ""
  const execFn = async (argv: string[]) => {
    if (argv.includes("claude")) {
      // zero-activity rc-0 now classifies transient (limit-exhaustion fix) —
      // fake a minimal DONE attempt: one tool_use + a result event.
      const doneOut = [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok" }),
      ].join("\n")
      return { rc: 0, stdout: doneOut, stderr: "", timedOut: false }
    }
    calls.push(argv)
    if (argv[1] === "cp" && argv[3]?.endsWith(":/app/.claude/settings.json")) {
      settingsContent = fs.readFileSync(argv[2]!, "utf-8")
    }
    if (argv[1] === "exec" && argv.includes("cat") && argv.some((a) => a.includes("outcomes.log"))) {
      return { rc: 0, stdout: "b1 shadow 1770000000\nb1 shadow 1770000009\n", stderr: "", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  mock.module("../src/bench/verifier.ts", () => ({ copyTests: async () => {}, runVerifier: async () => 1 }))
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  let res: RunTaskResult
  try {
    res = await runTaskOnce(
      paths, "t", "anthropic/claude-sonnet-5", "", "", 30, 30, "scripts", claudeCodeDriver, undefined, execFn, fakeAuthMounts(), [], TABLE,
    )
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreVerifier()
  }

  const cpCalls = calls.filter((c) => c[1] === "cp")
  expect(cpCalls.some((c) => c[3]?.endsWith(`:${HOOK_RULE_GATE_DIR}/eval.sh`))).toBe(true)
  expect(cpCalls.some((c) => c[3]?.endsWith(":/app/.claude/settings.json"))).toBe(true)
  expect(settingsContent).toContain('"PreToolUse"')
  expect(settingsContent).toContain(`bash ${HOOK_RULE_GATE_DIR}/eval.sh`)
  const mkdirCalls = calls.filter((c) => c[1] === "exec" && c.includes("mkdir"))
  expect(mkdirCalls.some((c) => c.includes(HOOK_RULE_GATE_DIR))).toBe(true)
  expect(res.hookRuleOutcomes).toEqual([
    { id: "b1", mode: "shadow" },
    { id: "b1", mode: "shadow" },
  ])
  // The faked exec gives the agent phase zero turns ("agent_no_output") —
  // the wiring assertion is only that injection didn't fail the setup.
  expect(res.error).not.toBe("setup_failed")
})

test("runTaskOnce: no hook-rule table (13-arg legacy call) issues NO .hookrule-gate cp and NO outcomes read", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(dir)

  const calls: string[][] = []
  const execFn = async (argv: string[]) => {
    if (argv.includes("claude")) {
      // zero-activity rc-0 now classifies transient (limit-exhaustion fix) —
      // fake a minimal DONE attempt: one tool_use + a result event.
      const doneOut = [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok" }),
      ].join("\n")
      return { rc: 0, stdout: doneOut, stderr: "", timedOut: false }
    }
    calls.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  mock.module("../src/bench/verifier.ts", () => ({ copyTests: async () => {}, runVerifier: async () => 1 }))
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  let res: RunTaskResult
  try {
    res = await runTaskOnce(
      paths, "t", "anthropic/claude-sonnet-5", "", "", 30, 30, "scripts", claudeCodeDriver, undefined, execFn, fakeAuthMounts(), [{ bulletId: "b1", cmd: "true", timeoutMs: 1000 }],
    )
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreVerifier()
  }

  expect(calls.some((c) => c.some((a) => a.includes(".hookrule-gate")))).toBe(false)
  expect(res.hookRuleOutcomes).toBeUndefined()
})

test("runTaskOnce: outcomes read rc!=0 (no matches — the common case) is fail-open, hookRuleOutcomes absent", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(dir)

  const execFn = async (argv: string[]) => {
    if (argv.includes("claude")) {
      // zero-activity rc-0 now classifies transient (limit-exhaustion fix) —
      // fake a minimal DONE attempt: one tool_use + a result event.
      const doneOut = [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok" }),
      ].join("\n")
      return { rc: 0, stdout: doneOut, stderr: "", timedOut: false }
    }
    if (argv[1] === "exec" && argv.includes("cat") && argv.some((a) => a.includes("outcomes.log"))) {
      return { rc: 1, stdout: "", stderr: "No such file or directory", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  mock.module("../src/bench/verifier.ts", () => ({ copyTests: async () => {}, runVerifier: async () => 1 }))
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  let res: RunTaskResult
  try {
    res = await runTaskOnce(
      paths, "t", "anthropic/claude-sonnet-5", "", "", 30, 30, "scripts", claudeCodeDriver, undefined, execFn, fakeAuthMounts(), [], TABLE,
    )
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreVerifier()
  }

  expect(res.hookRuleOutcomes).toBeUndefined()
  expect(res.error).not.toBe("setup_failed")
  expect(res.reward).toBe(1)
})

test("runTaskOnce: eval.sh copy-in failure -> setup_failed (mirrors rule-gate copy-in discipline)", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(dir)

  const execFn = async (argv: string[]) => {
    if (argv[1] === "cp" && argv[3]?.endsWith(`:${HOOK_RULE_GATE_DIR}/eval.sh`)) {
      return { rc: 1, stdout: "", stderr: "cp failed", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  let res: RunTaskResult
  try {
    res = await runTaskOnce(
      paths, "t", "anthropic/claude-sonnet-5", "", "", 30, 30, "scripts", claudeCodeDriver, undefined, execFn, fakeAuthMounts(), [], TABLE,
    )
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }

  expect(res.error).toBe("setup_failed")
})
