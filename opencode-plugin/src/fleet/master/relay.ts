/**
 * master/relay.ts — the deterministic relay tick (§9.1 gate mechanism, R1,
 * §9.3 halt-on-approval). One tick: poll the transport → parse each inbound
 * against a fixed grammar → route:
 *   - a gate *answer* (approve/revise) that matches a pending gate resumes the
 *     paused squad and maps its `SquadOutcome`;
 *   - a `status` query renders the R1 exposure surface (all pending gates);
 *   - anything else (unknown grammar, or an answer with no matching pending
 *     gate) is self-healed with a help reply — the human, the durability
 *     layer, simply re-sends.
 *
 * NO LLM, NO network, NO randomness in this decision path (binding
 * determinism invariant): `RelayDeps` exposes NO LLM seam, timestamps come
 * from the injected `now`, and every branch is a pure function of durable
 * gate-state + the injected transport/resume seams.
 *
 * REUSE, never reimplement: `resumeSquad` is the shipped `cmdSquadRun` bound
 * with `runtimeRoot = namespace.runtimeRoot` — a human gate answer rides the
 * existing `cmdSquadRun({ resume:true, gateAnswer })` checkpoint/resume idiom.
 * The relay never opens its own checkpoint/resume machinery, and never opens
 * its own PR/push flow — that is the injected `onApprovedTerminal`
 * outward-action seam (self-hosting N2), which fires ONLY on a human approve
 * that terminated the squad (halt-on-approval, §9.3).
 */
import { Transport } from "./transport.ts"
import {
  pendingGates,
  raiseGate,
  resolveGate,
  type PendingGate,
  type GateKind,
} from "./gate-state.ts"
import type { SquadOutcome } from "../squad.ts"

export interface ParsedInbound {
  verb: "answer" | "status" | "unknown"
  project?: string
  sliceId?: string
  answer?: "approve" | "revise"
}

/**
 * Deterministic grammar (no LLM):
 *   `approve <project>/<sliceId>` → answer/approve
 *   `revise  <project>/<sliceId>` → answer/revise
 *   `status`                      → status
 * anything else                   → unknown
 */
export function parseInbound(text: string): ParsedInbound {
  const t = text.trim()
  if (t === "status") return { verb: "status" }
  const m = /^(approve|revise)\s+([^/\s]+)\/([^/\s]+)$/.exec(t)
  if (m) {
    return {
      verb: "answer",
      answer: m[1] as "approve" | "revise",
      project: m[2],
      sliceId: m[3],
    }
  }
  return { verb: "unknown" }
}

/** The shipped `cmdSquadRun` bound with the namespace's runtimeRoot — the
 * relay REUSES its checkpoint/resume, never reimplements it. */
export type ResumeSquadFn = (a: {
  project: string
  sliceId: string
  resume: true
  gateAnswer: "approve" | "revise"
}) => Promise<SquadOutcome>

export interface RelayDeps {
  masterRoot: string
  transport: Transport
  resumeSquad: ResumeSquadFn
  /** The outward-action seam (self-hosting N2 push/PR). Fires ONLY on a human
   * approve that terminated the squad (`status:"done"`) — never on revise or a
   * non-terminal path. NO LLM. */
  onApprovedTerminal?: (o: SquadOutcome, ctx: { project: string; sliceId: string }) => Promise<void>
  now?: () => string
}

/**
 * One deterministic relay tick. Returns the count of inbound messages
 * processed (each is acked, so it will not re-appear on the next poll).
 */
export async function relayTick(deps: RelayDeps): Promise<{ handled: number }> {
  const { masterRoot, transport, resumeSquad, onApprovedTerminal } = deps
  const now = deps.now ?? (() => new Date().toISOString())

  const inbound = await transport.poll()
  let handled = 0

  for (const msg of inbound) {
    const parsed = parseInbound(msg.text)

    if (parsed.verb === "status") {
      await transport.send({ text: renderStatus(masterRoot), replyTo: msg.id })
      await transport.ack(msg.id)
      handled += 1
      continue
    }

    if (parsed.verb === "answer") {
      const { project, sliceId, answer } = parsed as {
        project: string
        sliceId: string
        answer: "approve" | "revise"
      }
      // Resolve the answer against a pending gate: the inbound names only
      // project+sliceId, so the *kind* comes from the matching pending entry.
      const matched = pendingGates(masterRoot, project).find((g) => g.sliceId === sliceId)
      if (!matched) {
        // Self-heal: no matching pending gate → do NOT resume the squad; the
        // human re-sends after seeing the reply / a `status`.
        await transport.send({
          text: `no such pending gate: ${project}/${sliceId}`,
          replyTo: msg.id,
        })
        await transport.ack(msg.id)
        handled += 1
        continue
      }

      const outcome = await resumeSquad({ project, sliceId, resume: true, gateAnswer: answer })

      // Map the resumed outcome. A new pause re-enters pending; a terminal
      // done fires the outward-action seam ONLY on approve.
      if (outcome.status === "gate") {
        const g: PendingGate = {
          project,
          sliceId,
          kind: outcome.gate as GateKind,
          payload: outcome.payload,
          raisedAt: now(),
        }
        raiseGate(masterRoot, g)
        await transport.send({
          text: `gate ${outcome.gate} for ${project}/${sliceId}: ${outcome.payload}`,
          replyTo: msg.id,
        })
      } else if (outcome.status === "escalation") {
        const g: PendingGate = {
          project,
          sliceId,
          kind: "escalation",
          payload: outcome.escalation.body,
          raisedAt: now(),
        }
        raiseGate(masterRoot, g)
        await transport.send({
          text: `escalation for ${project}/${sliceId}: ${outcome.escalation.body}`,
          replyTo: msg.id,
        })
      } else if (outcome.status === "done") {
        await transport.send({ text: `done: ${project}/${sliceId}`, replyTo: msg.id })
        // Halt-on-approval (§9.3): the outward-action seam fires ONLY here,
        // and ONLY when a human *approve* terminated the squad — never on
        // revise or any non-terminal path.
        if (answer === "approve") {
          await onApprovedTerminal?.(outcome, { project, sliceId })
        }
      }

      // Resolve the ANSWERED gate using the matched kind, then ack.
      resolveGate(masterRoot, project, sliceId, matched.kind, {
        inboundId: msg.id,
        project,
        sliceId,
        answer,
        processedAt: now(),
      })
      await transport.ack(msg.id)
      handled += 1
      continue
    }

    // unknown grammar → help reply, self-heal.
    await transport.send({ text: helpText(), replyTo: msg.id })
    await transport.ack(msg.id)
    handled += 1
  }

  return { handled }
}

/** Deterministic rendering of the R1 exposure surface: every pending gate,
 * one per line, each including its `sliceId`. */
function renderStatus(masterRoot: string): string {
  const pending = pendingGates(masterRoot)
  if (pending.length === 0) return "no pending gates"
  const lines = pending.map((g) => `${g.project}/${g.sliceId} [${g.kind}] ${g.payload}`)
  return `pending gates (${pending.length}):\n${lines.join("\n")}`
}

function helpText(): string {
  return "commands: approve <project>/<sliceId> | revise <project>/<sliceId> | status"
}
