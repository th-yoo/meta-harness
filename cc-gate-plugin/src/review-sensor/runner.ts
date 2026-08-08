#!/usr/bin/env bun
/**
 * runner.ts — the review sensor's detached child (task-6 brief,
 * docs/superpowers/plans/2026-08-06-review-sensor.md Task 6): `bun
 * runner.ts <repoDir>`. Spawned by the (not-yet-built) Task 7 seam from
 * hook-cli's Stop branch, BEFORE `emit()` — same fire-and-forget discipline
 * as prompt-check-cli.ts / refiner-cli.ts. Claims a single-flight slot,
 * assembles the accumulated diff since the last completed pass, dispatches
 * ONE haiku review over the ACP warm lane, and emits a counts-only F2 line.
 *
 * Fail-open family rule (spec §4): every guard emits its skip line via the
 * core builders and returns — this file's own top-level catch is the
 * backstop for anything that slips past an individual guard, never a
 * a substitute for one. `bun test` must never make a live model call:
 * everything that can reach the network lives behind `import.meta.main`
 * (refiner-cli.ts:129 precedent), and the one thing worth unit-testing in
 * isolation (`pruneSideFiles`) is pure fs, exported for
 * review-sensor-core.test.ts.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  MODEL,
  SIDE_FILE_KEEP,
  DEBOUNCE_MS,
  shouldDispatch,
  nextCapState,
  truncateDiff,
  buildReviewPrompt,
  parseFindings,
  passLine,
  skipLine,
  type SensorState,
  type SkipReason,
} from "./core.ts"
import { assembleDiff } from "./git-diff.ts"
import {
  ensureDaemon,
  daemonCall,
  closeSession,
  modelProvenBy,
  type WarmIsolation,
} from "@th-yoo/cc-api-daemon"
import { readPluginVersion } from "../sensor-append.ts"

/** review-sensor's isolation profile — copies GAUGE_ISOLATION's shape
 * (acp-wire.ts) with a distinct marker `title`, per index.ts's own
 * extraction-wart note (:20-26): an isolation VALUE belongs to the
 * consumer, not the ACP layer, so it is declared here on the caller side.
 * Same sibling relationship as REASONING_ISOLATION in
 * src/gauge/send-prompt.ts. */
export const REVIEW_SENSOR_ISOLATION: WarmIsolation = {
  systemPrompt: "",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "kkamak-review-sensor",
  thinking: { type: "disabled" },
}

/** Retention (spec §3): keep the newest `keep` side files by ts (the
 * filename, `<ts>.json`), delete the rest. Pure fs, no dependency on the
 * rest of this module — the one piece worth isolating per the brief.
 * Never throws: a missing/unreadable dir is a no-op (nothing to prune), and
 * an individual unlink failure (lost race, permissions) is swallowed —
 * pruning is best-effort disk hygiene, never load-bearing for the sensor's
 * own decision logic. */
export function pruneSideFiles(dir: string, keep: number): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }

  const parsed = names
    .map((name) => ({ name, ts: Number(name.replace(/\.json$/, "")) }))
    .filter((f) => Number.isFinite(f.ts))
    .sort((a, b) => a.ts - b.ts)

  const excess = parsed.length - keep
  if (excess <= 0) return

  for (const f of parsed.slice(0, excess)) {
    try {
      fs.unlinkSync(path.join(dir, f.name))
    } catch {
      // best-effort — a lost unlink race or permissions error leaves one
      // extra file around; the next prune cleans it up.
    }
  }
}

/** Tolerant state read (brief: "missing/corrupt -> undefined"). A
 * structurally wrong file (wrong types, partial write) is treated
 * identically to a missing one — never throws into the caller. */
