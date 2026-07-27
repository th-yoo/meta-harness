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
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { runCompletionGate } from "./complete-gate.ts"
import { COVERAGE_HOOK_PY, parseCoveredLines } from "./cover.ts"
import { clampParallel, pidAlive } from "./schedule.ts"
import { clockPreflight } from "./clock.ts"
import { designCheck, liftFutility } from "./futility.ts"
import { HYGIENE_MARKER, bInstruction, mergeThen, type ThenResult } from "./session2.ts"
import { parseRequirements } from "./spec-probe.ts"

const HERE = import.meta.dir

/** sessionID rides every opencode --format json event. */
function extractSessionId(out: string): string | undefined {
  for (const line of out.split("\n")) {
    const t = line.trim()
    if (!t.startsWith("{")) continue
    try {
      const sid = JSON.parse(t).sessionID
      if (typeof sid === "string" && sid) return sid
    } catch {
      /* noise */
    }
  }
  return undefined
}
const IMAGE = "localhost/mh-bench:latest"
const DEFAULT_TIMEOUT_SEC = 3600

// Adaptive-width admission thresholds (--parallel). Host-level /proc reads on
// purpose: per-container cgroup stats are known-poisoned on the WSL2 box
// (shared/non-reset cgroup under rootless podman — see the load-aware
// scheduler notes), host aggregates are not.
const LOAD_HI = 0.85 // hold new launches while cpu busy-fraction >= this
const MEM_FLOOR_MB = 1024 // ... or MemAvailable below this
const HOLD_POLL_MS = 3000

// Reservation layer (schedule.ts): static capacity bound applied BEFORE the
// measurement loop above — measurement alone is commitment-blind (an
// admitted container ramps to full cost after the check passes).
const RESERVE_POLICY = { minCpusPer: 2, reserveMbPer: 800, memFloorMb: MEM_FLOOR_MB }
// Hard per-container runaway cap (podman -m). Observed agent peak ~614MB;
// 2g leaves headroom without letting one attempt eat the machine.
const CONTAINER_MEM_CAP = "2048m"

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

/** Instant whole-host cpu busy fraction: /proc/stat "cpu" line sampled twice.
 * darwin has no /proc — fall back to 1-min loadavg / core count (coarser but
 * the same admission semantics). */
