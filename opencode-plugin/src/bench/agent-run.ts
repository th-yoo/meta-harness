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
 * imports them directly from this module (agent-run.ts) — it has scanned
 * this module's log output directly since B2, not via a re-export from
 * opencode-run.ts. test/bench-opencode-run.test.ts asserts the log lines
 * this module actually emits contain these markers — see that file for the
 * producer/consumer wiring evidence.
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

/** Logged on an agent-phase timeout (driver-neutral wording, ported from
 * runner.py:878). Also matched by REALWORK_RE below — a timeout is "the provider
 * did something", not a provider outage (see retry_provider.py's module
 * docstring: "This deliberately treats a *timeout* as 'up'"). The phrase
 * "timed out after" (substring) also matches the judge's host-side timeout
 * line — an accepted, pre-existing property (the old judge line
 * "judge opencode timed out after 90s" contained this as a substring too). */
export const TIMEOUT_MARK = "agent timed out after"

/** Evidence the provider actually did something this attempt: real turns, a
 * task that hit the agent timeout, or an outright pass. Driver-neutral
 * version; ported from retry_provider.py:43's REALWORK_RE. */
export const REALWORK_RE = /turns=[1-9]\d*|timed out after|reward=1/

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

/** Fallback remediation tail for a driver that doesn't set its own
 * `authHint` (drivers/types.ts) — deliberately driver-neutral (no
 * opencode-specific filenames/commands), since it may be shown for ANY
 * driver, not just opencode (final-review fix 5: the old hardcoded message
 * named opencode's `auth.json`/`opencode auth login` even when the driver
 * that actually failed was claude-code). */
const AUTH_FAIL_GENERIC_HINT = "the model credential was rejected. Refresh it, or set a long-lived *_API_KEY."

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
 * ordinary task output the way "403" can.
 *
 * `authentication[_ ]?(?:error|failed)` (not just `...error`): task-B5-brief
 * fixture evidence — a REAL captured claude-code auth failure (an
 * unauthenticated CLAUDE_CONFIG_DIR, test/fixtures/drivers/claude-code/
 * auth-error.txt) reports `"error":"authentication_failed"` and result text
 * "Not logged in - Please run /login", neither of which the original
 * `authentication[_ ]?error` alternative (nor any other alternative here)
 * matched -- a genuine miss on real driver output, not a hypothetical one.
 * `failed` is added as a second accepted suffix; this is a SHARED regex
 * (both drivers import it), so the extension benefits opencode too if it
 * ever emits the same wording. */
export const AUTH_ERROR_RE =
  /\b401\b|authentication[_ ]?(?:error|failed)|unauthorized|forbidden|invalid[_ ]?(?:api[_ ]?key|token|credential)|oauth|token[_ ]?expired|expired[_ ]?token/i

const MAX_ATTEMPTS = 4

export type SleepFn = (seconds: number) => Promise<void>

/** Default SleepFn — a real `setTimeout`-backed delay. Shared by runAgent
 * below and by opencode-run.ts's runJudgeOpencode (ledger B1a: the two
 * modules had identical private copies; this is now the single source). */
export async function defaultSleep(seconds: number): Promise<void> {
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

  // Advisory wall-clock budget line (Loop-3 T5, task-5-brief.md) — a
  // CONTROLLED CONSTANT derived only from `agentTimeout`, never from the
  // (evolvable, per-arm) harness markdown. It is appended to the instruction
  // here — NOT placed in the evolvable AGENTS.md harness — so it is
  // byte-identical across both A/B arms of an ab run (which always pass the
  // same agentTimeout to both arms); making this text proposer-controlled
  // would turn it into an accidental A/B lever and contaminate the gate. The
  // wording is deliberately advisory (never a hard "stop at N") and the real
  // wall (env.maxAgentTimeout, record.ts:236) is unchanged — mitigating
  // premature termination (design §7).
  const budgetLine = `\n\nYou have roughly ${pyFixed(agentTimeout, 0)}s of wall-clock for this task. `
    + `Budget it: prefer a simpler approach that finishes over an ambitious one that risks running out of time.`
  instruction = instruction + budgetLine

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
      return { turnCount: 0, toolUsage: {}, events: [], timedOut: true, agentElapsedSec: elapsedSec }
    }

    // Auth failures take PRECEDENCE over the transient path: an expired
    // oauth token / bad api key can never recover by retrying, so it must
    // fail fast with an actionable message rather than being classified as
    // "transient provider error" and burned through MAX_ATTEMPTS retries
    // (the root cause opencode-run.ts's runOpencode fixed — see
    // task-authfix-brief.md).
    const cls = driver.classifyAttempt(result)

    if (cls === "auth") {
      log(`  ${AUTH_FAIL_MARK} — ${driver.authHint ?? AUTH_FAIL_GENERIC_HINT} NOT retrying.`)
      // Zero result — exactly like the timeout path above, and NOT
      // driver.parseOutput(output) (final-review fix 2): an unrecoverable
      // auth failure is not real agent work, but at least one driver's
      // auth-failure output DOES parse to a non-zero turnCount (claude-code
      // emits a synthetic assistant echo with num_turns:1 even for a pure
      // pre-flight auth rejection — see drivers/claude-code.ts's file
      // header). Returning that as the result would let a bogus
      // turnCount>0 SessionRecord slip past recordToStores' turnCount===0
      // skip guard, and would accidentally satisfy REALWORK_RE via the
      // logged "turns=1" line.
      return { turnCount: 0, toolUsage: {}, events: [] }
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
  // W1a (time-to-resolve): populate agentElapsedSec on EVERY completion path,
  // not just the timeout branch above — a passing run (the only kind
  // speed-stats pairs on) always falls through to here, so leaving this
  // unset would mean time-to-resolve had no signal on the runs that matter.
  return { ...parsed, agentElapsedSec: elapsedSec }
}