function readState(statePath: string): SensorState | undefined {
  try {
    const raw = fs.readFileSync(statePath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<SensorState> | null
    if (
      parsed &&
      typeof parsed.lastPassTs === "number" &&
      typeof parsed.lastPassHead === "string" &&
      typeof parsed.dayKey === "string" &&
      typeof parsed.dayCount === "number"
    ) {
      return parsed as SensorState
    }
    return undefined
  } catch {
    return undefined
  }
}

export interface RunnerDeps {
  now(): number
  call: typeof daemonCall
  close: typeof closeSession
  ensure: typeof ensureDaemon
}

/** One claim -> diff -> warm-call -> emit cycle. `repoDir` is the argv
 * positional (the main checkout, per the arming gate Task 7 enforces
 * upstream — this file does not re-check cwd, it trusts its caller). Every
 * `.km/` path is resolved relative to `repoDir`, never `process.cwd()` — a
 * detached spawn's cwd is not guaranteed to match its argv.
 *
 * NEVER throws: the outer try/catch is the fail-open backstop (skip reason
 * "dispatch-error") for anything an individual guard didn't already
 * classify; the claim file is unlinked in a `finally` regardless of which
 * path was taken. */
export async function runOnce(
  repoDir: string,
  env: Record<string, string | undefined>,
  deps: RunnerDeps,
): Promise<void> {
  const now = deps.now()
  const host = os.hostname()
  const pluginVersion = readPluginVersion()

  const kmDir = path.join(repoDir, ".km")
  const statePath = path.join(kmDir, "review-sensor-state.json")
  const claimPath = path.join(kmDir, "review-sensor.claim")
  const sideFileDir = path.join(kmDir, "review-findings-text")
  const streamPath = path.join(kmDir, "review-findings.ndjson")

  /** Every skip line funnels through here — the same F2 builder every
   * pass line uses, so no caller can accidentally hand-roll a line that
   * carries more than {ts, reason, host, pluginVersion}. Fail-open: a
   * write failure here must never surface. */
  function emitSkip(reason: SkipReason): void {
    try {
      fs.mkdirSync(kmDir, { recursive: true })
      fs.appendFileSync(streamPath, skipLine({ ts: now, reason, pluginVersion, host }) + "\n")
    } catch {
      // sensor-write failure must never change or surface anywhere.
    }
  }

  let claimed = false
  try {
    const state = readState(statePath)

    const d = shouldDispatch(state, now)
    if (!d.go) {
      emitSkip(d.reason)
      return
    }

    fs.mkdirSync(kmDir, { recursive: true })

    // Stale-claim cleanup: a claim older than the debounce window is a
    // crash leftover (spec §2), not a live claimant — remove it before
    // the create attempt. A narrow TOCTOU is declared and accepted here
    // (stat -> unlink -> open-wx): worst case one extra dispatch when two
    // Stops race the cleanup after a prior crash.
    try {
      const st = fs.statSync(claimPath)
      if (now - st.mtimeMs >= DEBOUNCE_MS) fs.unlinkSync(claimPath)
    } catch {
      // ENOENT (no claim) or a races-with-cleanup unlink: nothing to do
      // either way — the create attempt below is the real gate.
    }

    try {
      fs.closeSync(fs.openSync(claimPath, "wx"))
      claimed = true
    } catch {
      // EEXIST (a live claimant already holds it) or any other open
      // failure: fail-open, this Stop loses the race.
      emitSkip("claim-lost")
      return
    }

    const diff = assembleDiff(repoDir, state?.lastPassHead)
    if (diff === undefined) {
      emitSkip("merge-in-progress")
      return
    }
    if (diff.diff === "") {
      // Nothing to review: spec §2 — "no dispatch, no line". Not even a
      // skip line; an empty-diff Stop is not an observation.
      return
    }

    const { text: truncatedDiff, truncated } = truncateDiff(diff.diff)
    const prompt = buildReviewPrompt(truncatedDiff)

    // Zero-wait seat acquisition (spec §2 warm-lane bullet): kick the
    // daemon and proceed regardless of what `ensure` returns, matching
    // anthropic-cli-warm.ts's precedent — a missing daemon means THIS
    // call lands no-call and skips, while the spawn warms for next time.
    await deps.ensure(env, { waitMs: 0 })

    const started = deps.now()
    const outcome = await deps.call(prompt, MODEL, env, { isolation: REVIEW_SENSOR_ISOLATION })
    const durationMs = deps.now() - started

    if (outcome.kind !== "ok") {
      emitSkip("warm-lane-busy")
      return
    }

    try {
      // daemonCall forwards model evidence UNVERIFIED by design (its own
      // doc comment) — every direct caller must reconcile it. Checked
      // FIRST, before anything else in `outcome` is trusted (skipping
      // this reinstates the request-echo tautology the interface
      // forbids; anthropic-cli-warm.ts precedent).
      if (!modelProvenBy(outcome.model, MODEL, outcome.canonicalModel)) {
        emitSkip("bad-review-output")
        return
      }

      const parsed = parseFindings(outcome.text)
      if (parsed === undefined) {
        emitSkip("bad-review-output")
        return
      }

      const line = passLine({
        ts: now,
        findings: parsed.findings,
        diffStat: diff.diffStat,
        baseSha: diff.baseSha,
        headSha: diff.headSha,
        truncated,
        diffBase: diff.diffBase,
        model: MODEL,
        durationMs,
        pluginVersion,
        host,
      })
      // F2: the stream carries the passLine builder's output ONLY — never
      // hand-assembled JSON, so no finding text can leak into it.
      fs.appendFileSync(streamPath, line + "\n")

      fs.mkdirSync(sideFileDir, { recursive: true })
      fs.writeFileSync(
        path.join(sideFileDir, `${now}.json`),
        JSON.stringify({ ts: now, baseSha: diff.baseSha, headSha: diff.headSha, findings: parsed.findings }),
      )
      pruneSideFiles(sideFileDir, SIDE_FILE_KEEP)

      const newState: SensorState = {
        lastPassTs: now,
        lastPassHead: diff.headSha,
        ...nextCapState(state, now),
      }
      // Atomic write (state.ts:87-93 StateStore.save precedent): a torn
      // write here, paired with readState's tolerant undefined-on-corrupt
      // fallback, would make the NEXT Stop see no state at all ->
      // shouldDispatch {go:true} unconditionally -> silently bypasses both
      // the debounce window and the 30/day cap for that dispatch. Write to
      // a pid+random-suffixed tmp file in the same dir, then rename — POSIX
      // rename is atomic, so a reader never observes a partial file.
      const tmpStatePath = path.join(
        kmDir,
        `.${path.basename(statePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
      )
      fs.writeFileSync(tmpStatePath, JSON.stringify(newState))
      fs.renameSync(tmpStatePath, statePath)
    } finally {
      // Close-not-release (spec §2): a session was established for THIS
      // outcome (kind === "ok"), so it is closed here regardless of
      // whether the pass above went on to count as a real observation
      // (bad-review-output still established a session) — releasing
      // daemon-side session state promptly rather than leaving it to age
      // out. review-sensor's model (MODEL, core.ts) is claude-haiku-4-5,
      // which @th-yoo/cc-api-daemon's routeBackend sends to the `api` lane:
      // ApiSession answers per-session and is never pooled, so there is no
      // warm-lane slot here to pin and no pool-exhaustion error this close
      // avoids — that rationale applied to the old CLI-backed WarmSession
      // pool, not this client. The 900s reap remains the backstop for
      // whatever this call can't reach; result is logged, never inspected
      // for control flow.
      if (outcome.sessionId) {
        try {
          const result = await deps.close(outcome.sessionId, env)
          console.error(`review-sensor: closeSession -> ${JSON.stringify(result)}`)
        } catch {
          // best-effort by spec — never surfaces.
        }
      }
    }
  } catch {
    emitSkip("dispatch-error")
  } finally {
    if (claimed) {
      try {
        fs.unlinkSync(claimPath)
      } catch {
        // best-effort — never let claim release surface.
      }
    }
  }
}

async function main(): Promise<void> {
  const [repoDir] = process.argv.slice(2)
  if (!repoDir) return
  await runOnce(repoDir, process.env, {
    now: () => Date.now(),
    call: daemonCall,
    close: closeSession,
    ensure: ensureDaemon,
  })
}

if (import.meta.main) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0))
}
