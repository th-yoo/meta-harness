/**
 * Trajectory capping + truncation disclosure. LEAF MODULE: no imports, no side
 * effects — so both the root judge path (`src/judge.ts`) and the bench judge
 * path (`src/bench/judge-audit.ts`) can share it without either depending on
 * the other. Previously these lived in `bench/judge-audit.ts`, which made the
 * plugin-entry scoring path import a bench COMMAND module and pull
 * `opencode-run` -> exec/staging/agent-run/drivers into the plugin graph
 * (fresh-context review, finding 6).
 */

/** The trajectory budget handed to a judge.
 *
 * WAS 8_000, and that silently truncated real work out of view: measured
 * 2026-08-21, path-tracing failure trajectories render to 21,673-66,508 chars,
 * so the judge saw 12-38% of each session. In 5 of 7 the agent's first
 * `write /app/image.c` fell OUTSIDE the window, and the judge — accurately
 * describing its own input — reported "the trajectory ends before any image.c
 * is written". It had not. Worse, a window cut mid-session matches the
 * `incomplete` mode's definition ("stops partway with work visibly unfinished")
 * BY CONSTRUCTION, so the cap manufactured the mode it was meant to observe.
 * Re-running the taxonomy after the fix flipped all 8 classifications.
 *
 * The value is a RESOURCE bound, not a correctness knob: truncation now
 * announces itself, so exhausting the budget is visible rather than silent.
 *
 * WHY 100_000: it is a MEASURED bound now, not a transport one. The argv
 * ceiling that used to set it is gone — the judge prompt rides on stdin
 * (opencode-run.ts, covered in test/bench-exec-stdin.test.ts), so Linux's
 * MAX_ARG_STRLEN no longer bounds anything here. What remains is the measured
 * range of real trajectories: the path-tracing failures rendered to
 * 21,673-66,508 chars, all inside 100_000, so nothing observed is being cut.
 * Raising it further is a separate decision that needs its own evidence (judge
 * context budget and cost per call), not a free consequence of the transport. */
export const DEFAULT_TRAJ_CAP = 100_000

export interface RenderedTraj {
  /** the text the judge reads; ends with a neutral marker when truncated */
  text: string
  truncated: boolean
  /** length of the full rendering before capping */
  totalChars: number
  /** INVARIANT: always equals text.length */
  shownChars: number
}

/** The neutral in-data marker. NEVER an imperative: both judge prompts order
 * the model to ignore instructions found inside the trajectory, so an
 * instruction here is either discounted (inert) or obeyed (proving trajectory
 * data can steer verdicts — the injection surface that rule closes). The
 * instructive sentence goes in the trusted frame instead; see truncationNotice. */
function marker(cap: number, total: number): string {
  return `\n\n[truncated at ${cap.toLocaleString()} of ${total.toLocaleString()} characters]`
}

/** Cap a rendered trajectory, reserving room for the marker so the returned
 * `text` does not exceed `cap` — the bare `.slice(0, cap)` contract this
 * replaced guaranteed that, and callers may still size buffers against it.
 *
 * ONE EXCEPTION, deliberate: when `cap` is smaller than the marker itself
 * (pathological, ~40 chars), DISCLOSURE WINS over the bound and `text` is just
 * the marker. Silently returning a bare 5-char prefix would reproduce the exact
 * defect this module exists to prevent. The invariant that always holds is
 * `shownChars === text.length`. */
export function applyTrajCap(full: string, cap: number = DEFAULT_TRAJ_CAP): RenderedTraj {
  if (full.length <= cap) {
    return { text: full, truncated: false, totalChars: full.length, shownChars: full.length }
  }
  // two-pass: the marker's own length depends on the cut point only via `cap`,
  // which is fixed, so one measurement suffices.
  const room = Math.max(0, cap - marker(cap, full.length).length)
  const text = full.slice(0, room) + marker(cap, full.length)
  return { text, truncated: true, totalChars: full.length, shownChars: text.length }
}

/** The truncation notice for the TRUSTED prompt frame — outside the untrusted
 * trajectory section, where the judge is permitted to act on it. Empty string
 * when nothing was cut, so call sites can interpolate unconditionally. */
export function truncationNotice(r: RenderedTraj): string {
  if (!r.truncated) return ""
  return (
    `NOTE (harness, trusted): the trajectory below is TRUNCATED — you are seeing ` +
    `the first ${r.shownChars.toLocaleString()} of ${r.totalChars.toLocaleString()} ` +
    `characters. The session continues beyond it. Absence from this prefix is not ` +
    `evidence of absence: do not conclude that work you cannot see never happened.`
  )
}
