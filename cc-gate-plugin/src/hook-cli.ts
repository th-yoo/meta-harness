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
import Anthropic from "@anthropic-ai/sdk"
import { maybeSpawnGauge } from "./gauge/spawn.ts"
import { decideNudge, NUDGE_TIMEOUT_MS } from "./gauge/nudge.ts"
import { readAuthToken } from "./gauge/transport.ts"
import { maybeSpawnPromptCheck } from "./prompt-check-spawn.ts"
import { shadowEvaluateAtStop } from "./gauge/shadow.ts"
import { applyReinjectVariant, pickReinjectVariant } from "./reinject.ts"
import { appendCheckOutput, buildCheckOutputRecord } from "./sidecar.ts"
import { captureFixtureRef, bunGitRunner } from "./fixture-ref.ts"
import { appendSensor } from "./sensor-append.ts"
import { runCheck } from "./check-runner.ts"
import type { CoreDeps, DeliveryMode, EmitPlan, GaugeOffReason, SensorLine } from "./types.ts"

const MH_CHILD_ENV = "MH_CHILD"
const KM_CHILD_ENV = "KM_CHILD"
const KNOWN_EVENTS = new Set(["PostToolUse", "UserPromptSubmit", "Stop"])
const DEFAULT_CHECK_TIMEOUT_MS = 300_000
const GAUGE_CHECK_TIMEOUT_MS = 30_000
const VALID_DELIVERY_MODES: readonly DeliveryMode[] = ["block-json", "exit2-stderr", "block-json+context"]

/** gate.json at <cwd>/gate.json, read as a raw string; undefined if unreadable. */
function readGateConfigRaw(cwd: string): string | undefined {
  try {
    return fs.readFileSync(path.join(cwd, "gate.json"), "utf-8")
  } catch {
    return undefined
  }
}

