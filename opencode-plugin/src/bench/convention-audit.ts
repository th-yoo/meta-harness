import { readFileSync, readdirSync, realpathSync, statSync, appendFileSync } from "node:fs"
import { join, dirname, relative, sep } from "node:path"
import { ensureDaemon, daemonCall, closeSession, modelProvenBy, type WarmIsolation } from "@th-yoo/cc-api-daemon"
import type { BenchPaths } from "./paths.ts"
import { DEFAULT_BENCH_MODEL } from "./paths.ts"
import { BenchError } from "./util.ts"

export const AUDIT_PROMPT_VERSION = "lane-a-v2"

/** Numeric parse of a first-column token, tolerant of a single decimal comma
 * (EU locale, e.g. "47183,554644"). A token with a lone comma and no dot has the
 * comma read as a decimal point; anything else falls through to Number(). */
export function parseFirstColNum(tok: string): number {
  if (/^-?\d+,\d+$/.test(tok)) return Number(tok.replace(",", "."))
  return Number(tok)
}

export function auditPrompt(): string {
  return readFileSync(join(dirname(new URL(import.meta.url).pathname), "convention-audit-prompt.txt"), "utf-8")
}

/** Output of buildSample: the flattened text handed to the audit model call
 * + whether the size budget forced early truncation (files after the cutoff
 * were dropped, not partially emitted). */
export interface Sample {
  text: string
  truncated: boolean
}

const DEFAULT_BUDGET_BYTES = 200_000

/** Parse only the COPY directives out of a Dockerfile's raw text — a
 * deliberately narrow, leak-guard-only parser. Do NOT import
 * parseTaskDockerfile (staging.ts): it does zero path containment and
 * die()s on any directive it doesn't classify, which is fatal for a sampler
 * that must run over arbitrary task Dockerfiles. Mirrors the COPY-handling
 * shape at staging.ts:735-756 (skip --from=, multi-source COPY iterates
 * every token but the last as a source) without adopting any of that
 * module's other behavior.
 *
 * Best-effort beyond that mirror: flag tokens (`--chown=`, `--chmod=`,
 * `--link`, ...) are stripped rather than mistaken for a source, and a
 * source containing an unescaped glob char (`*`, `?`, `[`) is skipped
 * (not added, not thrown on) since it can't be realpath-resolved — sampling
 * a subset of a glob's matches is fine for a best-effort sampler. A
 * `--from=` flag still skips the WHOLE COPY line (its source is another
 * build stage, not a host path) rather than being stripped like other flags.
 */
function parseCopySources(dockerfileText: string): string[] {
  const sources: string[] = []
  for (const raw of dockerfileText.split("\n")) {
    const line = raw.trim()
    const m = /^COPY\s+(.+)$/i.exec(line)
    if (!m) continue
    const body = m[1]!
    if (/--from=/.test(body)) continue // multi-stage/external-image copy — not a host path
    const tokens = body.split(/\s+/).filter((p) => p.length > 0)
    const parts = tokens.filter((t) => !t.startsWith("--")) // drop flag tokens (--chown=, --chmod=, --link, ...)
    if (parts.length < 2) continue // need at least one source + a dest
    const srcs = parts.slice(0, -1) // last token is the dest, everything else is a source
    for (const s of srcs) {
      if (/[*?[]/.test(s)) continue // glob source — can't realpath-resolve; skip gracefully
      sources.push(s)
    }
  }
  return sources
}

/** Depth-first, name-sorted file listing under `p` (file or directory) —
 * sorted so the emitted sample is deterministic across OS readdir order. */
function collectFiles(p: string): string[] {
  const st = statSync(p)
  if (st.isFile()) return [p]
  if (!st.isDirectory()) return []
  const out: string[] = []
  const entries = [...readdirSync(p, { withFileTypes: true })].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    const full = join(p, e.name)
    if (e.isDirectory()) out.push(...collectFiles(full))
    else if (e.isFile()) out.push(full)
  }
  return out
}

/** A cheap, dependency-free per-file summary: line count + a `\S+` token
 * histogram (top 10) + a first-column numeric range when every non-blank
 * line's first column parses as a number; binary files (a NUL byte in the
 * first 8000 bytes) get a hex dump of the first 64 bytes instead. Followed
 * by head-20/tail-20 lines so the model sees real content, not just stats.
 */
