// TODO(F): runSingleRound — rounds:1 capture-and-refuse over runCompletionGate
import type { RoundOutcome } from "../types.ts"
export async function runSingleRound(
  runCheck: (cmd: string) => Promise<{ code: number; out: string }>,
  check: string,
): Promise<{ outcome: RoundOutcome; evidence?: string }> {
  void runCheck; void check
  throw new Error("TODO(F)")
}
