// TODO(C): delivery seam — block-only modes; allow-family mode-independent
import type { DeliveryMode, EmitPlan, StopDecision } from "./types.ts"
export function buildStopOutput(d: StopDecision, mode: DeliveryMode): EmitPlan {
  void d; void mode
  throw new Error("TODO(C)")
}
