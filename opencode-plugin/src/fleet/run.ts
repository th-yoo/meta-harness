/**
 * run.ts — headless leaf-node drive (spec §5): render check → spawn via
 * AgentDriver shapes → parse → classify → pending file. No retry loop here:
 * the squad runner / master owns retries (spec §3).
 *
 * Reality-binding notes (vs. the task brief's sketch — see task-5-report.md
 * for the full trace):
 *
 *  - `classifyAttempt` (drivers/opencode.ts, typed in drivers/types.ts) takes
 *    a single `ExecResult` (`{rc,stdout,stderr,timedOut}`, bench/exec.ts) —
 *    not `(stdout, rc)` — and returns a bare `"auth"|"transient"|"done"`
 *    string, not `{kind,hint}`. There is no `"timeout"` AttemptClass at all.
 *    The one real caller (agent-run.ts's `runAgent`) checks
 *    `result.timedOut` and returns early BEFORE calling `classifyAttempt` —
 *    correct, because `classifyAttempt`'s TRANSIENT_RE/hadActivity logic
 *    would otherwise call an externally-killed timeout "done" whenever any
 *    turn happened before the kill. This module mirrors that exact ordering.
 *    `authHint` also lives on the driver object (`opencodeDriver.authHint`),
 *    not on the classification result.
 *
 *  - `ExecFn`'s return type gains optional `stderr?`/`timedOut?` fields
 *    (structurally compatible with the brief's `{stdout,rc}` — the test's
 *    inline execFns that omit them still typecheck) so `defaultExec` can
 *    report a real timeout without breaking the documented shape.
 *    `defaultExec` is `bench/exec.ts`'s `runHost` — this codebase's "single
 *    spawn funnel" (see that file's header: concurrent stdout/stderr drain
 *    to dodge a pipe-buffer deadlock, `timeoutSec` timer, rc-124 handling) —
 *    rather than a second raw `Bun.spawn` call site reimplementing the same
 *    footguns.
 *
 *  - `opencodeDriver.parseOutput(stdout).events` is `TrajEvent[]`
 *    (harness-store.ts) — the compact output of `normalizeEvents`, which
 *    silently DROPS `step_finish` lines (no branch handles that event type)
 *    and has no `sessionID`/`tokens`/`cost` fields in its
 *    `{t,tool,args,output,error,text}` shape. None of step_finish segment
 *    boundaries, sessionID, or tokens/cost survive that transform, so
 *    `extractFinalPayload`/`extractSessionId`/`sumTokens`/`sumCost` all read
 *    the RAW per-line NDJSON (parsed locally with the same
 *    trim/skip-non-'{'/try-catch idiom `parseOutput` itself uses) instead —
 *    exactly what the brief's own Step-1 test does
 *    (`multiTurn.trim().split("\n").map(JSON.parse)` passed straight into
 *    `extractFinalPayload`). `turnCount`/`toolUsage` still come from the
 *    real `opencodeDriver.parseOutput` — the single source of truth the
 *    rest of the bench harness already trusts for turn/tool-error counting.
 *    `toolUsage` there is `Record<string,{calls,errors}>`
 *    (harness-store.ts's `ToolUsage`); the wire-level `FleetPendingSession`/
 *    `RoleRunResult` shapes want `Record<string, number>` (call counts) per
 *    the brief's literal interface, so it's collapsed via `toolCallCounts`.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { roleSpec } from "./roles.ts"
import { parseStamp } from "./render.ts"
import { writePending, type FleetPendingSession } from "./pending.ts"
import { sandboxEnv } from "./sandbox.ts"
import { opencodeDriver } from "../bench/drivers/opencode.ts"
import { runHost } from "../bench/exec.ts"
import { die } from "../bench/util.ts"
import type { ToolUsage } from "../harness-store.ts"

export interface RoleRunResult {
  id: string
  payload: string
  turnCount: number
  toolUsage: Record<string, number>
}

export type ExecFn = (
  argv: string[],
  opts: { timeoutSec: number; env?: Record<string, string> },
) => Promise<{ stdout: string; rc: number; stderr?: string; timedOut?: boolean }>

/** Real default: bench/exec.ts's `runHost` (the project's single spawn
 * funnel — see file header). Tests always inject their own `execFn`; this
 * is never exercised hermetically. */
