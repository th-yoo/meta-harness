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

/** Conservative-fallback scope = the ORIGINAL incumbent check's scope
 * (amendment c) — ccgate + gateplugin + kmcrank + doccheck, i.e. what the
 * pre-two-tier gate always ran. opencode is deliberately absent here even
 * though it was ADDED to tier 1's `full` command (scripts/gate-check.ts,
 * 2026-08-08, closing the blind-spot where a cc-gate-plugin-only commit that
 * broke opencode-plugin was invisible to both tiers indefinitely): this
 * list is a different, cost-conscious tradeoff, not a mirror of `full`'s
 * argv. Measured 2026-08-08, `cd opencode-plugin && bun test` alone takes
 * ~45s — adding it here would tax it onto every no-baseline tier-0 Stop.
 * That tax buys little: TIA already runs opencode precisely when
 * opencode-plugin/ or functional minimal/ paths change (below), and the
 * fallback-triggering cases (no green marker yet, or a genuinely
 * unrecognized changed path) are still bounded by tier 1's background
 * full-sync — which DOES now cover opencode-plugin — on the very next
 * tree-changing Stop. So omission here costs latency-to-detection, not
 * permanent blindness; keep it out unless that latency proves unacceptable
 * in practice. */
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
 * background full check, and in the pre-merge sanity chain. ONE regex = one
 * policy site. */
const SLOW_CCGATE_TEST_RE =
  /(acp-client|acp-daemon|acp-pool|anthropic-cli-warm|warm-session|gauge-agent-transport)\.test\.ts$/

/** Spawn-heavy km-crank test file excluded from tier 0. Measured 2026-08-06:
 * gate-check-cli.test.ts is an end-to-end CLI drive with multi-second
 * `until()` waits — 13.9s of km-crank's ≈15.8s suite. Basename-anchored for
 * the same reason as the pull-in rules below (a future directory move must
 * not silently stop this matching). ONE regex = one policy site (mirrors
 * SLOW_CCGATE_TEST_RE). */
export const SLOW_KMCRANK_TEST_RE = /(^|\/)gate-check-cli\.test\.ts$/

/** Suite id -> the package directory its tests live under. Only the suites
 * that currently need it (pull-in self-matching below; `scripts/gate-check.ts`'s
 * `scanFastArgv`-derived `Cmd.cwd`/`Cmd.argv`) are populated — this is not a
 * claim that every SuiteId has (or needs) an entry.
 *
 * DOUBLE DUTY, one map, two consumers: (1) here in `pullInsFor`, presence
 * drives the self-pull regex (a changed slow test file pulls itself); (2)
 * in `scripts/gate-check.ts`'s `realCommands()`, presence is what a suite
 * needs to get its `Cmd.cwd` derived AND its argv turned from bare
 * `["bun","test"]` into an enumerated fast-file list via `fastFiles()`. A
 * third entry added here later for reason (1) alone would, if
 * `gate-check.ts` is ever changed to iterate this map rather than call
 * `fastFiles`/`Cmd.cwd` derivation explicitly per suite, silently convert
 * that suite's argv into a file list too — read both call sites before
 * adding an entry. */
export const PKG_DIR: Partial<Record<SuiteId, string>> = {
  ccgate: "cc-gate-plugin",
  kmcrank: "km-crank",
}

/** A pull-in rule: a changed path matching `re` pulls `tests` into its
 * suite's tier-0 run. `guard`, when present, is a path prefix a change must
 * also satisfy — e.g. a package prefix, so the same source basename can't
 * false-positive across packages sharing this table. Guardless rules are
 * legitimate: kmcrank's rules below are the guardless case, a `scripts/…`
 * -> km-crank test mapping that by construction can't be package-prefixed,
 * since `scripts/gate-check.ts` and this module live outside `km-crank/`. */
interface PullInRule {
  re: RegExp
  tests: string[]
  guard?: RegExp
}

interface SuitePolicy {
  /** Spawn-heavy test files excluded from this suite's tier 0. Absent means
   * this suite has no narrowing, so its self-pull step is a no-op. */
  slowTestRe?: RegExp
  rules: PullInRule[]
}

