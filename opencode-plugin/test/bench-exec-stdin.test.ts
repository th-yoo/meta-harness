/**
 * runHost's stdin transport — REAL subprocesses, no mocks.
 *
 * Every test here is built from an input that BREAKS a specific way of getting
 * the transport wrong; reading the source finds none of them. The reverted
 * first attempt (review record ecde549) shipped three defects that a mocked
 * seam cannot see: a payload the child never reads, a parent whose own stdin
 * is held open, and a byte count that disagrees with the char count.
 *
 * MEASURED kill map (each mutation applied to exec.ts and the file re-run) —
 * not a claim about what "should" fail. Corrected 2026-08-21 after a
 * fresh-context review reproduced every row: one was worded loosely enough to
 * be false, and a kill map is the acceptance evidence this repo merges on.
 *   - delete the write/end block            -> 1, 2, 3, 4 fail
 *   - AWAIT the write before the timer is
 *     armed (the exact reverted shape:
 *     `write(); await end()` above the
 *     timer)                                -> 5 fails, timedOut false after 30s
 *   - `stdin: "inherit"` when no payload    -> 6 fails (times out; the child ate
 *                                              the parent's held-open stdin)
 * And the rows that kill NOTHING, which matter just as much:
 *   - MOVE the write statement above the timer without moving the await:
 *     7 pass. Creation order is immaterial — `write()` never blocks long
 *     enough (220 KB: 0ms, 1 MB: 1ms, 20 MB: 16ms). The operative rule is
 *     narrower than "created after the timer": do not AWAIT before arming it.
 *   - await the write before the drains: 7 pass. Bun eagerly drains a child's
 *     piped stdout with nothing reading it, so this is not the input-side
 *     twin of the sequential-drain deadlock.
 *   - drop the `.catch`, or drop `written` from the Promise.all: 7 pass.
 *     Nothing here produced a rejection to catch (a child that reads 1 KB then
 *     exits, one already dead, and one SIGKILLed mid-stream all RESOLVE with a
 *     short count), and `proc.exited` is in the Promise.all regardless, so
 *     `written` cannot be the last thing outstanding. Insurance, not coverage.
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
  // The ceiling being removed, demonstrated rather than asserted from docs —
  // but MAX_ARG_STRLEN is a LINUX constant (32 * PAGE_SIZE, per argv ELEMENT;
  // measured here: 131,071 spawns, 131,072 throws, and 16 elements of 100,000
  // each — 1.6 MB of total argv — spawn fine, so the bound is per-element and
  // not ARG_MAX). XNU has no per-string cap, so this argument would spawn
  // happily on the project's MacBook and only this half of the test would go
  // red there. This repo transfers by git alone, so a Linux-only assertion
  // would ship a broken suite to that host; the stdin half below is
  // platform-neutral and always runs.
  if (process.platform === "linux") {
    await expect(runHost(["/bin/echo", payload])).rejects.toThrow(/E2BIG/)
  }
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
    // process.execPath, not "bun": bun lives outside any default PATH on this
    // host, and resolving it through PATH makes the ONLY test that catches
    // `stdin: "inherit"` die with "Executable not found in $PATH" instead —
    // a guard that fails for a reason unrelated to what it guards.
    const proc = Bun.spawn([process.execPath, fixture], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
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
  // is gone before it lands. This asserts the CONTRACT, not the catch — and it
  // cannot assert delivery, because neither return value can audit that:
  // measured, `write()` gives a short count once backpressured (5 MB into a
  // child that reads 1 KB resolves at 219,264, remainder dropped) and `end()`
  // is a final-flush count, 736 for a fully delivered 220 KB and 0 for total
  // loss. Delivery is proven by tests 1-4 reading the payload back out of the
  // child instead.
  const result = await runHost(["true"], { stdin: "w".repeat(500_000) })
  expect(result.rc).toBe(0)
  expect(result.timedOut).toBe(false)
}, 30_000)
