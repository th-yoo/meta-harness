#!/usr/bin/env bun
/**
 * crank.ts — km-crank main. `bun src/crank.ts [--force]`.
 *
 * Scheduled half-automatic evolution crank: scan kkamak sensor streams
 * across dogfooded repos, and if enough new data has accumulated, run ONE
 * headless propose round through the existing engine (proposer + review
 * gate + candidate staging), then SITREP the outcome to Slack. Human
 * touchpoints stay out-of-band: the user reads the SITREP in Slack and
 * launches trials manually (v0.1 does not auto-trial).
 *
 * Composition note (see the task brief): this does NOT call propose.ts's
 * triggerPropose() directly. ClaudeCodeHost unconditionally implements
 * `stageArtifactApply`, so triggerPropose's "if (host.stageArtifactApply)"
 * branch always fires — it spawns the detached proposer, writes a lock file,
 * and returns immediately without waiting, deferring the apply to a LATER
 * Claude Code hook event that will never come (this is a batch script, not a
 * hook chain). crank.ts instead composes the same pieces triggerPropose uses
 * internally (nextVersion, buildProposerContext, buildProposerPrompt,
 * runTaskAgent) and does its OWN polling + applyStagedArtifact call, mirroring
 * propose.ts's opencode inline path rather than its Claude Code lock-file path.
 *
 * Fail-open: the entire body runs inside main(), and the outer .catch posts a
 * FAILURE SITREP (never with the token) and exits 0 — a crashed crank must
 * never leave stale in-flight state or a non-zero launchd exit spiraling into
 * a broken schedule.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  accountMetaRoot,
  layersFor,
  readMhConfig,
  seedPlaybook,
  buildProposerContext,
  readRejectedLedger,
  readTrial,
  resolveGateTrial,
  nextVersion,
  candidateExists,
  readCandidateSystem,
  parseModelSpec,
} from "../../opencode-plugin/src/harness-store.ts"
import { parseExposureRows, type ExposureRow } from "../../opencode-plugin/src/trial-arm.ts"
import { buildProposerPrompt, applyStagedArtifact } from "../../opencode-plugin/src/propose.ts"
import { ClaudeCodeHost } from "../../opencode-plugin/src/adapters/claude-code/cc-host.ts"
import type { StagedArtifactDescriptor } from "../../opencode-plugin/src/host.ts"
import type { SensorLineIn } from "../../cc-gate-plugin/src/score.ts"

import { parseSensorLines, aggregate, notable, newLineCount, type SensorLine } from "./scan.ts"
import { readPositions, writePositionsAtomic, type Positions } from "./positions.ts"
import { readSnapshotAges } from "./snapshot-age.ts"
import { unionRawLines } from "./sensor-union.ts"
import { renderEvidence, type RepoEvidence } from "./evidence.ts"
import { formatSitrep, postSlack, type SitrepAction, type RepoSummary } from "./sitrep.ts"
import { decideGate, acquireCrankLock, releaseCrankLock } from "./gate.ts"
import { readCalibration, calibrationStale } from "./calibration.ts"
import { runTrialScan } from "./trial-verdict.ts"

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p
}

export const REPOS = ["~/z2/meta-harness", "~/z2/squad", "~/z2/km-play", "~/z2/kkamak"].map(expandHome)
/** Dogfooded repos list — mirrored in scripts/km-sensors-sync.sh:41 (REPOS array).
 * Drift-guarded by km-crank/test/repos-parity.test.ts. */
/** This repo's root — where km-crank/calibration.json (the §4.3 FA registry)
 * and the staleness git scope live, regardless of which repo hosts a trial. */
const META_REPO_ROOT = path.resolve(import.meta.dir, "..", "..")
/** Committed cross-host sensor snapshot dir (scripts/km-sensors-sync.sh
 * export target) — feeds TrialSitrepDetail.snapshotAges (§7, deferred from
 * TM6). Always this repo's own tree, regardless of which repo a trial
 * lives in: the snapshot is git-tracked here, not per-target-repo. */
const EVIDENCE_ROOT = path.join(META_REPO_ROOT, "evidence", "kkamak-sensors")
const THRESHOLD = 10
const MAX_AGE_DAYS = 7
const POLL_TIMEOUT_MS = 10 * 60 * 1000
const POLL_INTERVAL_MS = 5_000
const AGENT_ROLE = "mh-build"

interface RepoScan {
  repo: string
  sensorPath: string
  newLines: SensorLine[]
  newOffset: number
}