function summarizeFile(buf: Buffer): string {
  const probe = buf.subarray(0, 8000)
  if (probe.includes(0)) {
    const head = buf.subarray(0, 64)
    return `binary; first 64 bytes hex: ${head.toString("hex")}`
  }

  const text = buf.toString("utf-8")
  const rawLines = text.split("\n")
  const lines = text.endsWith("\n") ? rawLines.slice(0, -1) : rawLines
  const lineCount = lines.length

  const tokenCounts = new Map<string, number>()
  for (const m of text.matchAll(/\S+/g)) {
    tokenCounts.set(m[0], (tokenCounts.get(m[0]) ?? 0) + 1)
  }
  const top = [...tokenCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 10)
    .map(([tok, c]) => `${tok}:${c}`)
    .join(" ")

  const nonBlank = lines.filter((l) => l.trim().length > 0)
  const firstCols = nonBlank.map((l) => l.trim().split(/\s+/)[0]!)
  const nums = firstCols.map(parseFirstColNum)
  let rangeStr = ""
  if (firstCols.length > 0 && nums.every((n) => !Number.isNaN(n))) {
    rangeStr = ` first-col-range=[${Math.min(...nums)}, ${Math.max(...nums)}]`
  }

  const head = lines.slice(0, 20).join("\n")
  const tail = lines.slice(-20).join("\n")
  return `lines=${lineCount} top-tokens: ${top}${rangeStr}\n--head--\n${head}\n--tail--\n${tail}`
}

/** Sample a task's instruction + Dockerfile COPY inputs for the convention-
 * audit model call — LEAK-SAFE: every COPY source is realpath-canonicalized
 * and required to resolve to `<task>/environment` or a descendant of it
 * before any bytes are read, so it can NEVER emit tests/ or solution/
 * content (directly, via `..`-traversal, or via a symlink that resolves
 * outside environment/). Both containment failures throw BenchError rather
 * than silently skipping — a leak guard that degrades instead of failing
 * loud is not a leak guard.
 */
export function buildSample(paths: BenchPaths, task: string, budgetBytes: number = DEFAULT_BUDGET_BYTES): Sample {
  const taskDir = join(paths.tbRoot, task)
  const instructionText = readFileSync(join(taskDir, "instruction.md"), "utf-8")

  let dockerfileText = ""
  try {
    dockerfileText = readFileSync(join(taskDir, "environment", "Dockerfile"), "utf-8")
  } catch {
    dockerfileText = "" // no Dockerfile — nothing to COPY, instruction-only sample
  }

  const root = realpathSync(join(taskDir, "environment"))
  const sources = parseCopySources(dockerfileText)

  const parts: string[] = [instructionText]
  let usedBytes = Buffer.byteLength(instructionText, "utf-8")
  let truncated = false

  outer: for (const src of sources) {
    let cand: string
    try {
      cand = realpathSync(join(root, src))
    } catch (e) {
      throw new BenchError(`convention-audit: COPY source not found (leak guard): ${src}`)
    }
    if (!(cand === root || cand.startsWith(root + sep))) {
      throw new BenchError(`convention-audit: COPY source escapes environment/ (leak guard): ${src}`)
    }

    for (const filePath of collectFiles(cand)) {
      const buf = readFileSync(filePath)
      const name = relative(root, filePath)
      const block = `=== ${name} (${buf.length}) ===\n${summarizeFile(buf)}\n`
      const blockBytes = Buffer.byteLength(block, "utf-8")
      if (usedBytes + blockBytes > budgetBytes) {
        truncated = true
        break outer
      }
      parts.push(block)
      usedBytes += blockBytes
    }
  }

  return { text: parts.join("\n"), truncated }
}

export function parseVerdict(raw: string): "MISMATCH" | "NO_MISMATCH" {
  const m = raw.match(/CONTENT VERDICT:\s*(MISMATCH|NO MISMATCH)/i)
  if (!m) return "NO_MISMATCH"
  return m[1].toUpperCase() === "MISMATCH" ? "MISMATCH" : "NO_MISMATCH"
}

export function cardFrom(raw: string): string {
  return raw.trim()
}

export type RevalTransform = "reciprocal" | "scale" | "offset" | "identity"

/** Evaluate a whitelisted single-constant transform. Pinned: offset = C - in
 * (laser-line subtraction; both gen4 fixtures use this sign). No eval, no
 * arbitrary formulae. */
export function applyTransform(t: RevalTransform, c: number, x: number): number {
  switch (t) {
    case "reciprocal": return c / x
    case "scale": return c * x
    case "offset": return c - x
    case "identity": return x
  }
}

/** The audit call's isolation: bare (no tools, no persisted session,
 * thinking disabled) — mirrors `A4_ISOLATION` (a4-review.ts:88-96)
 * exactly, distinguished only by `title` so an audit call is unambiguous
 * in a transcript or a log line. `daemonCall`'s `opts.isolation` is
 * REQUIRED, never defaulted (acp-client.ts:120) — `{}` would be a compile
 * error and a meaningless frame to the daemon. */
const AUDIT_ISOLATION: WarmIsolation = {
  systemPrompt: "",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "kkamak-lane-a-convention-audit",
  thinking: { type: "disabled" },
}

export type AuditResult =
  | { card: string; rawAudit: string; verdict: "MISMATCH"; sample: string; truncated: boolean }
  | { card: null; rawAudit: string; verdict: "NO_MISMATCH" | "ERROR"; sample: string; truncated: boolean }

