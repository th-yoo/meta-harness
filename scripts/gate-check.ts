// scripts/gate-check.ts
/**
 * Two-tier gate check — the command gate.json names (design:
 * docs/superpowers/plans/2026-08-05-two-tier-gate-check.md; decision logic:
 * km-crank/src/gate-check-core.ts, tested there).
 *
 * Exit 0 = allow the Stop; non-zero = block (check-runner captures output
 * as the block reason). Env: KKAMAK_GATE_FULL=1 forces the incumbent
 * full-sync check; KKAMAK_GATE_NO_BG=1 suppresses the background spawn
 * (tests/CI); KKAMAK_GATE_COMMANDS=<json> replaces the command table
 * (TEST SEAM ONLY).
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawnSync, spawn } from "node:child_process"
import {
  decide, parseMarker, suitesForChangedPaths, ccgateFastFiles,
  slowCcgateTestsForChangedPaths,
  type GateBgMarker, type SuiteId,
} from "../km-crank/src/gate-check-core.ts"

const cwd = process.cwd()
const BG_DIR = path.join(cwd, ".km", "gate-bg")
const MARKER = path.join(BG_DIR, "state.json")
const OUTPUT_TAIL_BYTES = 4096

// ---------- command table (real, or test-seam override) ----------
interface Cmd { cwd: string; argv: string[] }
interface CommandTable { suites: Record<SuiteId, Cmd>; full: Cmd }

function realCommands(): CommandTable {
  // Scan test/ AND src/ recursively: bare `bun test` (the full check)
  // discovers .test.ts anywhere in the package, so a src/-colocated test
  // must not silently drop out of tier 0. None exist today (verified
  // 2026-08-05) — this is the guard for when one lands.
  const fast: string[] = (() => {
    const all: string[] = []
    for (const root of ["test", "src"]) {
      const abs = path.join(cwd, "cc-gate-plugin", root)
      let entries: string[] = []
      try { entries = fs.readdirSync(abs, { recursive: true }) as string[] } catch { continue }
      // foreign repo / missing dirs -> empty list; suite selection won't pick ccgate anyway
      for (const e of entries) if (e.endsWith(".test.ts")) all.push(`${root}/${e}`)
    }
    return ccgateFastFiles(all)
  })()
  return {
    suites: {
      ccgate: { cwd: "cc-gate-plugin", argv: ["bun", "test", ...fast] },
      opencode: { cwd: "opencode-plugin", argv: ["bun", "test"] },
      gateplugin: { cwd: "gate-plugin", argv: ["bun", "test"] },
      kmcrank: { cwd: "km-crank", argv: ["bun", "test"] },
      doccheck: { cwd: ".", argv: ["bun", "scripts/doc-check.ts"] },
    },
    // Tier 1 = incumbent check VERBATIM (plan Global Constraints).
    full: { cwd: ".", argv: ["bash", "-c",
      "cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test && cd ../km-crank && bun test && cd .. && bun scripts/doc-check.ts"] },
  }
}

function commands(): CommandTable {
  const seam = process.env.KKAMAK_GATE_COMMANDS
  if (seam) return JSON.parse(fs.readFileSync(seam, "utf8")) as CommandTable
  return realCommands()
}

// ---------- dirty-tree hash (fixture-ref.ts precedent) ----------
function dirtyTreeId(): string {
  const tmpIndex = path.join(BG_DIR, `index-${process.pid}`)
  fs.mkdirSync(BG_DIR, { recursive: true })
  try {
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex }
    execFileSync("git", ["read-tree", "HEAD"], { cwd, env })
    // DEVIATION (verbatim `git add -A -- . ':!.km'` fails when .km/ is
    // gitignored, as it is in this repo's real .gitignore): git treats an
    // explicitly-named ignored path — even negated — as a hard error
    // ("use -f"), unlike a bare `add -A` which silently skips ignored
    // paths. Add everything with NO explicit pathspec (so gitignored .km
    // is skipped exactly like fixture-ref.ts's plain `git add -A`), then
    // unstage any .km/ entries that snuck in when it's NOT gitignored (the
    // throwaway CLI-test temp repos have no .gitignore at all).
    execFileSync("git", ["add", "-A"], { cwd, env })
    // -f: the temp index file itself lives under .km/gate-bg/ and mutates
    // every call, so its staged content always differs from HEAD/worktree
    // — a plain `rm --cached` refuses that as unsafe. We're deliberately
    // dropping .km/ wholesale, so force is correct here, not dangerous.
    execFileSync("git", ["rm", "-r", "--cached", "-f", "--ignore-unmatch", "--", ".km"], { cwd, env })
    return execFileSync("git", ["write-tree"], { cwd, env, encoding: "utf8" }).trim()
  } finally {
    fs.rmSync(tmpIndex, { force: true })
  }
}

function changedPathsSince(tree: string, current: string): string[] | undefined {
  try {
    const out = execFileSync("git", ["diff", "--name-only", tree, current], { cwd, encoding: "utf8" })
    return out.split("\n").filter(Boolean)
  } catch {
    return undefined   // unknown tree (pruned) -> caller falls back to ALL
  }
}

// ---------- marker I/O ----------
function readMarker(): GateBgMarker | undefined {
  try { return parseMarker(fs.readFileSync(MARKER, "utf8")) } catch { return parseMarker(undefined) }
}
function writeMarker(m: GateBgMarker): void {
  fs.mkdirSync(BG_DIR, { recursive: true })
  const tmp = `${MARKER}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(m))
  fs.renameSync(tmp, MARKER)
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

// ---------- runners ----------
function runSyncCaptured(cmd: Cmd): { code: number; tail: string } {
  const r = spawnSync(cmd.argv[0]!, cmd.argv.slice(1), {
    cwd: path.join(cwd, cmd.cwd), encoding: "utf8", env: process.env,
  })
  const out = (r.stdout ?? "") + (r.stderr ?? "")
  process.stdout.write(out)   // check-runner captures this as the block reason
  return { code: r.status ?? 1, tail: out.slice(-OUTPUT_TAIL_BYTES) }
}

function runFullSync(table: CommandTable, tree: string): number {
  const { code, tail } = runSyncCaptured(table.full)
  writeMarker(code === 0
    ? { status: "green", tree, startedTs: Date.now(), finishedTs: Date.now() }
    : { status: "red", tree, startedTs: Date.now(), finishedTs: Date.now(), outputTail: tail })
  return code
}

/** Detached tier-1: this script re-execs itself in bg mode; the child
 * survives the hook's exit (detached + unref, stdio to a log file).
 * MUST use import.meta.path (the script's own resolved location), NOT a
 * cwd-relative guess — the CLI tests run this script from throwaway temp
 * repos that contain no scripts/ directory. */
