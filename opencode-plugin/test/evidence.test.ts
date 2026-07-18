import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { validateEvidenceDir, buildExternalEvidenceSection } from "../src/evidence.ts"

// Phase 8 / W4b: external strategy-evidence seam. Token-free — exercises the
// pure directory-scan + prompt-section builder directly, no LLM/opencode
// session involved.

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mh-evidence-${name}-`))
}

/** evidence/<task>/<agent>.md, mirroring the committed repo layout. */
function seedEvidenceFile(dir: string, task: string, agent: string, body: string): void {
  const taskDir = path.join(dir, task)
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, `${agent}.md`), body)
}

// ── validateEvidenceDir ──────────────────────────────────────────────────

test("validateEvidenceDir: no evidence files -> empty", () => {
  const dir = tmpDir("empty")
  expect(validateEvidenceDir(dir, ["some-held-out-task"])).toEqual([])
})

test("validateEvidenceDir: missing dir -> empty, does not throw", () => {
  const dir = path.join(tmpDir("missing"), "does-not-exist")
  expect(validateEvidenceDir(dir, ["task-a"])).toEqual([])
})

test("validateEvidenceDir: flags files whose task is held-out", () => {
  const dir = tmpDir("flag")
  seedEvidenceFile(dir, "task-held-in", "agentA", "# notes\nheld-in task notes")
  seedEvidenceFile(dir, "task-held-out", "agentB", "# notes\nheld-out task notes")

  const offending = validateEvidenceDir(dir, ["task-held-out"])

  expect(offending).toEqual([path.join(dir, "task-held-out", "agentB.md")])
})

test("validateEvidenceDir: TEMPLATE.md at the evidence-dir root is never flagged (not inside a task dir)", () => {
  const dir = tmpDir("template")
  fs.writeFileSync(path.join(dir, "TEMPLATE.md"), "# template")
  seedEvidenceFile(dir, "task-held-out", "agentB", "notes")

  const offending = validateEvidenceDir(dir, ["task-held-out"])

  // Only the real evidence file under the held-out task dir is flagged —
  // TEMPLATE.md at the root is not enumerated as a task at all.
  expect(offending).toEqual([path.join(dir, "task-held-out", "agentB.md")])
})

// ── buildExternalEvidenceSection ─────────────────────────────────────────

test("buildExternalEvidenceSection: empty dir arg -> \"\" (config disabled)", () => {
  expect(buildExternalEvidenceSection("", ["anything"])).toBe("")
})

test("buildExternalEvidenceSection: dir does not exist on disk -> \"\"", () => {
  const dir = path.join(tmpDir("nodir"), "nope")
  expect(buildExternalEvidenceSection(dir, [])).toBe("")
})

test("buildExternalEvidenceSection: dir exists but has no evidence files -> \"\"", () => {
  const dir = tmpDir("noevidence")
  expect(buildExternalEvidenceSection(dir, [])).toBe("")
})

test("buildExternalEvidenceSection: renders an INDEX with UNTRUSTED header + relative path + first line", () => {
  const dir = tmpDir("index")
  seedEvidenceFile(dir, "task-alpha", "agentA", "Prefer reading the full error before retrying.\nmore body text")

  const section = buildExternalEvidenceSection(dir, [])

  expect(section).toContain("UNTRUSTED, third-party")
  expect(section).toContain(path.join("task-alpha", "agentA.md"))
  expect(section).toContain("Prefer reading the full error before retrying.")
  // The index must NOT dump the rest of the file body (index only).
  expect(section).not.toContain("more body text")
})

test("buildExternalEvidenceSection: skips held-out tasks' files and logs a warning naming them", () => {
  const dir = tmpDir("skip")
  seedEvidenceFile(dir, "task-in", "agentA", "held-in lesson")
  seedEvidenceFile(dir, "task-out", "agentB", "held-out lesson")

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const section = buildExternalEvidenceSection(dir, ["task-out"])

    expect(section).toContain(path.join("task-in", "agentA.md"))
    expect(section).not.toContain(path.join("task-out", "agentB.md"))

    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("task-out") && m.includes("agentB.md"))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }
})

test("buildExternalEvidenceSection: ALL files held-out -> section entirely absent (\"\"), still warns", () => {
  const dir = tmpDir("allskip")
  seedEvidenceFile(dir, "task-out", "agentB", "held-out lesson")

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const section = buildExternalEvidenceSection(dir, ["task-out"])
    expect(section).toBe("")
    expect(errSpy).toHaveBeenCalled()
  } finally {
    errSpy.mockRestore()
  }
})

test("buildExternalEvidenceSection: no held-out overlap -> no warning logged", () => {
  const dir = tmpDir("nowarn")
  seedEvidenceFile(dir, "task-in", "agentA", "held-in lesson")

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    buildExternalEvidenceSection(dir, ["some-other-task"])
    expect(errSpy).not.toHaveBeenCalled()
  } finally {
    errSpy.mockRestore()
  }
})

// ── Tested against the committed evidence dir (repo root) ────────────────
// Phase 8 ships TEMPLATE.md only — no real evidence files yet (distillation
// is a later manual step) — so the committed dir must validate clean today,
// and TEMPLATE.md itself must never be misread as a task's evidence file.

test("committed evidence/tb2-leaderboard dir: validates clean (no evidence files committed yet)", () => {
  const repoRoot = path.resolve(import.meta.dir, "..", "..")
  const committedDir = path.join(repoRoot, "evidence", "tb2-leaderboard")

  expect(fs.existsSync(path.join(committedDir, "TEMPLATE.md"))).toBe(true)
  expect(validateEvidenceDir(committedDir, [])).toEqual([])
  // No task subdirectories with real evidence yet -> the section is empty
  // even completely unguarded (heldOut: []).
  expect(buildExternalEvidenceSection(committedDir, [])).toBe("")
})
