import type { CoreDeps, RoundOutcome, SensorLine } from "../types.ts"

export function buildSensorLine(
  deps: CoreDeps,
  args: {
    sessionID: string
    check: string
    accepted: boolean
    gateExhausted: boolean
    rounds: RoundOutcome[]
    interrupted: boolean
    marker: boolean
    durationMs: number
    // §4.3 amendment (Task 1 of §11 item 6) — both optional & passed
    // through only when the caller supplies them, so callers that omit
    // them (stop.ts/prompt.ts today) produce byte-identical lines to
    // before this amendment.
    forced?: boolean
    pluginVersion?: string
    // Task 1 (fix-them-serialized-teacup plan) amendment — same
    // spread-only-when-defined discipline, so callers that omit it (every
    // caller except the new prompt.ts skipped-Stop marker) produce
    // byte-identical lines to before this amendment.
    skippedStop?: true
    // Task 2 (fix-them-serialized-teacup plan) amendment — same
    // spread-only-when-defined discipline; stop.ts is the only caller that
    // ever supplies it (accept/exhaust points), so every other caller
    // (and every pre-amendment line) is byte-identical.
    checkMs?: number[]
    // A1 cycle-tagging amendment (2026-08-13) — same spread-only-when-
    // defined discipline; suppliers are the cycle-CLOSING lines only
    // (stop.ts accept/exhaust, prompt.ts interrupted). A skippedStop
    // diagnostic line never carries them. Booleans only — a raw path
    // must never reach this builder.
    implOnly?: boolean
    sameTurnCoEdit?: boolean
  },
): SensorLine {
  return {
    ts: deps.now(),
    sessionID: args.sessionID,
    check: args.check,
    accepted: args.accepted,
    gateExhausted: args.gateExhausted,
    rounds: args.rounds,
    interrupted: args.interrupted,
    marker: args.marker,
    durationMs: args.durationMs,
    host: deps.hostname(),
    app: "claude-code",
    ...(args.forced !== undefined ? { forced: args.forced } : {}),
    ...(args.pluginVersion !== undefined ? { pluginVersion: args.pluginVersion } : {}),
    ...(args.skippedStop !== undefined ? { skippedStop: args.skippedStop } : {}),
    ...(args.checkMs !== undefined ? { checkMs: args.checkMs } : {}),
    ...(args.implOnly !== undefined ? { implOnly: args.implOnly } : {}),
    ...(args.sameTurnCoEdit !== undefined ? { sameTurnCoEdit: args.sameTurnCoEdit } : {}),
  }
}
