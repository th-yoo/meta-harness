/**
 * minimal-llm.test.ts — llmCall's async contract and the claude-code driver's
 * argv/stdin/parse/error behaviour, exercised against a FAKE binary.
 *
 * ZERO real model calls, and the seam that guarantees it is `opts.binPath`.
 *
 * MEASURED 2026-08-04, the reason this seam exists: Bun resolves an
 * executable from the PATH captured at PROCESS START, not from a mutated
 * `process.env.PATH`. A test that prepends a temp dir to `process.env.PATH`
 * and spawns `"claude"` therefore runs the REAL Claude CLI — silently, and at
 * real cost. (Proven: spawning a fake reachable only via mutated PATH throws
 * ENOENT, while the same fake resolves fine via an explicit `env` or an
 * absolute path.) Injecting the path is the only honest way to fake this.
 *
 * Why llmCall became async: it was `Bun.spawnSync`, which blocks the event
 * loop for the whole call, and the design-time seats routinely spend minutes
 * in one. The five call sites in propose.ts/review.ts were already
 * async-tolerant — `reviewBullet.call` is typed `string | Promise<string>`
 * and awaited at review.ts:262 — so the signature change is the migration.
 */
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { llmCall, PROPOSER_DRIVERS } from "../../minimal/llm.ts"

/** Write an executable fake CLI and return its ABSOLUTE path. `body` is bash.
 * Absolute, never PATH-relative — see the header note. */
function fakeBin(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "minimal-llm-fake-"))
  const p = join(dir, "fake-cli")
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

describe("llmCall (claude-code driver, fake binary — no model)", () => {
  test("is async: returns a Promise, not a string", async () => {
    const binPath = fakeBin(`cat >/dev/null; echo '{"result":"ok"}'`)
    const r = llmCall("claude-code", "claude-opus-5", "hi", { binPath })
    expect(typeof (r as { then?: unknown }).then).toBe("function")
    expect(await r).toBe("ok")
  })

  test("parses .result out of --output-format json", async () => {
    const binPath = fakeBin(`cat >/dev/null; echo '{"result":"HELLO-FROM-FAKE"}'`)
    expect(await llmCall("claude-code", "claude-opus-5", "hi", { binPath })).toBe("HELLO-FROM-FAKE")
  })

  test("the prompt is delivered on STDIN, not argv", async () => {
    // Why stdin at all: a >0.5MB prompt blows Linux's ~128KB per-argv-string
    // limit (E2BIG, observed live at round 2). The fake echoes what it read,
    // so this asserts the delivery channel rather than trusting the comment.
    const binPath = fakeBin(`IN=$(cat); printf '{"result":"%s"}' "$IN"`)
    expect(await llmCall("claude-code", "claude-opus-5", "PROMPT-ON-STDIN", { binPath })).toBe("PROMPT-ON-STDIN")
  })

  test("a prompt far past the argv limit survives the stdin path", async () => {
    const big = "x".repeat(600_000) // > ~128KB argv limit, on purpose
    const binPath = fakeBin(`IN=$(cat); printf '{"result":"%s"}' "\${#IN}"`)
    expect(await llmCall("claude-code", "claude-opus-5", big, { binPath })).toBe(String(big.length))
  })

  test("the model and the json output-format reach argv", async () => {
    const binPath = fakeBin(`cat >/dev/null; printf '{"result":"%s"}' "$*"`)
    const out = await llmCall("claude-code", "claude-sonnet-5", "hi", { binPath })
    expect(out).toContain("-p")
    expect(out).toContain("--model claude-sonnet-5")
    expect(out).toContain("--output-format json")
  })

  test("a non-zero exit REJECTS with the stderr tail — never resolves empty", async () => {
    const binPath = fakeBin(`cat >/dev/null; echo 'BOOM-DETAIL' >&2; exit 3`)
    await expect(llmCall("claude-code", "claude-opus-5", "hi", { binPath })).rejects.toThrow(/exit 3/)
    await expect(llmCall("claude-code", "claude-opus-5", "hi", { binPath })).rejects.toThrow(/BOOM-DETAIL/)
  })

  test("a missing .result yields the empty string, not undefined", async () => {
    const binPath = fakeBin(`cat >/dev/null; echo '{"other":1}'`)
    expect(await llmCall("claude-code", "claude-opus-5", "hi", { binPath })).toBe("")
  })

  test("binPath is honoured over ambient PATH — the no-real-call guarantee", async () => {
    // If this ever regresses to resolving "claude" from PATH, this test runs
    // the real CLI and starts costing money. The marker makes that loud.
    const binPath = fakeBin(`cat >/dev/null; echo '{"result":"FAKE-ONLY-MARKER"}'`)
    expect(await llmCall("claude-code", "claude-opus-5", "hi", { binPath })).toBe("FAKE-ONLY-MARKER")
  })
})

describe("PROPOSER_DRIVERS", () => {
  test("claude-code defaults to opus — design-time seats are judgment", () => {
    expect(PROPOSER_DRIVERS["claude-code"].defaultModel).toBe("claude-opus-5")
  })
})