const defaultExec: ExecFn = (argv, opts) => runHost(argv, { timeoutSec: opts.timeoutSec, env: opts.env })

/** Same per-line parse `drivers/opencode.ts`'s `parseOutput`/`normalizeEvents`
 * use (trim, skip non-'{' lines, tolerate unparseable JSON) — kept local
 * because raw events (with `sessionID`/step_finish/`tokens`/`cost` intact)
 * are what this module needs, not `parseOutput`'s compacted `TrajEvent[]`. */
function parseNdjsonLines(stdout: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim()
    if (!line.startsWith("{")) continue
    try {
      out.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      continue
    }
  }
  return out
}

/** Text-bearing fields of a `"text"` event — same fields
 * `normalizeEvents`'s `text` branch reads (`ev.text` / `ev.part.text`). Any
 * other event type (tool_use, step_finish, error, …) contributes nothing to
 * the payload. */
function extractText(ev: Record<string, unknown>): string {
  if (ev["type"] !== "text") return ""
  const part = (ev["part"] as Record<string, unknown>) ?? {}
  const txt = (ev["text"] as string) || (part["text"] as string) || ""
  return typeof txt === "string" ? txt : ""
}

/** First `sessionID` found on any raw event (top-level, falling back to
 * `part.sessionID`) — per T0 result 4, every `--format json` NDJSON event
 * carries the genuine opencode `sessionID` (`ses_…`). */
function extractSessionId(events: Array<Record<string, unknown>>): string | undefined {
  for (const ev of events) {
    const id = ev["sessionID"]
    if (typeof id === "string" && id.trim()) return id
    const part = ev["part"] as Record<string, unknown> | undefined
    const pid = part?.["sessionID"]
    if (typeof pid === "string" && pid.trim()) return pid
  }
  return undefined
}

/** Sum `step_finish` events' `part.tokens.{input,output}`. */
function sumTokens(events: Array<Record<string, unknown>>): { input: number; output: number } {
  let input = 0
  let output = 0
  for (const ev of events) {
    if (ev["type"] !== "step_finish") continue
    const part = (ev["part"] as Record<string, unknown>) ?? {}
    const tokens = (part["tokens"] as Record<string, unknown>) ?? {}
    input += Number(tokens["input"]) || 0
    output += Number(tokens["output"]) || 0
  }
  return { input, output }
}

/** Sum `step_finish` events' `part.cost`. */
function sumCost(events: Array<Record<string, unknown>>): number {
  let cost = 0
  for (const ev of events) {
    if (ev["type"] !== "step_finish") continue
    const part = (ev["part"] as Record<string, unknown>) ?? {}
    cost += Number(part["cost"]) || 0
  }
  return cost
}

/** `ToolUsage` (Record<string,{calls,errors}>) → wire-level call counts
 * (Record<string, number>) — see file header. */
function toolCallCounts(toolUsage: ToolUsage): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [tool, usage] of Object.entries(toolUsage)) out[tool] = usage.calls
  return out
}

/** Last step_finish-delimited segment's joined text — the final message IS
 * the payload (fleet wire contract). Operates on RAW NDJSON-parsed events
 * (see file header) — `events` here is deliberately `unknown[]` so callers
 * can pass either the module's own `parseNdjsonLines` output or (as the
 * test does) `JSON.parse`d fixture lines directly. */
export function extractFinalPayload(events: unknown[]): string {
  const segments: string[][] = [[]]
  for (const raw of events) {
    const ev = raw as Record<string, unknown>
    if (ev["type"] === "step_finish") {
      segments.push([])
      continue
    }
    const text = extractText(ev)
    if (text) segments[segments.length - 1]!.push(text)
  }
  for (let i = segments.length - 1; i >= 0; i--) {
    const joined = segments[i]!.join("\n").trim()
    if (joined) return joined
  }
  return ""
}

