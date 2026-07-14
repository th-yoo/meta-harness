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

/** Harness instruction appended to the agent's AGENTS.md (Phase 0, opt-in) —
 * asks the agent to run REAL checks and record the count. Language-agnostic
 * (bash echo), unlike TB2's own pytest/ctrf verifier. */
export const SELF_CHECK_INSTRUCTION = [
  "## Self-check (harness instruction)",
  "",
  "After you finish implementing, WRITE AND RUN your own checks that verify your",
  "work (compile / execute / assert — real checks, not guesses), then record the",
  "outcome as a fraction:",
  "",
  "```",
  `mkdir -p ${SELF_SCORE_PATH.replace(/\/[^/]+$/, "")} && echo "<passed>/<total>" > ${SELF_SCORE_PATH}`,
  "```",
  "",
  "where <passed> = checks that passed and <total> = checks you ran. Base the",
  "numbers on checks you actually executed.",
].join("\n")

type ExecArgvFn = (argv: string[]) => Promise<ExecResult>

/**
 * Read the agent's self-reported `passed/total` from the sandbox and return it
 * as a 0..1 fraction. Mirrors the exec+read PATTERN of verifier.ts:runVerifier
 * (`podman exec cat <file>` → trim), but that reads a BINARY "0"/"1" — the
 * fraction parse here is new. Returns null when the file is absent (agent
 * skipped the self-check) or malformed / total=0. Injectable execFn for tests.
 */
export async function readSelfScore(name: string, execFn: ExecArgvFn = podman): Promise<number | null> {
  const res = await execFn(buildExecArgv(name, ["cat", SELF_SCORE_PATH]))
  if (res.rc !== 0) return null
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(res.stdout.trim())
  if (!m) return null
  const passed = Number(m[1])
  const total = Number(m[2])
  return total > 0 ? passed / total : null
}
