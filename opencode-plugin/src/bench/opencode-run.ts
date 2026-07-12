/**
 * opencode-run.ts — the opencode agent phase.
 *
 * Ports term-bench2/runner.py's normalize_events (:768-812), run_opencode
 * (:813-965, adapted so opencode runs INSIDE the podman container — see
 * cmd-run.ts for the credential/binary mounts that make that possible), and
 * the judge transport run_judge_opencode (:1127-1207, which runs on the HOST,
 * no container — the judge never touches a task workspace).
 *
 * Marker-string producer/consumer contract: TRANSIENT_MARK and REALWORK_RE
 * are exported here as the single source of truth and re-used (not
 * re-declared) by retry-provider.ts (port of retry_provider.py:43-45), which
 * scans this module's own log output for them. test/bench-opencode-run.test.ts
 * asserts the log lines this module actually emits contain these markers —
 * see that file for the producer/consumer wiring evidence.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { podman, runHost } from "./exec.ts"
import { withTimeout } from "./exec.ts"
import type { ExecResult } from "./exec.ts"
import type { ExecFn } from "./staging.ts"
import { buildExecArgv, buildCpToArgv } from "./sandbox.ts"
import type { BenchPaths } from "./paths.ts"
import { die, log, pyFixed, writeJsonAtomic } from "./util.ts"
import { judgeAgentConfig, judgeReplyText } from "./judge-audit.ts"
import type { TrajEvent, ToolUsage } from "../harness-store.ts"

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

/** Tools whose non-zero exit / "error" status counts as a tool error —
 * runner.py:906's EXECUTION_TOOLS. */
export const EXECUTION_TOOLS = new Set(["bash", "task"])

const MAX_ATTEMPTS = 4

export type SleepFn = (seconds: number) => Promise<void>

