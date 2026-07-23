#!/usr/bin/env bun
/**
 * minimal/ — iterations 1+2 of the kernel in docs/minimal-loop-ood.md.
 *
 * Iteration 1: Sandbox (podman) + Task (dir) + Agent (real model via
 * `claude -p`) + Scorer (verify.sh, injected only after the attempt) + Trial
 * dump (JSON + trajectory ndjson).
 *
 * Iteration 2: Harness slot (--harness <file> podman-cp'd to /app/CLAUDE.md,
 * Claude Code's auto-loaded project memory — the evolvable context, identity
 * recorded as sha256) + k-repeat (--k N, a FRESH container per attempt) with
 * an aggregated run record. Still no Store/Gate/Proposer — later iterations.
 *
 * Drivers (--driver): "opencode" (default — the TB2 production Agent;
 * `opencode run`, harness file AGENTS.md) or "claude-code" (`claude -p`,
 * harness file CLAUDE.md) — both mirror the TB2 drivers' invocation + auth
 * recipes exactly.
 *
 * Usage:  bun minimal/run.ts [taskDir] [--k N] [--harness <file>]
 *                            [--driver <id>] [--model <id>] [--timeout <sec>]
 * Result: minimal/results/<task>-<startedAt>.json
 *         (+ one <task>-<startedAt>-aN.traj.ndjson per attempt)
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

const HERE = import.meta.dir
const IMAGE = "localhost/mh-bench:latest"
const DEFAULT_TIMEOUT_SEC = 600

// Adaptive-width admission thresholds (--parallel). Host-level /proc reads on
// purpose: per-container cgroup stats are known-poisoned on the WSL2 box
// (shared/non-reset cgroup under rootless podman — see the load-aware
// scheduler notes), host aggregates are not.
const LOAD_HI = 0.85 // hold new launches while cpu busy-fraction >= this
const MEM_FLOOR_MB = 1024 // ... or MemAvailable below this
const HOLD_POLL_MS = 3000

/** Per-driver mechanics, mirroring the TB2 drivers (drivers/claude-code.ts,
 * drivers/opencode.ts + agent-auth.ts). harnessFile = the workspace file the
 * agent auto-loads as project memory; defaultModel = that driver's model-id
 * dialect (opencode wants the provider-prefixed canonical form). */
const DRIVERS = {
  "claude-code": {
    harnessFile: "CLAUDE.md",
    defaultModel: "claude-opus-4-8",
    argv: (model: string, instruction: string) => [
      "claude", "-p", instruction,
      "--output-format", "stream-json", "--verbose",
      "--model", model,
      "--dangerously-skip-permissions",
    ],
    parse: (out: string) => {
      let turns = 0
      let resultText = ""
      for (const ev of ndjson(out)) {
        if (ev.type === "assistant") turns++
        if (ev.type === "result") resultText = String(ev.result ?? "").slice(0, 400)
      }
      return { turns, resultText }
    },
  },
  opencode: {
    harnessFile: "AGENTS.md",
    defaultModel: "anthropic/claude-opus-4-8",
    argv: (model: string, instruction: string) => [
      "opencode", "run", "--dir", "/app", "--auto", "--format", "json", "--model", model, instruction,
    ],
    parse: (out: string) => {
      // turn = step_finish with reason "stop"; resultText = last text event
      // (same accounting as TB2's opencode parseOutput/normalizeEvents).
      let turns = 0
      let resultText = ""
      for (const ev of ndjson(out)) {
        if (ev.type === "step_finish" && (ev.reason === "stop" || ev.part?.reason === "stop")) turns++
        if (ev.type === "text") {
          const txt = String(ev.text ?? ev.part?.text ?? "")
          if (txt.trim()) resultText = txt.slice(0, 400)
        }
      }
      return { turns, resultText }
    },
  },
} as const
type DriverId = keyof typeof DRIVERS

