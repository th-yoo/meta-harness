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
  // The pattern captures what's inside the parentheses
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

  // Check set equality
  expect(crankSet.size).toBe(bashSet.size)
  for (const repo of crankSet) {
    expect(bashSet.has(repo)).toBe(true)
  }
  for (const repo of bashSet) {
    expect(crankSet.has(repo)).toBe(true)
  }
})
