/**
 * harvest-cli.ts — Phase 2 harvest entry point. Assembles a terminal-bench-2
 * task directory from a captured fixture ref (`.km/fixture-refs.ndjson`) +
 * its check-output sidecar (`.km/check-output.ndjson`), using the pure
 * parsers/renderers from fixture-harvest.ts and tb2-task.ts.
 *
 * Allowlist guard (private-repo one-way door): a repo whose basename is not
 * in FIXTURE_ALLOWED_REPOS is refused outright. There is deliberately NO
 * bypass flag — adding a repo means a reviewed commit to this file, the
 * explicit per-repo inclusion ruling.
 */
import fs from "node:fs"
import path from "node:path"
import { parseFixtureRefRecords, joinFixture, extractPromptContext } from "./fixture-harvest.ts"
import type { FixtureRefRecord } from "./fixture-harvest.ts"
import { parseCheckOutputRecords } from "./check-output.ts"
import { renderTaskToml, renderDockerfile, renderTestSh, renderInstruction, TEST_PRISTINE_GLOBS } from "./tb2-task.ts"

/** Reviewed one-way door: a repo basename must be listed here before it can
 * ever be harvested. NO CLI bypass flag exists — adding an entry is itself
 * the explicit per-repo inclusion ruling.
 *
 * meta-harness: RULED IN 2026-08-10 (user go, "go with 1 and 3"). Rationale:
 * the 19 organic fixture-refs are this repo's own blocked cycles; converting
 * our own failure evidence into TB2 fixture tasks is the phase's designed
 * purpose, and the harvest path strips `.km` + secrets recursively before
 * anything is materialized. Other repos (kkamak, km-play, squad) remain
 * excluded until their own rulings. */
export const FIXTURE_ALLOWED_REPOS: string[] = ["meta-harness"]

/** Ruling C (2026-08-10, user go): history-coupled checks are un-harvestable.
 * gate-check's calibration drift guard compares committed calibration.json
 * against `git log -1 -- <mechanism paths>` — REAL repo history. A fixture
 * image materializes the captured tree as one synthetic commit, so that
 * test fails environmentally in every container, forever: the fixture never
 * goes vacuous but never reproduces the harvested failure either (probed
 * live, 4 unmasked failure classes deep). Only tree-pure checks harvest;
 * editing this list is itself the per-check ruling — no bypass flag. */
export const UNHARVESTABLE_CHECKS: string[] = ["bun scripts/gate-check.ts"]

export class HarvestRefusal extends Error {}

/** Validity-probe result: did the environment image build, and what did the
 * harvested check exit with inside a fresh container? */
export interface ProbeOutcome {
  buildOk: boolean
  checkExitCode?: number
  output: string
}

export type FixtureProber = (a: { envDir: string; check: string }) => Promise<ProbeOutcome>

export interface HarvestOptions {
  repoPath: string
  outDir: string
  allowedRepos: string[]
  refName?: string
  taskName?: string
  /** Validity probe (47M ruling 2026-08-10): when set, the assembled fixture
   * is built and its check run in a fresh container BEFORE the harvest is
   * accepted. A check that PASSES there is vacuous — reward 1 with zero
   * agent work, the harvested failure class did not survive
   * re-materialization (e.g. stale host node_modules) — and is refused.
   * When unset, no probe runs (library callers / tests own their gating;
   * the CLI defaults to the podman prober, `--skip-probe` to opt out). */
  prober?: FixtureProber
}

const AGENT_TIMEOUT_SEC = 900
const VERIFIER_TIMEOUT_SEC = 300

function runOrThrow(cmd: string, cwd: string): void {
  const r = Bun.spawnSync(["bash", "-c", cmd], { cwd })
  if (r.exitCode !== 0) {
    const stderr = r.stderr ? r.stderr.toString() : ""
    throw new Error(`command failed (exit ${r.exitCode}) in ${cwd}: ${cmd}\n${stderr}`)
  }
}

/** Secrets hygiene, RECURSIVE (finding I2): strip `.env*`, `.npmrc`, and
 * `.netrc` at ANY depth under `dir`, not just the top level — a tracked
 * `packages/sub/.env` must not survive into a committed fixture any more
 * than a top-level one would. Best-effort / pattern-based: see the
 * registration note's Known Limitations for what this does NOT catch. */