function* ndjson(text: string): Generator<any> {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line.startsWith("{")) continue
    try {
      yield JSON.parse(line)
    } catch {
      /* non-JSON noise line */
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Instant whole-host cpu busy fraction: /proc/stat "cpu" line sampled twice. */
async function cpuBusyFrac(sampleMs = 500): Promise<number> {
  const read = () => {
    const f = readFileSync("/proc/stat", "utf-8").split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number)
    const total = f.reduce((a, b) => a + b, 0)
    return { total, idle: (f[3] ?? 0) + (f[4] ?? 0) } // idle + iowait
  }
  const a = read()
  await sleep(sampleMs)
  const b = read()
  const dt = b.total - a.total
  return dt > 0 ? 1 - (b.idle - a.idle) / dt : 0
}

function memAvailableMb(): number {
  const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf-8"))
  return m ? Math.round(Number(m[1]) / 1024) : Infinity
}

function die(msg: string): never {
  console.error(`minimal/run.ts: ${msg}`)
  process.exit(1)
}

async function podman(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["podman", ...args], { stdout: "pipe", stderr: "pipe" })
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

const USAGE = `minimal kernel runner (docs/minimal-loop-ood.md, iterations 1+2)

usage: bun minimal/run.ts [taskDir] [options]

  taskDir            task directory relative to minimal/ (default: tasks/hello-fs)
                     must contain instruction.md plus a scorer: verify.sh
                     (exit code = reward) OR an unmodified upstream
                     terminal-bench tests/ dir (test.sh + reward.txt
                     protocol). Optional fixtures/ is copied to /app before
                     the attempt; tests/ reaches /tests only at scoring time

options:
  --k N              attempts, each in a fresh container (default: 1)
  --parallel M       max attempts in flight (default: 1 = sequential).
                     Effective width ADAPTS to live host load: a new attempt
                     launches only while cpu busy < ${Math.round(LOAD_HI * 100)}% and MemAvailable
                     > ${MEM_FLOOR_MB}MB (host /proc, sampled per admission; one attempt
                     is always allowed to run)
  --harness <file>   context file copied to the driver's project-memory file
                     in /app (CLAUDE.md / AGENTS.md — the evolvable harness;
                     sha256 recorded in the run record)
  --driver <id>      opencode | claude-code (default: opencode, the TB2
                     production Agent)
  --model <id>       model in the driver's dialect (defaults:
                     claude-code=${DRIVERS["claude-code"].defaultModel}, opencode=${DRIVERS.opencode.defaultModel})
  --timeout <sec>    per-attempt agent timeout (default: ${DEFAULT_TIMEOUT_SEC})
  -h, --help         this text

output: minimal/results/<task>-<startedAt>.json (run record with rewards[] +
passRate) and one <task>-<startedAt>-aN.traj.ndjson per attempt.
View a trajectory:  bun minimal/traj.ts <traj.ndjson> [--full]`

// --- args ---
const argv = process.argv.slice(2)
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE)
  process.exit(0)
}
let taskDirArg = "tasks/hello-fs"
let modelArg: string | undefined
let timeoutSec = DEFAULT_TIMEOUT_SEC
let k = 1
let parallelMax = 1
let harnessArg: string | undefined
let driverId: DriverId = "opencode"
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!
  if (a === "--model") modelArg = argv[++i] ?? die("--model needs a value")
  else if (a === "--timeout") timeoutSec = Number(argv[++i] ?? die("--timeout needs a value")) || die("--timeout not a number")
  else if (a === "--k") k = Number(argv[++i] ?? die("--k needs a value")) || die("--k not a number")
  else if (a === "--parallel") parallelMax = Number(argv[++i] ?? die("--parallel needs a value")) || die("--parallel not a number")
  else if (a === "--harness") harnessArg = argv[++i] ?? die("--harness needs a value")
  else if (a === "--driver") {
    const d = argv[++i] ?? die("--driver needs a value")
    if (!(d in DRIVERS)) die(`--driver must be one of: ${Object.keys(DRIVERS).join(", ")}`)
    driverId = d as DriverId
  } else if (a.startsWith("--")) die(`unknown flag ${a}`)
  else taskDirArg = a
}
if (k < 1 || !Number.isInteger(k)) die(`--k must be a positive integer, got ${k}`)
if (parallelMax < 1 || !Number.isInteger(parallelMax)) die(`--parallel must be a positive integer, got ${parallelMax}`)
const driver = DRIVERS[driverId]
const model = modelArg ?? driver.defaultModel

