/**
 * agent-run.ts — the generic agent-phase retry loop (driver-agnostic).
 *
 * Extracted from opencode-run.ts (task-B1-brief.md, pure refactor — zero
 * behavior change) so future drivers (claude-code, codex) can reuse the same
 * MAX_ATTEMPTS retry-with-backoff loop, harness-delivery step, and
 * marker-string contract that opencode-run.ts's `runOpencode` used to own
 * outright. All opencode-specific behavior (argv shape, NDJSON parsing,
 * error-classification heuristics) now lives behind the AgentDriver interface
 * (drivers/types.ts) and its opencode implementation (drivers/opencode.ts);
 * this module only orchestrates.
 *
 * Marker-string producer/consumer contract: TRANSIENT_MARK and REALWORK_RE
 * are exported here as the single source of truth and re-used (not
 * re-declared) by retry-provider.ts (port of retry_provider.py:43-45), which
 * scans this module's log output (re-exported, unchanged, from
 * opencode-run.ts) for them. test/bench-opencode-run.test.ts asserts the log
 * lines this module actually emits contain these markers — see that file for
 * the producer/consumer wiring evidence.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { podman } from "./exec.ts"
import { withTimeout } from "./exec.ts"
import type { ExecResult } from "./exec.ts"
import type { ExecFn } from "./staging.ts"
import { buildExecArgv, buildCpToArgv } from "./sandbox.ts"
import type { BenchPaths } from "./paths.ts"
import { die, log, pyFixed } from "./util.ts"
import type { AgentDriver, AgentRunOutput } from "./drivers/types.ts"

// ── shared constants (producer here, consumer in retry-provider.ts) ───────

/** Logged whenever a transient-provider retry fires (runner.py:893, :1196
 * verbatim wording "transient provider error"). retry_provider.py:45's
 * TRANSIENT_MARK ported unchanged. */
export const TRANSIENT_MARK = "transient provider error"

/** Logged on an agent-phase timeout (runner.py:878's f-string prefix,
 * verbatim). Also matched by REALWORK_RE below — a timeout is "the provider
 * did something", not a provider outage (see retry_provider.py's module
 * docstring: "This deliberately treats a *timeout* as 'up'"). */
export const TIMEOUT_MARK = "opencode timed out after"

/** Evidence the provider actually did something this attempt: real turns, a
 * task that hit the agent timeout, or an outright pass. Verbatim port of
 * retry_provider.py:43's REALWORK_RE. */
export const REALWORK_RE = /turns=[1-9]\d*|opencode timed out after|reward=1/

/** Provider-error detection regex — verbatim port of runner.py:857-861
 * (TRANSIENT_RE) and :1070-1074 (_JUDGE_AUDIT_TRANSIENT_RE), which are
 * byte-identical patterns in the Python source. */
export const TRANSIENT_RE =
  /overloaded|unexpected server error|rate.?limit|429|503|timeout|connection|temporarily unavailable|apicallerror/i

/** Logged instead of TRANSIENT_MARK when an auth failure is detected — an
 * expired oauth token / bad api key can never recover by retrying, so this
 * marks a fail-fast path rather than a retry-with-backoff one. Distinct from
 * TRANSIENT_MARK so retry-provider.ts's TRANSIENT_MARK scan never confuses
 * the two (an auth failure must never read as "provider degradation"). */
export const AUTH_FAIL_MARK = "authentication error"

/** Unrecoverable-auth-failure detection — root-caused live: an expired
 * auth.json oauth token surfaces from `opencode run` as a `{"type":"error"}`
 * event whose message is an ordinary 401/"unauthorized"/"invalid api key"
 * string, indistinguishable from a transient provider hiccup by shape alone
 * (both are "an error event with no activity"). This regex is what tells
 * the two apart so an auth failure fails fast instead of being retried
 * MAX_ATTEMPTS times as "transient provider error" (the bug this module
 * fixes — see opencode-run.ts's file header / task-authfix-brief.md).
 *
 * Deliberately does NOT include a bare `\b403\b` alternative: real task
 * output legitimately contains standalone "403" (e.g. "403 lines
 * processed") with nothing to do with auth, and matching it here would
 * wrongly fail-fast a normal run. "forbidden" is included instead, since
 * genuine 403-as-auth-failure text virtually always names itself as such
 * ("403 Forbidden", "Forbidden: ...") rather than appearing as a bare
 * number. 401 IS matched bare — in practice it does not collide with
 * ordinary task output the way "403" can. */