async function cpuBusyFrac(sampleMs = 500): Promise<number> {
  if (!existsSync("/proc/stat")) {
    const { loadavg, cpus } = await import("node:os")
    return Math.min(1, loadavg()[0]! / Math.max(1, cpus().length))
  }
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
  // darwin: no /proc/meminfo, and os.freemem() undercounts (excludes
  // reclaimable cache) — it would falsely block admission. Skip the mem gate
  // there; the cpu gate still paces launches.
  if (!existsSync("/proc/meminfo")) return Infinity
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

  taskDir            task directory, resolved against the current working
                     directory (default: minimal/tasks/hello-fs)
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
  --system <file>    REPLACE opencode's built-in base system prompt
                     (session/prompt/anthropic.txt for claude models) with
                     this file, via config agent.build.prompt. opencode-only.
                     sha256 recorded in the run record
  --driver <id>      opencode | claude-code (default: opencode, the TB2
                     production Agent)
  --model <id>       model in the driver's dialect (defaults:
                     claude-code=${DRIVERS["claude-code"].defaultModel}, opencode=${DRIVERS.opencode.defaultModel})
  --timeout <sec>    per-attempt agent timeout (default: ${DEFAULT_TIMEOUT_SEC})
  --temperature <f>  sampling temperature (opencode driver only; recorded in
                     the run record — a provenance dimension, arms must match).
                     CAVEAT: current Anthropic flagships (opus-4.8/4.7,
                     fable-5) REMOVED sampling params from the API — opencode
                     capability-gates them off for such models, so the flag is
                     silently inert there (llm.ts capabilities.temperature)
  --top-p <f>        nucleus sampling top-p (opencode only, same caveat)
  --complete-gate <artifact-path-in-container>
                     COMPLETION GATE (binding actuator, docs/2026-07-24-
                     completion-gate-design.md): after the agent exits, the
                     harness requires /app/verify.sh, runs it, and probes its
                     adequacy with crude mutants of the named artifact (e.g.
                     /app/run.py); failures reinject "not done" + evidence
                     into the SAME session, bounded. opencode-only. The
                     one-paragraph contract is appended to the instruction.
  --gate-rounds N    max reinjection rounds per attempt (default: 2)
  --gate-mutants N   max mutants per adequacy probe (default: 4)
  --then <taskDirB>  MULTI-TASK SESSION (C2 experiment, docs/2026-07-25-gate-
                     session-hygiene.md §3): after task A fully completes
                     (gate + scoring), stage task B's fixtures into the SAME
                     container ON TOP of A's leftovers and run B's
                     instruction as a continuation of the SAME opencode
                     session; then score B with B's own scorer (rewardB).
                     Trial gains thenB {rewardB,turnsB,elapsedSecB,
                     markerUsed}. opencode-only
  --marker           with --then: inject one hygiene countermand message into
                     the session between A and B ("previous gate closed;
                     evidence obsolete — do not apply")
  --stop-futile <basePass>/<baseN>
                     deterministic curtailment (futility.ts, Alling 1963):
                     give the baseline arm's result (e.g. 3/10) and the run
                     stops the moment remaining attempts CANNOT change the
                     lift verdict. Dies at startup if the design is futile
                     before any spend (the R7 case); mid-run it stops
                     admitting new attempts (in-flight ones finish and are
                     recorded). Zero false-stop probability
  --alpha <f>        significance threshold for --stop-futile (default: 0.05)
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
let taskDirArg: string | undefined
let modelArg: string | undefined
let timeoutSec = DEFAULT_TIMEOUT_SEC
let k = 1
let parallelMax = 1
let harnessArg: string | undefined
let systemArg: string | undefined
let driverId: DriverId = "opencode"
let temperature: number | undefined
let topP: number | undefined
let gateArtifact: string | undefined
let gateRounds = 2
let gateMutants = 4
let thenArg: string | undefined
let markerFlag = false
let stopFutileArg: string | undefined
let alpha = 0.05
function parseFloatFlag(flag: string, raw: string | undefined): number {
  if (raw === undefined) die(`${flag} needs a value`)
  const v = Number(raw)
  if (!Number.isFinite(v)) die(`${flag} not a number: ${raw}`)
  return v
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!
  if (a === "--model") modelArg = argv[++i] ?? die("--model needs a value")
  else if (a === "--timeout") timeoutSec = Number(argv[++i] ?? die("--timeout needs a value")) || die("--timeout not a number")
  else if (a === "--k") k = Number(argv[++i] ?? die("--k needs a value")) || die("--k not a number")
  else if (a === "--parallel") parallelMax = Number(argv[++i] ?? die("--parallel needs a value")) || die("--parallel not a number")
  else if (a === "--harness") harnessArg = argv[++i] ?? die("--harness needs a value")
  else if (a === "--system") systemArg = argv[++i] ?? die("--system needs a value")
  else if (a === "--temperature") temperature = parseFloatFlag("--temperature", argv[++i])
  else if (a === "--top-p") topP = parseFloatFlag("--top-p", argv[++i])
  else if (a === "--complete-gate") gateArtifact = argv[++i] ?? die("--complete-gate needs the artifact path in the container")
  else if (a === "--gate-rounds") gateRounds = Number(argv[++i] ?? die("--gate-rounds needs a value")) || die("--gate-rounds not a number")
  else if (a === "--gate-mutants") gateMutants = Number(argv[++i] ?? die("--gate-mutants needs a value")) || die("--gate-mutants not a number")
  else if (a === "--then") thenArg = argv[++i] ?? die("--then needs a task directory")
  else if (a === "--marker") markerFlag = true
  else if (a === "--stop-futile") stopFutileArg = argv[++i] ?? die("--stop-futile needs <basePass>/<baseN> (e.g. 3/10)")
  else if (a === "--alpha") alpha = parseFloatFlag("--alpha", argv[++i])
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
// Sampling knobs ride opencode's per-agent config (agent.build in the temp
// opencode.json); the claude CLI exposes no equivalent — fail loud rather
// than silently ignore a knob the user thinks is applied.
if ((temperature !== undefined || topP !== undefined) && driverId !== "opencode")
  die(`--temperature/--top-p are opencode-only (driver ${driverId} has no sampling flags)`)
// --system REPLACES opencode's built-in per-provider base prompt (anthropic.txt
// for claude models) via config agent.build.prompt — opencode request.ts:
// `agent.prompt ? [agent.prompt] : SystemPrompt.provider(model)`. The <env>
// block and tool schemas are assembled separately and survive the swap.
if (systemArg && driverId !== "opencode") die(`--system is opencode-only (agent.prompt config)`)
// Completion gate needs session continuation (opencode run --session) for the
// reinjection path — claude -p has no equivalent here.
if (gateArtifact && driverId !== "opencode") die(`--complete-gate is opencode-only (session reinjection)`)
// Multi-task session chains task B via `opencode run --session` — the same
// continuation mechanism the gate's reinjection uses; claude -p has none.
if (thenArg && driverId !== "opencode") die(`--then is opencode-only (session continuation)`)
if (markerFlag && !thenArg) die(`--marker only makes sense with --then`)
// Deterministic curtailment (futility.ts): parse the baseline and run the
// design check NOW — an under-powered design must die before any spend
// (before auth, before the first podman call). The R7 lesson.
let futilityBase: { basePass: number; baseN: number } | null = null
if (stopFutileArg) {
  const m = /^(\d+)\/(\d+)$/.exec(stopFutileArg)
  if (!m) die(`--stop-futile must be <basePass>/<baseN> (e.g. 3/10), got "${stopFutileArg}"`)
  const basePass = Number(m[1])
  const baseN = Number(m[2])
  if (baseN < 1 || basePass > baseN) die(`--stop-futile: impossible baseline ${basePass}/${baseN}`)
  futilityBase = { basePass, baseN }
  const design = designCheck(k, basePass, baseN, alpha)
  if (design.futile) die(`design check (futility): ${design.reason}`)
}
const systemPath = systemArg ? resolve(systemArg) : undefined
if (systemPath && !existsSync(systemPath)) die(`system prompt file not found: ${systemPath}`)
const system = systemPath
  ? {
      file: systemArg!,
      sha256: createHash("sha256").update(readFileSync(systemPath)).digest("hex").slice(0, 16),
    }
  : null

// --- Task (user paths resolve against CWD, like any CLI; only the built-in
// default lives relative to this script) ---
const taskDir = taskDirArg ? resolve(taskDirArg) : join(HERE, "tasks/hello-fs")
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
// With the completion gate on, the one-paragraph contract rides the
// INSTRUCTION (not system-v0 / the harness file) so mechanism A/Bs stay
// one-variable: arms differ by the gate + its contract, not by base content.
const GATE_CONTRACT = `

Before you finish: leave a runnable verification script at /app/verify.sh (exit 0 = verified) that exercises each promised behavior of your artifact, including scenarios that combine boundary conditions. The harness will run it, and may inject faults into your artifact to check that your script detects them. You are done only when the harness accepts. Your verification must exercise every requirement stated in the task instruction — an unexercised stated requirement, or artifact behavior contradicting the instruction, will be treated as not done.`
const instruction = readFileSync(instructionPath, "utf-8").trim() + (gateArtifact ? GATE_CONTRACT : "")
const testsDir = join(taskDir, "tests")

// Fixture source: minimal-native fixtures/, or an upstream terminal-bench
// checkout's environment/ (its data files ARE the fixtures; the Dockerfile is
// build machinery, staged out via a temp copy). Lets a task run straight from
// the checkout: bun minimal/run.ts ../../terminal-bench-2/<task>.
// Only covers tasks whose environment needs no build step (no apt/pip/RUN) —
// anything else needs the TB2 staging pipeline or a real conversion.
function resolveFixtures(dir: string): string {
  const fx = join(dir, "fixtures")
  const env = join(dir, "environment")
  if (existsSync(fx) || !existsSync(env)) return fx
  const staged = join(mkdtempSync(join(tmpdir(), "minimal-fixtures-")), "fixtures")
  mkdirSync(staged)
  for (const entry of readdirSync(env)) {
    if (entry === "Dockerfile") continue
    cpSync(join(env, entry), join(staged, entry), { recursive: true })
  }
  return staged
}
const fixturesDir = resolveFixtures(taskDir)

// False-accept probes (docs/superpowers/plans/2026-07-27-false-accept-probes.md):
// frozen per-task requirement list + instruction-derived relation scripts.
// Both optional — tasks without them get the unchanged completion gate.
const reqPath = join(taskDir, "requirements.json")
const gateRequirements = existsSync(reqPath) ? parseRequirements(readFileSync(reqPath, "utf-8")) : undefined
const relationsDir = join(taskDir, "relations")
const gateRelations: import("./complete-gate.ts").Relation[] = existsSync(relationsDir)
  ? readdirSync(relationsDir)
      .filter((f) => f.endsWith(".py"))
      .sort()
      .map((f) => ({ id: f.replace(/\.py$/, ""), script: readFileSync(join(relationsDir, f), "utf-8") }))
  : []

// --- Task B (--then): the multi-task-session chain target. Same layout
// rules as task A (instruction.md + verify.sh OR tests/test.sh; optional
// fixtures/ or buildless environment/). Its instruction rides VERBATIM —
// the gate contract applies to task A only (session2.bInstruction). ---
const thenDir = thenArg ? resolve(thenArg) : undefined
const thenTask = thenDir ? basename(thenDir) : null
let instructionB = ""
let fixturesDirB = ""
let testsDirB = ""
let verifierPathB = ""
let hasVerifyShB = false
if (thenDir) {
  const instructionPathB = join(thenDir, "instruction.md")
  if (!existsSync(instructionPathB)) die(`--then: no instruction.md in ${thenDir}`)
  verifierPathB = join(thenDir, "verify.sh")
  hasVerifyShB = existsSync(verifierPathB)
  testsDirB = join(thenDir, "tests")
  if (!hasVerifyShB && !existsSync(join(testsDirB, "test.sh"))) die(`--then: no verify.sh or tests/test.sh in ${thenDir}`)
  instructionB = bInstruction(readFileSync(instructionPathB, "utf-8").trim())
  fixturesDirB = resolveFixtures(thenDir)
}

// --- Harness (the evolvable context; identity = content hash for provenance) ---
const harnessPath = harnessArg ? resolve(harnessArg) : undefined
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
const authTmp = mkdtempSync(join(tmpdir(), "minimal-auth-"))
// Credential source dir mounted as /root/.claude. linux: the real ~/.claude
// (.credentials.json on disk). darwin: no file — CC stores oauth in the
// Keychain; export it into a throwaway 700/600 dir (same recipe as TB2's
// prepareAgentAuthMounts, opencode-plugin/src/bench/agent-auth.ts).
let claudeHost = join(home, ".claude")
if (!existsSync(join(claudeHost, ".credentials.json"))) {
  if (process.platform !== "darwin")
    die(`~/.claude/.credentials.json not found — run \`claude /login\` on the host first`)
  const { execFileSync } = await import("node:child_process")
  let creds = ""
  try {
    creds = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf-8" }).trim()
  } catch { /* fall through to die below */ }
  if (!creds) die(`no ~/.claude/.credentials.json and Keychain export failed — run \`claude /login\` on the host first`)
  const claudeDir = join(authTmp, "claude")
  mkdirSync(claudeDir, { recursive: true })
  chmodSync(claudeDir, 0o700)
  writeFileSync(join(claudeDir, ".credentials.json"), creds + "\n")
  chmodSync(join(claudeDir, ".credentials.json"), 0o600)
  claudeHost = claudeDir
}
const containerArgs: string[] = []
if (driverId === "claude-code") {
  const onboardingPath = join(authTmp, "claude.json")
  writeFileSync(onboardingPath, JSON.stringify({ hasCompletedOnboarding: true }) + "\n")
  containerArgs.push(
    "-v", `${claudeHost}:/root/.claude:rw`,
    "-v", `${onboardingPath}:/root/.claude.json:ro`,
    "-e", "IS_SANDBOX=1",
  )
} else {
  const configDir = join(authTmp, "config")
  mkdirSync(configDir, { recursive: true })
  const ocConfig: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    plugin: ["opencode-claude-auth@latest"],
  }
  const buildAgent: Record<string, unknown> = {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { top_p: topP } : {}),
    ...(systemPath ? { prompt: readFileSync(systemPath, "utf-8") } : {}),
  }
  // "build" is `opencode run`'s default agent; config agent entries accept
  // temperature/top_p/prompt (opencode agent.ts merge).
  if (Object.keys(buildAgent).length > 0) ocConfig["agent"] = { build: buildAgent }
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify(ocConfig) + "\n")
  containerArgs.push(
    "-v", `${configDir}:/root/.config/opencode:rw`,
    "-v", `${claudeHost}:/root/.claude:ro`,
    "-v", `${join(home, ".local", "share", "opencode")}:/root/.local/share/opencode:rw`,
  )
}