export async function cmdRoleRun(
  args: {
    project: string
    role: string
    input: string
    model?: string
    nodePath?: string
    sliceId?: string
    timeoutSec?: number
    json?: boolean
    /** When true, suppress ALL stdout/stderr output this call would
     * otherwise print (the payload console.log, the `id:` console.error,
     * and the `--json` envelope) — e.g. squad-run's prod DriveFn, which
     * drives several role-runs per outcome and needs the final outcome
     * JSON to be the only line on stdout. Return value unchanged. Default
     * false — standalone `role-run` CLI behavior is unaffected. */
    silent?: boolean
  },
  execFn: ExecFn = defaultExec,
): Promise<RoleRunResult> {
  const spec = roleSpec(args.role)
  const mdPath = join(args.project, ".opencode", "agents", `${spec.agent}.md`)
  if (!existsSync(mdPath)) die(`no rendered persona at ${mdPath} — run roles-render first`)
  const stamp = parseStamp(readFileSync(mdPath, "utf-8")) ?? undefined

  const model = args.model ?? spec.model
  const timeoutSec = args.timeoutSec ?? 600
  const argv = [
    "opencode", "run", "--dir", args.project, "--agent", spec.agent,
    "--auto", "--format", "json", "--model", model, args.input,
  ]
  // Squad-spawned bash:allow roles (implementer/evaluator) run `opencode run`
  // with the owner's full ambient env by default (runHost merges onto
  // process.env) — that includes remote-write git/gh credentials. sandboxEnv
  // returns a blocking override + a cleanup handle for those roles
  // (undefined for bash:deny roles, which can't exec anything anyway —
  // behavior there is byte-identical to before this change). The tmp files
  // sandboxEnv writes (per-role git config, empty gh config dir) MUST be
  // shredded even if the drive dies partway through — see fleet/sandbox.ts.
  const sbx = sandboxEnv(spec)
  try {
    const { stdout, rc, stderr, timedOut } = await execFn(argv, { timeoutSec, env: sbx?.env })

    // Timeout is checked BEFORE classification — see file header (agent-run.ts
    // parity: a timed-out kill mid-run can otherwise read as "done").
    if (timedOut) die(`timeout driving ${spec.agent} (${timeoutSec}s) — re-drive`)

    const cls = opencodeDriver.classifyAttempt({ rc, stdout, stderr: stderr ?? "", timedOut: false })
    if (cls === "auth") die(`auth error driving ${spec.agent}: ${opencodeDriver.authHint ?? "check opencode auth"}`)
    if (cls === "transient") die(`transient error driving ${spec.agent} — re-drive`)

    const parsed = opencodeDriver.parseOutput(stdout)
    if (parsed.turnCount === 0 || parsed.events.length === 0) {
      die(`${spec.agent} produced 0 turns / no events — nothing recorded`)
    }

    const rawEvents = parseNdjsonLines(stdout)
    const id = extractSessionId(rawEvents) ?? `fleet-${args.role}-${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString("hex")}`
    const payload = extractFinalPayload(rawEvents)
    const toolUsage = toolCallCounts(parsed.toolUsage)

    const pending: FleetPendingSession = {
      id, role: args.role, agent: spec.agent, project: args.project, model,
      turnCount: parsed.turnCount, toolUsage,
      payload, events: rawEvents,
      nodePath: args.nodePath, sliceId: args.sliceId, renderStamp: stamp,
      tokens: sumTokens(rawEvents), cost: sumCost(rawEvents),
      ts: new Date().toISOString(),
    }
    writePending(pending)

    const result: RoleRunResult = { id, payload, turnCount: parsed.turnCount, toolUsage }
    if (!args.silent) {
      if (args.json) console.log(JSON.stringify(result))
      else {
        console.log(payload)
        console.error(`id: ${id}`)
      }
    }
    return result
  } finally {
    sbx?.cleanup()
  }
}