/**
 * Read whatever complete ndjson lines exist past `fromOffset` in
 * `sensorPath`. Byte-offset-safe (multi-byte UTF-8 lines), and stops at the
 * last complete line so a concurrently-written partial line is never
 * consumed — it stays pending for the next run. Missing file, unreadable
 * file, or a rotated/truncated file (size < fromOffset, offset reset to 0)
 * all degrade to "no new lines" rather than throwing — one repo's bad sensor
 * file must never take down the whole scan.
 */
function readNewSensorLines(sensorPath: string, fromOffset: number): { lines: SensorLine[]; newOffset: number } {
  let size: number
  try {
    size = fs.statSync(sensorPath).size
  } catch {
    return { lines: [], newOffset: fromOffset }
  }
  const start = fromOffset > size ? 0 : fromOffset
  if (start >= size) return { lines: [], newOffset: size }

  let text: string
  try {
    const fd = fs.openSync(sensorPath, "r")
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, size - start, start)
    fs.closeSync(fd)
    text = buf.toString("utf-8")
  } catch {
    return { lines: [], newOffset: fromOffset }
  }

  const lastNewline = text.lastIndexOf("\n")
  if (lastNewline === -1) return { lines: [], newOffset: start } // no complete line yet

  const complete = text.slice(0, lastNewline)
  const newOffset = start + Buffer.byteLength(text.slice(0, lastNewline + 1), "utf-8")
  return { lines: parseSensorLines(complete), newOffset }
}

/**
 * §4.3 verdict input: the WHOLE sensor file, never the positions-offset tail
 * — the trial verdict wants the entire [startedAt, now] window every round
 * (trial-verdict.ts time-bounds the join itself) — UNIONED with every OTHER
 * host's committed snapshot under EVIDENCE_ROOT (§7, final review item 3;
 * sensor-union.ts), deduped by full raw-line identity BEFORE parsing. No
 * snapshot dir at all degrades to exactly the live-only read (pre-union
 * behavior). parseSensorLines validates the shared required fields and
 * passes extra optional fields (reinject / forced / gauge / skippedStop)
 * through untouched on the parsed objects, so the runtime values are full
 * SensorLineIn rows; the cast re-attaches the wider type. This is what
 * makes trial-verdict.ts's evaluateGateTrial (via runTrialScan below) the
 * REAL production filter for skipped-stop lines (join rule 7, metrics AND
 * density) — km-crank's own volume-contest discount (newLineCount, scan.ts)
 * is a separate, narrower concern scoped to totalNew/target-selection only.
 */
function readUnionSensorLines(repo: string): SensorLineIn[] {
  const sensorPath = path.join(repo, ".km", "gate-outcomes.ndjson")
  let liveText = ""
  try {
    liveText = fs.readFileSync(sensorPath, "utf-8")
  } catch {
    // missing/unreadable live file degrades to snapshot-only union — same
    // fail-open tolerance the pre-union read had for a missing live file.
  }
  const unioned = unionRawLines(EVIDENCE_ROOT, repo, "gate-outcomes", liveText).join("\n")
  return parseSensorLines(unioned) as unknown as SensorLineIn[]
}

/**
 * Same cross-host union discipline for the exposure log (§7/item 3: the
 * union feeds BOTH sensorLines and exposureRows, so a session enrolled and
 * scored entirely on another host still joins here). readExposureRows
 * (opencode-plugin/src/trial-arm.ts) is whole-file-only and can't take a
 * pre-unioned text, so this reads the live file directly and reuses its
 * exported parseExposureRows on the unioned text instead.
 */
function readUnionExposureRows(repo: string): ExposureRow[] {
  const exposurePath = path.join(repo, ".km", "trial-arms.ndjson")
  let liveText = ""
  try {
    liveText = fs.readFileSync(exposurePath, "utf-8")
  } catch {
    // missing/unreadable live file degrades to snapshot-only union.
  }
  const unioned = unionRawLines(EVIDENCE_ROOT, repo, "trial-arms", liveText).join("\n")
  return parseExposureRows(unioned)
}

