/**
 * judge.ts
 *
 * Headless dense-judge LLM session (Phase 4 Part D).
 *
 * Scores a completed mh-* session against its task-summary "rubric" by
 * spawning a short-lived headless LLM session — copying triggerPropose's
 * session-spawn idiom in propose.ts EXACTLY: client.session.create →
 * proposerSessions.add (so the judge session itself is excluded from every
 * scoring/trajectory/idle hook) → client.session.prompt → waitForFile. The
 * judge is a single turn, so it gets a much shorter timeout than the
 * proposer's 10 minutes.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import * as fs from "fs"
import * as path from "path"
import { readMhConfig, parseModelSpec, type TrajEvent } from "./harness-store.ts"
import { proposerSessions } from "./session-state.ts"
import { waitForFile } from "./propose.ts"

type Client = PluginInput["client"]

/** One turn is plenty for a verdict — do not hold up scoring for 10 minutes
 * the way the proposer does. */
const JUDGE_TIMEOUT_MS = 90_000

export interface JudgeVerdict {
  passed: boolean
  confidence: number
  reasoning: string
}

/**
 * Render trajectory events for the judge prompt. Mirrors the per-event
 * formatting `fmtTrajEvent` uses for `buildFailureExcerpts` in
 * harness-store.ts, factored locally: `runJudge` is handed an in-memory
 * `TrajEvent[]` for the session just scored, not a stored trajectory file on
 * disk, so the storeRoot/version-keyed excerpting in harness-store.ts doesn't
 * apply here.
 */
function renderTrajEvents(events: TrajEvent[], cap = 8_000): string {
  if (!events.length) return "(no trajectory captured)"
  const lines = events.map((e) => {
    if (e.t === "tool") {
      return `TOOL ${e.tool ?? "?"}${e.error ? " [ERROR]" : ""}: ${e.args ?? ""}${e.output ? ` → ${e.output}` : ""}`
    }
    if (e.t === "error") return `ERROR: ${e.text ?? ""}`
    return `SAY: ${e.text ?? ""}`
  })
  return lines.join("\n").slice(0, cap)
}

/**
 * Build the rubric prompt the judge session receives: the task summary, turn
 * count, and rendered trajectory (tool calls with args/output/errors, plus
 * text/error events), followed by instructions to judge SUCCESS on the
 * evidence — skeptical of any claimed-but-unverified success — and to write
 * ONLY the JSON verdict to the staging file via a bash heredoc (the same
 * write-mechanism the proposer prompts use).
 */
export function buildJudgePrompt(
  summary: string,
  turns: number,
  traj: TrajEvent[],
  stagingPath: string,
  worktree: string,
): string {
  const relStaging = path.relative(worktree, stagingPath)
  const trajSection = renderTrajEvents(traj)

  return `# Meta-Harness Judge

You are scoring whether a coding-agent session ACTUALLY ACCOMPLISHED its task.
You did not watch the session happen — you only have the evidence below. Be
SKEPTICAL: a session's own final message claiming success, completion, or that
tests pass is NOT evidence by itself — only verifiable actions in the
trajectory (commands that were actually run and actually succeeded, files that
were actually created/edited, tests that actually passed) count as evidence.
If the trajectory doesn't verify the claimed outcome, or the evidence is
ambiguous, or a tool call errored and was never recovered from, lean toward
failing the session.

## Task summary
${summary}

## Turn count
${turns}

## Trajectory (tool calls with args/output/errors, plus text/error events)
${trajSection}

## Your task

Judge whether the task above was completed SUCCESSFULLY, based ONLY on the
evidence in the trajectory. Then write ONLY the JSON verdict below to the
staging file — no markdown fences, no commentary, nothing else in that file:

\`\`\`bash
cat > "${relStaging}" << 'ENDOFVERDICT'
{"passed":true,"confidence":0.0,"reasoning":"<=500 chars explaining the verdict>"}
ENDOFVERDICT
\`\`\`

The JSON MUST have exactly these keys: "passed" (boolean), "confidence"
(number, 0..1 — how confident you are in the verdict), "reasoning" (string,
<=500 chars). Replace the example values with your actual verdict; do not
leave the placeholder values in place.`
}

/**
 * Score one session by spawning a headless judge LLM session. Returns the
 * parsed verdict, or null on ANY failure (missing session id, timeout,
 * missing/malformed/invalid staging file) — this never throws, so a broken
 * judge degrades to "no verdict" rather than breaking the caller's flow.
 */
export async function runJudge(
  client: Client,
  worktree: string,
  sessionID: string,
  summary: string,
  turns: number,
  traj: TrajEvent[],
): Promise<JudgeVerdict | null> {
  const stagingPath = path.join(worktree, ".meta-harness", "staging", `judge-${sessionID}.json`)
  let judgeSessionID: string | undefined

  try {
    const cfg = readMhConfig()
    const judgeModel = parseModelSpec(cfg.judgeModel)
    const prompt = buildJudgePrompt(summary, turns, traj, stagingPath, worktree)

    fs.mkdirSync(path.dirname(stagingPath), { recursive: true })

    const sessionRes = await client.session.create({
      body: { title: `[meta-harness] judge ${sessionID}` },
    })
    judgeSessionID = sessionRes.data?.id
    if (!judgeSessionID) return null

    proposerSessions.add(judgeSessionID)
    await client.session.prompt({
      path: { id: judgeSessionID },
      body: {
        parts: [{ type: "text", text: prompt }],
        ...(judgeModel ? { model: judgeModel } : {}),
      },
    })

    const found = await waitForFile(stagingPath, JUDGE_TIMEOUT_MS)
    if (!found) return null

    const raw = JSON.parse(fs.readFileSync(stagingPath, "utf-8"))
    if (
      typeof raw !== "object" || raw === null ||
      typeof raw.passed !== "boolean" ||
      typeof raw.confidence !== "number" || raw.confidence < 0 || raw.confidence > 1 ||
      typeof raw.reasoning !== "string"
    ) {
      return null
    }

    // Cap reasoning to 500 chars even if the LLM ignores the prompt's <=500
    // instruction — an overlong reasoning string must not bloat score.json.
    return { passed: raw.passed, confidence: raw.confidence, reasoning: raw.reasoning.slice(0, 500) }
  } catch {
    return null
  } finally {
    if (judgeSessionID) proposerSessions.delete(judgeSessionID)
    fs.rmSync(stagingPath, { force: true })
  }
}
