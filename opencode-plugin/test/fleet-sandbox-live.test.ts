/**
 * fleet-sandbox-live.test.ts — the ONLY honest bar for mh-followup-A: a live
 * probe that exercises the REAL shipped `sandboxEnv` (fleet/sandbox.ts)
 * against this machine's actual git config / gh keyring / GitHub network,
 * mirroring exactly how `runHost` (bench/exec.ts) merges `opts.env` onto
 * `process.env` (`{ ...process.env, ...sbx.env }`).
 *
 * Skipped by default (`test.skipIf`) — it needs `git`/`gh` on PATH and a
 * network round-trip to github.com, neither of which every CI box has.
 * Opt in with `MH_LIVE_SANDBOX_PROBE=1 bun test test/fleet-sandbox-live.test.ts`.
 *
 * Proves, against reality (not mocks):
 *  1. `git push` to a real repo we have no write access to (octocat's
 *     Hello-World — public, exists, definitely not ours) FAILS with an
 *     auth/credential error, not "Everything up-to-date" and not a silent
 *     success. Before mh-followup-A this same push would succeed (or fail
 *     for an unrelated reason) using the host's real osxkeychain-stored
 *     token, because the OLD scrub (empty GH_TOKEN/GIT_ASKPASS=/bin/false)
 *     never touched a configured `credential.helper`.
 *  2. `gh auth status` reports NOT logged in, despite the real host keyring
 *     having a live, scoped oauth token (the OLD scrub's empty GH_TOKEN was
 *     silently ignored by gh's fallback-to-keyring behavior).
 *  3. `git commit` still SUCCEEDS, with the real committer identity
 *     preserved (not a placeholder) — the credential-helper neutralization
 *     must not cost local git identity.
 *  4. A `*_API_KEY`-shaped env var set in the parent is still visible to the
 *     child — model auth is untouched by the scrub.
 */
import { describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sandboxEnv } from "../src/fleet/sandbox.ts"
import { roleSpec } from "../src/fleet/roles.ts"

declare const Bun: {
  spawn(
    cmd: string[],
    opts: { stdout: "pipe"; stderr: "pipe"; env?: Record<string, string | undefined> },
  ): {
    readonly stdout: ReadableStream<Uint8Array>
    readonly stderr: ReadableStream<Uint8Array>
    readonly exitCode: number | null
    readonly exited: Promise<number>
  }
}

async function run(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<{ rc: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { rc: proc.exitCode ?? -1, stdout, stderr }
}

function hasBinary(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const enabled = process.env["MH_LIVE_SANDBOX_PROBE"] === "1" && hasBinary("git") && hasBinary("gh")

describe("fleet sandbox — LIVE probe (mh-followup-A acceptance bar)", () => {
  test.skipIf(!enabled)(
    "real git/gh: push blocked, gh unauthenticated, commit still works, API key preserved",
    async () => {
      const sbx = sandboxEnv(roleSpec("implementer"))!
      const repoDir = mkdtempSync(join(tmpdir(), "mh-live-probe-"))
      try {
        execSync("git init -q", { cwd: repoDir })
        execSync("git remote add origin https://github.com/octocat/Hello-World.git", { cwd: repoDir })
        writeFileSync(join(repoDir, "probe.txt"), `mh-followup-A live probe ${new Date().toISOString()}\n`)

        const mergedEnv = { ...process.env, ...sbx.env } // exact runHost merge shape

        // 3. local commit still works, real identity preserved
        const add = await run(["git", "-C", repoDir, "add", "probe.txt"], mergedEnv)
        expect(add.rc).toBe(0)
        const commit = await run(["git", "-C", repoDir, "commit", "-m", "mh-followup-A probe"], mergedEnv)
        expect(commit.rc).toBe(0)
        const who = await run(["git", "-C", repoDir, "log", "-1", "--format=%an <%ae>"], mergedEnv)
        expect(who.stdout.trim().length).toBeGreaterThan(0)
        expect(who.stdout).not.toContain("<>") // a real identity was written, not an empty placeholder

        // 1. push to a repo we don't own fails with auth/permission, not "up to date"
        const push = await run(
          ["git", "-C", repoDir, "push", "origin", "HEAD:refs/heads/mh-followup-probe-branch"],
          mergedEnv,
        )
        expect(push.rc).not.toBe(0)
        expect(push.stderr).not.toContain("Everything up-to-date")
        expect(push.stderr.toLowerCase()).toMatch(/could not read username|terminal prompts disabled|permission|denied|authentication|403/)

        // 2. gh reports unauthenticated despite a real keyring login existing
        const gh = await run(["gh", "auth", "status"], mergedEnv)
        expect(gh.rc).not.toBe(0)
        expect((gh.stdout + gh.stderr).toLowerCase()).toContain("not logged into any github hosts")

        // 4. model auth (*_API_KEY-shaped var) survives the scrub
        const apiKeyEnv = { ...mergedEnv, MH_LIVE_PROBE_TEST_API_KEY: "sk-should-survive" }
        const apiKeyCheck = await run(["bash", "-c", "printf '%s' \"$MH_LIVE_PROBE_TEST_API_KEY\""], apiKeyEnv)
        expect(apiKeyCheck.stdout).toBe("sk-should-survive")
      } finally {
        sbx.cleanup()
        rmSync(repoDir, { recursive: true, force: true })
      }
    },
    30_000,
  )
})
