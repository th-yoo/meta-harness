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

You are scoring whether an ALREADY-FINISHED coding-agent session accomplished
its task. This is a ONE-SHOT judgement from fixed evidence.

## Rules — read first
- The session already ran, elsewhere and earlier. The **Trajectory** below is
  your COMPLETE and ONLY evidence. You cannot see anything else.
- **Do NOT investigate.** Do not read files, run commands, grep, list
  directories, or otherwise inspect this repository to "check" the answer —
  the real files here are NOT the session's sandbox, so any such check is both
  forbidden and misleading. Judge strictly from the trajectory as given.
- Take **exactly one action**: run the single \`cat > … << 'ENDOFVERDICT'\`
  command below to write your verdict. No other tool calls, no exploration
  before or after. Decide, write, done.

## How to decide
- PASS if the trajectory shows the task's concrete goal was actually achieved:
  the required file/output exists with correct content, or the required command
  ran and succeeded — visible in a real tool result, not merely asserted.
- FAIL if the goal is missing, a required step errored and was never recovered,
  or success is only CLAIMED in a text/final message without a tool result that
  verifies it. Be SKEPTICAL of self-reported success: the session's own words
  are not evidence — only tool results are.
- If the trajectory clearly shows the goal met, PASS with high confidence — do
  not fail just because you couldn't independently re-verify (you're not
  allowed to).

## Task summary
${summary}

## Turn count
${turns}

## Trajectory (tool calls with args/output/errors, plus text/error events)
${trajSection}

## Write the verdict (your only action)

Write ONLY this JSON to the staging file — no markdown fences, no commentary,
nothing else in the file:

\`\`\`bash
cat > "${relStaging}" << 'ENDOFVERDICT'
{"passed":true,"confidence":0.0,"reasoning":"<=500 chars explaining the verdict"}
ENDOFVERDICT
\`\`\`

The JSON MUST have exactly these keys: "passed" (boolean), "confidence"
(number 0..1 — your confidence in the verdict), "reasoning" (string, <=500
chars). Replace the example values with your actual verdict; do not leave the
placeholders in place.`
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
