/**
 * gate-plugin/src/core.ts — standalone completion-gate plugin core
 * (design: docs/2026-07-25-daily-evolution-loop.md §4.1; engine-free).
 * Round semantics reused from minimal/complete-gate.ts. v1: mutants=0.
 * Marker default OFF (C2 verdict, HISTORY.md; overrides hygiene doc §4).
 */
import { runCompletionGate, type GateIO } from "../../minimal/complete-gate.ts"
import { HYGIENE_MARKER } from "../../minimal/session2.ts"

export interface GateConfig {
  check: string
  rounds: number
  marker: boolean
  sensor: string
}

export function parseGateConfig(raw: string): GateConfig | undefined {
  try {
    const j = JSON.parse(raw)
    if (typeof j.check !== "string" || !j.check) return undefined
    return {
      check: j.check,
      rounds: typeof j.rounds === "number" ? j.rounds : 2,
      marker: j.marker === true,
      sensor: typeof j.sensor === "string" ? j.sensor : ".meta-harness/gate-outcomes.ndjson",
    }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// makeGateHooks — the full hook factory, pure and dependency-injected.
// ---------------------------------------------------------------------------

export interface GateDeps {
  readGateConfig(): string | undefined // gate.json content or undefined
  runCheck(cmd: string): Promise<{ code: number; out: string }>
  promptSession(sessionID: string, text: string): Promise<boolean>
  toast(message: string, variant: "info" | "success" | "warning" | "error"): Promise<void>
  appendSensor(relPath: string, line: string): void
  now(): number
}

const EDIT_TOOLS = new Set(["write", "edit", "patch", "multiedit"])
const OUT_TAIL = 600

export function makeGateHooks(deps: GateDeps): {
  toolExecuteAfter(tool: string, sessionID: string): void
  chatMessage(sessionID: string): void
  sessionIdle(sessionID: string): Promise<void>
} {
  const edited = new Set<string>() // sessions with un-gated edits
  const gating = new Set<string>() // gate loop currently running
  const interrupted = new Set<string>() // human typed while gating

  return {
    toolExecuteAfter(tool: string, sessionID: string): void {
      // Edits made by the reinjected agent during gating DO mark `edited`
      // here (no gating guard) — but the unconditional `edited.delete`
      // below at gate completion wipes them again, so a mid-gate edit can
      // never by itself trigger a second gate run (contract 11). That
      // unconditional delete is the actual no-infinite-re-gate mechanism.
      if (EDIT_TOOLS.has(tool)) edited.add(sessionID)
    },
    chatMessage(sessionID: string): void {
      if (gating.has(sessionID)) interrupted.add(sessionID) // contract 10
    },
    async sessionIdle(sessionID: string): Promise<void> {
      if (gating.has(sessionID)) return
      if (!edited.has(sessionID)) return
      const raw = deps.readGateConfig()
      if (!raw) return
      const cfg = parseGateConfig(raw)
      if (!cfg) return
      gating.add(sessionID)
      interrupted.delete(sessionID)
      const t0 = deps.now()
      try {
        const io: GateIO = {
          verifyExists: () => true,
          runVerify: async () => deps.runCheck(cfg.check),
          readArtifact: () => "", // v1: no mutation probe
          writeArtifact: () => false,
          restoreArtifact: () => true,
          syntaxOk: () => true,
          reinject: async (message: string) => {
            if (interrupted.has(sessionID)) return false
            await deps.toast(`gate: check failed — reinjecting evidence`, "warning")
            // Defensive cap on the reinject prompt size: complete-gate already
            // tails failing verify output to OUT_TAIL (600) chars, but the
            // surrounding explanatory text is unbounded, so cap the whole
            // message (4000 chars of context + the 600-char tail budget) to
            // keep a single reinject prompt from ballooning the session.
            return deps.promptSession(sessionID, message.slice(0, 4000 + OUT_TAIL))
          },
        }
        const result = await runCompletionGate(io, { rounds: cfg.rounds, mutants: 0 })
        deps.appendSensor(
          cfg.sensor,
          JSON.stringify({
            ts: deps.now(),
            sessionID,
            check: cfg.check,
            accepted: result.accepted,
            gateExhausted: result.gateExhausted,
            rounds: result.rounds.map((r) => r.outcome),
            interrupted: interrupted.has(sessionID),
            marker: cfg.marker,
            durationMs: deps.now() - t0,
          }),
        )
        if (result.gateExhausted) await deps.toast(`gate: rounds exhausted — accepting anyway`, "warning")
        else await deps.toast(`gate: check passed`, "success")
        if (cfg.marker && result.accepted && !result.gateExhausted) await deps.promptSession(sessionID, HYGIENE_MARKER)
        // Unconditional: clears both the pre-gate edit that armed this run
        // AND any edits the reinjected agent made mid-gate (toolExecuteAfter
        // no longer special-cases `gating`). This IS the no-infinite-re-gate
        // mechanism — see the comment on toolExecuteAfter above.
        edited.delete(sessionID)
      } finally {
        gating.delete(sessionID)
        interrupted.delete(sessionID)
      }
    },
  }
}
