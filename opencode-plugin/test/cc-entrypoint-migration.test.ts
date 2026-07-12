/**
 * cc-entrypoint-migration.test.ts — F2 (final-review fix list).
 *
 * Bug: hook-cli.ts's main() (and install.ts's main()) never called
 * migrateAccountRoot() (harness-store.ts), yet FileSessionStateStore mkdirs
 * under accountMetaRoot() the first time a hook writes session state. On a
 * Claude-Code-only install (no opencode plugin ever loaded, so index.ts's
 * migrateAccountRoot() call never ran either), the FIRST thing to ever touch
 * the new root is that mkdir — which creates an empty new root BEFORE
 * migration gets a chance to run. migrateAccountRoot() then sees "new root
 * exists" and no-ops (or, once the old root is later discovered to hold real
 * content, permanently downgrades to a "stranded store" warning) — a user's
 * evolved account-layer store is left behind at the old opencode-owned path
 * forever.
 *
 * These tests exercise the REAL CLI entrypoints as subprocesses (not via
 * import — hook-cli.ts's main() runs unconditionally at module scope with no
 * import.meta.main guard, so importing it directly would hijack this test
 * process's stdin/exit). Hermetic: XDG_CONFIG_HOME + META_HARNESS_HOME pin
 * both the legacy and resolved roots into tmp dirs, exactly like
 * harness-store-account-root.test.ts's setupRoots() helper — never the real
 * homedir.
 */
import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Mirrors harness-store-account-root.test.ts's setupRoots(): XDG_CONFIG_HOME
 * controls legacyAccountRoot()'s lookup, META_HARNESS_HOME pins the resolved
 * new root outright — neither ever falls through to the real homedir. */
function setupRoots(): { oldRoot: string; newRoot: string; xdgBase: string; mhBase: string } {
  const xdgBase = tmpDir("mh-entry-migrate-xdg-")
  const mhBase = tmpDir("mh-entry-migrate-mh-")
  const newRoot = path.join(mhBase, "meta-harness")
  const oldRoot = path.join(xdgBase, "opencode", ".meta-harness")
  return { oldRoot, newRoot, xdgBase, mhBase }
}

/** Seed the legacy root with real (non-scaffolding) content, exactly like an
 * evolved account-layer store from before Task L5. */
function seedOldRoot(oldRoot: string, marker: string): void {
  fs.mkdirSync(path.join(oldRoot, "global", "active"), { recursive: true })
  fs.writeFileSync(path.join(oldRoot, "global", "active", "system.md"), marker)
}

const HOOK_CLI = path.resolve(import.meta.dir, "..", "src", "adapters", "claude-code", "hook-cli.ts")
const INSTALL_CLI = path.resolve(import.meta.dir, "..", "src", "adapters", "claude-code", "install.ts")

async function run(
  cmd: string[],
  opts: { env: Record<string, string | undefined>; stdin?: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    stdin: opts.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env,
  })
  if (opts.stdin !== undefined && proc.stdin) {
    // @ts-ignore — Bun's FileSink write/end
    proc.stdin.write(opts.stdin)
    // @ts-ignore
    proc.stdin.end()
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

test("F2: a SessionStart hook (bun hook-cli.ts) migrates the legacy account store BEFORE creating any new-root state", async () => {
  const { oldRoot, newRoot, xdgBase, mhBase } = setupRoots()
  const marker = "evolved rule from before the CC entrypoint fix\n"
  seedOldRoot(oldRoot, marker)

  const project = tmpDir("mh-entry-migrate-proj-")

  const input = JSON.stringify({
    session_id: "entry-sess-1",
    cwd: project,
    hook_event_name: "SessionStart",
    source: "startup",
  })

  const { exitCode } = await run(["bun", HOOK_CLI, "SessionStart"], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgBase,
      META_HARNESS_HOME: newRoot,
      MH_ROLE: "mh-build",
    },
    stdin: input,
  })
  expect(exitCode).toBe(0)

  // Migration ran: old path is now a symlink, new root holds the real content.
  expect(fs.lstatSync(oldRoot).isSymbolicLink()).toBe(true)
  expect(fs.readFileSync(path.join(newRoot, "global", "active", "system.md"), "utf-8")).toBe(marker)

  // The hook's own state write landed under the MIGRATED new root, not a
  // second, disconnected "new root" created before migration ran.
  const stateFile = path.join(newRoot, "runtime", "cc", "entry-sess-1.json")
  expect(fs.existsSync(stateFile)).toBe(true)

  fs.rmSync(xdgBase, { recursive: true, force: true })
  fs.rmSync(mhBase, { recursive: true, force: true })
  fs.rmSync(project, { recursive: true, force: true })
})

test("F2: bun install.ts also migrates the legacy account store on run", async () => {
  const { oldRoot, newRoot, xdgBase, mhBase } = setupRoots()
  const marker = "evolved rule seen by install.ts\n"
  seedOldRoot(oldRoot, marker)

  const project = tmpDir("mh-entry-migrate-install-proj-")

  const { exitCode } = await run(["bun", INSTALL_CLI, "--project", project, "--role", "mh-build"], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgBase,
      META_HARNESS_HOME: newRoot,
    },
  })
  expect(exitCode).toBe(0)

  expect(fs.lstatSync(oldRoot).isSymbolicLink()).toBe(true)
  expect(fs.readFileSync(path.join(newRoot, "global", "active", "system.md"), "utf-8")).toBe(marker)

  fs.rmSync(xdgBase, { recursive: true, force: true })
  fs.rmSync(mhBase, { recursive: true, force: true })
  fs.rmSync(project, { recursive: true, force: true })
})
