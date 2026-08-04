/**
 * Two-tier gate check — pure decision logic (no I/O, no processes).
 *
 * Design (docs/superpowers/plans/2026-08-05-two-tier-gate-check.md):
 * the blocking Stop-hook check runs a FAST tier scoped by package-level
 * test-impact selection; the incumbent full check runs DETACHED in the
 * background keyed by dirty-tree hash. A red background result becomes
 * debt: the next gated Stop repays it by running the full check
 * synchronously (self-clearing — failure mode degenerates to the old
 * behavior, never silently weaker).
 */

export type SuiteId = "ccgate" | "opencode" | "gateplugin" | "kmcrank" | "doccheck"

export const ALL_SUITES: SuiteId[] = ["ccgate", "opencode", "gateplugin", "kmcrank", "doccheck"]

/** Conservative-fallback scope = the incumbent check's scope (amendment c).
 * opencode is deliberately absent: the incumbent gate never ran it, and
 * putting it in the fallback would add ~47s to every no-baseline Stop.
 * opencode still runs when TIA matches opencode-plugin/ or functional
 * minimal/ paths — blocking coverage the incumbent never had. */
export const FALLBACK_SUITES: SuiteId[] = ["ccgate", "gateplugin", "kmcrank", "doccheck"]

/** Wedged-bg liveness bound (amendment a): a "running" marker older than
 * this is treated as dead even with a live pid (≈3× expected full-check
 * duration). A hung bg run must not stop full-check coverage forever. */
export const BG_STALE_MS = 15 * 60_000

export interface GateBgMarker {
  status: "running" | "green" | "red"
  /** dirty-tree object id (temp-index write-tree) the run was keyed to */
  tree: string
  pid?: number
  startedTs: number
  finishedTs?: number
  /** tail of the failing check output (host-local only, never committed) */
  outputTail?: string
}

const MARKER_STATUSES = new Set(["running", "green", "red"])

/** Missing/malformed/unknown -> undefined: a broken marker must degrade to
 * "no marker" (spawn a fresh run), never crash the gate. */
export function parseMarker(raw: string | undefined): GateBgMarker | undefined {
  if (raw === undefined) return undefined
  let v: unknown
  try { v = JSON.parse(raw) } catch { return undefined }
  if (typeof v !== "object" || v === null) return undefined
  const m = v as Record<string, unknown>
  if (typeof m.status !== "string" || !MARKER_STATUSES.has(m.status)) return undefined
  if (typeof m.tree !== "string" || m.tree.length === 0) return undefined
  if (typeof m.startedTs !== "number") return undefined
  return m as unknown as GateBgMarker
}

export type GateDecision =
  | { mode: "tier0"; suites: SuiteId[]; spawnBg: boolean; killPid?: number }
  | { mode: "full-sync"; reason: "debt" | "forced" }

/** The whole state machine, one place. Order matters:
 * forced > debt > running-alive (fresh vs wedged) > everything-else. */
export function decide(input: {
  tree: string
  marker: GateBgMarker | undefined
  pidAlive: (pid: number) => boolean
  forceFull: boolean
  now: number
}): GateDecision {
  if (input.forceFull) return { mode: "full-sync", reason: "forced" }
  const m = input.marker
  if (m?.status === "red") return { mode: "full-sync", reason: "debt" }
  if (m?.status === "running" && typeof m.pid === "number" && input.pidAlive(m.pid)) {
    if (input.now - m.startedTs > BG_STALE_MS) {
      // wedged (amendment a): alive pid that never finishes. Kill pid-scoped,
      // respawn — otherwise full-check coverage silently stops for as long
      // as the hung process lives.
      return { mode: "tier0", suites: FALLBACK_SUITES, spawnBg: true, killPid: m.pid }
    }
    return { mode: "tier0", suites: FALLBACK_SUITES, spawnBg: false }
  }
  if (m?.status === "green" && m.tree === input.tree) {
    return { mode: "tier0", suites: FALLBACK_SUITES, spawnBg: false }
  }
  // no marker, dead "running", pid-less "running", or green-for-older-tree
  return { mode: "tier0", suites: FALLBACK_SUITES, spawnBg: true }
}

/** Package-level TIA. Conservative: any path outside the map unions in
 * FALLBACK_SUITES (never an early return — a fallback must never DROP a
 * TIA-picked suite like opencode). `minimal/` maps to opencode (its tests
 * live in opencode-plugin/test/; cc-gate-plugin only holds VENDORED
 * byte-copies, which change under cc-gate-plugin/ and select ccgate on
 * their own). Doc-only paths are checked FIRST so markdown inside a TIA
 * package (minimal/HISTORY.md) stays doc-only; minimal/CLAUDE.md is
 * carved out — it is the FUNCTIONAL sha256'd harness slot, not a doc.
 * doccheck always runs — seconds, and doc drift is half of what the gate
 * exists to catch. */
