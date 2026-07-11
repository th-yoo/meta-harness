/**
 * bench-toml-audit.test.ts — token-free audit of tasks.ts's `Bun.TOML.parse`
 * -based taskTimeouts against Python's hand-rolled minimal TOML reader
 * (term-bench2/runner.py's `read_toml_value`, :286-303), ported here verbatim
 * as a local comparison oracle.
 *
 * Runs for real against every `<tbRoot>/*\/task.toml` in an actual
 * terminal-bench-2 checkout when present; skips cleanly (no failures, just
 * fewer tests) when the clone is absent — this suite must never require the
 * clone to exist.
 *
 * A disagreement here means Bun.TOML's parser (real, spec-compliant TOML)
 * disagrees with Python's minimal regex-line reader on some real task.toml —
 * that would be a deliberate-adoption decision for the controller, not
 * something to paper over, hence a hard test failure naming task+key+both
 * values rather than a warning.
 */
import { test, expect } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { makeBenchPaths } from "../src/bench/paths.ts"
import { taskTimeouts } from "../src/bench/tasks.ts"

const paths = makeBenchPaths()
const tbRootExists = existsSync(paths.tbRoot)

/**
 * Verbatim port of term-bench2/runner.py's `read_toml_value` (:286-303):
 * a minimal reader for `[section]\nkey = value` (floats/ints only), scanning
 * line by line rather than parsing TOML properly.
 */
function readTomlValueMinimal(tomlPath: string, section: string, key: string): number | undefined {
  if (!existsSync(tomlPath)) return undefined
  const text = readFileSync(tomlPath, "utf-8")
  let inSection = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith(`[${section}]`)) {
      inSection = true
      continue
    }
    if (line.startsWith("[") && inSection) {
      inSection = false
    }
    if (inSection && line.startsWith(key)) {
      const m = line.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*([\\d.]+)`))
      if (m && m[1] !== undefined) {
        return parseFloat(m[1])
      }
    }
  }
  return undefined
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** `read_toml_value(...) or <default>` — Python's falsy-fallback idiom
 * (0 also falls back to the default; JS `||` matches that). */
function withPythonDefault(v: number | undefined, fallback: number): number {
  return v || fallback
}

const taskDirs: string[] = tbRootExists
  ? readdirSync(paths.tbRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => existsSync(join(paths.tbRoot, name, "task.toml")))
      .sort()
  : []

test.skipIf(!tbRootExists)(`terminal-bench-2 checkout found at ${paths.tbRoot} with task.toml files`, () => {
  expect(taskDirs.length).toBeGreaterThan(0)
})

for (const task of taskDirs) {
  test.skipIf(!tbRootExists)(`taskTimeouts agrees with minimal TOML reader: ${task}`, () => {
    const tomlPath = join(paths.tbRoot, task, "task.toml")
    const pyAgent = withPythonDefault(readTomlValueMinimal(tomlPath, "agent", "timeout_sec"), 900)
    const pyVerifier = withPythonDefault(readTomlValueMinimal(tomlPath, "verifier", "timeout_sec"), 300)

    const ts = taskTimeouts(paths, task, 0)

    expect(
      ts.agentTimeout,
      `${task} [agent] timeout_sec: Bun.TOML=${ts.agentTimeout} minimal-reader=${pyAgent}`,
    ).toBe(pyAgent)
    expect(
      ts.verifierTimeout,
      `${task} [verifier] timeout_sec: Bun.TOML=${ts.verifierTimeout} minimal-reader=${pyVerifier}`,
    ).toBe(pyVerifier)
  })
}
