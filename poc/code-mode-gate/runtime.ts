/** Mini code-mode runtime with gated, staged effects and a cost meter.
 *
 * Composition under test:
 *   - code-mode-style BATCHING: a turn is one guest PROGRAM that may make many
 *     tool calls; the whole program costs ONE model round trip.
 *   - kkamak-style ZERO-SPEND GATING: the only way an effect commits is through
 *     a deterministic verifier; rejection returns steering INSIDE the turn.
 *
 * Capability discipline (the OpenClaw lesson, identity not names): the guest
 *   receives an API OBJECT; commit authority is not on it. The runtime commits
 *   internally iff the gate passed. There is no name a guest could call to
 *   bypass the gate, because the capability is never constructed for it.
 *
 * NOT A SANDBOX: guests run via new Function() and are trusted. The reference
 * implementation for hostile guests is OpenClaw's QuickJS-WASI worker; sandbox
 * hardening is explicitly out of this PoC's scope.
 */
import { gateClaim, type GateVerdict } from "./verifier.ts"

export interface CostMeter {
  roundTrips: number
  toolCalls: number
  gateChecks: number
  gateRejections: number
  /** rejections whose steering was consumed inside the SAME turn */
  localRetries: number
  approxTokens: number
}

export function newMeter(): CostMeter {
  return { roundTrips: 0, toolCalls: 0, gateChecks: 0, gateRejections: 0, localRetries: 0, approxTokens: 0 }
}

const approxTokensOf = (s: string): number => Math.ceil(s.length / 4)

export interface Scenario {
  /** tokens re-sent to the model on EVERY round trip (system + history + tools) */
  contextTokens: number
  anchorsU: number[]
  /** auxiliary read-only tools the task needs before any claim can be made */
  auxTools: Record<string, () => unknown>
}

export interface GuestApi {
  /** read-only auxiliary tools; each call is metered */
  tools: Record<string, () => unknown>
  /** stage a claim; verify; commit iff the gate passes. Returns the verdict —
   * with steering on rejection — so correction can happen in-turn. */
  checkAndCommit(canonicals: number[]): GateVerdict
  log(msg: string): void
}

export interface TurnResult {
  committed: number[] | null
  verdicts: GateVerdict[]
  logs: string[]
}

export class Runtime {
  readonly meter = newMeter()
  private committed: number[] | null = null

  constructor(private readonly scenario: Scenario) {}

  getCommitted(): number[] | null {
    return this.committed
  }

  /** Execute one guest program = ONE model round trip. */
  runTurn(programSrc: string): TurnResult {
    this.meter.roundTrips += 1
    this.meter.approxTokens += this.scenario.contextTokens + approxTokensOf(programSrc)

    const verdicts: GateVerdict[] = []
    const logs: string[] = []
    let sawRejectionThisTurn = false

    const tools: GuestApi["tools"] = {}
    for (const [name, fn] of Object.entries(this.scenario.auxTools)) {
      tools[name] = () => {
        this.meter.toolCalls += 1
        return fn()
      }
    }

    const api: GuestApi = {
      tools,
      checkAndCommit: (canonicals: number[]) => {
        this.meter.gateChecks += 1
        const verdict = gateClaim(this.scenario.anchorsU, canonicals)
        verdicts.push(verdict)
        if (verdict.ok) {
          // the ONLY commit site; guests hold no commit capability
          this.committed = [...canonicals]
        } else {
          this.meter.gateRejections += 1
          if (sawRejectionThisTurn) {
            // second+ rejection in the same turn: prior steering was available
          }
          sawRejectionThisTurn = true
        }
        return verdict
      },
      log: (msg: string) => logs.push(msg),
    }

    // Trusted-guest execution; see file header. The guest sees ONLY `api`.
    const guest = new Function("api", `"use strict";\n${programSrc}`)
    guest(api)

    // a rejection followed by a later in-turn success = steering consumed locally
    if (sawRejectionThisTurn && verdicts.some((v) => v.ok)) {
      this.meter.localRetries += verdicts.filter((v) => !v.ok).length
    }
    return { committed: this.committed, verdicts, logs }
  }
}
