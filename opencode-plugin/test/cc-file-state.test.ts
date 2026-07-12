import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  FileSessionStateStore,
  ccRuntimeDir,
  sessionStatePath,
} from "../src/adapters/claude-code/file-state.ts"
import type { SessionState } from "../src/engine.ts"

// Hermetic: point META_HARNESS_HOME at a fresh tmp dir per test so the store
// lives under <tmp>/runtime/cc and never touches the real ~/.config.

let home: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env["META_HARNESS_HOME"]
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cc-file-state-"))
  process.env["META_HARNESS_HOME"] = home
})

afterEach(() => {
  if (prevHome === undefined) delete process.env["META_HARNESS_HOME"]
  else process.env["META_HARNESS_HOME"] = prevHome
  fs.rmSync(home, { recursive: true, force: true })
})

function sampleState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    role: "mh-build",
    participates: true,
    turns: 3,
    summary: "did some real work here",
    toolUsage: { bash: { calls: 2, errors: 1 } },
    trajectory: [{ t: "text", text: "hello" }],
    bootstrapped: true,
    pendingScore: false,
    snapshotInjected: true,
    scoreCount: 1,
    pausedToastShown: false,
    ...overrides,
  }
}

test("runtime dir resolves under META_HARNESS_HOME (hermetic)", () => {
  expect(ccRuntimeDir()).toBe(path.join(home, "runtime", "cc"))
  expect(sessionStatePath("abc-123")).toBe(path.join(home, "runtime", "cc", "abc-123.json"))
})

test("put then get round-trips the full SessionState", () => {
  const store = new FileSessionStateStore()
  const s = sampleState()
  store.put("sess-1", s)
  expect(store.get("sess-1")).toEqual(s)
})

test("get on an absent session returns undefined (no throw)", () => {
  const store = new FileSessionStateStore()
  expect(store.get("never-written")).toBeUndefined()
})

test("delete removes the file; get afterwards is undefined; double-delete is safe", () => {
  const store = new FileSessionStateStore()
  store.put("sess-2", sampleState())
  expect(store.get("sess-2")).toBeDefined()
  store.delete("sess-2")
  expect(store.get("sess-2")).toBeUndefined()
  // idempotent
  expect(() => store.delete("sess-2")).not.toThrow()
})

test("a corrupt state file reads back as undefined and warns (never throws)", () => {
  const warnings: string[] = []
  const store = new FileSessionStateStore((m) => warnings.push(m))
  const p = sessionStatePath("sess-corrupt")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, "{ this is not valid json ")

  expect(store.get("sess-corrupt")).toBeUndefined()
  expect(warnings.length).toBe(1)
  expect(warnings[0]).toContain("corrupt session-state file")
})

test("writes are atomic — no lingering .tmp file after put", () => {
  const store = new FileSessionStateStore()
  store.put("sess-atomic", sampleState())
  const dir = ccRuntimeDir()
  const entries = fs.readdirSync(dir)
  expect(entries).toContain("sess-atomic.json")
  expect(entries.some((e) => e.includes(".tmp"))).toBe(false)
})

test("a partial-write simulation (leftover .tmp) does not corrupt a subsequent read", () => {
  const store = new FileSessionStateStore()
  // Simulate a crash that left a stray temp file behind: the real file is
  // written atomically, so get() must still see the committed state.
  store.put("sess-3", sampleState({ turns: 9 }))
  const dir = ccRuntimeDir()
  fs.writeFileSync(path.join(dir, "sess-3.json.999.stale.tmp"), "garbage")
  const got = store.get("sess-3")
  expect(got?.turns).toBe(9)
})

test("session ids with unsafe characters cannot escape the runtime dir", () => {
  const p = sessionStatePath("../../etc/passwd")
  // The real guarantee: the file always lands directly in the runtime dir —
  // path separators are stripped, so no id can traverse out of it.
  expect(path.dirname(p)).toBe(ccRuntimeDir())
  expect(path.basename(p).includes(path.sep)).toBe(false)
  expect(path.resolve(p).startsWith(path.resolve(ccRuntimeDir()) + path.sep)).toBe(true)
})
