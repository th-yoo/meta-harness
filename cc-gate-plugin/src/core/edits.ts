// cc-gate-plugin/src/core/edits.ts — PostToolUse arming: detect edit operations
import { EDIT_TOOLS } from "../types.ts"
import type { CcGateState } from "../types.ts"

/** Pure handler: if toolName is in EDIT_TOOLS (exact case), arm edited flag. */
export function handlePostToolUse(state: CcGateState, toolName: string): CcGateState {
  if (EDIT_TOOLS.includes(toolName as never)) {
    return { ...state, edited: true }
  }
  return state
}
