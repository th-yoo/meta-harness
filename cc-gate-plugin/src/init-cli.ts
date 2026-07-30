#!/usr/bin/env bun
/**
 * init-cli.ts — token-free `gate.json` initializer.
 *
 *   bun src/init-cli.ts [--check <cmd>] [--gauge] [--force] [--dry-run]
 *
 * Replaces the model-driven `/kkamak:init` slash command (commands/init.md)
 * for the common case: detecting a check command and writing a 4-line
 * gate.json costs no model tokens when done here instead. Detection order
 * mirrors commands/init.md exactly (package.json `scripts.test` first, then
 * bun.lock/@types/bun -> `bun test`); Makefile/pyproject/justfile are
 * explicitly OUT of scope here too (v0.2 deferral, same as the command).
 */
import fs from "node:fs"
import path from "node:path"

const GITIGNORE_LINE = ".km/"

interface ParsedArgs {
  checkOverride: string | undefined
  gauge: boolean
  force: boolean
  dryRun: boolean
}

/** Pure argv parser. Unknown flags are ignored (kept minimal per brief). */
export function parseArgs(argv: string[]): ParsedArgs {
  let checkOverride: string | undefined
  let gauge = false
  let force = false
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--check") {
      checkOverride = argv[i + 1]
      i++
    } else if (a === "--gauge") {
      gauge = true
    } else if (a === "--force") {
      force = true
    } else if (a === "--dry-run") {
      dryRun = true
    }
  }
  return { checkOverride, gauge, force, dryRun }
}

/**
 * Detects a check command at `cwd`, mirroring commands/init.md's Step 1:
 *   1. package.json `scripts.test` (non-empty string) -> "npm test"
 *   2. else bun.lock present, or package.json lists `@types/bun` in
 *      dependencies/devDependencies -> "bun test"
 *   3. else undefined (caller must supply --check or refuse)
 * Makefile/pyproject.toml/justfile are deliberately NOT scanned (v0.2).
 */
export function detectCheckCommand(cwd: string): string | undefined {
  const pkgPath = path.join(cwd, "package.json")
  let pkg: Record<string, unknown> | undefined
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>
  } catch {
    pkg = undefined
  }

  const scripts = pkg?.scripts as Record<string, unknown> | undefined
  if (scripts && typeof scripts.test === "string" && scripts.test.trim().length > 0) {
    return "npm test"
  }

  if (fs.existsSync(path.join(cwd, "bun.lock"))) return "bun test"

  const deps = pkg?.dependencies as Record<string, unknown> | undefined
  const devDeps = pkg?.devDependencies as Record<string, unknown> | undefined
  if ((deps && "@types/bun" in deps) || (devDeps && "@types/bun" in devDeps)) {
    return "bun test"
  }

  return undefined
}

/** Pure: the gate.json object to write (key order: check, rounds, gauge?). */
export function buildGateConfig(check: string, gauge: boolean): Record<string, unknown> {
  const cfg: Record<string, unknown> = { check, rounds: 2 }
  if (gauge) cfg.gauge = true
  return cfg
}

const TEMPLATE = JSON.stringify({ check: "<your verification command here>", rounds: 2 }, null, 2)

/** Appends `.km/` to <cwd>/.gitignore if absent; creates the file if missing.
 * Dedupe is an exact-line match (trimmed), same semantics as commands/init.md's
 * "if not already present" check. No-op if the line is already there. */
export function ensureGitignoreHasKm(cwd: string): void {
  const giPath = path.join(cwd, ".gitignore")
  let existing = ""
  try {
    existing = fs.readFileSync(giPath, "utf-8")
  } catch {
    existing = ""
  }
  const alreadyPresent = existing.split("\n").some((l) => l.trim() === GITIGNORE_LINE)
  if (alreadyPresent) return
  const needsNewline = existing.length > 0 && !existing.endsWith("\n")
  const addition = `${needsNewline ? "\n" : ""}${GITIGNORE_LINE}\n`
  fs.writeFileSync(giPath, existing + addition)
}

function main(): void {
  const cwd = process.cwd()
  const args = parseArgs(process.argv.slice(2))
  const gatePath = path.join(cwd, "gate.json")

  if (fs.existsSync(gatePath) && !args.force) {
    console.error(`init-cli: ${gatePath} already exists — refusing to overwrite. Pass --force to overwrite.`)
    process.exit(1)
  }

  const check = args.checkOverride ?? detectCheckCommand(cwd)
  if (!check) {
    console.error("init-cli: no check command detected in package.json (scripts.test) or bun.lock/@types/bun.")
    console.error("Pass --check '<your verification command>' to set one explicitly. Template:")
    console.error(TEMPLATE)
    console.error("Usage: bun src/init-cli.ts --check '<cmd>' [--gauge] [--force] [--dry-run]")
    process.exit(1)
  }

  const config = buildGateConfig(check, args.gauge)
  const json = JSON.stringify(config, null, 2) + "\n"

  if (args.dryRun) {
    console.log("Would write gate.json (dry run — nothing written):")
    console.log(json)
    return
  }

  fs.writeFileSync(gatePath, json)
  ensureGitignoreHasKm(cwd)
  console.log(`gate.json written at ${gatePath}:`)
  console.log(json)
}

if (import.meta.main) main()
