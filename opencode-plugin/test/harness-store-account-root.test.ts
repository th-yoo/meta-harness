/**
 * harness-store-account-root.test.ts — Task L5: lazy account-root resolver
 * (`accountMetaRoot`) + the one-time migration off the old opencode-owned
 * location (`migrateAccountRoot`).
 *
 * Hermetic by construction: every test drives the resolver/migration purely
 * through env vars (META_HARNESS_HOME for the new root, XDG_CONFIG_HOME for
 * BOTH the new root's XDG tier and the legacy root's XDG-aware lookup) or
 * explicit tmp-dir fixtures. No test ever calls a filesystem op (mkdir,
 * rename, symlink, existsSync-with-side-effects) against a path derived from
 * the real os.homedir() — the one test that exercises the ~/.config fallback
 * only asserts the RETURNED STRING (a pure path.join, no I/O) against
 * os.homedir(), it never touches the filesystem at that path. This is the
 * hard rule this suite exists to enforce (prior incident on this branch).
 */
import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  accountMetaRoot,
  accountGlobalRoot,
  accountRoleRoot,
  migrateAccountRoot,
  readMhConfig,
  isRealStore,
} from "../src/harness-store.ts"

// ── env isolation ────────────────────────────────────────────────────────
//
// Save/restore both env vars around every test so none of this file's
// stubbing leaks into other test files sharing the same bun test process.

const ENV_KEYS = ["META_HARNESS_HOME", "XDG_CONFIG_HOME"] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// ── accountMetaRoot precedence ──────────────────────────────────────────

test("accountMetaRoot: META_HARNESS_HOME wins outright (used as-is, absolute)", () => {
  const mh = tmpDir("mh-root-env-")
  process.env["META_HARNESS_HOME"] = mh
  process.env["XDG_CONFIG_HOME"] = tmpDir("mh-root-xdg-") // present but must lose
  expect(accountMetaRoot()).toBe(mh)
})

test("accountMetaRoot: XDG_CONFIG_HOME/kkamak when no HOME override is set", () => {
  delete process.env["META_HARNESS_HOME"]
  const xdg = tmpDir("mh-root-xdg-")
  process.env["XDG_CONFIG_HOME"] = xdg
  expect(accountMetaRoot()).toBe(path.join(xdg, "kkamak"))
})

test("accountMetaRoot: falls back to ~/.config/kkamak when neither env var is set (pure string check, no I/O)", () => {
  delete process.env["META_HARNESS_HOME"]
  delete process.env["XDG_CONFIG_HOME"]
  expect(accountMetaRoot()).toBe(path.join(os.homedir(), ".config", "kkamak"))
})

test("accountMetaRoot: is lazy — reflects env changes made AFTER the module was imported", () => {
  // The whole point of the L5 fix: this module was imported once, at the top
  // of this file, long before this test runs. If the root were still
  // computed at import time (the L2-era bug), this would return whatever
  // was true back then, not what's true now.
  const a = tmpDir("mh-root-lazy-a-")
  const b = tmpDir("mh-root-lazy-b-")
  process.env["META_HARNESS_HOME"] = a
  expect(accountMetaRoot()).toBe(a)
  process.env["META_HARNESS_HOME"] = b
  expect(accountMetaRoot()).toBe(b)
})

test("accountGlobalRoot/accountRoleRoot build on accountMetaRoot()", () => {
  const mh = tmpDir("mh-root-derived-")
  process.env["META_HARNESS_HOME"] = mh
  expect(accountGlobalRoot()).toBe(path.join(mh, "global"))
  expect(accountRoleRoot("mh-build")).toBe(path.join(mh, "roles", "mh-build"))
})

test("readMhConfig(): default configDir is now lazy too (no import-time freeze)", () => {
  const a = tmpDir("mh-root-cfg-a-")
  const b = tmpDir("mh-root-cfg-b-")
  fs.mkdirSync(a, { recursive: true })
  fs.mkdirSync(b, { recursive: true })
  fs.writeFileSync(path.join(a, "config.json"), JSON.stringify({ proposerModel: "from-a/model" }))
  fs.writeFileSync(path.join(b, "config.json"), JSON.stringify({ proposerModel: "from-b/model" }))

  process.env["META_HARNESS_HOME"] = a
  expect(readMhConfig().proposerModel).toBe("from-a/model")

  process.env["META_HARNESS_HOME"] = b
  expect(readMhConfig().proposerModel).toBe("from-b/model")
})