function buildDeps(cwd: string, gateConfigRaw: string | undefined, timeoutMsOverride?: number): CoreDeps {
  const cfg = parseGateConfig(gateConfigRaw)
  const timeoutMs = timeoutMsOverride ?? cfg?.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS

  return {
    // Thin wrapper over check-runner.ts's runCheck, binding cwd and the
    // resolved timeout. `ms` is discarded here — core callers (CoreDeps)
    // don't consume it; T3's detached runner reads it directly off
    // check-runner's own return.
    runCheck: (cmd: string) =>
      runCheck(cmd, cwd, timeoutMs).then(({ code, out }) => ({ code, out })),
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
  const transcriptPath = typeof rec.transcript_path === "string" && rec.transcript_path
    ? rec.transcript_path : undefined
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

    // 5th pre-data amendment (prompt-check): accompany, never replace — the
    // skippedStop line above is already appended; this only SPAWNS, detached.
    maybeSpawnPromptCheck({
      cwd,
      sessionID: sessionId,
      sensor,
      cfg: parseGateConfig(gateConfigRaw) ?? undefined,
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

    // Channel-ladder T5b (spec §5): C4 nudge — soft additionalContext ONLY.
    // cfg.channelNudge !== true skips this entire block: no model call, no
    // output, byte-identical to pre-T5b behavior (inertness is the
    // contract). When armed, decideNudge owns prefilter → transport →
    // 8s-budget race → parse; anything but a parsed C4 returns undefined
    // and we emit nothing (fail-open family rule — a broken channel
    // classification must never surface or block a prompt).
    const nudgeCfg = parseGateConfig(gateConfigRaw)
    if (nudgeCfg?.channelNudge === true) {
      try {
        const env = process.env as Record<string, string | undefined>
        const ctx = await decideNudge(
          {
            // Real SDK transport: same auth/base-URL seams + OAuth-only
            // client shape as gauge/transport.ts sdkComplete (unexported
            // there), minus structured outputs — parseChannelOutput is
            // shape-only and fence-tolerant. claude-opus-5: channel
            // classification is judgment (sonnet=subject, opus=judgment),
            // and like cls-label it is never routed through
            // KKAMAK_GAUGE_MODEL.
            transport: async (messageText) => {
              const authToken = readAuthToken(env)
              if (!authToken) return undefined
              const client = new Anthropic({
                authToken,
                apiKey: null,
                ...(env.KKAMAK_GAUGE_SDK_BASE_URL ? { baseURL: env.KKAMAK_GAUGE_SDK_BASE_URL } : {}),
                maxRetries: 0,
                timeout: NUDGE_TIMEOUT_MS,
                defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
              })
              const response = await client.messages.create({
                model: "claude-opus-5",
                max_tokens: 512,
                messages: [{ role: "user", content: messageText }],
              })
              for (const block of response.content) {
                if (block.type === "text" && block.text) return block.text
              }
              return undefined
            },
          },
          typeof rec.prompt === "string" ? rec.prompt : "",
          nudgeCfg,
        )
        if (ctx) {
          await emit({
            stdout: {
              hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx },
            },
            exitCode: 0,
          })
        }
      } catch {
        // Fail-open: emit nothing, exit 0 — the prompt proceeds untouched.
      }
    }
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
  const reinjectForced = process.env.KKAMAK_REINJECT === "v0" || process.env.KKAMAK_REINJECT === "v1" || process.env.KKAMAK_REINJECT === "v2"
  let line: SensorLine | undefined = sensor
    ? { ...sensor, reinject: arm, ...(reinjectForced ? { forced: true } : {}) }
    : undefined
  const cfg = parseGateConfig(gateConfigRaw)
  // Instrument state, not gate state (pre-reg §6b amendment, 2026-08-01). An
  // omitted gauge field cannot distinguish "ran, nothing to say" from "never
  // ran" — and on 2026-08-01 the second went unnoticed for two cycles after a
  // review removed `gauge` from gate.json. Silence is the one thing a
  // measurement instrument must not do.
  const gaugeOff: GaugeOffReason | undefined = !cfg?.gauge
    ? "disabled"
    : process.env.KKAMAK_GAUGE === "off"
      ? "env-off"
      : undefined
  if (!gaugeOff) {
    const gaugeDeps = buildDeps(cwd, gateConfigRaw, GAUGE_CHECK_TIMEOUT_MS)
    const gauged = await shadowEvaluateAtStop(cwd, sessionId, cfg!, line, gaugeDeps.runCheck, gaugeDeps)
    // Re-stamp the arm: shadowEvaluateAtStop may FABRICATE a gauge-only line
    // (fast-path Stop), which never passed through the stamping above —
    // forced must survive the same re-stamp for the same reason.
    line = gauged
      ? { ...gauged, reinject: arm, ...(reinjectForced ? { forced: true } : {}) }
      : undefined
  }
  // Annotate only; never fabricate. A line that already carries a real gauge
  // record keeps it, and a dropped line stays dropped — this must not change
  // which lines exist, only what an existing line admits about the instrument.
  if (line && !line.gauge) {
    line = { ...line, gauge: { present: false, offReason: gaugeOff ?? "no-record" } }
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
    const blockTs = Date.now()
    appendCheckOutput(
      cwd,
      buildCheckOutputRecord({
        ts: blockTs,
        sessionID: sessionId,
        round: decision.round,
        roundsMax: decision.roundsMax,
        check: cfg?.check ?? "",
        rawText: decision.rawOut ?? decision.evidence,
      }),
      deps.log,
    )
    // Phase 2 fixture ref (evidence-only): snapshot the dirty tree that the
    // failing check saw. Fail-open inside; never touches gate-outcomes,
    // never changes the decision. Shares blockTs with the check-output
    // record — (sessionID, ts, round) is the harvest join key.
    await captureFixtureRef(
      { cwd, ts: blockTs, sessionID: sessionId, round: decision.round, check: cfg?.check ?? "", transcriptPath },
      bunGitRunner,
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
