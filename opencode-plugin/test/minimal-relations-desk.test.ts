import { test, expect } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Desk validation (false-accept probes plan Task 5/6): every relation must
// PASS on the oracle artifact (zero false alarms) and the suite must FAIL a
// deliberately degraded artifact (grip). Real python3 — no fakes.

const TASKS = join(import.meta.dir, "../../minimal/tasks")

function runRelation(scriptPath: string, appdir: string, artifact: string): { code: number; out: string } {
  const r = Bun.spawnSync(["python3", scriptPath], {
    cwd: appdir,
    env: { ...process.env, APPDIR: appdir, ARTIFACT: artifact },
    timeout: 60_000,
  })
  return { code: r.exitCode ?? 1, out: r.stdout.toString() + r.stderr.toString() }
}

function headlessAppdir(artifactSource: string): { appdir: string; artifact: string } {
  const dir = mkdtempSync(join(tmpdir(), "mh-desk-headless-"))
  cpSync(join(TASKS, "headless-terminal/fixtures/base_terminal.py"), join(dir, "base_terminal.py"))
  const artifact = join(dir, "headless_terminal.py")
  writeFileSync(artifact, artifactSource)
  return { appdir: dir, artifact }
}

const RELDIR = join(TASKS, "headless-terminal/relations")
const ORACLE = readFileSync(join(TASKS, "headless-terminal/oracle/headless_terminal.py"), "utf-8")

test("headless: every relation PASSES on the oracle artifact", () => {
  const { appdir, artifact } = headlessAppdir(ORACLE)
  for (const f of readdirSync(RELDIR).filter((f) => f.endsWith(".py"))) {
    const r = runRelation(join(RELDIR, f), appdir, artifact)
    expect({ relation: f, code: r.code, out: r.out.slice(-300) }).toEqual({ relation: f, code: 0, out: r.out.slice(-300) })
  }
}, 120_000)

test("headless: degraded artifact (drops modifier keys) violates at least one relation", () => {
  // Degradation: strip control characters before sending — Ctrl-C/Ctrl-D become no-ops.
  const degraded = ORACLE.replace(
    "def send_keystrokes(self, keystrokes: str, wait_sec: float = 0.0) -> None:",
    'def send_keystrokes(self, keystrokes: str, wait_sec: float = 0.0) -> None:\n        keystrokes = "".join(c for c in keystrokes if c >= " " or c == "\\n")',
  )
  expect(degraded).not.toBe(ORACLE) // the anchor line must exist
  const { appdir, artifact } = headlessAppdir(degraded)
  const codes = readdirSync(RELDIR)
    .filter((f) => f.endsWith(".py"))
    .map((f) => runRelation(join(RELDIR, f), appdir, artifact).code)
  expect(codes.some((c) => c !== 0)).toBe(true)
}, 120_000)