const CCGATE_GUARD = /^cc-gate-plugin\//

/** Amendment b: slow-source pull-in. A changed slow-covered source must
 * pull its MATCHING slow test file(s) into tier 0 — otherwise the one
 * suite that tests the change is exactly the one excluded (edit
 * acp-daemon.ts ⇒ TIA picks ccgate ⇒ tier 0 runs ccgate MINUS the
 * acp-daemon tests). Targeted: only the matching file(s), never the whole
 * ~110s slow set. Source basenames + stub consumers grep-verified
 * 2026-08-05 against cc-gate-plugin (sources in src/acp/ and
 * src/gauge/providers/; stubs in test/). The ACP sources moved from
 * src/gauge/ to src/acp/ later the same day; these patterns are
 * basename-anchored (`(^|\/)name\.ts$`) precisely so a directory move
 * cannot silently stop them matching — do not re-anchor them to a
 * directory. */
// Policy: DIRECT value imports only (one hop, source/stub -> slow test
// file; `import type` does not count — it cannot break at runtime).
// Deeper transitive chains (e.g. warm-session.ts -> acp-pool.ts ->
// acp-daemon.test.ts) are deliberately NOT chased: full closure would pull
// most of the ~110s slow set and defeat "targeted"; the bg debt gate is
// the stated safety net for that depth.
//
// INVARIANT (the mirror image of PKG_DIR's double-duty warning above): a
// suite may be given `rules` here ONLY if its `Cmd.argv` in
// scripts/gate-check.ts is an ENUMERATED fast-file list, never a bare
// `["bun","test"]`. `pullInsFor` returns rule-derived tests independent of
// PKG_DIR/Cmd shape — it has no way to know or check what a suite's argv
// looks like. A suite added here with pull-in rules while its Cmd stays
// literal `["bun","test"]` would have the pull-in append silently convert
// "run the whole suite" into "run only the appended file" — the exact
// class of bug the `scanFailed` degradation guard in scripts/gate-check.ts
// exists to prevent, reintroduced by a policy-side mistake instead of a
// scan-side one. Pinned by a test (every SUITE_POLICY key is also a PKG_DIR
// key) in gate-check-core.test.ts — exported for that reason.
export const SUITE_POLICY: Partial<Record<SuiteId, SuitePolicy>> = {
  ccgate: {
    slowTestRe: SLOW_CCGATE_TEST_RE,
    rules: [
      { re: /(^|\/)acp-client\.ts$/, tests: ["test/acp-client.test.ts"], guard: CCGATE_GUARD },
      { re: /(^|\/)acp-daemon\.ts$/, tests: ["test/acp-daemon.test.ts"], guard: CCGATE_GUARD },
      { re: /(^|\/)acp-pool\.ts$/, tests: ["test/acp-daemon.test.ts", "test/acp-pool.test.ts"], guard: CCGATE_GUARD },
      { re: /(^|\/)anthropic-cli-warm\.ts$/, tests: ["test/anthropic-cli-warm.test.ts"], guard: CCGATE_GUARD },
      { re: /(^|\/)warm-session\.ts$/, tests: ["test/acp-pool.test.ts", "test/warm-session.test.ts"], guard: CCGATE_GUARD },
      { re: /(^|\/)agent-transport\.ts$/, tests: [
        "test/acp-client.test.ts", "test/anthropic-cli-warm.test.ts", "test/gauge-agent-transport.test.ts",
      ], guard: CCGATE_GUARD },
      // test stubs — direct value consumers among the SLOW files only
      // (anthropic-api.test.ts also imports agent-cli-stub but is fast — it
      // already runs in every ccgate tier 0):
      { re: /(^|\/)acp-fake-daemon\.ts$/, tests: ["test/acp-client.test.ts", "test/anthropic-cli-warm.test.ts"], guard: CCGATE_GUARD },
      { re: /(^|\/)agent-cli-stub\.ts$/, tests: [
        "test/acp-client.test.ts", "test/acp-daemon.test.ts",
        "test/gauge-agent-transport.test.ts", "test/warm-session.test.ts",
      ], guard: CCGATE_GUARD },
    ],
  },
  kmcrank: {
    slowTestRe: SLOW_KMCRANK_TEST_RE,
    rules: [
      // Guardless (the first such rule — see the PullInRule doc comment
      // above): scripts/gate-check.ts and gate-check-core.ts live OUTSIDE
      // km-crank/, so a package-prefix guard would make these rules dead
      // code. That is the whole point — editing the gate's own entry point
      // or its pure-logic module must pull km-crank's end-to-end CLI test
      // back into tier 0, or the gate loses its most direct coverage of
      // itself. gate-check-core.ts is matched basename-anchored per the
      // convention documented above; do not re-anchor it to a directory.
      { re: /^scripts\/gate-check\.ts$/, tests: ["test/gate-check-cli.test.ts"] },
      { re: /(^|\/)gate-check-core\.ts$/, tests: ["test/gate-check-cli.test.ts"] },
    ],
  },
}