function stripSecretsRecursive(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.name.startsWith(".env") || entry.name === ".npmrc" || entry.name === ".netrc") {
      fs.rmSync(p, { recursive: true, force: true })
      continue
    }
    if (entry.isDirectory()) stripSecretsRecursive(p)
  }
}

/** Single-quote a string for safe interpolation into `bash -c "..."`. Double
 * quotes leave `$` and backticks live (command/variable substitution), so
 * paths must be single-quoted with the standard '\'' escape — same pattern
 * as cc-gate-plugin/src/hook-cli.ts:264. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const TREE_SHA_RE = /^[0-9a-f]{40}$/

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** yyyymmdd-hhmmss from a record's ts (epoch ms), in UTC — never wall clock,
 * so the task name is reproducible from the record alone. */
function utcStamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
}

/** refName selects by exact `ref` string (any record, including bailed —
 * an explicit ask overrides the auto-pick safety filter, but NOT ruling C:
 * an un-harvestable check is structurally broken, not merely risky).
 * Otherwise: newest (max ts) record with no `bail`, a non-empty treeSha,
 * and a tree-pure check. Bailed and un-harvestable records are never
 * auto-picked. */
function selectRef(records: FixtureRefRecord[], refName?: string): FixtureRefRecord {
  if (refName !== undefined) {
    const found = records.find((r) => r.ref === refName)
    if (!found) throw new Error(`no fixture-ref record found with ref === ${JSON.stringify(refName)}`)
    if (UNHARVESTABLE_CHECKS.includes(found.check.trim())) {
      throw new HarvestRefusal(
        `harvest refused: check ${JSON.stringify(found.check)} is ruled un-harvestable (ruling C, ` +
        `2026-08-10) — it is history-coupled and can never reproduce from a tree snapshot. ` +
        `Editing UNHARVESTABLE_CHECKS in km-crank/src/harvest-cli.ts is itself the per-check ruling.`,
      )
    }
    return found
  }
  const eligible = records.filter((r) => !r.bail && r.treeSha && !UNHARVESTABLE_CHECKS.includes(r.check.trim()))
  if (eligible.length === 0) {
    throw new Error("no eligible fixture-ref records (all bailed, missing treeSha, or un-harvestable checks)")
  }
  return eligible.reduce((best, r) => (r.ts > best.ts ? r : best))
}

