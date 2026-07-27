// TODO(K): handleStop — the Stop transition state machine (Wave 3)
import type { CcGateState, CoreDeps, StopInput, StopResult } from "../types.ts"
export async function handleStop(
  state: CcGateState,
  input: StopInput,
  gateConfigRaw: string | undefined,
  deps: CoreDeps,
): Promise<StopResult> {
  void state; void input; void gateConfigRaw; void deps
  throw new Error("TODO(K)")
}
