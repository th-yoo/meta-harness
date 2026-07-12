/**
 * opencode-run.ts — the opencode agent phase.
 *
 * Ports term-bench2/runner.py's normalize_events (:768-812), run_opencode
 * (:813-965, adapted so opencode runs INSIDE the podman container — see
 * cmd-run.ts for the credential/binary mounts that make that possible), and
 * the judge transport run_judge_opencode (:1127-1207, which runs on the HOST,
 * no container — the judge never touches a task workspace).
 *
 * task-B1-brief.md (pure refactor, zero behavior change) split this module:
 * the generic retry loop moved to agent-run.ts, and the opencode-specific
 * argv/parsing/classification moved to drivers/opencode.ts, behind the
 * AgentDriver interface (drivers/types.ts) — this file now re-exports
 * everything that moved so retry-provider.ts, judge-audit.ts, and
 * test/bench-opencode-run.test.ts keep compiling and behaving unchanged.
 * `runOpencode` itself is now a one-line wrapper around agent-run.ts's
 * generic `runAgent`, bound to the opencode driver.
 *
 * Marker-string producer/consumer contract: TRANSIENT_MARK and REALWORK_RE
 * are re-exported here (declared in agent-run.ts, the actual source of
 * truth) and re-used (not re-declared) by retry-provider.ts (port of
 * retry_provider.py:43-45), which scans this module's own log output for
 * them. test/bench-opencode-run.test.ts asserts the log lines this module
 * actually emits contain these markers — see that file for the
 * producer/consumer wiring evidence.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHost } from "./exec.ts"
import type { ExecResult } from "./exec.ts"
import type { ExecFn } from "./staging.ts"
import type { BenchPaths } from "./paths.ts"
import { log, pyFixed, writeJsonAtomic } from "./util.ts"
import { judgeAgentConfig, judgeReplyText } from "./judge-audit.ts"
import { runAgent, TRANSIENT_MARK, TRANSIENT_RE } from "./agent-run.ts"
import type { SleepFn } from "./agent-run.ts"
import { opencodeDriver } from "./drivers/opencode.ts"
import type { AgentRunOutput } from "./drivers/types.ts"

export { TRANSIENT_MARK, TIMEOUT_MARK, REALWORK_RE, TRANSIENT_RE, AUTH_FAIL_MARK, AUTH_ERROR_RE } from "./agent-run.ts"
export type { SleepFn } from "./agent-run.ts"
export { normalizeEvents, EXECUTION_TOOLS } from "./drivers/opencode.ts"

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

/** Alias of agent-run.ts's driver-agnostic AgentRunOutput — kept as its own
 * exported name since callers (cmd-run.ts) already destructure this shape
 * off `runOpencode`. */
export type RunOpencodeResult = AgentRunOutput

/**
 * Run opencode inside the already-created+started container. Thin wrapper
 * around agent-run.ts's generic `runAgent`, bound to the opencode driver —
 * see that module for the retry loop, and drivers/opencode.ts for the
 * opencode-specific argv/parsing/classification.
 */
export async function runOpencode(
  paths: BenchPaths,
  containerName: string,
  task: string,
  model: string,
  variant: string,
  agentTimeout: number,
  harnessMd: string,
  execFn?: ExecFn,
  sleepFn?: SleepFn,
): Promise<RunOpencodeResult> {
  return runAgent(opencodeDriver, paths, containerName, task, model, variant, agentTimeout, harnessMd, execFn, sleepFn)
}

// ── run_judge_opencode (judge transport — runs on the HOST, no container) ──

export type HostExecFn = (argv: string[], opts?: { timeoutSec?: number }) => Promise<ExecResult>

async function defaultSleep(seconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

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