// --- Task ---
const taskDir = resolve(HERE, taskDirArg)
const taskId = basename(taskDir)
const instructionPath = join(taskDir, "instruction.md")
const verifierPath = join(taskDir, "verify.sh")
if (!existsSync(instructionPath)) die(`no instruction.md in ${taskDir}`)
// Two scorer modes: minimal-native verify.sh (exit code = reward), or an
// unmodified upstream terminal-bench tests/ dir whose test.sh writes
// /logs/verifier/reward.txt (the TB2 verifier.ts protocol) — the latter lets
// TB2 tasks import with zero verifier rewrite.
const hasVerifySh = existsSync(verifierPath)
const hasTestSh = existsSync(join(taskDir, "tests", "test.sh"))
if (!hasVerifySh && !hasTestSh) die(`no verify.sh or tests/test.sh in ${taskDir}`)
const instruction = readFileSync(instructionPath, "utf-8").trim()
const fixturesDir = join(taskDir, "fixtures")
const testsDir = join(taskDir, "tests")

// --- Harness (the evolvable context; identity = content hash for provenance) ---
const harnessPath = harnessArg ? resolve(HERE, harnessArg) : undefined
if (harnessPath && !existsSync(harnessPath)) die(`harness file not found: ${harnessPath}`)
const harness = harnessPath
  ? {
      file: harnessArg!,
      sha256: createHash("sha256").update(readFileSync(harnessPath)).digest("hex").slice(0, 16),
    }
  : null

// --- auth (linux host; same recipes as TB2 agent-auth.ts) ---
// claude-code (prepareClaudeCodeAuth): ~/.claude mounts RW (CC rotates its
// oauth refresh token + writes settings on use); /root/.claude.json is CC's
// headless first-run onboarding gate — without it CC exits before ever
// reaching the model; IS_SANDBOX=1 is required for CC to accept
// --dangerously-skip-permissions while running as container root.
// opencode (prepareAgentAuthMounts): a temp config dir with the
// opencode-claude-auth plugin mounts RW at /root/.config/opencode (opencode
// writes a .gitignore + plugin cache there at startup — ro = 0-turn exit),
// ~/.claude RO (the auth plugin only reads the credential), and the real
// ~/.local/share/opencode RW.
const home = process.env["HOME"] ?? die("no $HOME")
if (!existsSync(join(home, ".claude", ".credentials.json")))
  die(`~/.claude/.credentials.json not found — run \`claude /login\` on the host first`)
const authTmp = mkdtempSync(join(tmpdir(), "minimal-auth-"))
const containerArgs: string[] = []
if (driverId === "claude-code") {
  const onboardingPath = join(authTmp, "claude.json")
  writeFileSync(onboardingPath, JSON.stringify({ hasCompletedOnboarding: true }) + "\n")
  containerArgs.push(
    "-v", `${join(home, ".claude")}:/root/.claude:rw`,
    "-v", `${onboardingPath}:/root/.claude.json:ro`,
    "-e", "IS_SANDBOX=1",
  )
} else {
  const configDir = join(authTmp, "config")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["opencode-claude-auth@latest"] }) + "\n",
  )
  containerArgs.push(
    "-v", `${configDir}:/root/.config/opencode:rw`,
    "-v", `${join(home, ".claude")}:/root/.claude:ro`,
    "-v", `${join(home, ".local", "share", "opencode")}:/root/.local/share/opencode:rw`,
  )
}