async function defaultSleep(seconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

// ── normalize_events ────────────────────────────────────────────────────────

function jsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/**
 * opencode `run --format json` NDJSON → compact TrajEvents for the proposer.
 * Verbatim port of runner.py:768-810: skip non-`{`/unparseable/step_finish
 * lines; tool_use → {t:"tool", tool, args<=300, output<=800, error}; text
 * (skip-blank) <=800; error extraction; capped at maxEvents.
 */
export function normalizeEvents(ndjsonText: string, maxEvents = 400): TrajEvent[] {
  const events: TrajEvent[] = []
  for (const rawLine of ndjsonText.split("\n")) {
    const line = rawLine.trim()
    if (!line.startsWith("{")) continue
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const t = (ev["type"] as string) ?? ""
    if (t === "tool_use") {
      const part = (ev["part"] as Record<string, unknown>) ?? {}
      const state = (part["state"] as Record<string, unknown>) ?? {}
      const tool = (part["tool"] as string) ?? "unknown"
      const rawArgs = "input" in state ? state["input"] : ((part["input"] as unknown) ?? "")
      const args = typeof rawArgs === "string" ? rawArgs : jsonStringify(rawArgs)
      const rawOut = state["output"] ?? ""
      const out = typeof rawOut === "string" ? rawOut : jsonStringify(rawOut)
      const status = (state["status"] as string) ?? ""
      const metadata = (state["metadata"] as Record<string, unknown>) || {}
      const exitCode = (metadata["exit"] as number) ?? 0
      const err = status === "error" || Boolean(exitCode && exitCode !== 0)
      events.push({ t: "tool", tool, args: args.slice(0, 300), output: out.slice(0, 800), error: err })
    } else if (t === "text") {
      const part = (ev["part"] as Record<string, unknown>) ?? {}
      const txt = (ev["text"] as string) || (part["text"] as string) || ""
      if (typeof txt === "string" && txt.trim()) {
        events.push({ t: "text", text: txt.slice(0, 800) })
      }
    } else if (t === "error") {
      const errVal = ev["error"] ?? {}
      let msg: string
      if (errVal && typeof errVal === "object" && !Array.isArray(errVal)) {
        const eo = errVal as Record<string, unknown>
        const data = (eo["data"] as Record<string, unknown>) ?? {}
        msg = (data["message"] as string) || (eo["name"] as string) || jsonStringify(eo)
      } else {
        msg = String(errVal)
      }
      events.push({ t: "error", text: String(msg).slice(0, 800) })
    }
    if (events.length >= maxEvents) break
  }
  return events
}

// ── run_opencode ─────────────────────────────────────────────────────────

// FOLLOW-UP (caller-abort bonus, deferred — task-authfix-brief.md's bonus
// section): today an auth failure fails fast per-arm (this module) but the
// caller (cmd-run.ts's cmd_run loop, and cmd-ab.ts's own loop over the same
// injectable runTaskOnce) still moves on to the NEXT task/arm, each failing
// fast again — no more infinite retry, but still one wasted attempt per
// remaining task. Aborting the WHOLE run on first auth failure would need an
// authFailed flag threaded through RunTaskResult (cmd-run.ts) AND through
// cmd-ab.ts's separate loop (which has its own early-stop/regression-stats
// control flow to reconcile this with) — more than a trivially-clean change,
// so left as this follow-up rather than forced. Not implemented.

export interface RunOpencodeResult {
  turnCount: number
  toolUsage: ToolUsage
  events: TrajEvent[]
}

/**
 * Write AGENTS.md (if harnessMd non-empty) then run `opencode run` INSIDE
 * the already-created+started container, with the transient-provider retry
 * loop (runner.py:864-896) — adapted from Python's host-side bwrap
 * subprocess to a `podman exec` (see cmd-run.ts for the mounts that make
 * opencode + credentials available inside the container; this function
 * assumes they already are).
 *
 * AGENTS.md delivery: Python writes it directly to the host-visible
 * workspace path before the namespace launch. There is no stdin-piping
 * support in this project's exec funnel (exec.ts's ExecFn is argv-only), so
 * this port writes harnessMd to a HOST temp file and `podman cp`s it in
 * (buildCpToArgv) rather than piping via `bash -c 'cat > ...'` — the brief
 * explicitly allows either; this one needs no exec-funnel changes.
 */
export async function runOpencode(
  paths: BenchPaths,
  containerName: string,
  task: string,
  model: string,
  variant: string,
  agentTimeout: number,
  harnessMd: string,
  execFn: ExecFn = podman,
  sleepFn: SleepFn = defaultSleep,
): Promise<RunOpencodeResult> {
  const instructionPath = join(paths.tbRoot, task, "instruction.md")
  let instruction: string
  try {
    instruction = readFileSync(instructionPath, "utf-8")
  } catch {
    return die(`instruction.md not found: ${instructionPath}`)
  }

  if (harnessMd) {
    const scratch = mkdtempSync(join(tmpdir(), "mh-agents-md-"))
    try {
      const hostTmp = join(scratch, "AGENTS.md")
      writeFileSync(hostTmp, harnessMd)
      await execFn(buildCpToArgv(containerName, hostTmp, "/app/AGENTS.md"))
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  // --format json: one JSON event per line (NDJSON). --auto: approve all
  // tool permissions. NEVER --pure — it strips provider/auth config (see
  // runner.py:836-840's comment, preserved here for the same reason).
  const cmd = ["opencode", "run", "--dir", "/app", "--auto", "--format", "json", "--model", model]
  if (variant) cmd.push("--variant", variant)
  cmd.push(instruction)

  let result: ExecResult | undefined
  let elapsedSec = 0
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log(`  opencode run (timeout=${pyFixed(agentTimeout, 0)}s, attempt ${attempt}/${MAX_ATTEMPTS})...`)
    const t0 = Date.now()
    result = await execFn(buildExecArgv(containerName, withTimeout(cmd, agentTimeout), { workdir: "/app" }))
    elapsedSec = (Date.now() - t0) / 1000

    if (result.timedOut) {
      log(`  ${TIMEOUT_MARK} ${pyFixed(agentTimeout, 0)}s`)
      return { turnCount: 0, toolUsage: {}, events: [] }
    }

    const out = result.stdout || ""
    // Detect a transient error run: an {"type":"error"} event AND no
    // assistant/tool activity (step_finish/text/tool_use).
    const hadErrorEvent = out.includes('"type":"error"')
    const hadActivity = out.includes('"type":"step_finish"') || out.includes('"type":"tool_use"')

    // Auth failures take PRECEDENCE over the transient path: an expired
    // oauth token / bad api key can never recover by retrying, so it must
    // fail fast with an actionable message rather than being classified as
    // "transient provider error" and burned through MAX_ATTEMPTS retries
    // (the root cause this module fixes — the old first clause below
    // treated ANY failed-with-no-activity run as transient, auth included).
    const isAuth = ((hadErrorEvent || result.rc !== 0) && !hadActivity) && AUTH_ERROR_RE.test(out)
    if (isAuth) {
      log(
        `  ${AUTH_FAIL_MARK} — the model credential was rejected (auth.json oauth token likely expired). ` +
          "Refresh it (run a host `opencode run`, or `opencode auth login`), or set a long-lived *_API_KEY. NOT retrying.",
      )
      break
    }

    const transient = (hadErrorEvent && !hadActivity) || (result.rc !== 0 && !hadActivity && TRANSIENT_RE.test(out))

    if (transient && attempt < MAX_ATTEMPTS) {
      const backoff = Math.min(30, 5 * attempt)
      log(`  ${TRANSIENT_MARK} — retrying in ${backoff}s`)
      await sleepFn(backoff)
      continue
    }
    break
  }

  // Parse NDJSON output for turn count and tool usage.
  // turn_count = number of step_finish events with reason=="stop"
  // tool errors = tool_use events where state.status=="error" OR
  //   metadata.exit != 0 — EXECUTION_TOOLS only, to avoid false positives.
  const output = result?.stdout || ""
  let turnCount = 0
  const toolUsage: ToolUsage = {}

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim()
    if (!line.startsWith("{")) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const evtType = (event["type"] as string) ?? ""

    if (evtType === "tool_use") {
      const part = (event["part"] as Record<string, unknown>) ?? {}
      const tool = (part["tool"] as string) ?? "unknown"
      const state = (part["state"] as Record<string, unknown>) ?? {}
      if (!toolUsage[tool]) toolUsage[tool] = { calls: 0, errors: 0 }
      toolUsage[tool]!.calls += 1
      if (EXECUTION_TOOLS.has(tool)) {
        const status = (state["status"] as string) ?? ""
        const metadata = (state["metadata"] as Record<string, unknown>) || {}
        const exitCode = (metadata["exit"] as number) ?? 0
        if (status === "error" || (exitCode && exitCode !== 0)) {
          toolUsage[tool]!.errors += 1
        }
      }
    } else if (evtType === "step_finish") {
      const part = (event["part"] as Record<string, unknown>) ?? {}
      if (part["reason"] === "stop") turnCount += 1
    }
  }

  // Note: Python's MH_DEBUG dump-to-/tmp behavior (runner.py:940-948) is
  // dropped in this port — it is a local debugging aid, not part of any
  // marker-string consumer contract (flagged in the task report).

  const events = normalizeEvents(output)
  log(`  opencode done in ${pyFixed(elapsedSec, 1)}s, turns=${turnCount}`)
  return { turnCount, toolUsage, events }
}

// ── run_judge_opencode (judge transport — runs on the HOST, no container) ──

export type HostExecFn = (argv: string[], opts?: { timeoutSec?: number }) => Promise<ExecResult>

/**
 * Invoke the judge headlessly on the HOST (no bwrap/podman sandbox — the
 * judge never touches a task workspace), in a fresh scratch --dir. Port of
 * runner.py:1127-1207. Retries on transient provider errors with a short
 * capped backoff (min(20, 5*attempt)), same detection style as runOpencode.
 * Returns the judge's reply text, or null if every attempt times out/fails/
 * errors transiently — callers must treat null as a skip, not a crash.
 */
export async function runJudgeOpencode(
  prompt: string,
  model: string,
  timeoutSec = 90,
  maxAttempts = 3,
  execFn: HostExecFn = runHost,
  sleepFn: SleepFn = defaultSleep,
  promptPath?: string,
): Promise<string | null> {
  const agentBlock = judgeAgentConfig(promptPath)
  const scratch = mkdtempSync(join(tmpdir(), "mh-judge-audit-"))
  try {
    let agentArgs: string[] = []
    if (agentBlock) {
      writeJsonAtomic(join(scratch, "opencode.json"), {
        $schema: "https://opencode.ai/config.json",
        agent: { "mh-judge": agentBlock },
      })
      agentArgs = ["--agent", "mh-judge"]
      log("  judge agent: mh-judge (locked-down persona)")
    } else {
      log("  judge agent: default (judge-prompt.txt missing)")
    }

    const cmd = ["opencode", "run", "--dir", scratch, ...agentArgs, "--auto", "--format", "json", "--model", model, prompt]

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      log(`  judge opencode run (timeout=${pyFixed(timeoutSec, 0)}s, attempt ${attempt}/${maxAttempts})...`)
      const result = await execFn(cmd, { timeoutSec })

      if (result.timedOut) {
        log(`  judge opencode timed out after ${pyFixed(timeoutSec, 0)}s`)
        if (attempt < maxAttempts) continue
        return null
      }

      const out = result.stdout || ""
      const hadErrorEvent = out.includes('"type":"error"')
      const hadActivity = out.includes('"type":"step_finish"') || out.includes('"type":"text"')
      const transient = (hadErrorEvent && !hadActivity) || (result.rc !== 0 && !hadActivity && TRANSIENT_RE.test(out))
      if (transient && attempt < maxAttempts) {
        const backoff = Math.min(20, 5 * attempt)
        log(`  judge ${TRANSIENT_MARK} — retrying in ${backoff}s`)
        await sleepFn(backoff)
        continue
      }

      const text = judgeReplyText(out)
      return text.trim() ? text : null
    }
    return null
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
