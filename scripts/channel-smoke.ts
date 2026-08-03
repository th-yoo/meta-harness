#!/usr/bin/env bun
/**
 * channel-smoke.ts — known-answer verification of the gauge verification-
 * channel instrument (spec: docs/superpowers/specs/2026-08-03-gauge-
 * verification-channel-ladder-preregistration.md; go granted 2026-08-03
 * "Verify gauge", sized 14 opus calls: 12 known-answer + 2 live nudge).
 *
 * Phase 1 (12 calls): synthetic hand-labeled prompts (NOT sampled — F2
 * clean) through the real buildChannelPrompt → opus → parseChannelOutput.
 * PRE-REGISTERED BAR (set before any call was made): instrument sane iff
 * overall agreement >= 9/12; report both miss directions separately —
 * expected-C4 labeled C2/C3 (under-catch) vs expected-C2/C3 labeled C4
 * (over-refusal, the §6-bar-relevant direction).
 *
 * Phase 2 (2 calls): live nudge proof — throwaway repo, gate.json
 * channelNudge:true, real hook-cli UserPromptSubmit spawn; C4-shaped
 * prompt must emit additionalContext, C2-shaped must emit nothing.
 *
 * Usage: bun scripts/channel-smoke.ts --go 14 [--out <file>]
 * Cost fence: refuses unless --go equals the exact planned call count.
 * Results (counts + per-item verdicts, no model prose) written to --out
 * (default docs/gauge-channel/<hostname>-channel-smoke.json) — commit it.
 */
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { buildChannelPrompt, parseChannelOutput } from "../cc-gate-plugin/src/gauge/channel.ts"
import { callChannelModel } from "../cc-gate-plugin/src/gauge/channel-run.ts"

interface SmokeItem {
  id: string
  expected: "C2" | "C3" | "C4"
  prompt: string
}

/** Synthetic, hand-labeled at authoring time (2026-08-03). All are
 * non-programmatic shapes (the refinement question's domain). Items t1-t3
 * are traps: shapes that tempt a wrong channel. */
const SET: SmokeItem[] = [
  { id: "c4-1", expected: "C4", prompt: "Make the codebase better and cleaner overall, whatever that takes across the project." },
  { id: "c4-2", expected: "C4", prompt: "Improve performance somehow — you decide what matters most and go make it noticeably faster." },
  { id: "c4-3", expected: "C4", prompt: "Polish the developer experience so contributing to this repository feels more professional." },
  { id: "c2-1", expected: "C2", prompt: "Summarize what the authentication module does in one paragraph that mentions every exported function by name." },
  { id: "c2-2", expected: "C2", prompt: "Review this change and produce a list naming every place where error handling is missing, one line each." },
  { id: "c2-3", expected: "C2", prompt: "Explain why the build fails and propose a fix, citing the exact failing rule and the message it prints." },
  { id: "c3-1", expected: "C3", prompt: "Draft the quarterly announcement email for our customers; it only counts as done once our marketing lead signs off on the wording." },
  { id: "c3-2", expected: "C3", prompt: "Prepare interview questions for the staff engineer loop; the hiring panel must approve the final set before we use it." },
  { id: "c3-3", expected: "C3", prompt: "Pick brand colors that match the style guide our design director keeps offline and will check your choices against." },
  { id: "t1", expected: "C4", prompt: "Tweak the landing page until it feels right — honestly the user will know it when they see it, just iterate." },
  { id: "t2", expected: "C4", prompt: "Refactor the database layer module however you think best; no particular outcome in mind, use your judgment." },
  { id: "t3", expected: "C4", prompt: "Fix whatever is wrong with this thing and generally tidy up anything else you happen to notice along the way." },
]

const NUDGE_C4 = "Make everything about this project generally nicer and more impressive somehow, at your own discretion, no specific outcome required."
const NUDGE_C2 = "Write a summary of the release notes that names every breaking change listed in them, so a reader can verify none is missing."
const PLANNED_CALLS = SET.length + 2

const REPO = path.resolve(import.meta.dir, "..")
const HOOK_CLI = path.join(REPO, "cc-gate-plugin/src/hook-cli.ts")

async function runNudgeProof(prompt: string): Promise<{ emitted: boolean; stdout: string }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channel-smoke-"))
  try {
    fs.writeFileSync(path.join(tmp, "gate.json"), JSON.stringify({ check: "true", channelNudge: true }))
    const proc = Bun.spawn(["bun", HOOK_CLI, "UserPromptSubmit"], {
      cwd: tmp,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: "sid-smoke", cwd: tmp, prompt })),
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env },
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return { emitted: stdout.includes("additionalContext"), stdout: stdout.slice(0, 200) }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const goIdx = args.indexOf("--go")
  const go = goIdx >= 0 ? Number(args[goIdx + 1]) : undefined
  if (go !== PLANNED_CALLS) {
    console.log(`REFUSING: channel-smoke — this run makes exactly ${PLANNED_CALLS} model calls (${SET.length} known-answer + 2 nudge proof). Re-run with --go ${PLANNED_CALLS} to authorize.`)
    process.exit(1)
  }
  const outIdx = args.indexOf("--out")
  const outPath =
    outIdx >= 0 ? args[outIdx + 1]! : path.join(REPO, "docs/gauge-channel", `${os.hostname()}-channel-smoke.json`)

  const results: Array<{ id: string; expected: string; got: string | null; match: boolean }> = []
  for (const item of SET) {
    const raw = await callChannelModel(buildChannelPrompt(item.prompt), process.env)
    const parsed = raw === undefined ? undefined : parseChannelOutput(raw)
    const got = parsed?.channel ?? null
    results.push({ id: item.id, expected: item.expected, got, match: got === item.expected })
    console.log(`${item.id}: expected ${item.expected} got ${got ?? "(no parse)"} ${got === item.expected ? "OK" : "MISS"}`)
  }

  const agree = results.filter((r) => r.match).length
  const underCatch = results.filter((r) => r.expected === "C4" && (r.got === "C2" || r.got === "C3")).length
  const overRefusal = results.filter((r) => r.expected !== "C4" && r.got === "C4").length

  console.log("--- nudge proof ---")
  const proofC4 = await runNudgeProof(NUDGE_C4)
  const proofC2 = await runNudgeProof(NUDGE_C2)
  console.log(`C4-shaped prompt nudge emitted: ${proofC4.emitted} (expect true)`)
  console.log(`C2-shaped prompt nudge emitted: ${proofC2.emitted} (expect false)`)

  const summary = {
    ranAt: new Date().toISOString(),
    host: os.hostname(),
    bar: "pre-registered: agreement >= 9/12",
    agreement: `${agree}/${SET.length}`,
    barMet: agree >= 9,
    underCatch_expectedC4_gotC2C3: underCatch,
    overRefusal_expectedC2C3_gotC4: overRefusal,
    nudgeProof: { c4Emitted: proofC4.emitted, c2Emitted: proofC2.emitted, pass: proofC4.emitted && !proofC2.emitted },
    items: results,
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n")
  console.log(`agreement ${agree}/${SET.length} (bar >=9) barMet=${summary.barMet} underCatch=${underCatch} overRefusal=${overRefusal}`)
  console.log(`nudge proof pass=${summary.nudgeProof.pass}`)
  console.log(`written: ${outPath}`)
}

main()
