/**
 * harness-store-kkamak-rename.test.ts — project rename meta-harness → kkamak.
 *
 * The runtime store moves `.meta-harness/` → `.kkamak/` and
 * `~/.config/meta-harness` → `~/.config/kkamak`, and the env override becomes
 * KKAMAK_HOME. Two properties must hold or 4 MB of un-git-tracked loop state
 * (candidates v0–v11, role trials) silently becomes invisible — which reads
 * as "fresh empty store", not as an error:
 *
 *   1. the OLD env var keeps working (scripts, launchd jobs, docs still set it)
 *   2. an existing old-named store is MIGRATED, not orphaned
 *
 * Same hermetic rule as harness-store-account-root.test.ts: never touch the
 * filesystem under the real os.homedir(); path-only assertions there.
 */
import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  accountMetaRoot,
  migrateAccountRoot,
  migrateProjectRoot,
  projectGlobalRoot,
  projectRoleRoot,
} from "../src/harness-store.ts"

const ENV_KEYS = ["KKAMAK_HOME", "META_HARNESS_HOME", "XDG_CONFIG_HOME"] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
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

/** A store with real content — what migration must never lose. */
function seedStore(root: string, marker: string): void {
  fs.mkdirSync(path.join(root, "global", "active"), { recursive: true })
  fs.writeFileSync(
    path.join(root, "global", "active", "playbook.json"),
    JSON.stringify({ schemaVersion: 1, nextId: 2, bullets: [{ id: "b1", text: marker }] }),
  )
}

// ── new names ────────────────────────────────────────────────────────────

test("accountMetaRoot: XDG tier uses kkamak, not meta-harness", () => {
  process.env["XDG_CONFIG_HOME"] = "/xdg"
  expect(accountMetaRoot()).toBe(path.join("/xdg", "kkamak"))
})

test("accountMetaRoot: home fallback is ~/.config/kkamak (path only, no I/O)", () => {
  expect(accountMetaRoot()).toBe(path.join(os.homedir(), ".config", "kkamak"))
})

test("project roots use .kkamak/", () => {
  expect(projectGlobalRoot("/w")).toBe(path.join("/w", ".kkamak", "global"))
  expect(projectRoleRoot("/w", "mh-build")).toBe(path.join("/w", ".kkamak", "roles", "mh-build"))
})

// ── env override, old and new ────────────────────────────────────────────

test("KKAMAK_HOME wins outright", () => {
  process.env["KKAMAK_HOME"] = "/explicit/kkamak"
  process.env["XDG_CONFIG_HOME"] = "/xdg"
  expect(accountMetaRoot()).toBe("/explicit/kkamak")
})

test("BACK-COMPAT: META_HARNESS_HOME still honored when KKAMAK_HOME is unset", () => {
  process.env["META_HARNESS_HOME"] = "/legacy/home"
  expect(accountMetaRoot()).toBe("/legacy/home")
})

test("KKAMAK_HOME beats META_HARNESS_HOME when both are set", () => {
  process.env["KKAMAK_HOME"] = "/new"
  process.env["META_HARNESS_HOME"] = "/old"
  expect(accountMetaRoot()).toBe("/new")
})

// ── migration ────────────────────────────────────────────────────────────

test("migrateAccountRoot: an old meta-harness account store is MOVED to kkamak", () => {
  const xdg = tmpDir("km-rename-xdg-")
  process.env["XDG_CONFIG_HOME"] = xdg

  const oldRoot = path.join(xdg, "meta-harness")
  seedStore(oldRoot, "PRESERVE ME")

  migrateAccountRoot()

  const newRoot = path.join(xdg, "kkamak")
  expect(fs.existsSync(newRoot)).toBe(true)
  const pb = JSON.parse(fs.readFileSync(path.join(newRoot, "global", "active", "playbook.json"), "utf-8"))
  expect(pb.bullets[0].text).toBe("PRESERVE ME")

  // The old path survives as a back-compat SYMLINK, not as a real directory:
  // anything still pointing at the pre-rename name keeps resolving.
  const oldStat = fs.lstatSync(oldRoot)
  expect(oldStat.isSymbolicLink()).toBe(true)
  expect(fs.realpathSync(oldRoot)).toBe(fs.realpathSync(newRoot))
})