// Reap leftovers from interrupted runs first (a mid-flight SIGKILL skips the
// per-attempt cleanup below — observed live: escape during a run leaked a
// container in "Stopping" state with the agent process still inside). Each
// container is labeled with its runner's PID, and only containers whose
// runner is DEAD are reaped — a blanket label reap killed a concurrent run's
// live container mid-attempt (observed live, 2026-07-23).
const staleLines = (
  await podman(["ps", "-a", "--filter", "label=minimal.kernel=1", "--format", '{{.ID}} {{.Label "minimal.pid"}}'])
).out
  .trim()
  .split("\n")
  .filter(Boolean)
const dead = staleLines
  .map((l) => l.split(" "))
  .filter(([, pid]) => !pid || !existsSync(`/proc/${pid}`))
  .map(([id]) => id!)
if (dead.length) await podman(["rm", "-f", ...dead])

const liveContainers = new Set<string>()
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    for (const c of liveContainers) Bun.spawnSync(["podman", "rm", "-f", c])
    process.exit(130)
  })

const resultsDir = join(HERE, "results")
mkdirSync(resultsDir, { recursive: true })
const startedAt = new Date().toISOString()
const stamp = startedAt.replace(/[:.]/g, "-")
const resultFile = join(resultsDir, `${taskId}-${stamp}.json`)

interface Trial {
  attempt: number
  reward: 0 | 1
  turns: number
  elapsedSec: number
  agentExitCode: number
  timedOut: boolean
  /** true = 0-turn agent failure (the parallel auth-race signature from TB2:
   * silent zeros that poison pass-rate math) — inspect the traj before
   * trusting this trial. */
  suspect: boolean
  resultText: string
  trajFile: string
  agentStderr: string
}

async function attempt(i: number): Promise<Trial> {
  // PID in the name: two concurrent runs hit the same Date.now() ms and
  // collided on container create (observed live, 2026-07-23).
  const name = `minimal-${taskId}-${process.pid}-${Date.now()}-a${i}`
  liveContainers.add(name)
  await podmanOrDie(
    [
      "run", "-d", "--name", name,
      "--label", "minimal.kernel=1",
      "--label", `minimal.pid=${process.pid}`,
      ...containerArgs,
      "-w", "/app",
      IMAGE, "sleep", "infinity",
    ],
    "sandbox start",
  )
  try {
    await podmanOrDie(["exec", name, "mkdir", "-p", "/app"], "workdir prep")
    if (existsSync(fixturesDir)) await podmanOrDie(["cp", `${fixturesDir}/.`, `${name}:/app/`], "fixture copy")
    // Harness injected AFTER fixtures so a fixture can never mask the rule file.
    if (harnessPath) await podmanOrDie(["cp", harnessPath, `${name}:/app/${driver.harnessFile}`], "harness copy")

    // --- Agent attempt (the verifier is NOT in the container yet) ---
    const t0 = Date.now()
    const agent = await podman(["exec", name, "timeout", String(timeoutSec), ...driver.argv(model, instruction)])
    const elapsedSec = Math.round((Date.now() - t0) / 10) / 100
    const trajFile = join(resultsDir, `${taskId}-${stamp}-a${i}.traj.ndjson`)
    writeFileSync(trajFile, agent.out)
    const { turns, resultText } = driver.parse(agent.out)

    // --- Scorer, injected only now (verify.sh / tests/ dir with held-out
    // data — all Scorer material the Agent must never see) ---
    if (existsSync(testsDir)) {
      await podmanOrDie(["exec", name, "mkdir", "-p", "/tests"], "tests dir prep")
      await podmanOrDie(["cp", `${testsDir}/.`, `${name}:/tests/`], "tests copy")
    }
    let reward: 0 | 1
    if (hasVerifySh) {
      await podmanOrDie(["cp", verifierPath, `${name}:/verify.sh`], "verifier copy")
      reward = (await podman(["exec", name, "sh", "/verify.sh"])).code === 0 ? 1 : 0
    } else {
      // TB2 protocol: test.sh exits 0 either way and writes the verdict to
      // /logs/verifier/reward.txt. A missing/garbled reward file is an infra
      // failure (scorer broken ≠ task failed) — die loud, never score it.
      await podmanOrDie(["exec", name, "mkdir", "-p", "/logs/verifier"], "verifier logs dir")
      await podman(["exec", name, "bash", "/tests/test.sh"])
      const rewardTxt = (await podman(["exec", name, "cat", "/logs/verifier/reward.txt"])).out.trim()
      if (rewardTxt !== "0" && rewardTxt !== "1") die(`scorer failure: /logs/verifier/reward.txt = "${rewardTxt}"`)
      reward = rewardTxt === "1" ? 1 : 0
    }

    return {
      attempt: i,
      reward,
      turns,
      elapsedSec,
      agentExitCode: agent.code,
      timedOut: agent.code === 124,
      suspect: turns === 0 && agent.code !== 0,
      resultText,
      trajFile: basename(trajFile),
      agentStderr: agent.err.trim().slice(0, 400),
    }
  } finally {
    await podman(["rm", "-f", name])
    liveContainers.delete(name)
  }
}

