// TODO(J): handleUserPromptSubmit — preemption (Wave 3)
import type { CcGateState, CoreDeps, PromptResult } from "../types.ts"
export function handleUserPromptSubmit(
  state: CcGateState,
  sessionId: string,
  gateConfigRaw: string | undefined,
  deps: CoreDeps,
): PromptResult {
  void state; void sessionId; void gateConfigRaw; void deps
  throw new Error("TODO(J)")
}
