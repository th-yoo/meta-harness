/** Host side of the composed runtime's isolation boundary. Owns the Worker
 * lifecycle, dispatches guest RPCs to callbacks, and enforces the limits with
 * enumerated failure codes. One worker per turn (created fresh, terminated
 * always) — simplest lifecycle that is correct; snapshots/resume are YAGNI.
 * Thread boundary, NOT a security sandbox — hostile-guest reference: OpenClaw's QuickJS-WASI worker (src/agents/code-mode-*). */
import type { FailureCode, Limits } from "./types.ts"

export interface BridgeCallbacks {
  onToolCall(name: string, args: unknown): unknown | Promise<unknown>
  onGateCall(claim: unknown): unknown
  onLog(msg: string): void
}

export type BridgeOutcome =
  | { status: "completed"; guestError?: string }
  | { status: "failed"; code: FailureCode; message: string }

type GuestMsg =
  | { type: "call"; id: number; target: "tool" | "gate"; name?: string; args: unknown }
  | { type: "log"; msg: string }
  | { type: "done"; error?: string }

export function runGuest(
  src: string,
  toolNames: string[],
  limits: Limits,
  cb: BridgeCallbacks,
  /** test seam for worker-construction failure; production callers omit it */
  shellUrl: URL = new URL("./guest-shell.ts", import.meta.url),
): Promise<BridgeOutcome> {
  return new Promise((resolve) => {
    let worker: Worker | undefined
    let settled = false
    let inFlight = 0
    let outputBytes = 0

    const finish = (outcome: BridgeOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      worker?.terminate()
      resolve(outcome)
    }

    const watchdog = setTimeout(
      () => finish({ status: "failed", code: "timeout", message: `guest exceeded ${limits.timeoutMs}ms` }),
      limits.timeoutMs,
    )

    // Construction can throw synchronously (bad URL, resolution failure on
    // another host). Uncaught, it would REJECT this promise and escape
    // runTurn() as a raw exception — breaking the every-failure-has-a-code
    // contract. Catch → structured guest_error.
    try {
      worker = new Worker(shellUrl)
    } catch (e) {
      finish({
        status: "failed",
        code: "guest_error",
        message: `worker construction failed: ${e instanceof Error ? e.message : String(e)}`,
      })
      return
    }

    worker.onmessage = async (ev: MessageEvent<GuestMsg>) => {
      const msg = ev.data
      if (settled) return
      if (msg.type === "log") {
        outputBytes += msg.msg.length
        if (outputBytes > limits.maxOutputBytes) {
          finish({
            status: "failed",
            code: "output_limit_exceeded",
            message: `guest output ${outputBytes}B > ${limits.maxOutputBytes}B`,
          })
          return
        }
        cb.onLog(msg.msg)
        return
      }
      if (msg.type === "done") {
        finish({ status: "completed", guestError: msg.error })
        return
      }
      // type === "call"
      inFlight += 1
      if (inFlight > limits.maxPendingCalls) {
        finish({
          status: "failed",
          code: "pending_limit_exceeded",
          message: `guest held ${inFlight} calls open > ${limits.maxPendingCalls}`,
        })
        return
      }
      try {
        const value =
          msg.target === "gate" ? cb.onGateCall(msg.args) : await cb.onToolCall(msg.name ?? "", msg.args)
        // the watchdog (or a cap) may have fired while the tool call was
        // in flight — posting to a terminated worker is the race the
        // slow-tool test exists to catch. Re-check after EVERY await.
        if (settled) return
        worker!.postMessage({ type: "result", id: msg.id, ok: true, value })
      } catch (e) {
        if (settled) return
        worker!.postMessage({
          type: "result",
          id: msg.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })
      } finally {
        inFlight -= 1
      }
    }

    // Fires for worker-load failures (e.g. the shell module failing to
    // resolve asynchronously). Guest program errors do NOT land here — the
    // shell's own try/catch reports them as guestError on "completed".
    worker.onerror = (e) => {
      finish({ status: "failed", code: "guest_error", message: String((e as ErrorEvent).message ?? e) })
    }

    worker.postMessage({ type: "run", src, toolNames })
  })
}