// --- k attempts, fresh sandbox each; up to --parallel M in flight, width
// adapting to live host load (admission serialized through a promise chain so
// checks never race and launches stagger naturally) ---
let running = 0
let admitChain: Promise<void> = Promise.resolve()
function admit(): Promise<void> {
  const p = admitChain.then(async () => {
    while (running > 0) {
      const busy = await cpuBusyFrac()
      const memMb = memAvailableMb()
      if (busy < LOAD_HI && memMb > MEM_FLOOR_MB) break
      console.log(`hold: cpu ${(busy * 100).toFixed(0)}% / mem ${memMb}MB (width ${running})`)
      await sleep(HOLD_POLL_MS)
    }
    running++
  })
  admitChain = p.catch(() => {})
  return p
}

const trials: Trial[] = []
let nextAttempt = 1
async function worker(): Promise<void> {
  while (nextAttempt <= k) {
    const i = nextAttempt++
    await admit()
    try {
      const t = await attempt(i)
      trials.push(t)
      console.log(
        `attempt ${i}/${k}: reward=${t.reward} turns=${t.turns} ${t.elapsedSec}s` +
          `${t.timedOut ? " TIMEOUT" : ""}${t.suspect ? " SUSPECT(0-turn)" : ""} [width ${running}]`,
      )
    } finally {
      running--
    }
  }
}
await Promise.all(Array.from({ length: Math.min(parallelMax, k) }, () => worker()))
trials.sort((a, b) => a.attempt - b.attempt)

// --- Run record ---
const rewards = trials.map((t) => t.reward)
const run = {
  task: taskId,
  driver: driverId,
  model,
  image: IMAGE,
  host: hostname(),
  startedAt,
  k,
  parallel: parallelMax,
  harness,
  rewards,
  passRate: rewards.reduce((a, b) => a + b, 0) / k,
  trials,
}
writeFileSync(resultFile, JSON.stringify(run, null, 2) + "\n")
console.log(`\n${JSON.stringify({ ...run, trials: undefined }, null, 2)}`)
const nSuspect = trials.filter((t) => t.suspect).length
if (nSuspect > 0)
  console.log(`\n⚠ ${nSuspect}/${k} SUSPECT trial(s) (0-turn agent failure) — inspect trajs before trusting passRate`)
console.log(`\nresult:     ${resultFile}\nview traj:  bun minimal/traj.ts ${join(resultsDir, `${taskId}-${stamp}-a1.traj.ndjson`)}`)