export const AUTH_ERROR_RE =
  /\b401\b|authentication[_ ]?error|unauthorized|forbidden|invalid[_ ]?(?:api[_ ]?key|token|credential)|oauth|token[_ ]?expired|expired[_ ]?token/i

const MAX_ATTEMPTS = 4

export type SleepFn = (seconds: number) => Promise<void>

async function defaultSleep(seconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

// ── runAgent ─────────────────────────────────────────────────────────────

/**
 * Deliver the harness (if any) then run the driver's agent CLI INSIDE the
 * already-created+started container, with the transient-provider retry loop
 * (runner.py:864-896, opencode-run.ts's former `runOpencode`) — adapted from
 * Python's host-side bwrap subprocess to a `podman exec` (see cmd-run.ts for
 * the mounts that make the agent + credentials available inside the
 * container; this function assumes they already are).
 *
 * Harness delivery: `workspace-file` drivers get the harness markdown
 * written to a HOST temp file and `podman cp`'d in (buildCpToArgv) rather
 * than piped via `bash -c 'cat > ...'` — there is no stdin-piping support in
 * this project's exec funnel (exec.ts's ExecFn is argv-only). `argv-flags`
 * drivers get the harness appended to argv via `driver.harness.buildFlags`
 * instead, no container filesystem write involved.
 */
export async function runAgent(
  driver: AgentDriver,
  paths: BenchPaths,
  containerName: string,
  task: string,
  model: string,
  variant: string,
  agentTimeout: number,
  harnessMd: string,
  execFn: ExecFn = podman,
  sleepFn: SleepFn = defaultSleep,
): Promise<AgentRunOutput> {
  const instructionPath = join(paths.tbRoot, task, "instruction.md")
  let instruction: string
  try {
    instruction = readFileSync(instructionPath, "utf-8")
  } catch {
    return die(`instruction.md not found: ${instructionPath}`)
  }

  let cmd = driver.buildArgv({ model: driver.modelArg(model), variant, instruction })

  if (harnessMd) {
    if (driver.harness.kind === "workspace-file") {
      const filename = driver.harness.filename
      const scratch = mkdtempSync(join(tmpdir(), "mh-agents-md-"))
      try {
        const hostTmp = join(scratch, filename)
        writeFileSync(hostTmp, harnessMd)
        await execFn(buildCpToArgv(containerName, hostTmp, `/app/${filename}`))
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    } else {
      cmd = [...cmd, ...driver.harness.buildFlags(harnessMd)]
    }
  }

  let result: ExecResult | undefined
  let elapsedSec = 0
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log(`  ${driver.id} run (timeout=${pyFixed(agentTimeout, 0)}s, attempt ${attempt}/${MAX_ATTEMPTS})...`)
    const t0 = Date.now()
    result = await execFn(buildExecArgv(containerName, withTimeout(cmd, agentTimeout), { workdir: "/app" }))
    elapsedSec = (Date.now() - t0) / 1000

    if (result.timedOut) {
      log(`  ${TIMEOUT_MARK} ${pyFixed(agentTimeout, 0)}s`)
      return { turnCount: 0, toolUsage: {}, events: [] }
    }

    // Auth failures take PRECEDENCE over the transient path: an expired
    // oauth token / bad api key can never recover by retrying, so it must
    // fail fast with an actionable message rather than being classified as
    // "transient provider error" and burned through MAX_ATTEMPTS retries
    // (the root cause opencode-run.ts's runOpencode fixed — see
    // task-authfix-brief.md).
    const cls = driver.classifyAttempt(result)

    if (cls === "auth") {
      log(
        `  ${AUTH_FAIL_MARK} — the model credential was rejected (auth.json oauth token likely expired). ` +
          "Refresh it (run a host `opencode run`, or `opencode auth login`), or set a long-lived *_API_KEY. NOT retrying.",
      )
      break
    }

    if (cls === "transient" && attempt < MAX_ATTEMPTS) {
      const backoff = Math.min(30, 5 * attempt)
      log(`  ${TRANSIENT_MARK} — retrying in ${backoff}s`)
      await sleepFn(backoff)
      continue
    }
    break
  }

  const output = result?.stdout || ""
  const parsed = driver.parseOutput(output)
  log(`  ${driver.id} done in ${pyFixed(elapsedSec, 1)}s, turns=${parsed.turnCount}`)
  return parsed
}