export async function harvestFixture(opts: HarvestOptions): Promise<string> {
  const repoBasename = path.basename(opts.repoPath)
  if (!opts.allowedRepos.includes(repoBasename)) {
    throw new HarvestRefusal(
      `harvest refused for '${repoBasename}': not in FIXTURE_ALLOWED_REPOS. Adding a repo requires a ` +
      `reviewed commit to km-crank/src/harvest-cli.ts — the explicit per-repo inclusion ruling. ` +
      `There is no bypass flag.`,
    )
  }

  const kmDir = path.join(opts.repoPath, ".km")
  const refsPath = path.join(kmDir, "fixture-refs.ndjson")
  const sidecarPath = path.join(kmDir, "check-output.ndjson")
  const refsText = fs.existsSync(refsPath) ? fs.readFileSync(refsPath, "utf-8") : ""
  const sidecarText = fs.existsSync(sidecarPath) ? fs.readFileSync(sidecarPath, "utf-8") : ""

  const records = parseFixtureRefRecords(refsText)
  const sidecar = parseCheckOutputRecords(sidecarText)
  const ref = selectRef(records, opts.refName)
  // Parsed records are not trusted input: treeSha flows straight into a
  // shell command below, so reject anything that isn't a 40-hex-char sha
  // BEFORE any directory is created or any subprocess runs.
  if (!TREE_SHA_RE.test(ref.treeSha)) {
    throw new Error(`fixture-ref treeSha is not a valid 40-hex-char sha: ${JSON.stringify(ref.treeSha)}`)
  }
  // Empty/whitespace check would render `if ( ); then` — broken bash in the
  // rendered test.sh. Reject BEFORE any directory is created or any
  // subprocess runs (finding M8).
  if (ref.check.trim().length === 0) {
    throw new Error(
      `fixture-ref check is empty/whitespace-only for ref ${JSON.stringify(ref.ref)}: cannot render a verifier`,
    )
  }
  const join = joinFixture(ref, sidecar)

  let promptContext = {} as ReturnType<typeof extractPromptContext>
  if (ref.transcriptPath) {
    try {
      const jsonl = fs.readFileSync(ref.transcriptPath, "utf-8")
      promptContext = extractPromptContext(jsonl, ref.ts)
    } catch {
      promptContext = {}
    }
  }

  const taskName = opts.taskName ?? `harvested-${repoBasename}-${utcStamp(ref.ts)}`
  const taskDir = path.join(opts.outDir, taskName)
  // mkdirSync(recursive) silently MERGES into an existing dir — refuse
  // outright rather than let a second harvest quietly overwrite/interleave
  // with a prior one's contents (finding M7).
  if (fs.existsSync(taskDir)) {
    throw new Error(`harvest refused: task dir already exists: ${taskDir}`)
  }
  const envDir = path.join(taskDir, "environment")
  const repoDir = path.join(envDir, "repo")
  const testsDir = path.join(taskDir, "tests")
  fs.mkdirSync(repoDir, { recursive: true })
  fs.mkdirSync(testsDir, { recursive: true })

  // Materialize the captured tree — git archive of the ref's treeSha,
  // extracted straight into environment/repo/. `set -o pipefail` is
  // required: without it bash's exit status is the LAST command in the
  // pipe (tar), so a `git archive` failure (e.g. treeSha not found) would
  // be masked by `tar -x` succeeding trivially on empty stdin, silently
  // producing an empty environment/repo instead of throwing.
  runOrThrow(
    `set -o pipefail && git -C ${shQuote(opts.repoPath)} archive --format=tar ${ref.treeSha} | tar -x -C ${shQuote(repoDir)}`,
    opts.repoPath,
  )

  // Secrets hygiene: host-local runtime state and secrets must not enter a
  // committed fixture. `.km` is stripped top-level only (it is only ever
  // materialized at the repo root); `.env*`/`.npmrc`/`.netrc` are stripped
  // recursively — see stripSecretsRecursive above (finding I2).
  fs.rmSync(path.join(repoDir, ".km"), { recursive: true, force: true })
  stripSecretsRecursive(repoDir)

  // Pristine test archive: tamper guard restores these dirs before the
  // check runs, from the capture-time snapshot. Empty archive if none exist
  // — test.sh tolerates a missing/empty tar.
  const pristinePath = path.join(testsDir, "pristine.tar")
  const existingGlobs = TEST_PRISTINE_GLOBS.filter((g) => fs.existsSync(path.join(repoDir, g)))
  if (existingGlobs.length > 0) {
    runOrThrow(`tar -cf ${shQuote(pristinePath)} ${existingGlobs.map((g) => shQuote(g)).join(" ")}`, repoDir)
  } else {
    runOrThrow(`tar -cf ${shQuote(pristinePath)} -T /dev/null`, repoDir)
  }

  fs.writeFileSync(
    path.join(taskDir, "task.toml"),
    renderTaskToml({
      name: taskName,
      description: `Harvested blocked cycle: '${ref.check}' failing (session ${ref.sessionID}, round ${ref.round})`,
      agentTimeoutSec: AGENT_TIMEOUT_SEC,
      verifierTimeoutSec: VERIFIER_TIMEOUT_SEC,
    }),
  )
  fs.writeFileSync(path.join(envDir, "Dockerfile"), renderDockerfile({}))
  const testShPath = path.join(testsDir, "test.sh")
  fs.writeFileSync(testShPath, renderTestSh({ check: ref.check }))
  fs.chmodSync(testShPath, 0o755)
  fs.writeFileSync(
    path.join(taskDir, "instruction.md"),
    renderInstruction({ check: ref.check, prompt: promptContext, excerpt: join.excerpt }),
  )

  // Validity probe — refusals must leave nothing behind: a half-materialized
  // task dir would block the next harvest of the same ref (M7 collision).
  let probe: { checkExitCode: number } | undefined
  if (opts.prober) {
    let outcome: ProbeOutcome
    try {
      outcome = await opts.prober({ envDir, check: ref.check })
    } catch (err) {
      fs.rmSync(taskDir, { recursive: true, force: true })
      throw err
    }
    if (!outcome.buildOk) {
      fs.rmSync(taskDir, { recursive: true, force: true })
      throw new HarvestRefusal(
        `harvest refused: environment image build failed during the validity probe.\n${outcome.output}`,
      )
    }
    if (outcome.checkExitCode === 0) {
      fs.rmSync(taskDir, { recursive: true, force: true })
      throw new HarvestRefusal(
        `harvest refused: fixture is vacuous — check ${JSON.stringify(ref.check)} PASSES in a fresh ` +
        `container (reward 1 with zero agent work). The harvested failure class did not survive ` +
        `re-materialization (host-state failures like stale node_modules cannot be harvested from a tree).`,
      )
    }
    probe = { checkExitCode: outcome.checkExitCode ?? 1 }
  }

  const fixtureJson = {
    ...join,
    ...promptContext,
    generatedAt: new Date().toISOString(),
    repoPath: repoBasename,
    ...(probe !== undefined ? { probe } : {}),
  }
  fs.writeFileSync(path.join(taskDir, "fixture.json"), JSON.stringify(fixtureJson, null, 2) + "\n")

  return taskDir
}