test("migrateAccountRoot: never clobbers an existing kkamak store", () => {
  const xdg = tmpDir("km-rename-xdg-")
  process.env["XDG_CONFIG_HOME"] = xdg

  seedStore(path.join(xdg, "meta-harness"), "OLD")
  seedStore(path.join(xdg, "kkamak"), "NEW")

  migrateAccountRoot()

  const pb = JSON.parse(
    fs.readFileSync(path.join(xdg, "kkamak", "global", "active", "playbook.json"), "utf-8"),
  )
  expect(pb.bullets[0].text).toBe("NEW") // existing store wins, old left in place for the human
})

test("migrateAccountRoot: no old store → clean no-op, no directory conjured", () => {
  const xdg = tmpDir("km-rename-xdg-")
  process.env["XDG_CONFIG_HOME"] = xdg
  migrateAccountRoot()
  expect(fs.existsSync(path.join(xdg, "kkamak"))).toBe(false)
})

test("migrateAccountRoot: idempotent — running twice is harmless", () => {
  const xdg = tmpDir("km-rename-xdg-")
  process.env["XDG_CONFIG_HOME"] = xdg
  seedStore(path.join(xdg, "meta-harness"), "ONCE")

  migrateAccountRoot()
  migrateAccountRoot()

  const pb = JSON.parse(
    fs.readFileSync(path.join(xdg, "kkamak", "global", "active", "playbook.json"), "utf-8"),
  )
  expect(pb.bullets[0].text).toBe("ONCE")
})

// ── project-store migration ──────────────────────────────────────────────
//
// The account store is not the only un-git-tracked store: every worktree has
// `.meta-harness/` too. A host that pulls the rename WITHOUT migrating its
// project store comes up with an empty one — which reads as "no candidates
// yet", never as an error. This is the same silent class as the account root,
// so it gets the same automatic treatment.

test("migrateProjectRoot: an old .meta-harness worktree store is MOVED to .kkamak", () => {
  const wt = tmpDir("km-rename-wt-")
  seedStore(path.join(wt, ".meta-harness"), "PROJECT STATE")

  migrateProjectRoot(wt)

  const pb = JSON.parse(
    fs.readFileSync(path.join(wt, ".kkamak", "global", "active", "playbook.json"), "utf-8"),
  )
  expect(pb.bullets[0].text).toBe("PROJECT STATE")

  // Back-compat symlink, same contract as the account root.
  expect(fs.lstatSync(path.join(wt, ".meta-harness")).isSymbolicLink()).toBe(true)
})

test("migrateProjectRoot: never clobbers an existing .kkamak store", () => {
  const wt = tmpDir("km-rename-wt-")
  seedStore(path.join(wt, ".meta-harness"), "OLD")
  seedStore(path.join(wt, ".kkamak"), "NEW")

  migrateProjectRoot(wt)

  const pb = JSON.parse(
    fs.readFileSync(path.join(wt, ".kkamak", "global", "active", "playbook.json"), "utf-8"),
  )
  expect(pb.bullets[0].text).toBe("NEW")
})

test("migrateProjectRoot: no old store → no directory conjured; idempotent; never throws", () => {
  const wt = tmpDir("km-rename-wt-")
  migrateProjectRoot(wt)
  expect(fs.existsSync(path.join(wt, ".kkamak"))).toBe(false)

  seedStore(path.join(wt, ".meta-harness"), "ONCE")
  migrateProjectRoot(wt)
  migrateProjectRoot(wt)
  const pb = JSON.parse(
    fs.readFileSync(path.join(wt, ".kkamak", "global", "active", "playbook.json"), "utf-8"),
  )
  expect(pb.bullets[0].text).toBe("ONCE")

  expect(() => migrateProjectRoot(path.join(wt, "does-not-exist"))).not.toThrow()
})
