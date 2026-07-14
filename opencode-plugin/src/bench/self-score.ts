/**
 * self-score.ts — Phase 0 plumbing for best-of-k search-with-verifier
 * (plan: docs/superpowers/plans/2026-07-14-… / .claude/plans/ethereal-cooking-whale.md).
 *
 * Measures whether an agent's OWN verification predicts the hidden TB2 grader —
 * the load-bearing unknown for best-of-k. This is a HARNESS-CONTROLLED TRANSPORT
 * of a self-report, NOT an independently-verified score: the harness controls
 * the READ (podman exec cat, a fixed-format file — robust vs. fragile prose
 * parsing), but the passed/total CONTENT is the agent's own claim, with no
 * independent-execution guarantee like reward.txt (which the harness itself runs
 * via test.sh). A truly harness-verified selection score is impossible by
 * construction — the only independent verifier IS the held-out grader, and
 * selecting on it recreates the coupling. Phase 0's job is to measure whether
 * this structured self-report can be trusted; nothing here consumes it for
 * selection yet.
 */
import { podman, type ExecResult } from "./exec.ts"
import { buildExecArgv } from "./sandbox.ts"

/** Fixed path the agent writes its self-check fraction to, inside the sandbox. */
export const SELF_SCORE_PATH = "/logs/self-check/score.txt"

/** Stable marker (the instruction's first line) — its presence in the assembled
 * harnessMd is the signal that self-check is on, so runTaskOnce reads the score
 * only then (zero overhead + byte-identical results when off). */
export const SELF_CHECK_MARKER = "## Self-check (harness instruction)"

/** Harness instruction appended to the agent's AGENTS.md (Phase 0, opt-in) —
 * asks the agent to run REAL checks and record the count. Language-agnostic
 * (bash echo), unlike TB2's own pytest/ctrf verifier. */
export const SELF_CHECK_INSTRUCTION = [
  SELF_CHECK_MARKER,
  "",
  "REQUIRED — the LAST thing you do, EVERY run, no exceptions.",
  "",
  "1. Before finishing, WRITE AND RUN real checks on your work — compile it, run",
  "   it, assert the expected outputs. Only checks you ACTUALLY executed and whose",
  "   output you SAW count; a check you didn't run does not count.",
  "2. Count HONESTLY. <total> = checks you ran; <passed> = those that produced the",
  "   correct result in output you saw. A check that errored, failed an assertion,",
  "   or you skipped is NOT passed. Do NOT write N/N unless you genuinely ran N",
  "   checks and saw all N pass — an inflated 3/3 is WORSE than an honest 2/3, and",
  "   claiming a pass you didn't verify defeats the point.",
  "3. ALWAYS end by running this EXACT command (even if some checks failed — report",
  "   the real numbers; only if you truly ran no checks, use 0/0):",
  "",
  "```",
  `mkdir -p ${SELF_SCORE_PATH.replace(/\/[^/]+$/, "")} && echo "<passed>/<total>" > ${SELF_SCORE_PATH}`,
  "```",
  "",
  "Writing this file is mandatory — skipping it fails the harness self-check.",
].join("\n")

type ExecArgvFn = (argv: string[]) => Promise<ExecResult>

/**
 * Read the agent's self-reported `passed/total` from the sandbox and return it
 * as a 0..1 fraction. Mirrors the exec+read PATTERN of verifier.ts:runVerifier
 * (`podman exec cat <file>` → trim), but that reads a BINARY "0"/"1" — the
 * fraction parse here is new. Returns null when the file is absent (agent
 * skipped the self-check) or malformed / total=0 / passed>total. Injectable
 * execFn for tests.
 *
 * The parse stays strict-anchored ($, no /m): a multi-line / prose-contaminated
 * file yields null (a dropped pair — conservative for a *measurement* gate)
 * rather than risking a wrong-fraction grab from a first-match sweep (review
 * R3#2 — a deliberate safety/coverage trade; revisit only if Phase 0 capture
 * rate is low).
 */
export async function readSelfScore(name: string, execFn: ExecArgvFn = podman): Promise<number | null> {
  const res = await execFn(buildExecArgv(name, ["cat", SELF_SCORE_PATH]))
  if (res.rc !== 0) return null
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(res.stdout.trim())
  if (!m) return null
  const passed = Number(m[1])
  const total = Number(m[2])
  // Reject total=0 (Infinity) and passed>total (>1.0): either poisons the
  // downstream self-PASS threshold + argmax (review R3#1, same class as R2#1).
  return total > 0 && passed <= total ? passed / total : null
}