/** Default CLI prober: podman-build the environment/, run the check in a
 * fresh container, always remove the probe image. Blocking is fine — the
 * CLI is interactive and the build is the point. */
export async function podmanProber(a: { envDir: string; check: string }): Promise<ProbeOutcome> {
  const tag = `kkamak-fixture-probe-${process.pid}`
  const build = Bun.spawnSync(["podman", "build", "-t", tag, a.envDir])
  if (build.exitCode !== 0) {
    return { buildOk: false, output: `${build.stdout?.toString() ?? ""}${build.stderr?.toString() ?? ""}` }
  }
  try {
    const run = Bun.spawnSync(["podman", "run", "--rm", tag, "bash", "-lc", `cd /app && ${a.check}`])
    return {
      buildOk: true,
      checkExitCode: run.exitCode ?? 1,
      output: `${run.stdout?.toString() ?? ""}${run.stderr?.toString() ?? ""}`,
    }
  } finally {
    Bun.spawnSync(["podman", "rmi", "-f", tag])
  }
}

function parseArgs(argv: string[]): { repoPath: string; ref?: string; out?: string; name?: string; skipProbe: boolean } {
  const args = [...argv]
  const repoPath = args.shift()
  if (!repoPath) {
    throw new Error(
      "usage: bun km-crank/src/harvest-cli.ts <repoPath> [--ref <fixtureRef>] [--out <tasksDir>] [--name <taskName>] [--skip-probe]",
    )
  }
  let ref: string | undefined
  let out: string | undefined
  let name: string | undefined
  let skipProbe = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--ref") ref = args[++i]
    else if (a === "--out") out = args[++i]
    else if (a === "--name") name = args[++i]
    else if (a === "--skip-probe") skipProbe = true
  }
  return { repoPath, ref, out, name, skipProbe }
}

// This repo's root (km-crank/src -> km-crank -> meta-harness), same
// resolution precedent as crank.ts:72's META_REPO_ROOT.
const META_REPO_ROOT = path.resolve(import.meta.dir, "..", "..")
const DEFAULT_OUT_DIR = path.join(META_REPO_ROOT, "term-bench2", "tasks")

// Run only when executed as the entrypoint — NEVER on import. Same guard
// precedent as crank.ts:485: an unguarded harvest here would fire git
// archive / tar subprocesses every time `bun test` imports this module.
if (import.meta.main) {
  const { repoPath, ref, out, name, skipProbe } = parseArgs(process.argv.slice(2))
  harvestFixture({
    repoPath: path.resolve(repoPath),
    outDir: out ? path.resolve(out) : DEFAULT_OUT_DIR,
    allowedRepos: FIXTURE_ALLOWED_REPOS,
    refName: ref,
    taskName: name,
    prober: skipProbe ? undefined : podmanProber,
  })
    .then((taskDir) => {
      console.log(taskDir)
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[harvest-cli] ${message}`)
      process.exit(1)
    })
}
