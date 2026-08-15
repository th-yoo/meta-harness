import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { REPOS as REPOS_FROM_CRANK } from "../src/crank.ts"

/**
 * Extract the REPOS array from km-sensors-sync.sh bash script.
 * Looks for the pattern: REPOS=(~/z2/meta-harness ~/z2/squad ...)
 * and returns the array of paths with ~ expanded to the home directory.
 */
function extractReposFromBashScript(scriptPath: string): string[] {
  const content = fs.readFileSync(scriptPath, "utf-8")

  // Match: REPOS=( ... )
  // The pattern captures what's inside the parentheses.
  // FORMAT ASSUMPTION: the assignment must stay single-line and unquoted
  // (REPOS=(~/a ~/b ...)). Reformatting it multi-line or quoting entries
  // breaks this extraction LOUDLY (throw / spurious mismatch), never
  // silently — if you reformat the script, update this parser with it.
  const match = content.match(/^REPOS=\((.*?)\)$/m)
  if (!match || !match[1]) {
    throw new Error(`Could not find REPOS assignment in ${scriptPath}`)
  }

  // Split by whitespace and filter out empty strings
  const rawRepos = match[1]
    .trim()
    .split(/\s+/)
    .filter((r) => r.length > 0)

  // Expand ~ to home directory, matching crank.ts's expandHome behavior
  const expanded = rawRepos.map((repo) => {
    return repo.startsWith("~") ? path.join(os.homedir(), repo.slice(1)) : repo
  })

  return expanded
}

test("REPOS parity: crank.ts and km-sensors-sync.sh contain the same repository list", () => {
  // Find the repo root (go up from test dir to km-crank to root)
  const repoRoot = path.resolve(import.meta.dir, "..", "..")
  const scriptPath = path.join(repoRoot, "scripts", "km-sensors-sync.sh")

  // Extract REPOS from bash script
  const reposFromBash = extractReposFromBashScript(scriptPath)

  // Convert both to sets for order-independent comparison
  const crankSet = new Set(REPOS_FROM_CRANK)
  const bashSet = new Set(reposFromBash)

  // Set equality asserted as empty difference lists so a drift failure
  // PRINTS the offending repo paths, not just sizes/booleans.
  const onlyInCrank = [...crankSet].filter((r) => !bashSet.has(r))
  const onlyInBash = [...bashSet].filter((r) => !crankSet.has(r))
  expect(onlyInCrank).toEqual([])
  expect(onlyInBash).toEqual([])
})

test("F2: check-output sidecar is NEVER in km-sensors-sync.sh's FILES export list", () => {
  // The snapshot is a one-way door (refuse-on-shrink dedup): a sidecar line
  // exported once can never be retroactively stripped. The sidecar carries
  // code-bearing check output and must stay host-local forever.
  const repoRoot = path.resolve(import.meta.dir, "..", "..")
  const scriptPath = path.join(repoRoot, "scripts", "km-sensors-sync.sh")
  const script = fs.readFileSync(scriptPath, "utf-8")
  const filesLine = script.split("\n").find((l) => l.trimStart().startsWith("FILES=("))
  expect(filesLine).toBeDefined()
  expect(filesLine!).not.toContain("check-output")
})

test("F2: rule-checks export is NEVER in km-sensors-sync.sh's FILES export list", () => {
  const repoRoot = path.resolve(import.meta.dir, "..", "..")
  const script = fs.readFileSync(path.join(repoRoot, "scripts", "km-sensors-sync.sh"), "utf-8")
  const filesLine = script.split("\n").find((l) => l.trimStart().startsWith("FILES=("))
  expect(filesLine).toBeDefined()
  expect(filesLine!).not.toContain("rule-checks")
})

test("F2: hook-rules table + hook-rule-outcomes accumulator are NEVER in km-sensors-sync.sh's FILES export list", () => {
  // hook-rule P2: `.km/hook-rules.json` (compiled patterns) and
  // `.km/hook-rule-outcomes-*.ndjson` (per-session accumulator) stay
  // host-local forever — same one-way-door rationale as the sidecar/
  // rule-checks locks above.
  const repoRoot = path.resolve(import.meta.dir, "..", "..")
  const script = fs.readFileSync(path.join(repoRoot, "scripts", "km-sensors-sync.sh"), "utf-8")
  const filesLine = script.split("\n").find((l) => l.trimStart().startsWith("FILES=("))
  expect(filesLine).toBeDefined()
  expect(filesLine!).not.toContain("hook-rules")
  expect(filesLine!).not.toContain("hook-rule-outcomes")
})
