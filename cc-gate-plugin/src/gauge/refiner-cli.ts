#!/usr/bin/env bun
/**
 * refiner-cli.ts — the detached km-gauge derivation child (pre-reg §2.2):
 * `bun refiner-cli.ts <cwd> <sessionID> <n>`. Reads the .req.json written by
 * maybeSpawnGauge, makes ONE small-model call over the direct Anthropic API
 * (§6c amendment, 2026-08-02 — previously a `claude -p` child that dragged
 * ~28k tokens of CC harness into every derivation), writes the pending gauge
 * file atomically, deletes the req. Any failure = silent exit 0 with the req
 * cleaned up — a missing gauge file is a recorded M0 coverage miss, never a
 * session problem.
 */
import fs from "node:fs"
import path from "node:path"
import { parseRefinerOutput } from "./refiner.ts"
import { callModelSdk, resolveModelId, selectTransport } from "./transport.ts"
import { validateDerivation } from "./validate.ts"
import { gaugeDir, writeGaugeFile } from "./files.ts"

async function main(): Promise<void> {
  const [cwd, sessionID, nStr] = process.argv.slice(2)
  const n = Number(nStr)
  if (!cwd || !sessionID || !Number.isInteger(n) || n < 1) return

  const dir = gaugeDir(cwd)
  const reqPath = path.join(dir, `${sessionID}-${n}.req.json`)

  let prompt: string
  let floorCheck: string
  try {
    const req = JSON.parse(fs.readFileSync(reqPath, "utf-8"))
    if (typeof req?.prompt !== "string" || !req.prompt) throw new Error("bad req")
    prompt = req.prompt
    // Stale v1 req tolerance: no floorCheck key at all → treat as unarmed.
    floorCheck = typeof req?.floorCheck === "string" ? req.floorCheck : ""
  } catch {
    return
  }

  try {
    const started = Date.now()
    // §6d "Selection is PER-CALLER, not a global default": this file is the
    // LIVE derive path (the Stop-hook's detached child) and MUST stay pinned
    // to transport "sdk" forever — it runs on haiku, which is not
    // rate-walled, so routing it through the Agent SDK would only pay
    // ~1.25s of subprocess spawn + ~423 bytes of /clear echo per Stop hook
    // for zero benefit. `KKAMAK_GAUGE_TRANSPORT=agent-sdk` is an opt-in for
    // BATCH callers (corpus-replay.ts) only; if it is ever exported in a
    // shell profile, tmux launcher, or wrapper that also happens to run this
    // process, it must NOT silently reroute the live path. Strip it from the
    // env view used here (never mutate process.env itself) so BOTH the
    // model call and the stamp below are computed from the same
    // agent-sdk-incapable source and can never diverge from the pin or from
    // each other.
    const liveEnv: Record<string, string | undefined> = { ...process.env, KKAMAK_GAUGE_TRANSPORT: undefined }
    const raw = await callModelSdk(prompt, floorCheck, liveEnv)
    if (raw === undefined) return

    const derivation = parseRefinerOutput(raw)
    if (!derivation) return

    // The persisted pending file is the VALIDATED result — validation runs
    // pre-persist so shadow.ts can trust a pending file as-is (no re-checking).
    const validated = validateDerivation({ derivation, prompt, floorCheck, repoRoot: cwd })

    writeGaugeFile(dir, {
      goalSummary: derivation.goalSummary,
      criteria: derivation.criteria,
      confidence: derivation.confidence,
      class: validated.class,
      reason: validated.reason,
      horizon: validated.horizon,
      check: validated.check,
      ...(validated.downgraded ? { downgraded: validated.downgraded } : {}),
      v: 2,
      sessionID,
      n,
      ts: Date.now(),
      // Record the model actually sent to the API (resolved id, not the CLI
      // alias) so the sensor line names the real instrument.
      model: resolveModelId(process.env.KKAMAK_GAUGE_MODEL ?? "haiku"),
      derivationMs: Date.now() - started,
      // Pinned per the same §6d rule as the call above — computed from
      // liveEnv, not process.env, so the stamp can never disagree with what
      // callModelSdk actually did.
      transport: selectTransport(liveEnv),
    })
  } finally {
    try {
      fs.unlinkSync(reqPath)
    } catch {
      // already gone / unreadable — nothing to clean
    }
  }
}

if (import.meta.main) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0))
}