// Reap leftovers from interrupted runs first (a mid-flight SIGKILL skips the
// per-attempt cleanup below — observed live: escape during a run leaked a
// container in "Stopping" state with the agent process still inside). Each
// container is labeled with its runner's PID, and only containers whose
// runner is DEAD are reaped — a blanket label reap killed a concurrent run's
// live container mid-attempt (observed live, 2026-07-23).
// NOTE: label reads go through `podman inspect` — `podman ps --format` has no
// .Label field (exit 125, observed live; the resulting empty pid made every
// live container look dead and the reap killed a concurrent run mid-attempt).
const staleIds = (await podman(["ps", "-aq", "--filter", "label=minimal.kernel=1"])).out.trim().split("\n").filter(Boolean)
const dead: string[] = []
for (const id of staleIds) {
  const r = await podman(["inspect", "--format", '{{index .Config.Labels "minimal.pid"}}', id])
  const pid = r.code === 0 ? r.out.trim() : ""
  // pidAlive, not /proc: darwin has no /proc, which made every runner look
  // dead here and reaped a CONCURRENT LIVE run's containers (schedule.ts).
  if (!pid || !pidAlive(Number(pid))) dead.push(id)
}
if (dead.length) await podman(["rm", "-f", ...dead])

// Reservation clamp: capacity of the machine that RUNS the containers — on
// darwin that's the podman VM, not the mac (host /proc reads would be the
// wrong machine entirely).
if (parallelMax > 1) {
  const info = await podman(["info", "--format", "{{.Host.CPUs}} {{.Host.MemTotal}}"])
  if (info.code === 0) {
    const [c, m] = info.out.trim().split(/\s+/)
    const clamp = clampParallel(
      parallelMax,
      { cpus: Number(c) || 1, memTotalMb: Math.round(Number(m) / 1048576) || 1024 },
      RESERVE_POLICY,
    )
    if (clamp.reason) console.log(`parallel clamped ${parallelMax} -> ${clamp.effective}: ${clamp.reason}`)
    parallelMax = clamp.effective
  }
}