// ── migrateAccountRoot ──────────────────────────────────────────────────
//
// Every migration test pins BOTH tiers via env: XDG_CONFIG_HOME controls
// legacyAccountRoot()'s old opencode-owned lookup (exactly like the old
// OPENCODE_CONFIG_DIR constant did), and META_HARNESS_HOME controls the new
// resolved root outright. Neither ever falls through to a real-homedir path.

function setupRoots(): { oldRoot: string; newRoot: string; xdgBase: string; mhBase: string } {
  const xdgBase = tmpDir("mh-migrate-xdg-")
  const mhBase = tmpDir("mh-migrate-mh-")
  process.env["XDG_CONFIG_HOME"] = xdgBase
  const newRoot = path.join(mhBase, "meta-harness")
  process.env["META_HARNESS_HOME"] = newRoot
  const oldRoot = path.join(xdgBase, "opencode", ".meta-harness")
  return { oldRoot, newRoot, xdgBase, mhBase }
}

test("migrateAccountRoot: fresh (neither root exists) -> no-op, nothing created", () => {
  const { oldRoot, newRoot } = setupRoots()
  migrateAccountRoot()
  expect(fs.existsSync(oldRoot)).toBe(false)
  expect(fs.existsSync(newRoot)).toBe(false)
})

test("migrateAccountRoot: old-only -> renamed to new, symlink left at old path, content intact", () => {
  const { oldRoot, newRoot } = setupRoots()
  fs.mkdirSync(path.join(oldRoot, "global", "active"), { recursive: true })
  const marker = path.join(oldRoot, "global", "active", "system.md")
  fs.writeFileSync(marker, "evolved rule from before L5\n")

  migrateAccountRoot()

  // new root now holds the real content
  expect(fs.statSync(newRoot).isDirectory()).toBe(true)
  expect(fs.lstatSync(newRoot).isSymbolicLink()).toBe(false)
  expect(fs.readFileSync(path.join(newRoot, "global", "active", "system.md"), "utf-8")).toBe(
    "evolved rule from before L5\n",
  )

  // old path is now a symlink pointing at the new root (back-compat)
  const oldStat = fs.lstatSync(oldRoot)
  expect(oldStat.isSymbolicLink()).toBe(true)
  expect(fs.realpathSync(oldRoot)).toBe(fs.realpathSync(newRoot))

  // reading THROUGH the old (now-symlinked) path still sees the same content
  expect(fs.readFileSync(path.join(oldRoot, "global", "active", "system.md"), "utf-8")).toBe(
    "evolved rule from before L5\n",
  )
})

test("migrateAccountRoot: both exist -> untouched (old stays a real dir, new stays whatever it was)", () => {
  const { oldRoot, newRoot } = setupRoots()
  fs.mkdirSync(oldRoot, { recursive: true })
  fs.writeFileSync(path.join(oldRoot, "old-marker.txt"), "old")
  fs.mkdirSync(newRoot, { recursive: true })
  fs.writeFileSync(path.join(newRoot, "new-marker.txt"), "new")

  migrateAccountRoot()

  expect(fs.lstatSync(oldRoot).isSymbolicLink()).toBe(false)
  expect(fs.readFileSync(path.join(oldRoot, "old-marker.txt"), "utf-8")).toBe("old")
  expect(fs.readFileSync(path.join(newRoot, "new-marker.txt"), "utf-8")).toBe("new")
  // no symlink swap happened
  expect(fs.existsSync(path.join(newRoot, "old-marker.txt"))).toBe(false)
})