/** SUITE-KEYED pull-in: returns only `suite`'s own test paths, never a flat
 * union across suites — a flat union would leak e.g. a km-crank test path
 * into the ccgate argv, and `bun test` treats positionals as path filters
 * (a non-matching filter wastes the run or exits non-zero). A suite absent
 * from SUITE_POLICY has no narrowing and pulls nothing. */
export function pullInsFor(suite: SuiteId, paths: string[]): string[] {
  const policy = SUITE_POLICY[suite]
  if (!policy) return []
  const pkgDir = PKG_DIR[suite]
  const selfPullRe = pkgDir ? new RegExp(`^${pkgDir}/((?:test|src)/.*\\.test\\.ts)$`) : undefined
  const out = new Set<string>()
  for (const p of paths) {
    // a changed slow TEST file pulls itself (test/ or a future src/-colocated
    // one), per-suite via PKG_DIR rather than a hardcoded ccgate anchor
    if (selfPullRe && policy.slowTestRe) {
      const tm = p.match(selfPullRe)
      if (tm && policy.slowTestRe.test(p)) { out.add(tm[1]!); continue }
    }
    for (const rule of policy.rules) {
      if (rule.guard && !rule.guard.test(p)) continue
      if (rule.re.test(p)) for (const t of rule.tests) out.add(t)
    }
  }
  return [...out].sort()
}

/** SUITE-KEYED fast-list filter: drops `suite`'s spawn-heavy test files
 * (per `SUITE_POLICY[suite].slowTestRe`) from a scanned file list. A suite
 * with no configured `slowTestRe` (no narrowing) returns the list
 * unfiltered — generalises the old ccgate-only `ccgateFastFiles`, which
 * this replaces, to any suite Task 1/2 gave a policy. */
export function fastFiles(suite: SuiteId, allTestFiles: string[]): string[] {
  const slowRe = SUITE_POLICY[suite]?.slowTestRe
  if (!slowRe) return allTestFiles
  return allTestFiles.filter((f) => !slowRe.test(f))
}

/** Pure decision half of scripts/gate-check.ts's scanFastArgv: given what a
 * (possibly partial) directory scan collected and whether ANY root of it
 * failed, return the fast-file suffix for that suite's tier-0 argv.
 *
 * `scanFailed` degrades the WHOLE scan, not just the root that threw: if
 * one root (e.g. test/) read fine and contributed to `all` but another
 * (e.g. src/) threw, keeping test/'s partial results would produce an argv
 * that LOOKS correctly narrowed but is silently missing whatever the
 * failed root would have added — and scripts/gate-check.ts's main() also
 * skips the pull-in append whenever scanFailed is set, so a changed
 * slow-covered file under the failed root would land in neither the fast
 * list nor the append: zero tier-0 coverage for it. So `scanFailed: true`
 * here always returns `[]` (the caller prepends `["bun","test"]`, i.e. run
 * everything for that package) regardless of what `all` collected —
 * factored out of the fs-touching scan loop specifically so this discard
 * decision is unit-testable without a real filesystem. */
export function fastArgvSuffix(suite: SuiteId, all: string[], scanFailed: boolean): string[] {
  return scanFailed ? [] : fastFiles(suite, all)
}
