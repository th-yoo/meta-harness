/** Runs INSIDE a Bun Worker. One guest program per "run" message. The guest
 * sees ONLY the `api` object; every tool/gate interaction is an async RPC to
 * the host. No host references cross the boundary (structured clone only).
 * Trusted-guest execution via new Function — the hostile-guest reference is
 * OpenClaw's QuickJS-WASI worker; this is a thread boundary, not a sandbox. */

type HostMsg =
  | { type: "run"; src: string; toolNames: string[] }
  | { type: "result"; id: number; ok: boolean; value?: unknown; error?: string }

let nextId = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function rpc(target: "tool" | "gate", name: string | undefined, args: unknown): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    postMessage({ type: "call", id, target, name, args })
  })
}

self.onmessage = async (ev: MessageEvent<HostMsg>) => {
  const msg = ev.data
  if (msg.type === "result") {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.value)
    else p.reject(new Error(msg.error ?? "rpc failed"))
    return
  }
  if (msg.type !== "run") return

  const tools: Record<string, (args?: unknown) => Promise<unknown>> = {}
  for (const name of msg.toolNames) {
    tools[name] = (args?: unknown) => rpc("tool", name, args)
  }
  const api = {
    tools,
    checkAndCommit: (claim: unknown) => rpc("gate", undefined, claim),
    log: (m: unknown) => postMessage({ type: "log", msg: String(m) }),
  }
  try {
    const guest = new Function("api", `"use strict"; return (async () => { ${msg.src}\n })();`)
    await guest(api)
    postMessage({ type: "done" })
  } catch (e) {
    postMessage({ type: "done", error: e instanceof Error ? e.message : String(e) })
  }
}
