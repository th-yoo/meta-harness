// cc-gate-plugin/src/gauge/channel.ts
// km-gauge verification-channel ladder (pre-reg spec 2026-08-03-gauge-
// verification-channel-ladder-preregistration.md §1-§3). Pure module:
// text builders + shape parsers + deterministic mapping. No IO here —
// same discipline as refiner.ts.
import type { GaugePromptClass } from "../types.ts"

export type VerificationChannel = "C1" | "C2" | "C3" | "C4"
export type ChannelOrExempt = VerificationChannel | "exempt"

export const CHANNEL_LITERALS: readonly string[] = ["C1", "C2", "C3", "C4"]

/** Spec §2: A1/B/C map deterministically; A2/D return null = the model
 * refinement question (buildChannelPrompt) decides C2/C3/C4. */
export function channelForClass(cls: GaugePromptClass): ChannelOrExempt | null {
  switch (cls) {
    case "A1":
      return "exempt"
    case "B":
    case "C":
      return "C1"
    case "A2":
    case "D":
      return null
  }
}