// Clock-skew preflight (clock.ts): after a mac sleep the podman VM clock ran
// ~17h behind the host — containers failed TLS ("certificate is not yet
// valid") and agents died 0-turn. Assess host↔VM skew, resync once, block if
// it persists. vmEpoch fails open on linux / no machine (no VM = no skew).
{
  const clock = await clockPreflight({
    hostEpoch: () => Math.floor(Date.now() / 1000),
    vmEpoch: async () => {
      const r = await podman(["machine", "ssh", "date", "+%s"])
      const n = Number(r.out.trim())
      return r.code === 0 && Number.isFinite(n) ? n : null
    },
    resync: async () => {
      // Last resort sets the VM clock to the HOST's epoch, read at call time.
      const cmd = `sudo systemctl restart systemd-timesyncd || sudo chronyc -a makestep || sudo date -u -s @${Math.floor(Date.now() / 1000)}`
      return (await podman(["machine", "ssh", cmd])).code === 0
    },
  })
  if (clock.action === "blocked")
    die(`podman VM clock skewed ${clock.skewSec}s vs host and resync failed — containers will fail TLS ("certificate is not yet valid"). Try: podman machine stop && podman machine start`)
  if (clock.action === "resynced")
    console.log(`clock preflight: corrected ${clock.skewSec}s VM clock skew`)
}

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
  /** --then only: task B chained into A's session. null = A left no session
   * id (0-turn death) so B was skipped entirely (suspect trial anyway). */
  thenB?: ThenResult | null
}

