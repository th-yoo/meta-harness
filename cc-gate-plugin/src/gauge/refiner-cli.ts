#!/usr/bin/env bun
/**
 * refiner-cli.ts — the detached km-gauge derivation child (pre-reg §2.2):
 * `bun refiner-cli.ts <cwd> <sessionID> <n>`. Reads the .req.json written by
 * maybeSpawnGauge, makes ONE small-model claude call, writes the pending
 * gauge file atomically, deletes the req. Any failure = silent exit 0 with
 * the req cleaned up — a missing gauge file is a recorded M0 coverage miss,
 * never a session problem.
 *
 * KM_CHILD=1 on the claude call keeps kkamak's own hooks out of the child
 * session (hook-cli's engine-child exclusion).
 */
import fs from "node:fs"
import path from "node:path"
import { buildRefinerPrompt, parseRefinerOutput } from "./refiner.ts"
import { validateDerivation } from "./validate.ts"
import { gaugeDir, writeGaugeFile } from "./files.ts"

const CALL_TIMEOUT_MS = 60_000

/** `claude -p --output-format json` wrapper → .result text; undefined if not that shape. */
export function extractResultText(text: string): string | undefined {
  try {
    const j = JSON.parse(text)
    if (typeof j === "object" && j !== null && typeof (j as Record<string, unknown>).result === "string") {
      return (j as Record<string, unknown>).result as string
    }
  } catch {
    // fall through
  }
  return undefined
}

async function callModel(prompt: string, floorCheck: string): Promise<string | undefined> {
  const bin = process.env.KKAMAK_GAUGE_CLAUDE_BIN ?? "claude"
  const model = process.env.KKAMAK_GAUGE_MODEL ?? "haiku"

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([bin, "-p", "--output-format", "json", "--model", model], {
      stdin: new TextEncoder().encode(buildRefinerPrompt(prompt, floorCheck)),
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, KM_CHILD: "1" },
    })
  } catch {
    return undefined
  }

  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // best-effort
    }
  }, CALL_TIMEOUT_MS)

  try {
    const [out, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text().catch(() => ""),
      proc.exited,
    ])
    if (code !== 0) return undefined
    return out
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

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
    const raw = await callModel(prompt, floorCheck)
    if (raw === undefined) return

    const derivation = parseRefinerOutput(extractResultText(raw) ?? raw)
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
      model: process.env.KKAMAK_GAUGE_MODEL ?? "haiku",
      derivationMs: Date.now() - started,
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
