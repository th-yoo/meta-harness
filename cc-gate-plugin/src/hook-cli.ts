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
import { FileStateStore, saveResetWithRetry } from "./state.ts"
import { parseGateConfig } from "./config.ts"
import { isInitialState } from "./types.ts"
import { buildStopOutput } from "./output.ts"
import { handlePostToolUse } from "./core/edits.ts"
import { handleUserPromptSubmit } from "./core/prompt.ts"
import { handleStop } from "./core/stop.ts"
import { maybeSpawnGauge } from "./gauge/spawn.ts"
import { decideNudge, NUDGE_TIMEOUT_MS } from "./gauge/nudge.ts"
import { sdkCall } from "./gauge/transport.ts"
import { maybeSpawnPromptCheck } from "./prompt-check-spawn.ts"
import { maybeSpawnReviewSensor } from "./review-sensor-spawn.ts"
import { shadowEvaluateAtStop } from "./gauge/shadow.ts"
import { applyReinjectVariant, pickReinjectVariant } from "./reinject.ts"
import { appendCheckOutput, buildCheckOutputRecord } from "./sidecar.ts"
import { captureFixtureRef, bunGitRunner } from "./fixture-ref.ts"
import { appendSensor } from "./sensor-append.ts"
import { runCheck } from "./check-runner.ts"
import { evaluateRuleChecks } from "./rule-checks.ts"
import { readAndConsumeHookRuleOutcomes } from "./hook-rule-outcomes.ts"
import type { CcGateState, CoreDeps, DeliveryMode, EmitPlan, GaugeOffReason, SensorLine } from "./types.ts"

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

/**
 * The single CAS-aware persist path, shared by all three hook events. Three
 * ways, keyed on how `next` relates to the loaded `prev`:
 *   - `next === prev` (pure pass-through, same reference): NO save at all.
 *     The store's save() re-stamps updatedAt, so an unconditional write here
 *     would re-date a file that didn't change — the only liveness signal
 *     sweep reads (an accepted, kkamak-parity behavior change).
 *   - changed AND `isInitialState(next)`: this is a RESET (every core reset
 *     site returns a bare {...INITIAL_STATE}). Route through never-throwing
 *     `saveResetWithRetry` — a reset is unconditional intent, so a lost CAS
 *     race retries once rather than being dropped.
 *   - changed AND non-initial: a real progress write (block/round advance,
 *     edit-tag). CAS save; on a lost race, `onNonResetFailure` decides the
 *     fail-open shape (Stop discards the block + emits exit 0; Prompt/
 *     PostToolUse log quietly and continue). The non-initial arm is also the
 *     structural safety net a future changed-but-non-initial prompt return
 *     falls into, instead of a reset-retry clobber.
 */
