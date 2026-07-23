#!/usr/bin/env bun
/**
 * minimal/ — iteration 1 of the kernel in docs/minimal-loop-ood.md.
 *
 * Scope: Sandbox (podman) + Task (dir) + Agent (real model via `claude -p`)
 * + Scorer (verify.sh, injected only after the attempt) + Trial dump (JSON +
 * trajectory ndjson). No Store, no Gate, no Harness versioning yet — those
 * are later iterations.
 *
 * Usage:  bun minimal/run.ts [taskDir] [--model <claude-model>] [--timeout <sec>]
 * Result: minimal/results/<task>-<startedAt>.json (+ .traj.ndjson beside it)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

const HERE = import.meta.dir
const IMAGE = "localhost/mh-bench:latest"
const DEFAULT_MODEL = "claude-opus-4-8"
const DEFAULT_TIMEOUT_SEC = 600

function die(msg: string): never {
  console.error(`minimal/run.ts: ${msg}`)
  process.exit(1)
}

async function podman(args: string[], opts: { stdin?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["podman", ...args], {
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

async function podmanOrDie(args: string[], what: string): Promise<string> {
  const r = await podman(args)
  if (r.code !== 0) die(`${what} failed (exit ${r.code}): ${r.err.trim() || r.out.trim()}`)
  return r.out
}

// --- args ---
const argv = process.argv.slice(2)
let taskDirArg = "tasks/hello-fs"
let model = DEFAULT_MODEL
let timeoutSec = DEFAULT_TIMEOUT_SEC
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!
  if (a === "--model") model = argv[++i] ?? die("--model needs a value")
  else if (a === "--timeout") timeoutSec = Number(argv[++i] ?? die("--timeout needs a value")) || die("--timeout not a number")
  else if (a.startsWith("--")) die(`unknown flag ${a}`)
  else taskDirArg = a
}

// --- Task ---
const taskDir = resolve(HERE, taskDirArg)
const taskId = basename(taskDir)
const instructionPath = join(taskDir, "instruction.md")
const verifierPath = join(taskDir, "verify.sh")
if (!existsSync(instructionPath)) die(`no instruction.md in ${taskDir}`)
if (!existsSync(verifierPath)) die(`no verify.sh in ${taskDir}`)
const instruction = readFileSync(instructionPath, "utf-8").trim()

// --- auth (linux host; same recipe as TB2 agent-auth.ts prepareClaudeCodeAuth) ---
// ~/.claude mounts RW (CC rotates its oauth refresh token + writes settings on
// use); /root/.claude.json is CC's headless first-run onboarding gate — without
// it CC exits before ever reaching the model; IS_SANDBOX=1 is required for CC
// to accept --dangerously-skip-permissions while running as container root.
const home = process.env["HOME"] ?? die("no $HOME")
if (!existsSync(join(home, ".claude", ".credentials.json")))
  die(`~/.claude/.credentials.json not found — run \`claude /login\` on the host first`)
const authTmp = mkdtempSync(join(tmpdir(), "minimal-cc-auth-"))
const onboardingPath = join(authTmp, "claude.json")
writeFileSync(onboardingPath, JSON.stringify({ hasCompletedOnboarding: true }) + "\n")

// --- Sandbox up ---
// Reap leftovers from interrupted runs first (a mid-flight SIGKILL skips the
// finally-block below — observed live: escape during the first run leaked a
// container in "Stopping" state with the agent process still inside).
const stale = (await podman(["ps", "-aq", "--filter", "label=minimal.kernel=1"])).out.trim()
if (stale) await podman(["rm", "-f", ...stale.split("\n")])

const startedAt = new Date().toISOString()
const name = `minimal-${taskId}-${Date.now()}`
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    Bun.spawnSync(["podman", "rm", "-f", name])
    process.exit(130)
  })
await podmanOrDie(
  [
    "run", "-d", "--name", name,
    "--label", "minimal.kernel=1",
    "-v", `${join(home, ".claude")}:/root/.claude:rw`,
    "-v", `${onboardingPath}:/root/.claude.json:ro`,
    "-e", "IS_SANDBOX=1",
    "-w", "/app",
    IMAGE, "sleep", "infinity",
  ],
  "sandbox start",
)
await podmanOrDie(["exec", name, "mkdir", "-p", "/app"], "workdir prep")
const fixturesDir = join(taskDir, "fixtures")
if (existsSync(fixturesDir)) await podmanOrDie(["cp", `${fixturesDir}/.`, `${name}:/app/`], "fixture copy")

const resultsDir = join(HERE, "results")
mkdirSync(resultsDir, { recursive: true })
const stamp = startedAt.replace(/[:.]/g, "-")
const trajFile = join(resultsDir, `${taskId}-${stamp}.traj.ndjson`)
const resultFile = join(resultsDir, `${taskId}-${stamp}.json`)

try {
  // --- Agent attempt (the verifier is NOT in the container yet) ---
  const t0 = Date.now()
  const agent = await podman([
    "exec", name,
    "timeout", String(timeoutSec),
    "claude", "-p", instruction,
    "--output-format", "stream-json", "--verbose",
    "--model", model,
    "--dangerously-skip-permissions",
  ])
  const elapsedSec = Math.round((Date.now() - t0) / 10) / 100
  writeFileSync(trajFile, agent.out)

  let turns = 0
  let resultText = ""
  for (const line of agent.out.split("\n")) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      if (ev.type === "assistant") turns++
      if (ev.type === "result") resultText = (ev.result ?? "").slice(0, 400)
    } catch {
      /* non-JSON noise line */
    }
  }
  const timedOut = agent.code === 124

  // --- Scorer, injected only now ---
  await podmanOrDie(["cp", verifierPath, `${name}:/verify.sh`], "verifier copy")
  const verdict = await podman(["exec", name, "sh", "/verify.sh"])
  const reward = verdict.code === 0 ? 1 : 0

  // --- Trial dump ---
  const trial = {
    task: taskId,
    model,
    image: IMAGE,
    host: hostname(),
    startedAt,
    elapsedSec,
    agentExitCode: agent.code,
    timedOut,
    turns,
    reward,
    resultText,
    trajFile: basename(trajFile),
    agentStderr: agent.err.trim().slice(0, 400),
  }
  writeFileSync(resultFile, JSON.stringify(trial, null, 2) + "\n")
  console.log(JSON.stringify(trial, null, 2))
  console.log(`\nresult:     ${resultFile}\ntrajectory: ${trajFile}\nview:       bun minimal/traj.ts ${trajFile}`)
} finally {
  await podman(["rm", "-f", name])
}
