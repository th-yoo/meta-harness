#!/usr/bin/env bun
/**
 * minimal/traj.ts — human-readable view of a trajectory ndjson.
 *
 * Usage:  bun minimal/traj.ts <results/xxx.traj.ndjson> [--full]
 *
 * The raw ndjson stays the evidence artifact (untrusted DATA per the kernel
 * doc); this is a read-only lens over it. --full disables truncation.
 */
import { readFileSync } from "node:fs"

const argv = process.argv.slice(2)
const full = argv.includes("--full")
const file = argv.find((a) => !a.startsWith("--"))
if (!file) {
  console.error("usage: bun minimal/traj.ts <traj.ndjson> [--full]")
  process.exit(1)
}

const CLIP = full ? Infinity : 600
const clip = (s: string): string => {
  const t = s.trimEnd()
  return t.length > CLIP ? `${t.slice(0, CLIP)} …[${t.length - CLIP} more chars]` : t
}
const indent = (s: string, pad = "    "): string =>
  s
    .split("\n")
    .map((l) => pad + l)
    .join("\n")

let turn = 0
for (const line of readFileSync(file, "utf-8").split("\n")) {
  if (!line.trim()) continue
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    console.log(`?? unparseable line: ${clip(line)}`)
    continue
  }

  switch (ev.type) {
    case "system":
      if (ev.subtype === "init")
        console.log(`── init  session=${ev.session_id ?? "?"}  model=${ev.model ?? "?"}  cwd=${ev.cwd ?? "?"}`)
      else console.log(`── system/${ev.subtype ?? "?"}`)
      break

    case "assistant": {
      turn++
      const model = ev.message?.model ?? "?"
      console.log(`\n▶ turn ${turn}  (${model})`)
      for (const block of ev.message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          console.log(indent(clip(block.text), "  "))
        } else if (block.type === "tool_use") {
          const args = typeof block.input === "string" ? block.input : JSON.stringify(block.input)
          console.log(`  ⚒ ${block.name}(${clip(args)})`)
        } else if (block.type === "thinking" && block.thinking?.trim()) {
          console.log(indent(clip(block.thinking), "  ~ "))
        }
      }
      break
    }

    case "user":
      for (const block of ev.message?.content ?? []) {
        if (block.type !== "tool_result") continue
        const parts = Array.isArray(block.content)
          ? block.content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
          : String(block.content ?? "")
        const tag = block.is_error ? "✗ tool error" : "→ tool result"
        console.log(`  ${tag}:${parts.trim() ? "\n" + indent(clip(parts)) : " (empty)"}`)
      }
      break

    case "result": {
      const cost = ev.total_cost_usd != null ? `  cost=$${ev.total_cost_usd.toFixed(4)}` : ""
      const dur = ev.duration_ms != null ? `  wall=${(ev.duration_ms / 1000).toFixed(1)}s` : ""
      console.log(`\n── result  ${ev.subtype ?? ""}${dur}${cost}  turns=${ev.num_turns ?? turn}`)
      if (ev.result?.trim()) console.log(indent(clip(ev.result), "  "))
      break
    }

    default:
      console.log(`── ${ev.type ?? "?"}`)
  }
}