function dispatchSave(
  store: FileStateStore,
  sessionId: string,
  prev: CcGateState,
  next: CcGateState,
  log: (msg: string) => void,
  onNonResetFailure: (err: unknown) => void,
): void {
  if (next === prev) return
  if (isInitialState(next)) {
    saveResetWithRetry(store, sessionId, next, prev.updatedAt, log)
    return
  }
  try {
    store.save(sessionId, next, prev.updatedAt)
  } catch (err) {
    onNonResetFailure(err)
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
    // A1 cycle-tagging: the edited path rides tool_input.file_path on CC's
    // PostToolUse payload (same extraction the kkamak kernel confirmed
    // against a captured payload). Absent/malformed → undefined; the
    // handler still arms, it just records no path.
    const ti = rec.tool_input
    const filePath =
      typeof ti === "object" && ti !== null &&
      typeof (ti as Record<string, unknown>).file_path === "string"
        ? ((ti as Record<string, unknown>).file_path as string)
        : undefined
    const state = store.load(sessionId)
    const next = handlePostToolUse(state, toolName, filePath)
    // PostToolUse never builds deps; a lost CAS race here is a dropped
    // telemetry write (kkamak onFileEdited parity), self-heals next edit —
    // quiet inline log, NOT a propagate-to-main().catch "fatal". next is
    // never initial (edits.ts always sets edited:true), so the reset arm is
    // dead here; harmless.
    dispatchSave(store, sessionId, state, next, (m) => console.error(m), (err) =>
      console.error(`cc-gate: edit state save lost race, record dropped: ${String(err)}`),
    )
    return
  }

  if (event === "UserPromptSubmit") {
    const deps = buildDeps(cwd, gateConfigRaw)
    const state = store.load(sessionId)
    const { state: next, sensor } = handleUserPromptSubmit(state, sessionId, gateConfigRaw, deps)
    // Changed prompt returns are all bare resets today; the reset arm carries
    // them via never-throwing saveResetWithRetry. A lost race can no longer
    // abort the sensor append or the spawns below (the pre-CAS unconditional
    // save could throw straight into main().catch and skip all of it).
    dispatchSave(store, sessionId, state, next, deps.log, (err) =>
      deps.log(`cc-gate: prompt state save lost race, dropped: ${String(err)}`),
    )
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
            // Real SDK transport: gauge/transport.ts `sdkCall` — same
            // auth/base-URL seams + OAuth-only client shape as every gauge
            // call, minus structured outputs (no schema knob) —
            // parseChannelOutput is shape-only and fence-tolerant. Nudge
            // knobs: 8s budget (NUDGE_TIMEOUT_MS), 512 tokens.
            // claude-opus-5: channel classification is judgment
            // (sonnet=subject, opus=judgment), and like cls-label it is
            // never routed through KKAMAK_GAUGE_MODEL.
            transport: (messageText) =>
              sdkCall(messageText, "claude-opus-5", env, {}, {
                maxTokens: 512,
                timeoutMs: NUDGE_TIMEOUT_MS,
              }),
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
  // sweep runs LATE (just before the final emit), not here: with CAS, sweeping
  // before this session's own save would delete a 7-day-stale record out from
  // under the load below and self-inflict a stale-write refusal. See the late
  // sweep call at the end of this handler.
  const deps = buildDeps(cwd, gateConfigRaw)
  const state = store.load(sessionId)

  const { state: next, decision, sensor } = await handleStop(
    state,
    { session_id: sessionId, cwd },
    gateConfigRaw,
    deps,
  )

  // (a) Persist BEFORE emitting. Fail-open: a lost CAS race on a real
  // progress write (block/round advance) is treated exactly like ENOSPC —
  // discard the block, emit exit 0, never wedge the session. A reset
  // (isInitialState) is carried by saveResetWithRetry and never downgrades an
  // allow. A pure pass-through (next===state, the common unarmed Stop) writes
  // nothing.
  let saveFailedOpen = false
  dispatchSave(store, sessionId, state, next, deps.log, (e) => {
    try {
      console.error(`hook-cli: state save failed, failing open: ${String(e)}`)
    } catch {
      // even logging failed; still fail open below
    }
    saveFailedOpen = true
  })
  if (saveFailedOpen) {
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
  // a3 live adapter: shadow rule checks — annotation only, after the Stop
  // decision is final and after every `line` reassignment (gauge replace,
  // no-record annotation); fail-open inside evaluateRuleChecks. Skip
  // evaluation entirely when no line will be emitted this Stop — don't
  // burn the budget for a line that won't exist.
  if (line) {
    const ruleChecks = await evaluateRuleChecks(cwd, (cmd, c, t) => runCheck(cmd, c, t))
    if (ruleChecks) line = { ...line, ruleChecks }
  }
  // hook-rule evolution P2: consume the dispatch-side per-session
  // accumulator and annotate — same discipline as ruleChecks above
  // (annotation only, after the decision is final, fail-open inside).
  if (line) {
    const hookRules = readAndConsumeHookRuleOutcomes(cwd, sessionId)
    if (hookRules) line = { ...line, hookRules }
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

  // review-sensor (spec 2026-08-05): detached BEFORE emit(); second detached
  // child on a gated Stop alongside gate-check's own spawnBg — declared, no
  // conflict.
  maybeSpawnReviewSensor({
    cwd,
    env: process.env as Record<string, string | undefined>,
    spawn: (cmd) => {
      const quoted = cmd.map((c) => `'${c.replace(/'/g, `'\\''`)}'`).join(" ")
      const proc = Bun.spawn(["bash", "-c", `nohup ${quoted} </dev/null >/dev/null 2>&1 &`], {
        stdout: "ignore",
        stderr: "ignore",
      })
      proc.unref()
    },
  })

  // Sweep LAST, after this session's own save landed (so its fresh record is
  // never a sweep target) and before the terminal emit() — emit() is
  // Promise<never> (process.exit), so anything after it is dead code. Runs
  // unconditionally after dispatchSave, including the no-save pass-through
  // arm (the most common Stop): sweep is per-directory hygiene, not gated on
  // whether THIS session wrote. sweep() never throws by contract.
  try {
    store.sweep(Date.now())
  } catch {
    // belt-and-suspenders only.
  }

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
