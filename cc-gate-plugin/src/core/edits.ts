// cc-gate-plugin/src/core/edits.ts — PostToolUse arming: detect edit operations
// A1 cycle-tagging (2026-08-13): the handler now also accumulates the edited
// path (when the hook payload carried one) into state.touchedPaths — deduped,
// capped at TOUCHED_PATHS_CAP with touchedTruncated marking the overflow.
// Paths live in .km/ state ONLY; the sensor line gets derived booleans.
import { EDIT_TOOLS, TOUCHED_PATHS_CAP } from "../types.ts"
import type { CcGateState } from "../types.ts"

/** Pure handler: if toolName is in EDIT_TOOLS (exact case), arm edited flag
 * and record the touched path (if the payload supplied one). */
export function handlePostToolUse(
  state: CcGateState,
  toolName: string,
  filePath?: string,
): CcGateState {
  if (!EDIT_TOOLS.includes(toolName as never)) return state

  const next: CcGateState = { ...state, edited: true }

  if (typeof filePath === "string" && filePath !== "") {
    const paths = state.touchedPaths ?? []
    if (paths.includes(filePath)) return next
    if (paths.length >= TOUCHED_PATHS_CAP) {
      if (!state.touchedTruncated) next.touchedTruncated = true
      return next
    }
    next.touchedPaths = [...paths, filePath]
  }

  return next
}
