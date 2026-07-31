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
 * the explicit per-repo inclusion ruling. */
export const FIXTURE_ALLOWED_REPOS: string[] = []

export class HarvestRefusal extends Error {}

export interface HarvestOptions {
  repoPath: string
  outDir: string
  allowedRepos: string[]
  refName?: string
  taskName?: string
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
 * an explicit ask overrides the auto-pick safety filter). Otherwise: newest
 * (max ts) record with no `bail` and a non-empty treeSha. Bailed records are
 * never auto-picked. */
function selectRef(records: FixtureRefRecord[], refName?: string): FixtureRefRecord {
  if (refName !== undefined) {
    const found = records.find((r) => r.ref === refName)
    if (!found) throw new Error(`no fixture-ref record found with ref === ${JSON.stringify(refName)}`)
    return found
  }
  const eligible = records.filter((r) => !r.bail && r.treeSha)
  if (eligible.length === 0) throw new Error("no eligible fixture-ref records (all bailed or missing treeSha)")
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

  const fixtureJson = {
    ...join,
    ...promptContext,
    generatedAt: new Date().toISOString(),
    repoPath: repoBasename,
  }
  fs.writeFileSync(path.join(taskDir, "fixture.json"), JSON.stringify(fixtureJson, null, 2) + "\n")

  return taskDir
}

function parseArgs(argv: string[]): { repoPath: string; ref?: string; out?: string; name?: string } {
  const args = [...argv]
  const repoPath = args.shift()
  if (!repoPath) {
    throw new Error(
      "usage: bun km-crank/src/harvest-cli.ts <repoPath> [--ref <fixtureRef>] [--out <tasksDir>] [--name <taskName>]",
    )
  }
  let ref: string | undefined
  let out: string | undefined
  let name: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--ref") ref = args[++i]
    else if (a === "--out") out = args[++i]
    else if (a === "--name") name = args[++i]
  }
  return { repoPath, ref, out, name }
}

// This repo's root (km-crank/src -> km-crank -> meta-harness), same
// resolution precedent as crank.ts:72's META_REPO_ROOT.
const META_REPO_ROOT = path.resolve(import.meta.dir, "..", "..")
const DEFAULT_OUT_DIR = path.join(META_REPO_ROOT, "term-bench2", "tasks")

// Run only when executed as the entrypoint — NEVER on import. Same guard
// precedent as crank.ts:485: an unguarded harvest here would fire git
// archive / tar subprocesses every time `bun test` imports this module.
if (import.meta.main) {
  const { repoPath, ref, out, name } = parseArgs(process.argv.slice(2))
  harvestFixture({
    repoPath: path.resolve(repoPath),
    outDir: out ? path.resolve(out) : DEFAULT_OUT_DIR,
    allowedRepos: FIXTURE_ALLOWED_REPOS,
    refName: ref,
    taskName: name,
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
