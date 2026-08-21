/**
 * Fixture for bench-exec-stdin.test.ts's no-inherit guard.
 *
 * The test spawns THIS script with `stdin: "pipe"` and never writes or closes
 * that pipe — i.e. the parent's stdin is open and will never produce EOF. The
 * script then calls `runHost(["cat"])` with NO stdin payload.
 *
 * - runHost passing `stdin: "ignore"` (correct): `cat` reads /dev/null, gets
 *   EOF immediately, and this script prints its JSON and exits.
 * - runHost passing `stdin: "inherit"` (the reverted regression): `cat`
 *   inherits the held-open pipe, blocks forever, and this script never exits —
 *   the test then fails on its own timeout.
 *
 * The parent's stdin must be held open by a DIFFERENT process, which is why
 * this cannot be an in-test assertion: `bun test` does not control its own
 * stdin.
 */
import { runHost } from "../../../src/bench/exec.ts"

const result = await runHost(["cat"])
console.log(JSON.stringify({ rc: result.rc, stdout: result.stdout, timedOut: result.timedOut }))
