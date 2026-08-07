/**
 * p2-rule.test.ts — TDD for src/bench/p2/rule.ts: the P2 Frozen Rule text
 * (task-2-brief.md, plan §Frozen Rule) plus its mechanical compliance
 * predicate and driver-neutral Bash-command extractor.
 *
 * Written FIRST, failing (src/bench/p2/rule.ts does not exist yet) — see
 * task-2-report.md for the red -> green transcript.
 *
 * F2 note: all doneCheck/command strings below are synthetic fixtures
 * invented for this test, never a real bench transcript.
 */
import { test, expect } from "bun:test"
import {
  P2_RULE_TEXT,
  DONE_CHECK_PATH,
  ruleSha,
  isCompliant,
  bashCommandsFromEvents,
  referencesDoneCheckPath,
} from "../src/bench/p2/rule.ts"

// ── P2_RULE_TEXT / DONE_CHECK_PATH: byte-verbatim guard ────────────────────

test("P2_RULE_TEXT matches the plan's frozen rule text byte-for-byte", () => {
  const expected =
    "Before you finish, independently verify your work: run at least one\n" +
    "concrete check command against the actual artifacts (tests, a build, or\n" +
    "direct inspection of produced output) and write the command(s) you ran\n" +
    "and their observed result to /app/DONE-CHECK.txt. Your own reasoning\n" +
    "does not count as verification."
  expect(P2_RULE_TEXT).toBe(expected)
})

test("DONE_CHECK_PATH is the frozen absolute container path", () => {
  expect(DONE_CHECK_PATH).toBe("/app/DONE-CHECK.txt")
})

// ── ruleSha: deterministic content identity ─────────────────────────────
//
// Pinned to the literal known sha256 hex digest of P2_RULE_TEXT (computed
// once, independently, via `python3 -c 'import hashlib; ...'` and cross-
// checked with a `bun -e` run against the shipped constant — see
// task-2-report.md's fix-round-1 section) rather than only asserting the
// shape, so any accidental future edit to P2_RULE_TEXT fails this test
// loudly instead of silently re-pinning to whatever the new text hashes to.

test("ruleSha returns the pinned sha256 of P2_RULE_TEXT", () => {
  const KNOWN_SHA256_OF_P2_RULE_TEXT = "f731ece57c798a43e1863aebfa5a11dec0b71bf08ac814ae35642c5c202bcf65"
  const sha = ruleSha()
  expect(sha).toBe(KNOWN_SHA256_OF_P2_RULE_TEXT)
  expect(sha).toMatch(/^[0-9a-f]{64}$/)
  expect(ruleSha()).toBe(sha) // deterministic across calls
})

// ── isCompliant: table-driven ────────────────────────────────────────────

test("isCompliant: undefined content -> false", () => {
  expect(isCompliant(undefined, ["bun test x.test.ts"])).toBe(false)
})

test("isCompliant: empty-string content -> false", () => {
  expect(isCompliant("", ["bun test x.test.ts"])).toBe(false)
})

test("isCompliant: whitespace-only content -> false", () => {
  expect(isCompliant("   \n\t\n  ", ["bun test x.test.ts"])).toBe(false)
})

test("isCompliant: content that only echoes the rule text, with unrelated commands -> false", () => {
  const echoed = P2_RULE_TEXT // agent just copy-pasted the rule, ran nothing
  const bashCommands = ["ls /app", "git status"]
  expect(isCompliant(echoed, bashCommands)).toBe(false)
})

test("isCompliant: content that only echoes the rule text, with NO commands at all -> false", () => {
  expect(isCompliant(P2_RULE_TEXT, [])).toBe(false)
})

test("isCompliant: line names a command that is present verbatim in bashCommands -> true", () => {
  const content = "Ran: bun test x.test.ts -> 12 pass, 0 fail"
  const bashCommands = ["bun test x.test.ts"]
  expect(isCompliant(content, bashCommands)).toBe(true)
})

test("isCompliant: 8-char boundary — exactly 8 shared chars -> true", () => {
  // "abcdefgh" is exactly 8 chars, present in both line and command.
  const content = "output: abcdefgh was checked"
  const bashCommands = ["run-tool --flag abcdefgh-suffix"]
  expect(isCompliant(content, bashCommands)).toBe(true)
})

test("isCompliant: 7-char boundary — only 7 shared chars -> false", () => {
  // Shared run is exactly "abcdefg" (7 chars); every 8-char window of the
  // line straddles a 'z' that the command's surrounding 'w's never match,
  // so no 8-char window can appear in the command.
  const content = "zzzabcdefgzzz"
  const bashCommands = ["wwwabcdefgwww"]
  expect(isCompliant(content, bashCommands)).toBe(false)
})

test("isCompliant: line shorter than 8 chars can never match, regardless of content", () => {
  const content = "abcdefg" // exactly 7 chars — no 8-char window exists
  const bashCommands = ["abcdefg"]
  expect(isCompliant(content, bashCommands)).toBe(false)
})

test("isCompliant: multi-line content — compliance found on a later line", () => {
  const content = ["I looked at the code and it seems fine.", "Verification command: pytest tests/test_app.py -q"].join(
    "\n",
  )
  const bashCommands = ["pytest tests/test_app.py -q"]
  expect(isCompliant(content, bashCommands)).toBe(true)
})

test("isCompliant: blank lines interleaved with a compliant line still resolve true", () => {
  const content = "\n\nbun run build succeeded\n\n"
  const bashCommands = ["bun run build"]
  expect(isCompliant(content, bashCommands)).toBe(true)
})