test("migrateAccountRoot: old-is-symlink (prior migration, new since removed) -> no-op, symlink left alone", () => {
  const { oldRoot, newRoot } = setupRoots()
  // Simulate a prior migration whose target later vanished (or points
  // elsewhere) — old is a symlink, not a real dir, and new doesn't exist.
  const elsewhere = tmpDir("mh-migrate-elsewhere-")
  fs.mkdirSync(path.dirname(oldRoot), { recursive: true })
  fs.symlinkSync(elsewhere, oldRoot)

  migrateAccountRoot()

  expect(fs.existsSync(newRoot)).toBe(false)
  expect(fs.lstatSync(oldRoot).isSymbolicLink()).toBe(true)
  expect(fs.realpathSync(oldRoot)).toBe(fs.realpathSync(elsewhere))
})

test("migrateAccountRoot: second call is idempotent (no-op once new exists)", () => {
  const { oldRoot, newRoot } = setupRoots()
  fs.mkdirSync(path.join(oldRoot, "global", "active"), { recursive: true })
  fs.writeFileSync(path.join(oldRoot, "global", "active", "system.md"), "v1\n")

  migrateAccountRoot()
  expect(fs.statSync(newRoot).isDirectory()).toBe(true)
  const afterFirst = fs.lstatSync(oldRoot)
  expect(afterFirst.isSymbolicLink()).toBe(true)

  // Second call (e.g. the OTHER entry point running after the first already
  // migrated) must not throw and must not touch anything further.
  expect(() => migrateAccountRoot()).not.toThrow()
  expect(fs.readFileSync(path.join(newRoot, "global", "active", "system.md"), "utf-8")).toBe("v1\n")
  expect(fs.lstatSync(oldRoot).isSymbolicLink()).toBe(true)
})

test("migrateAccountRoot: EDGE — META_HARNESS_HOME override still migrates a real old store into the resolved (overridden) root", () => {
  const xdgBase = tmpDir("mh-migrate-edge-xdg-")
  process.env["XDG_CONFIG_HOME"] = xdgBase
  const oldRoot = path.join(xdgBase, "opencode", ".meta-harness")
  fs.mkdirSync(oldRoot, { recursive: true })
  fs.writeFileSync(path.join(oldRoot, "marker.txt"), "pre-override content")

  // An unrelated override path — NOT derived from xdgBase at all.
  const overrideBase = tmpDir("mh-migrate-edge-override-")
  const overrideRoot = path.join(overrideBase, "wherever", "meta-harness")
  process.env["META_HARNESS_HOME"] = overrideRoot

  migrateAccountRoot()

  expect(fs.readFileSync(path.join(overrideRoot, "marker.txt"), "utf-8")).toBe("pre-override content")
  expect(fs.lstatSync(oldRoot).isSymbolicLink()).toBe(true)
})

// ── Fix L5: migration failure logging ────────────────────────────────────

test("migrateAccountRoot: rename failure logs error with both paths and remediation", () => {
  const { oldRoot, newRoot, mhBase } = setupRoots()
  fs.mkdirSync(path.join(oldRoot, "global"), { recursive: true })
  fs.writeFileSync(path.join(oldRoot, "global", "marker.txt"), "stranded content")

  // Simulate EXDEV by making newRoot's parent read-only so rename fails
  fs.mkdirSync(mhBase, { recursive: true })
  const logs: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  }

  try {
    // Make parent read-only to force rename to fail
    fs.chmodSync(mhBase, 0o444)
    migrateAccountRoot()
  } finally {
    console.error = originalError
    fs.chmodSync(mhBase, 0o755)
  }

  // Should have logged the error with both paths and remediation
  const errorLog = logs.find((l) => l.includes("migration") && l.includes("failed"))
  expect(errorLog).toBeDefined()
  expect(errorLog).toContain(oldRoot)
  expect(errorLog).toContain(newRoot)
  expect(errorLog).toContain("move the old directory")

  // Old content should still be stranded at old location
  expect(fs.readFileSync(path.join(oldRoot, "global", "marker.txt"), "utf-8")).toBe("stranded content")
  // New location should not exist
  expect(fs.existsSync(newRoot)).toBe(false)
})

