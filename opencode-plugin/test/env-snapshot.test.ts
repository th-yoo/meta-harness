import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { buildBootstrapCmd, buildSnapshot, parseSections } from "../src/env-snapshot.ts"
import { composeEnvPolicy, writeActive, type EnvPolicy } from "../src/harness-store.ts"

// ── buildBootstrapCmd: default (null policy) is unchanged behavior ────────

test("buildBootstrapCmd(null) contains all four section markers and default /app path", () => {
  const cmd = buildBootstrapCmd(null)
  expect(cmd).toContain("@@PWD@@")
  expect(cmd).toContain("@@LS@@")
  expect(cmd).toContain("@@LANG@@")
  expect(cmd).toContain("@@PKG@@")
  expect(cmd).toContain("@@MEM@@")
  expect(cmd).toContain("/app")
})

test("buildBootstrapCmd(undefined) behaves the same as null", () => {
  expect(buildBootstrapCmd(undefined)).toBe(buildBootstrapCmd(null))
})

test("buildBootstrapCmd(null) probes every language in the whitelist", () => {
  const cmd = buildBootstrapCmd(null)
  for (const lang of ["python3", "gcc", "g++", "node", "java", "rustc", "go"]) {
    expect(cmd).toContain(lang)
  }
})

// ── buildBootstrapCmd: probes.<x> = false omits that section ───────────────

test("buildBootstrapCmd: probes.mem=false omits @@MEM@@ and honors lsPath", () => {
  const policy: EnvPolicy = { schemaVersion: 1, probes: { mem: false }, lsPath: "/work" }
  const cmd = buildBootstrapCmd(policy)
  expect(cmd).not.toContain("@@MEM@@")
  expect(cmd).toContain("/work")
  // The other sections are still present.
  expect(cmd).toContain("@@PWD@@")
  expect(cmd).toContain("@@LS@@")
  expect(cmd).toContain("@@LANG@@")
  expect(cmd).toContain("@@PKG@@")
})

test("buildBootstrapCmd: @@PWD@@ is always kept even when everything else is disabled", () => {
  const policy: EnvPolicy = {
    schemaVersion: 1,
    probes: { ls: false, lang: false, pkg: false, mem: false },
  }
  const cmd = buildBootstrapCmd(policy)
  expect(cmd).toContain("@@PWD@@")
  expect(cmd).not.toContain("@@LS@@")
  expect(cmd).not.toContain("@@LANG@@")
  expect(cmd).not.toContain("@@PKG@@")
  expect(cmd).not.toContain("@@MEM@@")
})

// ── buildBootstrapCmd: languageProbes filters the language whitelist ───────

test("buildBootstrapCmd: languageProbes restricts to the given subset", () => {
  const policy: EnvPolicy = { schemaVersion: 1, languageProbes: ["go"] }
  const cmd = buildBootstrapCmd(policy)
  expect(cmd).toContain("go version")
  expect(cmd).not.toContain("java -version")
  expect(cmd).not.toContain("python3 --version")
})

// ── parseSections / buildSnapshot: maxLsEntries drives the truncation cap ──

function lsSection(nEntries: number): string {
  const lines = ["total 999"]
  for (let i = 0; i < nEntries; i++) lines.push(`-rw-r--r-- 1 u u 0 Jan 1 00:00 file${i}.txt`)
  return lines.join("\n")
}

test("buildSnapshot: default cap (no policy) truncates above 25 entries, showing 20", () => {
  // lsSection(30) -> 31 total lines ("total 999" header + 30 files)
  const sections = { LS: lsSection(30) }
  const out = buildSnapshot(sections)
  expect(out).toContain("(31 entries)")
  // head = lines.slice(0, 20) = header + file0..file18 (19 files); remaining = 31-20=11
  expect(out).toContain("... (11 more files)")
  expect(out).toContain("file18.txt")
  expect(out).not.toContain("file19.txt")
})

test("buildSnapshot: policy.maxLsEntries lowers the cap and the shown head (cap-5)", () => {
  // lsSection(15) -> 16 total lines (header + 15 files)
  const sections = { LS: lsSection(15) }
  const policy: EnvPolicy = { schemaVersion: 1, maxLsEntries: 10 }
  const out = buildSnapshot(sections, policy)
  expect(out).toContain("(16 entries)")
  // cap=10 -> show max(5, 10-5)=5 lines = header + file0..file3; remaining = 16-5=11
  expect(out).toContain("... (11 more files)")
  expect(out).toContain("file3.txt")
  expect(out).not.toContain("file4.txt")
})

test("buildSnapshot: policy.maxLsEntries floors the shown head at 5 even when cap-5 < 5", () => {
  // lsSection(6) -> 7 total lines (header + 6 files)
  const sections = { LS: lsSection(6) }
  const policy: EnvPolicy = { schemaVersion: 1, maxLsEntries: 5 }
  const out = buildSnapshot(sections, policy)
  expect(out).toContain("(7 entries)")
  // cap=5 -> show max(5, 5-5)=5 lines = header + file0..file3; remaining = 7-5=2
  expect(out).toContain("... (2 more files)")
  expect(out).toContain("file3.txt")
  expect(out).not.toContain("file4.txt")
})

test("parseSections: splits @@KEY@@ markers into a sections map", () => {
  const stdout = "@@PWD@@\n/app\n@@LS@@\ntotal 0"
  const sections = parseSections(stdout)
  expect(sections["PWD"]).toBe("/app")
  expect(sections["LS"]).toBe("total 0")
})

// ── composeEnvPolicy: most-specific layer wins (closes a C1 test gap) ─────

function tmpRoot(name: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `mh-envpolicy-compose-${name}-`))
  fs.mkdirSync(tmp, { recursive: true })
  return tmp
}

test("composeEnvPolicy: most-specific layer wins over a more-general one, and order matters", () => {
  const general = tmpRoot("general")
  const specific = tmpRoot("specific")

  const generalPolicy: EnvPolicy = { schemaVersion: 1, maxLsEntries: 15 }
  const specificPolicy: EnvPolicy = { schemaVersion: 1, maxLsEntries: 90 }
  writeActive(general, "v1", "general system", "", undefined, undefined, generalPolicy)
  writeActive(specific, "v1", "specific system", "", undefined, undefined, specificPolicy)

  // most-specific (later in array) wins outright — no field merging
  expect(composeEnvPolicy([general, specific])).toEqual(specificPolicy)
  expect(composeEnvPolicy([general, specific])?.maxLsEntries).toBe(90)

  // reversed order yields the general one
  expect(composeEnvPolicy([specific, general])).toEqual(generalPolicy)
  expect(composeEnvPolicy([specific, general])?.maxLsEntries).toBe(15)
})