// ── PRE-DATA AMENDMENT (plan commit 49c43d9): DONE-CHECK-path commands are
// excluded from the match set — the writer command necessarily contains
// the content it just wrote, which self-satisfied the unamended predicate
// with zero real verification. ─────────────────────────────────────────

test("referencesDoneCheckPath: true for a writer, true for a heredoc writer, true for a bare reader, false for an unrelated command", () => {
  expect(referencesDoneCheckPath('echo "done" > /app/DONE-CHECK.txt')).toBe(true)
  expect(referencesDoneCheckPath("cat <<'EOF' > /app/DONE-CHECK.txt\nfine\nEOF")).toBe(true)
  expect(referencesDoneCheckPath("cat /app/DONE-CHECK.txt")).toBe(true)
  expect(referencesDoneCheckPath("bun test test/p2-rule.test.ts")).toBe(false)
})

test("isCompliant: reviewer's exact repro — echo-prose-writer self-match is now NON-compliant", () => {
  // The old predicate self-satisfied here: the echo command's argv
  // literally contains the DONE-CHECK content it just wrote, so any
  // 8-char window of the file trivially reappeared in the command. The
  // amendment must reject this: the only candidate command references
  // DONE_CHECK_PATH, so it is excluded before the substring scan runs.
  const prose = "I verified everything works correctly by careful review"
  const echoWriterCmd = `echo "${prose}" > /app/DONE-CHECK.txt`
  expect(isCompliant(prose, [echoWriterCmd])).toBe(false)
})

test("isCompliant: heredoc/cat > writer variant is also NON-compliant", () => {
  const prose = "verification looks good, everything checks out fine"
  const heredocWriterCmd = `cat <<'EOF' > /app/DONE-CHECK.txt\n${prose}\nEOF`
  expect(isCompliant(prose, [heredocWriterCmd])).toBe(false)
})

test("isCompliant: a bare reader of the path (no writer) is also NON-compliant, even with real content overlap", () => {
  const content = "checked results via cat /app/DONE-CHECK.txt output review"
  const bashCommands = ["cat /app/DONE-CHECK.txt"]
  expect(isCompliant(content, bashCommands)).toBe(false)
})

test("isCompliant: genuine case — a real, path-unrelated command anchors compliance even when a writer command is ALSO present", () => {
  // "bun test" (8 chars) is a real command that actually ran and does not
  // touch DONE_CHECK_PATH; the echo writer command is present too (as it
  // would be in a real transcript, since something has to write the file)
  // but must be excluded, not required — the real command alone suffices.
  const content = "Ran bun test suite and confirmed 12 passing, 0 failing"
  const bashCommands = ["bun test", 'echo "Ran bun test suite and confirmed 12 passing, 0 failing" > /app/DONE-CHECK.txt']
  expect(isCompliant(content, bashCommands)).toBe(true)
})

test("isCompliant: ONLY a DONE-CHECK-path command available (no other bash commands) -> false", () => {
  const content = "some plausible-looking verification note here"
  const bashCommands = ['echo "some plausible-looking verification note here" > /app/DONE-CHECK.txt']
  expect(isCompliant(content, bashCommands)).toBe(false)
})

// ── bashCommandsFromEvents ────────────────────────────────────────────────

test("bashCommandsFromEvents: opencode-style lowercase 'bash' tool, raw args", () => {
  const events = [
    { t: "tool", tool: "bash", args: "echo hi" },
    { t: "tool", tool: "read", args: "/app/main.py" },
  ]
  expect(bashCommandsFromEvents(events)).toEqual(["echo hi"])
})

test("bashCommandsFromEvents: claude-code-style capitalized 'Bash' tool, JSON-wrapped args", () => {
  const events = [
    { t: "tool", tool: "Bash", args: JSON.stringify({ command: "pytest -q", description: "run tests" }) },
  ]
  expect(bashCommandsFromEvents(events)).toEqual(["pytest -q"])
})

test("bashCommandsFromEvents: filters out non-bash tools (edit, grep, task, text/error events)", () => {
  const events = [
    { t: "text", text: "thinking" },
    { t: "tool", tool: "edit", args: "/app/foo.py" },
    { t: "tool", tool: "grep", args: "TODO" },
    { t: "error", text: "boom" },
    { t: "tool", tool: "bash", args: "ls -la" },
  ]
  expect(bashCommandsFromEvents(events)).toEqual(["ls -la"])
})

test("bashCommandsFromEvents: events with no tool field are skipped, not thrown on", () => {
  const events = [{ t: "text", text: "no tool here" }, { t: "tool", tool: "bash", args: "pwd" }]
  expect(bashCommandsFromEvents(events)).toEqual(["pwd"])
})

test("bashCommandsFromEvents: empty events array -> empty array", () => {
  expect(bashCommandsFromEvents([])).toEqual([])
})

// ── end-to-end: events -> bashCommands -> isCompliant ───────────────────

test("end-to-end: a real-shaped bash event feeds isCompliant to true", () => {
  const events = [
    { t: "tool", tool: "Bash", args: JSON.stringify({ command: "bun test test/p2-rule.test.ts" }) },
    { t: "tool", tool: "edit", args: "/app/src/foo.ts" },
  ]
  const bashCommands = bashCommandsFromEvents(events)
  const doneCheck = "I ran: bun test test/p2-rule.test.ts and got 17 pass"
  expect(isCompliant(doneCheck, bashCommands)).toBe(true)
})
