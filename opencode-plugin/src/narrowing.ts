/** narrowing.ts — rule-8 exception plumbing (gauntlet spec, 2026-08-18).
 *
 * The proposer's rule 8 has always carried an exception: a rejection recorded
 * as trigger-overreach WITH the core mechanism certified invites a
 * NARROWER-scoped variant. But the review gate's duplicate check was blind to
 * it — the scoped pacing variant gen-3's proposer minted was dup-killed twice
 * against the v2-era ledger (live defect, resume 2026-08-18 verdict block).
 *
 * This module makes the certification MECHANICAL: a reject verdict whose
 * per-task table shows the candidate's own expect_improve predictions came
 * TRUE (net positive on the named tasks) while strong guards regressed (net
 * negative) is, by construction, "mechanism certified, trigger overreach" —
 * no human trajectory read required. The attribution feeds two prompt
 * surfaces (proposer rejected/ledger sections, reviewer duplicate check) via
 * a "Narrowing INVITED" block, and stamps ledger entries through the
 * RejectedEntry.narrowing field.
 */
import type { GuardEntry } from "./harness-store.ts"

export interface NarrowingAttribution {
  invited: boolean
  /** One-line certified-mechanism statement for prompts ("" when not invited). */
  mechanism: string
  /** Σ(candidate passes − active passes) over matched expect_improve tasks. */
  improveNet: number
  /** Σ(candidate passes − active passes) over strong guards in the table. */
  guardNet: number
  matchedImprove: string[]
  matchedGuards: string[]
}

/** Guards below this active-pass rate carry no regression signal. Mirrors the
 * proposer prompt's ">=80%" strong-guard bar (propose.ts guardsSection). */
const STRONG_GUARD_RATE = 0.8

function net(r: { candidate: number[]; active: number[] }): number {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + (b ? 1 : 0), 0)
  return sum(r.candidate) - sum(r.active)
}

export function attributeOverreach(a: {
  taskResults: Record<string, { candidate: number[]; active: number[] }>
  /** The candidate's own diagnosis predictions.expect_improve strings —
   * matching is by task-name mention, so prose predictions work. */
  expectImprove: string[]
  guards: GuardEntry[]
}): NarrowingAttribution {
  const tasks = Object.keys(a.taskResults).sort()
  const strong = new Set(a.guards.filter((g) => g.rate >= STRONG_GUARD_RATE).map((g) => g.task))
  const matchedImprove = tasks.filter((t) => a.expectImprove.some((p) => p.includes(t)))
  const matchedGuards = tasks.filter((t) => strong.has(t) && !matchedImprove.includes(t))
  const improveNet = matchedImprove.reduce((s, t) => s + net(a.taskResults[t]!), 0)
  const guardNet = matchedGuards.reduce((s, t) => s + net(a.taskResults[t]!), 0)
  const invited = matchedImprove.length > 0 && improveNet > 0 && guardNet < 0
  const mechanism = invited
    ? `predicted-improve tasks came true (net +${improveNet}: ${matchedImprove.join(", ")}) while strong guards regressed (net ${guardNet}: ${matchedGuards.join(", ")}) — the mechanism works; its recorded trigger fired where it should not have`
    : ""
  return { invited, mechanism, improveNet, guardNet, matchedImprove, matchedGuards }
}
