/** Public API of the composed runtime: code-mode batching (one guest program
 * = one metered round trip) + a pluggable zero-spend gate as the ONLY effect
 * path. The runtime is verifier-agnostic by construction — no verifier domain
 * content may appear in this file.
 *
 * Capability discipline: commit happens HERE, host-side, iff the plugged
 * verifier accepted. The guest api carries no commit capability; there is no
 * name a guest could call to bypass the gate, because the capability is never
 * constructed for it (authorization by object capability, not by name). */
import { runGuest } from "./bridge.ts"
import {
  DEFAULT_LIMITS,
  approxTokensOf,
  newMeter,
  type CostMeter,
  type FailureCode,
  type Limits,
  type Verdict,
  type Verifier,
} from "./types.ts"

export interface RuntimeOptions<C, S> {
  /** tokens re-sent to the model on EVERY round trip (system + history + tools) */
  contextTokens: number
  tools: Record<string, (args?: unknown) => unknown | Promise<unknown>>
  verifier: Verifier<C, S>
  limits?: Partial<Limits>
}

export type TurnResult = (
  | { status: "completed"; guestError?: string }
  | { status: "failed"; code: FailureCode; message: string }
) & { verdicts: Verdict<unknown>[]; logs: string[] }

export class ComposedRuntime<C, S = unknown> {
  readonly meter: CostMeter = newMeter()
  private committed: C | null = null
  private readonly limits: Limits

  constructor(private readonly opts: RuntimeOptions<C, S>) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits }
  }

  getCommitted(): C | null {
    return this.committed
  }

  async runTurn(src: string): Promise<TurnResult> {
    this.meter.roundTrips += 1
    this.meter.approxTokens += this.opts.contextTokens + approxTokensOf(src)

    const verdicts: Verdict<unknown>[] = []
    const logs: string[] = []
    let rejectionsThisTurn = 0
    let acceptedThisTurn = false

    const outcome = await runGuest(src, Object.keys(this.opts.tools), this.limits, {
      onToolCall: (name, args) => {
        const tool = this.opts.tools[name]
        if (!tool) throw new Error(`unknown tool: ${name}`)
        this.meter.toolCalls += 1
        return tool(args)
      },
      onGateCall: (claim) => {
        this.meter.gateChecks += 1
        const verdict = this.opts.verifier(claim as C)
        verdicts.push(verdict)
        if (verdict.ok) {
          // the ONLY commit site; guests hold no commit capability
          this.committed = structuredClone(claim) as C
          acceptedThisTurn = true
        } else {
          this.meter.gateRejections += 1
          rejectionsThisTurn += 1
        }
        return verdict
      },
      onLog: (msg) => logs.push(msg),
    })

    if (rejectionsThisTurn > 0 && acceptedThisTurn) {
      this.meter.localRetries += rejectionsThisTurn
    }
    return { ...outcome, verdicts, logs }
  }
}
