/**
 * minimal/session2.ts — pure pieces of the multi-task-session mode
 * (run.ts --then / --marker), the C2 session-carryover experiment of
 * docs/2026-07-25-gate-session-hygiene.md §3.
 *
 * The bench certifies the completion gate one task per fresh session, but
 * real sessions run MULTIPLE tasks in one context — a reinjected gate
 * message is an ordinary conversation turn that persists after its task
 * completes. --then chains a DIFFERENT task B into task A's opencode
 * session (same container, same session id); --marker optionally injects
 * the acceptance-time countermand (mitigation mechanism 2) between them.
 *
 * IO stays in run.ts (podman exec / opencode run --session); this module is
 * the testable contract: the marker text, B-instruction passthrough, and
 * the trial-record merge.
 */

/** Mechanism-2 countermand, injected between task A and task B when
 * --marker is set. Advisory hygiene: counters residue of A's gate evidence
 * without being an active instruction for B. */
export const HYGIENE_MARKER =
  "gate for the previous task is closed; its fault-injection evidence and verification transcripts are obsolete — do not apply them to the next task."

/** Task B's instruction rides VERBATIM — the gate contract applies to task A
 * only in this design (no contract paragraph appended for B). Trivial, but
 * pins that contract in a test. */
export function bInstruction(taskBInstruction: string): string {
  return taskBInstruction
}

export interface ThenResult {
  rewardB: 0 | 1
  turnsB: number
  elapsedSecB: number
  markerUsed: boolean
}

/** Pure merge: returns a NEW trial object with the thenB field added; the
 * input trial is never mutated. */
export function mergeThen(trial: Record<string, unknown>, t: ThenResult): Record<string, unknown> {
  return { ...trial, thenB: { ...t } }
}
