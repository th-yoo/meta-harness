// test/init-cli.test.ts — integration tests that spawn the real init-cli.ts
// process (bun src/init-cli.ts [flags]) against hermetic tmp repos, mirroring
// the temp-dir + spawn pattern in test/cli.test.ts:22-85. init-cli is a
// token-free replacement for the model-driven `/kkamak:init` slash command:
// it never calls a model, only detects a check command and writes gate.json.
import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const INIT_CLI = path.join(import.meta.dir, "..", "src", "init-cli.ts")

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function runInit(opts: { cwd: string; args?: string[] }): Promise<RunResult> {
  const proc = Bun.spawn(["bun", INIT_CLI, ...(opts.args ?? [])], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])

  return { stdout, stderr, exitCode }
}

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-gate-init-cli-"))
}

function rmRepo(repo: string): void {
  fs.rmSync(repo, { recursive: true, force: true })
}

function writePkg(repo: string, pkg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify(pkg))
}

function readGate(repo: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repo, "gate.json"), "utf-8"))
}

function readGitignore(repo: string): string {
  return fs.readFileSync(path.join(repo, ".gitignore"), "utf-8")
}

test("detects package.json scripts.test -> writes gate.json with npm test", async () => {
  const repo = mkRepo()
  try {
    writePkg(repo, { name: "x", scripts: { test: "vitest run" } })
    const r = await runInit({ cwd: repo })
    expect(r.exitCode).toBe(0)
    const gate = readGate(repo)
    expect(gate.check).toBe("npm test")
    expect(gate.rounds).toBe(2)
    expect(gate.gauge).toBeUndefined()
  } finally {
    rmRepo(repo)
  }
})

test("no package.json scripts.test but bun.lock present -> detects bun test", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, "bun.lock"), "")
    const r = await runInit({ cwd: repo })
    expect(r.exitCode).toBe(0)
    const gate = readGate(repo)
    expect(gate.check).toBe("bun test")
  } finally {
    rmRepo(repo)
  }
})

test("no package.json scripts.test but @types/bun devDependency present -> detects bun test", async () => {
  const repo = mkRepo()
  try {
    writePkg(repo, { name: "x", devDependencies: { "@types/bun": "latest" } })
    const r = await runInit({ cwd: repo })
    expect(r.exitCode).toBe(0)
    const gate = readGate(repo)
    expect(gate.check).toBe("bun test")
  } finally {
    rmRepo(repo)
  }
})

test("no detection and no --check -> non-zero exit, template + usage hint printed, no gate.json written", async () => {
  const repo = mkRepo()
  try {
    const r = await runInit({ cwd: repo })
    expect(r.exitCode).not.toBe(0)
    const combined = r.stdout + r.stderr
    expect(combined).toContain("check")
    expect(combined.toLowerCase()).toContain("--check")
    expect(fs.existsSync(path.join(repo, "gate.json"))).toBe(false)
  } finally {
    rmRepo(repo)
  }
})

test("--check overrides detection", async () => {
  const repo = mkRepo()
  try {
    writePkg(repo, { name: "x", scripts: { test: "vitest run" } })
    const r = await runInit({ cwd: repo, args: ["--check", "make check"] })
    expect(r.exitCode).toBe(0)
    const gate = readGate(repo)
    expect(gate.check).toBe("make check")
  } finally {
    rmRepo(repo)
  }
})

test("--gauge adds gauge:true to gate.json", async () => {
  const repo = mkRepo()
  try {
    const r = await runInit({ cwd: repo, args: ["--check", "npm test", "--gauge"] })
    expect(r.exitCode).toBe(0)
    const gate = readGate(repo)
    expect(gate.gauge).toBe(true)
  } finally {
    rmRepo(repo)
  }
})

test("existing gate.json without --force -> refuses, non-zero exit, clear message, file untouched", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify({ check: "echo untouched", rounds: 9 }))
    const r = await runInit({ cwd: repo, args: ["--check", "npm test"] })
    expect(r.exitCode).not.toBe(0)
    const combined = (r.stdout + r.stderr).toLowerCase()
    expect(combined).toContain("gate.json")
    expect(combined).toMatch(/exist|force/)
    const gate = readGate(repo)
    expect(gate.check).toBe("echo untouched")
    expect(gate.rounds).toBe(9)
  } finally {
    rmRepo(repo)
  }
})

test("existing gate.json with --force -> overwrites", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify({ check: "echo old", rounds: 9 }))
    const r = await runInit({ cwd: repo, args: ["--check", "npm test", "--force"] })
    expect(r.exitCode).toBe(0)
    const gate = readGate(repo)
    expect(gate.check).toBe("npm test")
    expect(gate.rounds).toBe(2)
  } finally {
    rmRepo(repo)
  }
})

test("--dry-run prints what would be written but writes no gate.json and no .gitignore", async () => {
  const repo = mkRepo()
  try {
    const r = await runInit({ cwd: repo, args: ["--check", "npm test", "--dry-run"] })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("npm test")
    expect(fs.existsSync(path.join(repo, "gate.json"))).toBe(false)
    expect(fs.existsSync(path.join(repo, ".gitignore"))).toBe(false)
  } finally {
    rmRepo(repo)
  }
})

test("dry-run against an existing gate.json without --force still refuses (safety wins over preview)", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify({ check: "echo untouched", rounds: 9 }))
    const r = await runInit({ cwd: repo, args: ["--check", "npm test", "--dry-run"] })
    expect(r.exitCode).not.toBe(0)
    const gate = readGate(repo)
    expect(gate.check).toBe("echo untouched")
  } finally {
    rmRepo(repo)
  }
})

test(".gitignore missing -> created with .km/", async () => {
  const repo = mkRepo()
  try {
    const r = await runInit({ cwd: repo, args: ["--check", "npm test"] })
    expect(r.exitCode).toBe(0)
    const gi = readGitignore(repo)
    expect(gi.split("\n").map((l) => l.trim())).toContain(".km/")
  } finally {
    rmRepo(repo)
  }
})

test(".gitignore exists without .km/ -> .km/ appended, existing content preserved", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n")
    const r = await runInit({ cwd: repo, args: ["--check", "npm test"] })
    expect(r.exitCode).toBe(0)
    const gi = readGitignore(repo)
    expect(gi).toContain("node_modules/")
    const lines = gi.split("\n").map((l) => l.trim())
    expect(lines.filter((l) => l === ".km/").length).toBe(1)
  } finally {
    rmRepo(repo)
  }
})

test(".gitignore already contains .km/ -> not duplicated", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n.km/\n")
    const r = await runInit({ cwd: repo, args: ["--check", "npm test"] })
    expect(r.exitCode).toBe(0)
    const gi = readGitignore(repo)
    const lines = gi.split("\n").map((l) => l.trim())
    expect(lines.filter((l) => l === ".km/").length).toBe(1)
  } finally {
    rmRepo(repo)
  }
})