test("migrateAccountRoot: poisoned state (both exist, old is real dir with content) logs warning", () => {
  const { oldRoot, newRoot } = setupRoots()

  // Create old store with evolved content
  fs.mkdirSync(path.join(oldRoot, "global", "active"), { recursive: true })
  fs.mkdirSync(path.join(oldRoot, "roles"), { recursive: true })
  fs.writeFileSync(path.join(oldRoot, "roles", "marker.txt"), "evolved rules")

  // Create new store (simulating prior failed migration or poison)
  fs.mkdirSync(newRoot, { recursive: true })

  const logs: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  }

  try {
    migrateAccountRoot()
  } finally {
    console.error = originalError
  }

  // Should have logged warning about poisoned state
  const warningLog = logs.find((l) => l.includes("stranded") && l.includes(oldRoot))
  expect(warningLog).toBeDefined()
  expect(warningLog).toContain(oldRoot)
  expect(warningLog).toContain(newRoot)
  expect(warningLog).toContain("move the old directory")

  // Old content should still be at old location (untouched)
  expect(fs.readFileSync(path.join(oldRoot, "roles", "marker.txt"), "utf-8")).toBe("evolved rules")
})

test("migrateAccountRoot: both exist but old is symlink -> no warning (successful prior migration)", () => {
  const { oldRoot, newRoot } = setupRoots()

  // Create the real new store
  fs.mkdirSync(newRoot, { recursive: true })
  fs.writeFileSync(path.join(newRoot, "marker.txt"), "new content")

  // Create old as a symlink to new (successful prior migration)
  fs.mkdirSync(path.dirname(oldRoot), { recursive: true })
  fs.symlinkSync(newRoot, oldRoot)

  const logs: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  }

  try {
    migrateAccountRoot()
  } finally {
    console.error = originalError
  }

  // Should NOT log any warning (this is a successful state)
  const warnings = logs.filter((l) => l.includes("stranded") || l.includes("warning"))
  expect(warnings.length).toBe(0)

  // Everything should remain as-is
  expect(fs.lstatSync(oldRoot).isSymbolicLink()).toBe(true)
  expect(fs.realpathSync(oldRoot)).toBe(fs.realpathSync(newRoot))
})

// ── isRealStore edge cases (stranded-store warning coverage) ────────────────

test("isRealStore: global/active with content (system.md only) returns true", () => {
  const root = tmpDir("is-real-store-global-active-")
  fs.mkdirSync(path.join(root, "global", "active"), { recursive: true })
  fs.writeFileSync(path.join(root, "global", "active", "system.md"), "evolved rule\n")
  // Empty scaffolding (no roles/, no config.json)
  fs.mkdirSync(path.join(root, "global"), { recursive: true })
  fs.mkdirSync(path.join(root, "roles"), { recursive: true })

  expect(isRealStore(root)).toBe(true)
})

test("isRealStore: config.json only (no roles/, no global/active content) returns true", () => {
  const root = tmpDir("is-real-store-config-json-")
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ proposerModel: "claude-3-5-sonnet-20241022" }))
  // Empty scaffolding
  fs.mkdirSync(path.join(root, "global", "active"), { recursive: true })
  fs.mkdirSync(path.join(root, "roles"), { recursive: true })

  expect(isRealStore(root)).toBe(true)
})

test("isRealStore: empty scaffold (global/active exists but empty, roles/ empty, no config.json) returns false", () => {
  const root = tmpDir("is-real-store-empty-scaffold-")
  fs.mkdirSync(path.join(root, "global", "active"), { recursive: true })
  fs.mkdirSync(path.join(root, "roles"), { recursive: true })
  // No config.json, no files in global/active

  expect(isRealStore(root)).toBe(false)
})

test("isRealStore: existing check — roles/ with content returns true", () => {
  const root = tmpDir("is-real-store-roles-")
  fs.mkdirSync(path.join(root, "roles", "mh-build"), { recursive: true })
  fs.writeFileSync(path.join(root, "roles", "mh-build", "marker.txt"), "role content")

  expect(isRealStore(root)).toBe(true)
})

test("isRealStore: existing check — active/ (old layout) with content returns true", () => {
  const root = tmpDir("is-real-store-active-")
  fs.mkdirSync(path.join(root, "active"), { recursive: true })
  fs.writeFileSync(path.join(root, "active", "system.md"), "old layout system prompt")

  expect(isRealStore(root)).toBe(true)
})