const TIA_MAP: Array<{ re: RegExp; suite: SuiteId }> = [
  { re: /^cc-gate-plugin\//, suite: "ccgate" },
  { re: /^opencode-plugin\//, suite: "opencode" },
  { re: /^minimal\//, suite: "opencode" },
  { re: /^gate-plugin\//, suite: "gateplugin" },
  { re: /^km-crank\//, suite: "kmcrank" },
]
const FUNCTIONAL_MD_RE = /^minimal\/CLAUDE\.md$/
const DOC_ONLY_RE = /^docs\/|\.md$/

export function suitesForChangedPaths(paths: string[]): SuiteId[] {
  const picked = new Set<SuiteId>()
  for (const p of paths) {
    if (DOC_ONLY_RE.test(p) && !FUNCTIONAL_MD_RE.test(p)) continue  // doccheck added below
    const hit = TIA_MAP.find((e) => e.re.test(p))
    if (hit) { picked.add(hit.suite); continue }
    for (const s of FALLBACK_SUITES) picked.add(s)   // conservative fallback, unioned
  }
  picked.add("doccheck")
  return ALL_SUITES.filter((s) => picked.has(s))
}

/** Spawn-heavy cc-gate-plugin test files excluded from tier 0. Measured
 * 2026-08-05 (darwin): these files ≈134s of a ≈160s suite (real daemon +
 * CC CLI subprocess spawns, 2s settles). They still run in tier 1 on every
 * background full check, and in the merge gate. ONE regex = one policy site. */
export const SLOW_CCGATE_TEST_RE =
  /(acp-client|acp-daemon|acp-pool|anthropic-cli-warm|warm-session|gauge-agent-transport)\.test\.ts$/

export function ccgateFastFiles(allTestFiles: string[]): string[] {
  return allTestFiles.filter((f) => !SLOW_CCGATE_TEST_RE.test(f))
}

/** Amendment b: slow-source pull-in. A changed slow-covered source must
 * pull its MATCHING slow test file(s) into tier 0 — otherwise the one
 * suite that tests the change is exactly the one excluded (edit
 * acp-daemon.ts ⇒ TIA picks ccgate ⇒ tier 0 runs ccgate MINUS the
 * acp-daemon tests). Targeted: only the matching file(s), never the whole
 * ~110s slow set. Source basenames + stub consumers grep-verified
 * 2026-08-05 against cc-gate-plugin (sources in src/gauge/ and
 * src/gauge/providers/; stubs in test/). */
// Policy: DIRECT value imports only (one hop, source/stub -> slow test
// file; `import type` does not count — it cannot break at runtime).
// Deeper transitive chains (e.g. warm-session.ts -> acp-pool.ts ->
// acp-daemon.test.ts) are deliberately NOT chased: full closure would pull
// most of the ~110s slow set and defeat "targeted"; the bg debt gate is
// the stated safety net for that depth.
const SLOW_SOURCE_TO_TESTS: Array<{ re: RegExp; tests: string[] }> = [
  { re: /(^|\/)acp-client\.ts$/, tests: ["test/acp-client.test.ts"] },
  { re: /(^|\/)acp-daemon\.ts$/, tests: ["test/acp-daemon.test.ts"] },
  { re: /(^|\/)acp-pool\.ts$/, tests: ["test/acp-daemon.test.ts", "test/acp-pool.test.ts"] },
  { re: /(^|\/)anthropic-cli-warm\.ts$/, tests: ["test/anthropic-cli-warm.test.ts"] },
  { re: /(^|\/)warm-session\.ts$/, tests: ["test/acp-pool.test.ts", "test/warm-session.test.ts"] },
  { re: /(^|\/)agent-transport\.ts$/, tests: [
    "test/acp-client.test.ts", "test/anthropic-cli-warm.test.ts", "test/gauge-agent-transport.test.ts",
  ] },
  // test stubs — direct value consumers among the SLOW files only
  // (anthropic-api.test.ts also imports agent-cli-stub but is fast — it
  // already runs in every ccgate tier 0):
  { re: /(^|\/)acp-fake-daemon\.ts$/, tests: ["test/acp-client.test.ts", "test/anthropic-cli-warm.test.ts"] },
  { re: /(^|\/)agent-cli-stub\.ts$/, tests: [
    "test/acp-client.test.ts", "test/acp-daemon.test.ts",
    "test/gauge-agent-transport.test.ts", "test/warm-session.test.ts",
  ] },
]

export function slowCcgateTestsForChangedPaths(paths: string[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    if (!/^cc-gate-plugin\//.test(p)) continue
    // a changed slow TEST file pulls itself (test/ or a future src/-colocated one)
    const tm = p.match(/^cc-gate-plugin\/((?:test|src)\/.*\.test\.ts)$/)
    if (tm && SLOW_CCGATE_TEST_RE.test(p)) { out.add(tm[1]!); continue }
    for (const m of SLOW_SOURCE_TO_TESTS) if (m.re.test(p)) for (const t of m.tests) out.add(t)
  }
  return [...out].sort()
}
