/** gate-plugin — standalone completion-gate sensor for daily sessions.
 * Engine-free by design (sidesteps engine.sessionIdle ordering hazard).
 * Opt-in per project: gate.json at the worktree root. */
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { makeGateHooks } from "./core.ts"

const gatePlugin: Plugin = async ({ client, $, worktree }) => {
  const hooks = makeGateHooks({
    readGateConfig: () => {
      const p = join(worktree, "gate.json")
      return existsSync(p) ? readFileSync(p, "utf-8") : undefined
    },
    runCheck: async (cmd) => {
      const r = await $`bash -c ${cmd}`.quiet().nothrow()
      return { code: r.exitCode, out: r.stdout.toString("utf8") + r.stderr.toString("utf8") }
    },
    promptSession: async (sessionID, text) => {
      const res = await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      })
      return !!res.data
    },
    toast: async (message, variant) => {
      await client.tui.showToast({ body: { title: "Gate", message, variant, duration: 8_000 } })
    },
    appendSensor: (relPath, line) => {
      const p = join(worktree, relPath)
      mkdirSync(dirname(p), { recursive: true })
      appendFileSync(p, line + "\n")
    },
    now: () => Date.now(),
  })
  return {
    "tool.execute.after": async (toolInput) => {
      const { tool, sessionID } = toolInput
      hooks.toolExecuteAfter(tool, sessionID)
    },
    "chat.message": async (_input, output) => {
      const sessionID = output.message.sessionID
      if (sessionID) hooks.chatMessage(sessionID)
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = event.properties.sessionID
      if (sessionID) await hooks.sessionIdle(sessionID)
    },
  }
}
export const server: PluginModule["server"] = gatePlugin