async function attempt(i: number): Promise<Trial> {
  // PID in the name: two concurrent runs hit the same Date.now() ms and
  // collided on container create (observed live, 2026-07-23).
  const name = `minimal-${taskId}-${process.pid}-${Date.now()}-a${i}`
  liveContainers.add(name)
  await podmanOrDie(
    [
      "run", "-d", "--name", name,
      "-m", CONTAINER_MEM_CAP,
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
    let agentOut = agent.out

    // --- Completion gate (binding actuator; the task grader is still NOT in
    // the container — the probe uses only the agent's own verify.sh + crude
    // mutants of the required artifact, invariant 1 intact) ---
    let gate: import("./complete-gate.ts").GateResult | null = null
    if (gateArtifact) {
      const sessionId = extractSessionId(agentOut)
      let original: string | undefined
      const gateIO: import("./complete-gate.ts").GateIO = {
        verifyExists: async () => (await podman(["exec", name, "test", "-f", "/app/verify.sh"])).code === 0,
        runVerify: async () => {
          const r = await podman(["exec", name, "timeout", "120", "bash", "-c", "cd /app && bash ./verify.sh"])
          return { code: r.code, out: (r.out + "\n" + r.err).trim() }
        },
        readArtifact: async () => {
          const r = await podman(["exec", name, "cat", gateArtifact!])
          if (r.code !== 0) return undefined
          original = r.out
          return r.out
        },
        writeArtifact: async (content: string) => {
          const tmp = join(tmpdir(), `minimal-mutant-${process.pid}-${i}.py`)
          writeFileSync(tmp, content)
          return (await podman(["cp", tmp, `${name}:${gateArtifact}`])).code === 0
        },
        restoreArtifact: async () => {
          if (original === undefined) return false
          const tmp = join(tmpdir(), `minimal-orig-${process.pid}-${i}.py`)
          writeFileSync(tmp, original)
          return (await podman(["cp", tmp, `${name}:${gateArtifact}`])).code === 0
        },
        syntaxOk: (mutated: string) => {
          if (!gateArtifact!.endsWith(".py")) return true
          const tmp = join(tmpdir(), `minimal-syn-${process.pid}-${i}.py`)
          writeFileSync(tmp, mutated)
          return Bun.spawnSync(["python3", "-m", "py_compile", tmp]).exitCode === 0
        },
        reinject: async (message: string) => {
          if (!sessionId) return false
          const r = await podman([
            "exec", name, "timeout", String(timeoutSec),
            "opencode", "run", "--dir", "/app", "--auto", "--format", "json",
            "--model", model, "--session", sessionId, message,
          ])
          agentOut += `\n{"type":"gate_reinject"}\n` + r.out
          return r.code === 0 || r.code === 124
        },
        coveredLines: async () => {
          // S1 (grip-fix design): one traced verify run — the sitecustomize
          // hook on PYTHONPATH records which artifact lines execute across
          // every python process the verification spawns. Fail-open
          // (undefined) on any capture error; an EMPTY line set is real data
          // (verification never executes the artifact) and flows through so
          // the probe's static fallback + zero-kill rule report it.
          const hookTmp = join(tmpdir(), `minimal-covhook-${process.pid}-${i}.py`)
          writeFileSync(hookTmp, COVERAGE_HOOK_PY)
          if ((await podman(["exec", name, "mkdir", "-p", "/tmp/covhook"])).code !== 0) return undefined
          if ((await podman(["cp", hookTmp, `${name}:/tmp/covhook/sitecustomize.py`])).code !== 0) return undefined
          await podman(["exec", name, "rm", "-f", "/tmp/cov.lines"])
          const r = await podman([
            "exec", name, "timeout", "120", "bash", "-c",
            `cd /app && PYTHONPATH=/tmp/covhook COV_TARGET=${gateArtifact} COV_OUT=/tmp/cov.lines bash ./verify.sh`,
          ])
          if (r.code !== 0) return undefined
          const cat = await podman(["exec", name, "cat", "/tmp/cov.lines"])
          if (cat.code !== 0) return undefined
          return parseCoveredLines(cat.out)
        },
        readVerify: async () => {
          const r = await podman(["exec", name, "cat", "/app/verify.sh"])
          return r.code === 0 ? r.out : undefined
        },
        runScript: async (script: string) => {
          const tmp = join(tmpdir(), `minimal-relation-${process.pid}-${i}.py`)
          writeFileSync(tmp, script)
          if ((await podman(["cp", tmp, `${name}:/tmp/mh-relation.py`])).code !== 0)
            return { code: 0, out: "" } // copy failure = fail-open, never a violation
          const r = await podman([
            "exec", name, "timeout", "60", "bash", "-c",
            `cd /app && APPDIR=/app ARTIFACT=${gateArtifact} python3 /tmp/mh-relation.py`,
          ])
          return { code: r.code, out: (r.out + "\n" + r.err).trim() }
        },
      }
      gate = await runCompletionGate(gateIO, {
        rounds: gateRounds,
        mutants: gateMutants,
        requirements: gateRequirements,
        relations: gateRelations.length > 0 ? gateRelations : undefined,
      })
    }

    const elapsedSec = Math.round((Date.now() - t0) / 10) / 100
    const trajFile = join(resultsDir, `${taskId}-${stamp}-a${i}.traj.ndjson`)
    // Written now so a scorer die() still leaves the trajectory on disk;
    // rewritten after the --then chain appends B's continuation output.
    writeFileSync(trajFile, agentOut)
    const { turns, resultText } = driver.parse(agentOut)

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

    // --- Task B (--then): chained into A's opencode session AFTER A fully
    // completes (post-gate, post-scoring) — the C2 session-carryover
    // experiment (docs/2026-07-25-gate-session-hygiene.md §3). /app is NOT
    // cleaned between tasks (realistic session accumulation). ---
    let thenB: ThenResult | null | undefined
    if (thenDir) {
      const sessionId = extractSessionId(agentOut)
      if (!sessionId) {
        // A died 0-turn — no session to continue. Skip B (suspect trial).
        thenB = null
      } else {
        // B fixtures staged ON TOP of A's leftovers.
        if (existsSync(fixturesDirB)) await podmanOrDie(["cp", `${fixturesDirB}/.`, `${name}:/app/`], "B fixture copy")
        if (markerFlag) {
          const m = await podman([
            "exec", name, "timeout", String(timeoutSec),
            "opencode", "run", "--dir", "/app", "--auto", "--format", "json",
            "--model", model, "--session", sessionId, HYGIENE_MARKER,
          ])
          agentOut += `\n{"type":"then_marker"}\n` + m.out
        }
        const tB0 = Date.now()
        const agentB = await podman([
          "exec", name, "timeout", String(timeoutSec),
          "opencode", "run", "--dir", "/app", "--auto", "--format", "json",
          "--model", model, "--session", sessionId, instructionB,
        ])
        const elapsedSecB = Math.round((Date.now() - tB0) / 10) / 100
        agentOut += `\n{"type":"then_b"}\n` + agentB.out
        const { turns: turnsB } = driver.parse(agentB.out)

        // B scoring: /tests REPLACED by B's tests; same reward protocol as A.
        let rewardB: 0 | 1
        if (hasVerifyShB) {
          await podmanOrDie(["cp", verifierPathB, `${name}:/verify.sh`], "B verifier copy")
          rewardB = (await podman(["exec", name, "sh", "/verify.sh"])).code === 0 ? 1 : 0
        } else {
          await podmanOrDie(["exec", name, "rm", "-rf", "/tests"], "B tests reset")
          await podmanOrDie(["exec", name, "mkdir", "-p", "/tests"], "B tests dir prep")
          await podmanOrDie(["cp", `${testsDirB}/.`, `${name}:/tests/`], "B tests copy")
          await podmanOrDie(["exec", name, "mkdir", "-p", "/logs/verifier"], "B verifier logs dir")
          await podmanOrDie(["exec", name, "rm", "-f", "/logs/verifier/reward.txt"], "B stale reward reset")
          await podman(["exec", name, "bash", "/tests/test.sh"])
          const rtB = (await podman(["exec", name, "cat", "/logs/verifier/reward.txt"])).out.trim()
          if (rtB !== "0" && rtB !== "1") die(`B scorer failure: /logs/verifier/reward.txt = "${rtB}"`)
          rewardB = rtB === "1" ? 1 : 0
        }
        thenB = { rewardB, turnsB, elapsedSecB, markerUsed: markerFlag }
      }
    }

    writeFileSync(trajFile, agentOut)
    const trial: Trial = {
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
      ...(gate
        ? {
            gate: {
              accepted: gate.accepted,
              exhausted: gate.gateExhausted,
              rounds: gate.rounds.map((r) => ({
                outcome: r.outcome,
                tried: r.mutantsTried,
                survived: r.mutantsSurvived,
                killed: r.mutantsKilled,
                coverage: r.coverage,
                ...(r.uncoveredReqs ? { uncoveredReqs: r.uncoveredReqs } : {}),
                ...(r.violatedRelations ? { violatedRelations: r.violatedRelations } : {}),
              })),
            },
          }
        : {}),
    }
    if (thenB === undefined) return trial
    if (thenB === null) return { ...trial, thenB: null }
    return mergeThen(trial as unknown as Record<string, unknown>, thenB) as unknown as Trial
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
// Curtailment state: running pass/fail over VALID (non-suspect) completed
// attempts. Once futileStop is set, workers stop admitting new attempts —
// in-flight ones finish and are recorded (no kills, no lost data).
let futileStop: { atAttempt: number; bestCaseP: number; reason: string } | null = null
let validPass = 0
let validFail = 0
async function worker(): Promise<void> {
  while (nextAttempt <= k && futileStop === null) {
    const i = nextAttempt++
    await admit()
    try {
      const t = await attempt(i)
      trials.push(t)
      const thenNote =
        t.thenB === null ? " B:SKIPPED(no-session)" : t.thenB ? ` B:reward=${t.thenB.rewardB} turns=${t.thenB.turnsB}` : ""
      console.log(
        `attempt ${i}/${k}: reward=${t.reward} turns=${t.turns} ${t.elapsedSec}s` +
          `${t.timedOut ? " TIMEOUT" : ""}${t.suspect ? " SUSPECT(0-turn)" : ""}${thenNote} [width ${running}]`,
      )
      if (futilityBase && !t.suspect) {
        if (t.reward === 1) validPass++
        else validFail++
        const v = liftFutility({ pass: validPass, fail: validFail, k }, futilityBase.basePass, futilityBase.baseN, alpha)
        if (v.futile && futileStop === null) {
          futileStop = { atAttempt: i, bestCaseP: v.bestCaseP, reason: v.reason! }
          console.log(`futility stop after attempt ${i}: ${v.reason} — no new attempts launched`)
        }
      }
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
  sampling: temperature !== undefined || topP !== undefined ? { temperature, topP } : null,
  system,
  harness,
  completeGate: gateArtifact ? { artifact: gateArtifact, rounds: gateRounds, mutants: gateMutants } : null,
  thenTask,
  marker: markerFlag,
  stopFutile: futilityBase,
  stoppedFutile: futileStop,
  rewards,
  // Over recorded trials, not k: a futility stop records fewer than k.
  passRate: rewards.reduce((a, b) => a + b, 0) / Math.max(rewards.length, 1),
  trials,
}
writeFileSync(resultFile, JSON.stringify(run, null, 2) + "\n")
console.log(`\n${JSON.stringify({ ...run, trials: undefined }, null, 2)}`)
const nSuspect = trials.filter((t) => t.suspect).length
if (nSuspect > 0)
  console.log(`\n⚠ ${nSuspect}/${k} SUSPECT trial(s) (0-turn agent failure) — inspect trajs before trusting passRate`)
console.log(`\nresult:     ${resultFile}\nview traj:  bun minimal/traj.ts ${join(resultsDir, `${taskId}-${stamp}-a1.traj.ndjson`)}`)
