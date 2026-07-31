#!/usr/bin/env bun
/**
 * replay-cli.ts — km-gauge corpus-replay CLI (plan 2026-07-31). Thin
 * `import.meta.main`-guarded entry; subcommands accrete task-by-task (T2:
 * `mine`; T3 adds `derive` below — T4/T5 add resolve/report on top,
 * unchanged here).
 *
 * `bun replay-cli.ts mine [cwd]` scans `~/.claude/projects/<slug>/*.jsonl`
 * (override `KKAMAK_CLAUDE_PROJECTS_DIR` — test seam), skipping any nested
 * subdirectory (e.g. `subagents/`) so only top-level session files are ever
 * read, mines each file with corpus-mine.ts's pure `mineJsonl`, dedupes
 * `(repo, promptSha256)` keep-earliest across the whole scan, and upserts
 * the result into the store rooted at `cwd` (`process.cwd()` if omitted).
 * Model-free — mine never spends.
 *
 * `bun replay-cli.ts derive [cwd] --go <n>` batch-derives every pending
 * ("mined" stage) record via corpus-replay.ts's `runDerive` — cost-fenced:
 * `n` must exactly equal the current pending count or the call refuses with
 * zero effect (no model calls, no store write); omitting `--go` also
 * refuses, printing the pending count so the operator can size the next
 * call. This is the ONLY subcommand that spends against a real model.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseGateConfig } from "../config.ts"
import { readCorpus, writeCorpus, upsertRecords } from "./corpus-store.ts"
import { mineJsonl, dedupeEarliest } from "./corpus-mine.ts"
import { runDerive } from "./corpus-replay.ts"

/** `~/.claude/projects`, or `KKAMAK_CLAUDE_PROJECTS_DIR` override. */
export function projectsDir(): string {
  return process.env.KKAMAK_CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), ".claude", "projects")
}

/** Top-level `*.jsonl` files directly under each project slug dir only — a
 * `subagents/` subdirectory (or any other nested dir) is never descended
 * into, per the plan's "only top-level session files" scope pin. Missing/
 * unreadable dirs -> []. */
export function findTranscriptFiles(dir: string): string[] {
  let slugDirs: fs.Dirent[]
  try {
    slugDirs = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const out: string[] = []
  for (const slug of slugDirs) {
    if (!slug.isDirectory()) continue
    const slugPath = path.join(dir, slug.name)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(slugPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl")) out.push(path.join(slugPath, e.name))
    }
  }
  return out
}

/** repo gate.json `.check`, "" if absent/unreadable/malformed — memoized
 * per repo within one mine run since many transcript lines share a repo. */
function makeFloorCheckLookup(): (repo: string) => string {
  const cache = new Map<string, string>()
  return (repo: string) => {
    const cached = cache.get(repo)
    if (cached !== undefined) return cached
    let value = ""
    try {
      const raw = fs.readFileSync(path.join(repo, "gate.json"), "utf-8")
      value = parseGateConfig(raw)?.check ?? ""
    } catch {
      value = ""
    }
    cache.set(repo, value)
    return value
  }
}

export function runMine(cwd: string, log: (m: string) => void): void {
  const files = findTranscriptFiles(projectsDir())
  const floorCheckFor = makeFloorCheckLookup()
  const now = Date.now()

  const mined = files.flatMap((f) => {
    let text: string
    try {
      text = fs.readFileSync(f, "utf-8")
    } catch {
      return []
    }
    return mineJsonl(text, { floorCheckFor, now })
  })

  const deduped = dedupeEarliest(mined)
  const merged = upsertRecords(readCorpus(cwd), deduped)
  const ok = writeCorpus(cwd, merged, log)
  if (ok) {
    log(
      `mine: scanned ${files.length} transcript file(s), mined ${deduped.length} record(s) ` +
        `(pre-dedupe ${mined.length}); store now ${merged.length} record(s)`,
    )
  }
}

/** `--go <n>` extracted; everything else is a positional arg (cwd). Absent
 * `--go` -> `go` stays undefined (runDerive's own missing-go refusal path);
 * a non-numeric value becomes NaN, which likewise never equals a real
 * pending count and refuses via the same mismatch path — no special-casing
 * needed here. */
function parseDeriveArgs(args: string[]): { cwd: string; go: number | undefined } {
  let go: number | undefined
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--go") {
      go = Number(args[i + 1])
      i++
    } else {
      positional.push(args[i]!)
    }
  }
  return { cwd: positional[0] ?? process.cwd(), go }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const sub = args[0]

  if (sub === "mine") {
    const cwd = args[1] ?? process.cwd()
    runMine(cwd, (m) => console.log(m))
    return
  }

  if (sub === "derive") {
    const { cwd, go } = parseDeriveArgs(args.slice(1))
    const summary = await runDerive(cwd, go, (m) => console.log(m))
    if (summary === undefined) process.exitCode = 1
    return
  }

  console.error(`unknown subcommand: ${sub ?? "(none)"} — usage: replay-cli.ts mine|derive [cwd] [--go <n>]`)
  process.exitCode = 1
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e))
    process.exitCode = 1
  })
}