/**
 * The live convention-audit call: `ensureDaemon` (zero-wait) -> `daemonCall`
 * -> `modelProvenBy`/truncation check -> `parseVerdict` -> `cardFrom` ->
 * `closeSession` (best effort, `finally`, only when a session was actually
 * created) — mirrors `runA4Review` (a4-review.ts:247-290).
 *
 * Fail-safe: any daemon error, non-"ok" outcome, `max_tokens` truncation,
 * or an unproven model returns `{ card: null, verdict: "ERROR", ... }`.
 * The daemon-call path never throws — every step from `ensure` through
 * `close` is wrapped in try/catch/finally, so a daemon-side failure always
 * comes back as an ERROR result, never an exception.
 *
 * NOTE: `buildSample(paths, task)` runs BEFORE that try block and CAN
 * throw — a leak-guard containment failure (COPY source escapes
 * `environment/`) or a missing `instruction.md` propagate straight out of
 * this function. That is deliberate: the leak guard is designed to fail
 * loud (see this module's `buildSample` doc comment — "a leak guard that
 * degrades instead of failing loud is not a leak guard"), so it is not
 * caught here. The caller (`runTaskOnce`, Task 7) is responsible for
 * guarding that boundary.
 *
 * `ACP_TURN_TIMEOUT_MS` defaults to "120000" in the env handed to the
 * daemon calls (unless the caller already set one) — the daemon's own
 * 16s default is tuned for short turns and kills a multi-KB-sample audit
 * turn before the model can reply.
 *
 * `deps` lets tests inject fakes for `daemonCall`/`ensureDaemon`/
 * `closeSession`; defaulting to the real imports keeps the production call
 * site a single import, not a wiring exercise.
 */
const _cache = new Map<string, Promise<AuditResult>>()

export function _resetAuditCache() {
  _cache.clear()
}

export async function auditCard(
  paths: BenchPaths,
  task: string,
  env: Record<string, string | undefined>,
  deps: { call?: typeof daemonCall; ensure?: typeof ensureDaemon; close?: typeof closeSession } = {},
): Promise<AuditResult> {
  const hit = _cache.get(task)
  if (hit) return hit
  const p = runAuditUncached(paths, task, env, deps)
  _cache.set(task, p)        // set the PROMISE before await → single-flight
  return p
}

export async function runAuditUncached(
  paths: BenchPaths,
  task: string,
  env: Record<string, string | undefined>,
  deps: { call?: typeof daemonCall; ensure?: typeof ensureDaemon; close?: typeof closeSession } = {},
): Promise<AuditResult> {
  const call = deps.call ?? daemonCall
  const ensure = deps.ensure ?? ensureDaemon
  const close = deps.close ?? closeSession

  const { text: sample, truncated } = buildSample(paths, task)
  const auditEnv = { ...env, ACP_TURN_TIMEOUT_MS: env.ACP_TURN_TIMEOUT_MS ?? "120000" }

  let sid: string | undefined
  try {
    await ensure(auditEnv, { waitMs: 0 })

    const outcome = await call(auditPrompt() + "\n\n" + sample, DEFAULT_BENCH_MODEL, auditEnv, {
      isolation: AUDIT_ISOLATION,
    })

    if (outcome.kind !== "ok") return { card: null, rawAudit: "", verdict: "ERROR", sample, truncated }
    sid = outcome.sessionId

    if (
      outcome.stopReason === "max_tokens" ||
      !modelProvenBy(outcome.model, DEFAULT_BENCH_MODEL, outcome.canonicalModel)
    ) {
      return { card: null, rawAudit: outcome.text ?? "", verdict: "ERROR", sample, truncated }
    }

    const verdict = parseVerdict(outcome.text)
    if (verdict === "NO_MISMATCH") return { card: null, rawAudit: outcome.text, verdict, sample, truncated }
    return { card: cardFrom(outcome.text), rawAudit: outcome.text, verdict: "MISMATCH", sample, truncated }
  } catch {
    return { card: null, rawAudit: "", verdict: "ERROR", sample, truncated }
  } finally {
    if (sid) {
      try {
        await close(sid, auditEnv)
      } catch {
        /* best effort — close-not-release, but never lets a close failure
         * override the audit outcome already decided above */
      }
    }
  }
}

/** Append one ndjson line to <resultsDir>/convention-audit-trail.ndjson recording
 * the audit result: {task, promptVersion, verdict, truncated, cardLen, sampleLen, card, rawAudit}.
 * This is the leak-safety record that documents what was sent to the audit model.
 */
export function writeAuditTrail(paths: BenchPaths, task: string, r: AuditResult): void {
  const line = {
    task,
    promptVersion: AUDIT_PROMPT_VERSION,
    verdict: r.verdict,
    truncated: r.truncated,
    cardLen: r.card?.length ?? 0,
    sampleLen: r.sample.length,
    card: r.card,
    rawAudit: r.rawAudit,
  }
  appendFileSync(join(paths.resultsDir, "convention-audit-trail.ndjson"), JSON.stringify(line) + "\n")
}