function spawnBg(tree: string): void {
  fs.mkdirSync(BG_DIR, { recursive: true })
  const log = fs.openSync(path.join(BG_DIR, "bg.log"), "w")
  const child = spawn("bun", [import.meta.path, "--bg", tree], {
    cwd, detached: true, stdio: ["ignore", log, log],
    env: { ...process.env, KKAMAK_GATE_NICE: "1" },
  })
  writeMarker({ status: "running", tree, pid: child.pid!, startedTs: Date.now() })
  child.unref()
  fs.closeSync(log)
}

/** --bg <tree>: run the full check, write green/red for <tree>. */
function bgMain(tree: string): never {
  const table = commands()
  const r = spawnSync(table.full.argv[0]!, table.full.argv.slice(1), {
    cwd: path.join(cwd, table.full.cwd), encoding: "utf8", env: process.env,
  })
  const out = (r.stdout ?? "") + (r.stderr ?? "")
  const code = r.status ?? 1
  writeMarker(code === 0
    ? { status: "green", tree, startedTs: Date.now(), finishedTs: Date.now() }
    : { status: "red", tree, startedTs: Date.now(), finishedTs: Date.now(), outputTail: out.slice(-OUTPUT_TAIL_BYTES) })
  process.exit(0)   // bg exit code is irrelevant; the marker is the result
}

// ---------- main ----------
function main(): never {
  if (process.argv[2] === "--bg") bgMain(process.argv[3]!)

  const table = commands()
  const tree = dirtyTreeId()
  const marker = readMarker()
  const d = decide({
    tree, marker, pidAlive,
    forceFull: process.env.KKAMAK_GATE_FULL === "1",
    now: Date.now(),
  })

  if (d.mode === "full-sync") {
    if (d.reason === "debt") {
      console.log("gate-check: repaying background-check debt (previous full check FAILED) — running full check synchronously")
      if (marker?.outputTail) console.log(`--- previous failure tail ---\n${marker.outputTail}\n---`)
    }
    process.exit(runFullSync(table, tree))
  }

  if (d.killPid !== undefined) {
    // wedged bg run (amendment a): spawnBg used detached:true, so killPid is
    // a process-GROUP leader — signal the group (negative pid) so the hung
    // bash/bun grandchildren die too, not just the wrapper. Falls back to
    // the single pid if the group is already gone. Still pid-scoped
    // (standing rule: never pkill -f).
    console.log(`gate-check: bg full run wedged (pid ${d.killPid}, started >15min ago) — killing group + respawning`)
    try { process.kill(-d.killPid) } catch { try { process.kill(d.killPid) } catch { /* died in between */ } }
  }

  // tier 0: package-TIA scoped fast suites (+ amendment-b slow pull-in)
  const base = marker?.status === "green" ? marker.tree : undefined
  const changed = base ? changedPathsSince(base, tree) : undefined
  const suites = changed !== undefined ? suitesForChangedPaths(changed) : [...d.suites]
  const slowPull = changed !== undefined ? slowCcgateTestsForChangedPaths(changed) : []
  console.log(`gate-check: tier0 suites [${suites.join(", ")}]${slowPull.length ? ` + slow pull-in [${slowPull.join(", ")}]` : ""} (tree ${tree.slice(0, 8)})`)

  for (const s of suites) {
    // amendment b: changed slow-covered sources append their matching slow
    // test files to the ccgate argv (fast list never contains them — no dupes)
    const cmd = s === "ccgate" && slowPull.length > 0
      ? { cwd: table.suites.ccgate.cwd, argv: [...table.suites.ccgate.argv, ...slowPull] }
      : table.suites[s]
    const { code } = runSyncCaptured(cmd)
    if (code !== 0) {
      console.error(`gate-check: tier0 suite '${s}' FAILED — blocking`)
      process.exit(code)   // no bg spawn while broken
    }
  }

  if (d.spawnBg && process.env.KKAMAK_GATE_NO_BG !== "1") spawnBg(tree)
  process.exit(0)
}

main()
