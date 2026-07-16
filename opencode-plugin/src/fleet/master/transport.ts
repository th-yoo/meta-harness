// master/transport.ts — the human↔master channel seam (R1 correction of §9.2).
//
// R1: Slack Socket Mode has NO offline durability (events during a socket
// gap are silently dropped). Any REAL transport implementation dropped in
// behind this seam MUST be offset-acknowledged — e.g. Telegram getUpdates
// (24h server-side backlog) or Slack-HTTP + Delayed Events. Socket Mode is
// FORBIDDEN as a backing implementation of this interface.
//
// The contract modeled here is exactly `poll() → ack(id)`: poll returns the
// backlog since the last ack; ack(id) advances the offset so that message
// (and anything before it, for a real offset-based backend) is not
// re-delivered. An un-acked message MUST re-appear on the next poll — that
// is the self-healing property that lets a down/crashed master resume
// without losing a human's answer.

export interface InboundMsg {
  id: string
  text: string
  from?: string
}

export interface OutboundMsg {
  text: string
  replyTo?: string
}

export interface Transport {
  poll(): Promise<InboundMsg[]>
  ack(id: string): Promise<void>
  send(m: OutboundMsg): Promise<{ id: string }>
}

/**
 * In-memory fake transport for hermetic tests. Holds the full backlog plus
 * an ack-cursor set; poll() returns every backlog entry whose id has not
 * been acked (offset-ack semantics, R1). No network, no LLM, no randomness
 * — the `send` id counter is a deterministic monotonic n++.
 */
export function fakeTransport(
  script?: InboundMsg[],
): Transport & { sent: OutboundMsg[]; acked: string[]; inject(msgs: InboundMsg[]): void } {
  const backlog: InboundMsg[] = script ? [...script] : []
  const ackedSet = new Set<string>()
  const acked: string[] = []
  const sent: OutboundMsg[] = []
  let sendCounter = 0

  return {
    sent,
    acked,
    inject(msgs: InboundMsg[]): void {
      backlog.push(...msgs)
    },
    async poll(): Promise<InboundMsg[]> {
      return backlog.filter((m) => !ackedSet.has(m.id))
    },
    async ack(id: string): Promise<void> {
      ackedSet.add(id)
      acked.push(id)
    },
    async send(m: OutboundMsg): Promise<{ id: string }> {
      sent.push(m)
      const id = `out-${sendCounter}`
      sendCounter += 1
      return { id }
    },
  }
}
