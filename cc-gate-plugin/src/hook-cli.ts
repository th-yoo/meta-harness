#!/usr/bin/env bun
/**
 * hook-cli.ts — the Claude Code hook entrypoint: `bun hook-cli.ts <Event>`
 * reads the CC hook JSON on stdin, drives the pure core (edits/prompt/stop)
 * against a FileStateStore, and (for Stop) emits the delivery-mode-shaped
 * stdout/stderr payload built by buildStopOutput.
 *
 * PRIME DIRECTIVE — a broken hook must NEVER break a user's normal CC
 * session. Every code path below either no-ops (exit 0, no output) or emits
 * an INTENTIONAL decision built by the pure core. The only non-zero exit is
 * an intentional block delivered via KKAMAK_DELIVERY=exit2-stderr.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FileStateStore } from "./state.ts"
import { parseGateConfig } from "./config.ts"
import { buildStopOutput } from "./output.ts"
import { handlePostToolUse } from "./core/edits.ts"
import { handleUserPromptSubmit } from "./core/prompt.ts"
import { handleStop } from "./core/stop.ts"
import { maybeSpawnGauge } from "./gauge/spawn.ts"
import { shadowEvaluateAtStop } from "./gauge/shadow.ts"
import { applyReinjectVariant, pickReinjectVariant } from "./reinject.ts"
import { appendCheckOutput, buildCheckOutputRecord } from "./sidecar.ts"
import type { CoreDeps, DeliveryMode, EmitPlan, SensorLine } from "./types.ts"

const MH_CHILD_ENV = "MH_CHILD"
const KM_CHILD_ENV = "KM_CHILD"
const KNOWN_EVENTS = new Set(["PostToolUse", "UserPromptSubmit", "Stop"])
const MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_CHECK_TIMEOUT_MS = 300_000
const DEFAULT_SENSOR_REL_PATH = ".km/gate-outcomes.ndjson"
const GAUGE_CHECK_TIMEOUT_MS = 30_000
const VALID_DELIVERY_MODES: readonly DeliveryMode[] = ["block-json", "exit2-stderr", "block-json+context"]

function capOutput(s: string): string {
  return s.length > MAX_OUTPUT_BYTES ? s.slice(0, MAX_OUTPUT_BYTES) : s
}

/** gate.json at <cwd>/gate.json, read as a raw string; undefined if unreadable. */
function readGateConfigRaw(cwd: string): string | undefined {
  try {
    return fs.readFileSync(path.join(cwd, "gate.json"), "utf-8")
  } catch {
    return undefined
  }
}

// Cache sentinel: `null` = not yet attempted, `undefined` = attempted and
// unreadable/invalid (cached negative — never re-stat every line).
let cachedPluginVersion: string | undefined | null = null

/** cc-gate-plugin version, read once per process from the manifest actually
 * shipped alongside this module. Resolved MODULE-relative (import.meta.dir),
 * never repo-relative: `claude plugin install` copies the whole plugin dir
 * (self-contained.test.ts INSTALL SHAPE proves .claude-plugin/ travels with
 * it), but a repo-relative path would resolve against the copy's cwd and
 * die silently. Fail-open: any read/parse failure just omits the field. */
function readPluginVersion(): string | undefined {
  if (cachedPluginVersion !== null) return cachedPluginVersion
  try {
    const p = path.join(import.meta.dir, "..", ".claude-plugin", "plugin.json")
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as { version?: unknown }
    cachedPluginVersion = typeof parsed.version === "string" ? parsed.version : undefined
  } catch {
    cachedPluginVersion = undefined
  }
  return cachedPluginVersion
}

function sensorFilePath(cwd: string, gateConfigRaw: string | undefined): string {
  const cfg = parseGateConfig(gateConfigRaw)
  // path.resolve (not path.join): an absolute `sensor` must stay absolute —
  // path.join would silently re-root it under cwd. For a relative sensor,
  // resolve behaves the same as join-against-an-absolute-cwd.
  return path.resolve(cwd, cfg?.sensor ?? DEFAULT_SENSOR_REL_PATH)
}

/** mkdir -p the sensor's parent dir then append one ndjson line. Never throws:
 * failures are logged to stderr and swallowed — a sensor-write problem must
 * never change the emitted decision. */
function appendSensor(
  cwd: string,
  gateConfigRaw: string | undefined,
  sensor: SensorLine,
  log: (msg: string) => void,
): void {
  try {
    // pluginVersion stamped here — the single choke point every sensor line
    // (UserPromptSubmit, Stop, and the gauge-fabricated re-stamp) funnels
    // through — so "every emitted line" holds without touching each caller.
    const version = readPluginVersion()
    const stamped = version !== undefined ? { ...sensor, pluginVersion: version } : sensor
    const p = sensorFilePath(cwd, gateConfigRaw)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(stamped) + "\n")
  } catch (e) {
    try {
      log(`hook-cli: failed to append sensor line (swallowed): ${String(e)}`)
    } catch {
      // even logging failed; nothing more to do
    }
  }
}

