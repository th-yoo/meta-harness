import { test, expect } from "bun:test"
import { COVERAGE_HOOK_PY, parseCoveredLines } from "../../minimal/cover.ts"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// S1 wiring (docs/2026-07-27-probe-grip-fix-design.md): a sitecustomize.py
// trace hook records which lines of COV_TARGET executed during a verify run.
// Real python3 subprocess — no fakes — the hook must work on an actual
// interpreter, since that is the only thing it will ever run under.

const TARGET_PY = `def f(a):
    if a > 0:
        return 1
    return 2

f(1)
`

function runTraced(): Set<number> {
  const dir = mkdtempSync(join(tmpdir(), "cover-test-"))
  writeFileSync(join(dir, "sitecustomize.py"), COVERAGE_HOOK_PY)
  const target = join(dir, "target.py")
  writeFileSync(target, TARGET_PY)
  const covOut = join(dir, "cov.lines")
  const r = Bun.spawnSync(["python3", target], {
    env: { ...process.env, PYTHONPATH: dir, COV_TARGET: target, COV_OUT: covOut },
  })
  expect(r.exitCode).toBe(0)
  return parseCoveredLines(existsSync(covOut) ? readFileSync(covOut, "utf-8") : "")
}

test("hook records executed lines of the target and omits the dead branch", () => {
  const covered = runTraced()
  expect(covered.has(2)).toBe(true) // if a > 0:
  expect(covered.has(3)).toBe(true) // return 1 (taken branch)
  expect(covered.has(4)).toBe(false) // return 2 (dead branch)
  expect(covered.has(6)).toBe(true) // f(1) module-level call
})

test("hook is inert without COV_TARGET/COV_OUT env", () => {
  const dir = mkdtempSync(join(tmpdir(), "cover-inert-"))
  writeFileSync(join(dir, "sitecustomize.py"), COVERAGE_HOOK_PY)
  const target = join(dir, "target.py")
  writeFileSync(target, TARGET_PY)
  const r = Bun.spawnSync(["python3", target], { env: { ...process.env, PYTHONPATH: dir } })
  expect(r.exitCode).toBe(0)
})

test("parseCoveredLines dedups and ignores non-numeric junk", () => {
  expect(parseCoveredLines("3\n1\n3\nnot-a-number\n\n2\n")).toEqual(new Set([1, 2, 3]))
})

test("parseCoveredLines of empty text is an empty set", () => {
  expect(parseCoveredLines("")).toEqual(new Set())
})