async function waitForFile(p: string, timeoutMs: number, intervalMs = POLL_INTERVAL_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return fs.existsSync(p)
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force")
  const now = Date.now()

  // FIX 3: launchd will NOT create StandardOutPath's parent directory on the
  // very first scheduled run, and positions.json / crank.lock live under the
  // same directory — self-heal unconditionally, before anything else, so
  // even a bare `bun src/crank.ts` (no prior manual mkdir, README Install
  // step skipped) works on a fresh host.
  fs.mkdirSync(path.join(accountMetaRoot(), "km-crank"), { recursive: true })

  const positions = readPositions()

  const scans: RepoScan[] = REPOS.map((repo) => {
    const sensorPath = path.join(repo, ".km", "gate-outcomes.ndjson")
    const fromOffset = positions.files[sensorPath]?.offset ?? 0
    const { lines, newOffset } = readNewSensorLines(sensorPath, fromOffset)
    return { repo, sensorPath, newLines: lines, newOffset }
  })

  // Task 1 (fix-them-serialized-teacup plan, round-2 review finding):
  // skipped-stop lines are counted OUT of the volume-contest/threshold input
  // (newLineCount), scoped narrowly to this one consumer — the raw
  // s.newLines array itself keeps them (aggregate()/notable()/evidence/the
  // SITREP's per-repo count below are unfiltered on purpose, and
  // trial-verdict.ts's readUnionSensorLines needs the unfiltered parse too).
  const totalNew = scans.reduce((sum, s) => sum + newLineCount(s.newLines), 0)

  const repoResults: RepoEvidence[] = scans.map((s) => ({
    repo: s.repo,
    newLines: s.newLines,
    aggregate: aggregate(s.newLines),
    notableLines: notable(s.newLines, 5),
  }))
  const repoSummaries: RepoSummary[] = repoResults.map((r) => ({
    repo: r.repo,
    newLines: r.newLines.length,
    cleanAccepts: r.aggregate.cleanAccepts,
    fixCycles: r.aggregate.fixCycles,
    exhausted: r.aggregate.exhausted,
    interrupted: r.aggregate.interrupted,
    medianDurationMs: r.aggregate.medianDurationMs,
  }))

  // §4.3 trial scan (spec §5 acceptance criterion; plan Task 6) — BEFORE
  // target selection and BEFORE decideGate, across ALL REPOS' project-global
  // layers, independent of which repo wins this round's new-line-volume
  // contest (a live trial in a non-winning repo must still be evaluated).
  // This is what un-deadlocks km-crank: resolution fires on every scheduled
  // run, and T_MAX bounds how long any one trial can occupy the slot.
  const trialScan = runTrialScan(REPOS, {
    readTrial,
    projectGlobalRootFor: (repo) => layersFor(repo, AGENT_ROLE)[1]!.root,
    readFullSensorLines: readUnionSensorLines,
    readExposureRows: readUnionExposureRows,
    readSnapshotAges: (repo) => readSnapshotAges(EVIDENCE_ROOT, repo, now),
    readCalibration: () => readCalibration(META_REPO_ROOT),
    calibrationStale: (cal) => calibrationStale(META_REPO_ROOT, cal),
    resolveGateTrial,
    now,
  })
  if (trialScan) {
    console.log(`[km-crank] trial: ${trialScan.action.kind} (${trialScan.repo})`)
    await postSlack(formatSitrep({ generatedAt: now, repos: repoSummaries, action: trialScan.action }))
  }
  // Fall-through choice (Task 6, recorded deliberately): EVERY trial outcome
  // falls through to the normal round below.
  //   - keep / rollback / abandoned: resolveGateTrial CLEARED the trial, so
  //     decideGate's trialInProgress check no longer fires for that layer and
  //     the round continues normally (proposing may resume immediately).
  //   - pending / deferred: nothing was cleared — the trial is still live,
  //     and decideGate's existing trialInProgress check then correctly skips
  //     proposing for that layer. No duplicate guard is needed here; the
  //     round still posts its own skip log / other-repo work as usual.

  // Target = repo with the most new lines (ties keep array order / first).
  // Same newLineCount discount as totalNew above — skipped-stop lines must
  // not be able to win a repo that round's proposal target.
  let target = scans[0]!
  for (const s of scans) if (newLineCount(s.newLines) > newLineCount(target.newLines)) target = s
  const targetRepo = target.repo

  const layer = layersFor(targetRepo, AGENT_ROLE)[1]! // project-global
  const host = new ClaudeCodeHost(targetRepo, {})

  // Gate: threshold/age (unchanged behavior) + FIX 1 (trial-clobber guard)
  // + FIX 2 (cross-process proposer guard) — ALL evaluated BEFORE computing
  // nextVersion() or building anything, mirroring propose.ts's
  // triggerPropose (opencode-plugin/src/propose.ts:141-149). See gate.ts's
  // decideGate for the priority order and full rationale.
  const gateDecision = decideGate({
    force,
    newCount: totalNew,
    threshold: THRESHOLD,
    lastRunTs: positions.lastRunTs,
    maxAgeMs: MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
    now,
    trialInProgress: readTrial(layer.root) !== null,
    inFlight: !!host.proposerInFlight?.(layer.root),
  })

  if (gateDecision !== "run") {
    const ageMs = now - positions.lastRunTs
    const reason =
      gateDecision === "skip-threshold"
        ? `${totalNew} new line(s) pooled (< ${THRESHOLD}), last run ${(ageMs / 3_600_000).toFixed(1)}h ago`
        : gateDecision === "skip-trial"
          ? `trial already in progress for ${layer.scope} (readTrial) — a live session owns this layer, not clobbering its .trial state`
          : `proposer already in flight for ${layer.scope} (host.proposerInFlight) — a live CC session's own round owns this layer`
    console.log(`[km-crank] skip (${gateDecision}): ${reason}`)
    return // positions NOT advanced — this round's lines (if any) stay pending, no Slack post
  }

  // FIX 2 (continued): crank-private round lock — NOT host.stageArtifactApply
  // (see gate.ts's header comment for why: that lock format is consumed by
  // proposer.ts's applyPendingArtifacts on every hook event, so registering
  // there risks a live CC session double-applying the same staged artifact
  // crank.ts itself polls for and applies). This lock guards ONLY against
  // two crank.ts invocations racing each other; acquired before
  // nextVersion() so both racers can never spawn a proposer for the same
  // round. host.proposerInFlight above was already checked read-only.
  const lockRoot = accountMetaRoot()
  if (!acquireCrankLock(lockRoot, now, POLL_TIMEOUT_MS + 5 * 60_000)) {
    console.log("[km-crank] skip (skip-inflight): another km-crank round already holds the round lock")
    return // positions NOT advanced, no Slack post
  }

  try {
    // Evidence dir: opencode-plugin's buildExternalEvidenceSection only
    // discovers <dir>/<task>/<agent>.md — see evidence.ts's header comment for
    // why the file goes one level deeper than a bare "evidence-<ts>/*.md" read
    // of the brief would suggest.
    const evidenceRoot = path.join(accountMetaRoot(), "km-crank", `evidence-${now}`)
    const evidenceTaskDir = path.join(evidenceRoot, "kkamak-sensors")
    fs.mkdirSync(evidenceTaskDir, { recursive: true })
    fs.writeFileSync(path.join(evidenceTaskDir, "km-crank.md"), renderEvidence(repoResults, now), "utf-8")

    const version = nextVersion(layer.root)
    const stagingBase = path.join(targetRepo, ".kkamak", "staging")
    const stagingSystem = path.join(stagingBase, `${layer.scope}-${version}-system.md`)
    const stagingTools = path.join(stagingBase, `${layer.scope}-${version}-tools.md`)
    const stagingDiagnosis = path.join(stagingBase, `${layer.scope}-${version}-diagnosis.json`)
    const stagingOps = path.join(stagingBase, `${layer.scope}-${version}-ops.json`)
    const stagingAgentConfig = path.join(stagingBase, `${layer.scope}-${version}-agent-config.json`)
    const stagingEnvPolicy = path.join(stagingBase, `${layer.scope}-${version}-env-policy.json`)

    const playbook = seedPlaybook(layer.root)
    const context = buildProposerContext(layer.root, layer.higherRoots)
    const cfg = readMhConfig()
    const proposerModel = parseModelSpec(cfg.proposerModel)

    const prompt = buildProposerPrompt(
      layer,
      version,
      context,
      stagingSystem,
      stagingTools,
      stagingDiagnosis,
      stagingOps,
      stagingAgentConfig,
      stagingEnvPolicy,
      targetRepo,
      playbook,
      evidenceRoot,
      [], // heldOut — km-crank's evidence isn't TB2-leaderboard evidence, nothing to hold out
    )

    const task = await host.runTaskAgent({
      title: `[km-crank] ${layer.scope} ${version}`,
      prompt,
      model: proposerModel,
    })
    if (!task) throw new Error("km-crank: proposer failed to spawn (runTaskAgent returned null — check the crank log)")

    const descriptor: StagedArtifactDescriptor = {
      kind: "propose",
      worktree: targetRepo,
      version,
      layer,
      playbookMode: !!playbook,
      proposerModel: cfg.proposerModel,
      proposerVariant: cfg.proposerVariant,
      sessionId: task.id,
      spawnedAt: now,
      timeoutMs: POLL_TIMEOUT_MS,
      pid: process.pid,
    }

    const primary = playbook ? stagingOps : stagingSystem
    let found = await waitForFile(primary, POLL_TIMEOUT_MS)
    if (!found && playbook && fs.existsSync(stagingSystem)) found = true // propose.ts's own grace case

    if (!found) {
      await postSlack(
        formatSitrep({ generatedAt: now, repos: repoSummaries, targetRepo, action: { kind: "proposer-timeout" } }),
      )
      console.log("[km-crank] proposer timeout — positions not advanced, this round's lines stay pending")
      return
    }

    // Capture staged content BEFORE applyStagedArtifact consumes (deletes) it —
    // applyStagedArtifact returns only "applied"|"pending", never which branch
    // (no-op / review-rejected / staged) it took, so the sitrep's "bullet text"
    // must be read from the raw staging files while they still exist.
    let preApplyBulletText = ""
    let preApplyFalsifyIf: string | undefined
    try {
      if (playbook && fs.existsSync(stagingOps)) {
        const raw = JSON.parse(fs.readFileSync(stagingOps, "utf-8")) as { ops?: Array<{ op: string; text?: string }> }
        preApplyBulletText = (raw.ops ?? [])
          .filter((o) => o.op === "add")
          .map((o) => o.text ?? "")
          .join("\n")
      } else if (fs.existsSync(stagingSystem)) {
        preApplyBulletText = fs.readFileSync(stagingSystem, "utf-8").trim()
      }
      if (fs.existsSync(stagingDiagnosis)) {
        const dx = JSON.parse(fs.readFileSync(stagingDiagnosis, "utf-8")) as Record<string, unknown>
        // Not part of propose.ts's diagnosis schema today (see report) — checked
        // defensively in case a future proposer prompt starts emitting it.
        if (typeof dx["falsify_if"] === "string") preApplyFalsifyIf = dx["falsify_if"] as string
      }
    } catch {
      /* best-effort capture only — never block the round over a read/parse error */
    }

    const rejectedBefore = readRejectedLedger(layer.root)
    const candidateExistedBefore = candidateExists(layer.root, version)

    // FIX 2 (continued): applyStagedArtifact is called from THIS process only
    // — crank.ts never registers via host.stageArtifactApply, so there is no
    // second consumer (a live CC session's applyPendingArtifacts scan) that
    // could race this call. The crank-private round lock (acquired above)
    // is released in the outer `finally`, right after this returns or throws.
    const applyResult = await applyStagedArtifact(host, descriptor)

    let action: SitrepAction
    let roundCompleted = false

    if (applyResult === "pending") {
      // Shouldn't happen (we just confirmed the primary artifact is on disk),
      // but defensive: treat exactly like a poll timeout — no candidate state
      // was touched, so positions must not advance either.
      action = { kind: "proposer-timeout" }
    } else {
      roundCompleted = true
      const rejectedAfter = readRejectedLedger(layer.root)
      if (rejectedAfter.length > rejectedBefore.length) {
        const newest = rejectedAfter[rejectedAfter.length - 1]!
        action = {
          kind: "review-rejected",
          reason: `${(newest.violations ?? []).join(", ") || "violations"} — "${newest.bullet.slice(0, 200)}"`,
        }
      } else if (!candidateExistedBefore && candidateExists(layer.root, version)) {
        action = {
          kind: "proposed-staged",
          scope: layer.scope,
          version,
          bulletText: preApplyBulletText || readCandidateSystem(layer.root, version),
          falsifyIf: preApplyFalsifyIf,
        }
      } else {
        action = { kind: "no-op" }
      }
    }

    if (roundCompleted) {
      const newPositions: Positions = { files: { ...positions.files }, lastRunTs: now }
      for (const s of scans) newPositions.files[s.sensorPath] = { offset: s.newOffset }
      writePositionsAtomic(newPositions)
    }

    await postSlack(formatSitrep({ generatedAt: now, repos: repoSummaries, targetRepo, action }))
    console.log(`[km-crank] done: ${action.kind}`)
  } finally {
    // FIX 2: always release the crank-private round lock, whether the round
    // completed, timed out, or threw — mirrors triggerPropose's
    // `finally { inFlight.delete(layer.root) }` (propose.ts:270-272).
    releaseCrankLock(lockRoot)
  }
}

main().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error("[km-crank] failure:", message)
  try {
    await postSlack(formatSitrep({ generatedAt: Date.now(), repos: [], action: { kind: "failure", message } }))
  } catch (postErr) {
    console.error("[km-crank] failed to post failure sitrep:", postErr instanceof Error ? postErr.message : String(postErr))
  }
  process.exit(0)
})
