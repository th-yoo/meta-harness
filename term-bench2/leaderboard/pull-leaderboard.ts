#!/usr/bin/env bun
/**
 * pull-leaderboard.ts — sweep the harborframework/terminal-bench-2-leaderboard
 * HF dataset and build the inputs curate-band.ts needs.
 *
 * Modes:
 *   bun pull-leaderboard.ts <sub>   single submission (legacy / validation
 *                                   mode) — fetch that submission's trials,
 *                                   write cache/agg-<sub>.json, then re-merge
 *                                   matrix.json from whatever's in cache/.
 *   bun pull-leaderboard.ts --all   sweep ALL submissions under
 *                                   submissions/terminal-bench/2.0/ on the HF
 *                                   dataset (76 as of 2026-07). Per-submission
 *                                   cache/agg-<sub>.json is skip-if-exists, so
 *                                   this is resumable / restartable — kill it
 *                                   and rerun, already-cached subs are read
 *                                   from disk instead of re-fetched. This is
 *                                   an hours-long network sweep; run it in the
 *                                   background (`bun ...  --all &`).
 *   bun pull-leaderboard.ts --merge re-merge matrix.json from the current
 *                                   cache/agg-*.json contents only — no
 *                                   network calls (submissions.json is left
 *                                   untouched; rebuilding it needs metadata.
 *                                   yaml fetches, so only --all / the single-
 *                                   sub mode touch it). Useful to rebuild
 *                                   matrix.json after a partial --all run, or
 *                                   after editing this script's merge logic.
 *
 * cache/ is gitignored — raw per-submission trial aggregates are never
 * committed, only the derived, committed matrix.json + submissions.json.
 *
 * matrix.json shape: Record<task, Record<sub, passRate>> — passRate is the
 * mean of that submission's k trials' 0/1 reward for that task. A (task,
 * sub) pair simply absent means that submission never reported that task
 * (sparse coverage is real — some submissions cover <89 tasks, or run a
 * different k) — never treat a missing pair as reward 0. See
 * opencode-plugin/src/bench/leaderboard.ts for the consumer of this shape.
 *
 * submissions.json shape: Record<sub, SubmissionMeta> — sub id -> agent/model
 * metadata, parsed from that submission's metadata.yaml (agent_display_name,
 * models[0].model_name, etc.) plus an agent/model slug fallback parsed from
 * the sub id itself (agent__model) when metadata.yaml is missing/unreachable.
 * This is a lightweight hand-rolled YAML reader for the one flat shape HF
 * leaderboard metadata.yaml files actually use — not a general YAML parser.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const HERE = new URL(".", import.meta.url).pathname
const CACHE_DIR = join(HERE, "cache")
const MATRIX_PATH = join(HERE, "matrix.json")
const SUBMISSIONS_PATH = join(HERE, "submissions.json")

const API = "https://huggingface.co/api/datasets/harborframework/terminal-bench-2-leaderboard/tree/main/"
const RES = "https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/resolve/main/"
const SUBMISSIONS_BASE = "submissions/terminal-bench/2.0"

// ── HTTP helpers (retry on 429 / transient failure, same policy as the
// original single-submission fetcher) ──────────────────────────────────────

async function j(url: string, tries = 4): Promise<any> {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url)
      if (r.status === 429) { await Bun.sleep(3000 * (a + 1)); continue }
      if (!r.ok) { await Bun.sleep(1000); continue }
      const v = await r.json()
      if (Array.isArray(v) || typeof v === "object") return v
    } catch { await Bun.sleep(1000) }
  }
  return null
}

async function text(url: string, tries = 4): Promise<string | null> {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url)
      if (r.status === 429) { await Bun.sleep(3000 * (a + 1)); continue }
      if (r.status === 404) return null
      if (!r.ok) { await Bun.sleep(1000); continue }
      return await r.text()
    } catch { await Bun.sleep(1000) }
  }
  return null
}

function ensureCacheDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true })
}

// ── submission listing ──────────────────────────────────────────────────

async function listSubmissions(): Promise<string[]> {
  const top = await j(API + SUBMISSIONS_BASE)
  if (!Array.isArray(top)) throw new Error("submission listing failed (tree API)")
  return top
    .filter((e: any) => e.type === "directory")
    .map((e: any) => String(e.path).split("/").pop() as string)
    .sort()
}

// ── per-submission trial fetch (skip-if-cached) ─────────────────────────

interface FetchSummary { tasks: number; trials: number; passPct: number }

function summarize(agg: Record<string, number[]>): FetchSummary {
  const tasks = Object.keys(agg)
  const trials = tasks.reduce((a, t) => a + agg[t]!.length, 0)
  const pass = tasks.reduce((a, t) => a + agg[t]!.reduce((x, y) => x + y, 0), 0)
  return { tasks: tasks.length, trials, passPct: (100 * pass) / (trials || 1) }
}

async function fetchSubmission(sub: string): Promise<{ summary: FetchSummary; fromCache: boolean } | null> {
  const cachePath = join(CACHE_DIR, `agg-${sub}.json`)
  if (existsSync(cachePath)) {
    const agg = JSON.parse(readFileSync(cachePath, "utf-8"))
    return { summary: summarize(agg), fromCache: true }
  }
  const base = `${SUBMISSIONS_BASE}/${sub}`
  const top = await j(API + base)
  if (!Array.isArray(top)) {
    console.error(`${sub}: TOP LISTING FAILED`)
    return null
  }
  const jobs = top.filter((e: any) => e.type === "directory").map((e: any) => e.path)
  const trials: string[] = []
  for (const jb of jobs) {
    const t = await j(API + jb)
    if (Array.isArray(t)) trials.push(...t.filter((e: any) => e.type === "directory").map((e: any) => e.path))
  }
  const agg: Record<string, number[]> = {}
  let i = 0
  async function worker() {
    while (i < trials.length) {
      const tr = trials[i++]!
      const r = await j(RES + tr + "/result.json")
      if (r && r.task_name) (agg[r.task_name] ??= []).push(r.verifier_result?.rewards?.reward ?? 0)
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker))
  await Bun.write(cachePath, JSON.stringify(agg))
  return { summary: summarize(agg), fromCache: false }
}

// ── metadata.yaml (agent/model display info) — tiny hand-rolled reader for
// this one known flat shape (top-level scalars + a `models:` list of flat
// scalar maps), not a general YAML parser. ─────────────────────────────────

interface ModelMeta {
  name?: string
  displayName?: string
  provider?: string
  org?: string
}
interface SubmissionMeta {
  sub: string
  agentSlug: string
  modelSlug: string
  agentDisplayName?: string
  agentOrg?: string
  agentUrl?: string
  models?: ModelMeta[]
}

function stripQuotes(v: string): string {
  return v.trim().replace(/^["']|["']$/g, "")
}

function setModelField(cur: ModelMeta, key: string, val: string): void {
  if (key === "model_name") cur.name = val
  else if (key === "model_display_name") cur.displayName = val
  else if (key === "model_provider") cur.provider = val
  else if (key === "model_org_display_name") cur.org = val
}

function parseMetadataYaml(raw: string): Pick<SubmissionMeta, "agentDisplayName" | "agentOrg" | "agentUrl" | "models"> {
  const out: Pick<SubmissionMeta, "agentDisplayName" | "agentOrg" | "agentUrl" | "models"> = { models: [] }
  let inModels = false
  let cur: ModelMeta | null = null
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "")
    if (/^\s*$/.test(line)) continue
    if (!/^\s/.test(line)) {
      // top-level key
      if (cur) { out.models!.push(cur); cur = null }
      const m = line.match(/^(\w+):\s*(.*)$/)
      if (!m) { inModels = false; continue }
      const [, key, val] = m as [string, string, string]
      if (key === "agent_display_name") out.agentDisplayName = stripQuotes(val)
      else if (key === "agent_org_display_name") out.agentOrg = stripQuotes(val)
      else if (key === "agent_url") out.agentUrl = stripQuotes(val)
      inModels = key === "models"
      continue
    }
    if (!inModels) continue
    const itemStart = line.match(/^\s*-\s*(\w+):\s*(.*)$/)
    if (itemStart) {
      if (cur) out.models!.push(cur)
      cur = {}
      setModelField(cur, itemStart[1]!, stripQuotes(itemStart[2]!))
      continue
    }
    const field = line.match(/^\s+(\w+):\s*(.*)$/)
    if (field && cur) setModelField(cur, field[1]!, stripQuotes(field[2]!))
  }
  if (cur) out.models!.push(cur)
  return out
}

async function fetchMetadata(sub: string): Promise<SubmissionMeta> {
  const idx = sub.indexOf("__")
  const agentSlug = idx >= 0 ? sub.slice(0, idx) : sub
  const modelSlug = idx >= 0 ? sub.slice(idx + 2) : ""
  const meta: SubmissionMeta = { sub, agentSlug, modelSlug }
  const raw = await text(RES + `${SUBMISSIONS_BASE}/${sub}/metadata.yaml`)
  if (raw) Object.assign(meta, parseMetadataYaml(raw))
  return meta
}

async function writeSubmissionsJson(subs: string[]): Promise<void> {
  let existing: Record<string, SubmissionMeta> = {}
  if (existsSync(SUBMISSIONS_PATH)) {
    try { existing = JSON.parse(readFileSync(SUBMISSIONS_PATH, "utf-8")) } catch { existing = {} }
  }
  const out: Record<string, SubmissionMeta> = { ...existing }
  for (const sub of subs) {
    if (out[sub]) continue // metadata already recorded — no network call
    out[sub] = await fetchMetadata(sub)
  }
  await Bun.write(SUBMISSIONS_PATH, JSON.stringify(out, null, 1) + "\n")
}

// ── merge cache/agg-*.json -> matrix.json ───────────────────────────────

function mergeMatrix(): { matrix: Record<string, Record<string, number>>; subs: string[] } {
  ensureCacheDir()
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("agg-") && f.endsWith(".json"))
  const matrix: Record<string, Record<string, number>> = {}
  const subs: string[] = []
  for (const f of files) {
    const sub = f.slice("agg-".length, -".json".length)
    subs.push(sub)
    const agg = JSON.parse(readFileSync(join(CACHE_DIR, f), "utf-8")) as Record<string, number[]>
    for (const [task, rewards] of Object.entries(agg)) {
      const rate = rewards.length ? rewards.reduce((a, b) => a + b, 0) / rewards.length : 0
      ;(matrix[task] ??= {})[sub] = rate
    }
  }
  subs.sort()
  return { matrix, subs }
}

async function writeMatrix(matrix: Record<string, Record<string, number>>): Promise<void> {
  // deterministic key order (sorted task names, sorted sub names per task)
  const ordered: Record<string, Record<string, number>> = {}
  for (const task of Object.keys(matrix).sort()) {
    const row = matrix[task]!
    const orderedRow: Record<string, number> = {}
    for (const sub of Object.keys(row).sort()) orderedRow[sub] = row[sub]!
    ordered[task] = orderedRow
  }
  await Bun.write(MATRIX_PATH, JSON.stringify(ordered, null, 1) + "\n")
}

// ── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  ensureCacheDir()

  if (args[0] === "--merge") {
    const { matrix, subs } = mergeMatrix()
    await writeMatrix(matrix)
    console.log(`merge: wrote ${MATRIX_PATH} (${Object.keys(matrix).length} tasks, ${subs.length} cached subs)`)
    return
  }

  if (args[0] === "--all") {
    const subs = await listSubmissions()
    console.log(`--all: ${subs.length} submissions discovered on HF`)
    for (const [n, sub] of subs.entries()) {
      const result = await fetchSubmission(sub)
      if (!result) continue
      const { summary, fromCache } = result
      console.log(
        `[${n + 1}/${subs.length}] ${sub}: ${fromCache ? "[cached] " : ""}` +
          `${summary.tasks} tasks, ${summary.trials} trials, ${summary.passPct.toFixed(1)}%`,
      )
    }
    const { matrix, subs: cachedSubs } = mergeMatrix()
    await writeSubmissionsJson(cachedSubs)
    await writeMatrix(matrix)
    console.log(
      `--all: wrote ${MATRIX_PATH} (${Object.keys(matrix).length} tasks, ${cachedSubs.length} subs) ` +
        `+ ${SUBMISSIONS_PATH}`,
    )
    return
  }

  const sub = args[0]
  if (!sub) {
    console.error("usage: bun pull-leaderboard.ts <sub> | --all | --merge")
    process.exit(1)
  }
  const result = await fetchSubmission(sub)
  if (!result) process.exit(1)
  const { summary, fromCache } = result!
  console.log(`${sub}: ${fromCache ? "[cached] " : ""}${summary.tasks} tasks, ${summary.trials} trials, ${summary.passPct.toFixed(1)}%`)
  const { matrix, subs } = mergeMatrix()
  await writeSubmissionsJson(subs)
  await writeMatrix(matrix)
  console.log(`merge: wrote ${MATRIX_PATH} (${Object.keys(matrix).length} tasks, ${subs.length} cached subs) + ${SUBMISSIONS_PATH}`)
}

await main()