function buildDeps(cwd: string, gateConfigRaw: string | undefined, timeoutMsOverride?: number): CoreDeps {
  const cfg = parseGateConfig(gateConfigRaw)
  const timeoutMs = timeoutMsOverride ?? cfg?.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS

  return {
    runCheck: (cmd: string) =>
      new Promise((resolve, reject) => {
        let proc: ReturnType<typeof Bun.spawn>
        try {
          proc = Bun.spawn(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" })
        } catch (e) {
          reject(e)
          return
        }

        // Read stdout/stderr concurrently; these resolve once each stream
        // closes, which happens on normal exit OR after proc.kill() below.
        const stdoutP = new Response(proc.stdout as ReadableStream<Uint8Array>).text().catch(() => "")
        const stderrP = new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "")

        // A killed `bash -c` compound command (e.g. `cmd & cmd`) can leave
        // forked grandchildren holding the stdout/stderr pipe fds open —
        // bash does not forward signals to background jobs — so the text
        // promises above may never settle even after the process "exits".
        // Race each against a short grace timer so we never hang the hook.
        const GRACE_MS = 2000
        const withGrace = (p: Promise<string>): Promise<string> =>
          Promise.race([p, new Promise<string>((res) => setTimeout(() => res(""), GRACE_MS))])

        let timedOut = false
        let hasExited = false
        const timer = setTimeout(() => {
          timedOut = true
          try {
            proc.kill() // SIGTERM
          } catch {
            // best-effort kill only
          }
          // Escalate to SIGKILL if the process (group) hasn't actually
          // exited shortly after — SIGTERM alone won't reach grandchildren
          // left behind by a `bash -c 'a & b'` style compound command.
          setTimeout(() => {
            if (!hasExited) {
              try {
                proc.kill("SIGKILL")
              } catch {
                // best-effort only
              }
            }
          }, 1500)
        }, timeoutMs)

        proc.exited
          .then(async (code) => {
            hasExited = true
            clearTimeout(timer)
            const [so, se] = await Promise.all([withGrace(stdoutP), withGrace(stderrP)])
            const combined = capOutput(so + se)
            if (timedOut) {
              // A timeout is a FAILED CHECK, not an internal error: resolve
              // (never reject) so the core folds it into the round outcome.
              resolve({ code: 124, out: combined + "\n[kkamak: check timed out]" })
            } else {
              resolve({ code, out: combined })
            }
          })
          .catch((err) => {
            hasExited = true
            clearTimeout(timer)
            reject(err)
          })
      }),
    now: () => Date.now(),
    hostname: () => os.hostname(),
    log: (msg: string) => console.error(msg),
  }
}

/** Write the EmitPlan's stdout/stderr (awaiting flush) then exit with its code. */
async function emit(plan: EmitPlan): Promise<never> {
  if (plan.stdout) {
    const json = JSON.stringify(plan.stdout)
    await new Promise<void>((resolve) => {
      process.stdout.write(json, () => resolve())
    })
  }
  if (plan.stderr) {
    await new Promise<void>((resolve) => {
      process.stderr.write(plan.stderr!, () => resolve())
    })
  }
  process.exit(plan.exitCode)
}

function resolveDeliveryMode(): DeliveryMode {
  const raw = process.env.KKAMAK_DELIVERY
  return (VALID_DELIVERY_MODES as readonly string[]).includes(raw ?? "") ? (raw as DeliveryMode) : "block-json"
}

