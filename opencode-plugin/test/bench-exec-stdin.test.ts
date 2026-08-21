/**
 * runHost's stdin transport — REAL subprocesses, no mocks.
 *
 * Every test here is built from an input that BREAKS a specific way of getting
 * the transport wrong; reading the source finds none of them. The reverted
 * first attempt (review record ecde549) shipped three defects that a mocked
 * seam cannot see: a payload the child never reads, a parent whose own stdin
 * is held open, and a byte count that disagrees with the char count.
 *
 * MEASURED kill map (each mutation applied to exec.ts and the file re-run,
 * 2026-08-21) — not a claim about what "should" fail:
 *   - delete the write/end block          -> 1, 2, 3, 4 fail
 *   - write BEFORE the timer is armed     -> 5 fails (timedOut false after 30s)
 *   - `stdin: "inherit"` when no payload  -> 6 fails (times out; the child ate
 *                                            the parent's held-open stdin)
 *   - drop the `.catch` on the write      -> NOTHING fails. Bun's FileSink
 *     swallows EPIPE, so no probe produced a rejection; that catch is crash
 *     insurance, and test 7 asserts the resolved contract, not the catch.
 *   - await the write before the drains   -> NOTHING fails. Bun buffers the
 *     payload in memory, so that ordering is not a deadlock the way a
 *     sequential stdout/stderr drain is. Ordering matters against the TIMER
 *     (mutation 2), not against the drains.
 */
import { test, expect } from "bun:test"
import { join } from "node:path"
import { runHost } from "../src/bench/exec.ts"

/** Linux caps ONE argv element at MAX_ARG_STRLEN = 32 * PAGE_SIZE. Measured on
 * this host 2026-08-21: a 200,000-char element throws
 * `E2BIG: argument list too long, posix_spawn` out of Bun.spawn itself (not a
 * nonzero exit — a THROW, which is why the argv path could crash a batch),
 * while 100,000 spawns fine. */
const MAX_ARG_STRLEN = 131_072

test("1: opts.stdin reaches the child's stdin", async () => {
  const payload = "hello transport\n"
  const result = await runHost(["cat"], { stdin: payload })
  expect(result.rc).toBe(0)
  expect(result.stdout).toBe(payload)
})

test(
  "2: a payload far larger than the OS pipe buffer round-trips whole",
  async () => {
    // 1 MB against a 64 KiB pipe buffer: `cat` must be read from while it is
    // being written to, in both directions at once, for any of this to finish.
    const payload = "x".repeat(1_000_000)
    const result = await runHost(["cat"], { stdin: payload })
    expect(result.rc).toBe(0)
    expect(result.stdout.length).toBe(payload.length)
    expect(result.timedOut).toBe(false)
  },
  30_000,
)

test("3: a multi-byte payload round-trips byte-exact (chars are not bytes)", async () => {
  // 50,000 chars but 150,000 bytes: under any char-denominated ceiling and
  // over the byte-denominated one. A transport that measures or slices the
  // payload in chars corrupts or truncates this.
  const payload = "日".repeat(50_000)
  expect(payload.length).toBeLessThan(MAX_ARG_STRLEN)
  expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(MAX_ARG_STRLEN)
  const result = await runHost(["cat"], { stdin: payload })
  expect(result.rc).toBe(0)
  expect(result.stdout).toBe(payload)
  expect(Buffer.byteLength(result.stdout, "utf8")).toBe(Buffer.byteLength(payload, "utf8"))
}, 30_000)

test("4: a payload past MAX_ARG_STRLEN is deliverable on stdin — as an argv element it is not", async () => {
  const payload = "z".repeat(200_000)
  // the ceiling being removed, demonstrated rather than asserted from docs
  await expect(runHost(["/bin/echo", payload])).rejects.toThrow(/E2BIG/)
  const result = await runHost(["cat"], { stdin: payload })
  expect(result.rc).toBe(0)
  expect(result.stdout.length).toBe(payload.length)
}, 30_000)

test(
  "5: the host timer bounds a write to a child that never reads stdin",
  async () => {
    // `sleep` never reads its stdin, so the write blocks once the 64 KiB pipe
    // buffer fills. A write outside the timer window hangs forever with
    // timeoutSec ignored — measured at 220,000 bytes on the reverted attempt.
    const started = Date.now()
    const result = await runHost(["sleep", "30"], { stdin: "q".repeat(220_000), timeoutSec: 2 })
    const elapsedMs = Date.now() - started
    expect(result.timedOut).toBe(true)
    expect(result.rc).toBe(-1)
    expect(elapsedMs).toBeLessThan(15_000)
  },
  30_000,
)

test(
  "6: with no payload the child gets EOF, never the parent's own stdin",
  async () => {
    // Bun's default is `ignore`; `inherit` regresses EVERY runHost caller
    // (podman create/start/exec/cp/build, fleet/run.ts, squad-propose.ts) by
    // letting children consume the runner's terminal input. `bun test` cannot
    // hold its own stdin open, so the probe runs in a child whose stdin is a
    // pipe this test opens and never closes.
    const fixture = join(import.meta.dir, "fixtures", "exec", "held-stdin-probe.ts")
    const proc = Bun.spawn(["bun", fixture], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(stderr).toBe("")
    expect(proc.exitCode).toBe(0)
    const inner = JSON.parse(stdout)
    expect(inner.rc).toBe(0)
    expect(inner.stdout).toBe("")
  },
  30_000,
)

test("7: a child that exits without reading still yields a normal result", async () => {
  // A payload nobody will ever read must not become runHost's problem: `true`
  // is gone before it lands. (Bun swallows the EPIPE itself — see the kill map;
  // this asserts the contract, not the catch.)
  const result = await runHost(["true"], { stdin: "w".repeat(500_000) })
  expect(result.rc).toBe(0)
  expect(result.timedOut).toBe(false)
}, 30_000)