async function main(): Promise<void> {
  // 1. Engine-child exclusion — before ANY IO (env lookup is not IO).
  if (process.env[MH_CHILD_ENV] !== undefined || process.env[KM_CHILD_ENV] !== undefined) return

  // 2. Event arg. Unknown/missing event -> exit 0 silently, no stdin read needed.
  const event = process.argv[2]
  if (!event || !KNOWN_EVENTS.has(event)) return

  let raw: string
  try {
    raw = await Bun.stdin.text()
  } catch {
    return
  }

  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }
  if (typeof input !== "object" || input === null) return
  const rec = input as Record<string, unknown>

  const sessionId = rec.session_id
  const cwd = rec.cwd
  if (typeof sessionId !== "string" || !sessionId) return
  if (typeof cwd !== "string" || !cwd) return

  const gateConfigRaw = readGateConfigRaw(cwd)
  const stateDir = path.join(cwd, ".km", "cc-gate")
  const store = new FileStateStore(stateDir)

  if (event === "PostToolUse") {
    const toolName = typeof rec.tool_name === "string" ? rec.tool_name : ""
    const state = store.load(sessionId)
    const next = handlePostToolUse(state, toolName)
    if (next !== state) store.save(sessionId, next)
    return
  }

  if (event === "UserPromptSubmit") {
    const deps = buildDeps(cwd, gateConfigRaw)
    const state = store.load(sessionId)
    const { state: next, sensor } = handleUserPromptSubmit(state, sessionId, gateConfigRaw, deps)
    store.save(sessionId, next)
    if (sensor) appendSensor(cwd, gateConfigRaw, sensor, deps.log)

    // km-gauge (pre-reg §2.2): best-effort, swallowed inside; spawns the
    // detached refiner via a double-fork so the hook returns immediately.
    maybeSpawnGauge({
      cwd,
      sessionID: sessionId,
      prompt: rec.prompt,
      cfg: parseGateConfig(gateConfigRaw),
      env: process.env as Record<string, string | undefined>,
      now: Date.now(),
      spawn: (cmd) => {
        const quoted = cmd.map((c) => `'${c.replace(/'/g, `'\\''`)}'`).join(" ")
        const proc = Bun.spawn(["bash", "-c", `nohup ${quoted} </dev/null >/dev/null 2>&1 &`], {
          stdout: "ignore",
          stderr: "ignore",
        })
        proc.unref()
      },
    })
    return
  }

  // event === "Stop"
  const deps = buildDeps(cwd, gateConfigRaw)
  const state = store.load(sessionId)
  try {
    store.sweep(Date.now())
  } catch {
    // sweep() never throws by contract; belt-and-suspenders only.
  }

  const { state: next, decision, sensor } = await handleStop(
    state,
    { session_id: sessionId, cwd },
    gateConfigRaw,
    deps,
  )

  // (a) Persist BEFORE emitting. A throw here is fail-open: never block on
  // an unrecorded round.
  try {
    store.save(sessionId, next)
  } catch (e) {
    try {
      console.error(`hook-cli: state save failed, failing open: ${String(e)}`)
    } catch {
      // even logging failed; still fail open below
    }
    await emit({ exitCode: 0 })
    return
  }

  // (b) Sensor append never changes the decision. km-gauge shadow eval
  // (pre-reg §2.3) may attach a gauge field or fabricate a gauge-only line —
  // it runs AFTER the decision is final and can only shape what gets logged.
  // The arm is per-session and constant for the session's lifetime: a
  // mid-experiment flip would contaminate both arms.
  const arm = pickReinjectVariant(sessionId)
  // forced:true iff KKAMAK_REINJECT itself picked the arm (env override),
  // not the salted hash — §4.4 exclusion marker. Absent (not false) when
  // unforced: cleaner lines. This is reinject-ONLY: KKAMAK_TRIAL_ARM (§4.3)
  // forcing is never stamped here — the exposure row in
  // `.km/trial-arms.ndjson` is the sole (and authoritative) record of that,
  // enforced from the exposure record at join time, never sensor-side
  // convention (spec §2, plan Global Constraints).
  const reinjectForced = process.env.KKAMAK_REINJECT === "v0" || process.env.KKAMAK_REINJECT === "v1"
  let line: SensorLine | undefined = sensor
    ? { ...sensor, reinject: arm, ...(reinjectForced ? { forced: true } : {}) }
    : undefined
  const cfg = parseGateConfig(gateConfigRaw)
  if (cfg?.gauge && process.env.KKAMAK_GAUGE !== "off") {
    const gaugeDeps = buildDeps(cwd, gateConfigRaw, GAUGE_CHECK_TIMEOUT_MS)
    const gauged = await shadowEvaluateAtStop(cwd, sessionId, cfg, line, gaugeDeps.runCheck, gaugeDeps)
    // Re-stamp the arm: shadowEvaluateAtStop may FABRICATE a gauge-only line
    // (fast-path Stop), which never passed through the stamping above —
    // forced must survive the same re-stamp for the same reason.
    line = gauged
      ? { ...gauged, reinject: arm, ...(reinjectForced ? { forced: true } : {}) }
      : undefined
  }
  if (line) appendSensor(cwd, gateConfigRaw, line, deps.log)

  // Phase 1 check-output sidecar (evidence-only; spec docs/superpowers/
  // specs/2026-07-30-phase1-check-output-sidecar-design.md): capture the
  // failing check output the block branch otherwise discards. PRE-reinject
  // rawOut on purpose — the sidecar records what the check printed, not
  // what delivery shaped. Fail-open inside; never touches gate-outcomes,
  // never changes the decision. Exhausted final rounds are NOT captured:
  // their rawOut never leaves core/stop.ts, and core/ is a MECHANISM_PATH
  // (F1) — documented spec limitation, not an oversight.
  if (decision.kind === "block") {
    appendCheckOutput(
      cwd,
      buildCheckOutputRecord({
        ts: Date.now(),
        sessionID: sessionId,
        round: decision.round,
        roundsMax: decision.roundsMax,
        check: cfg?.check ?? "",
        rawText: decision.rawOut ?? decision.evidence,
      }),
      deps.log,
    )
  }

  // (c) Emit the delivery-mode-shaped plan, with the session's reinject arm
  // applied to block evidence (§4.4 experiment, pre-reg §4b).
  const mode = resolveDeliveryMode()
  const armed = decision.kind === "block"
    ? { ...decision, evidence: applyReinjectVariant(decision.evidence, arm, decision.rawOut) }
    : decision
  await emit(buildStopOutput(armed, mode))
}

main().catch((e) => {
  try {
    console.error(`hook-cli: fatal (swallowed): ${e?.stack ?? e}`)
  } catch {
    // nothing more we can do
  }
  process.exit(0)
})
