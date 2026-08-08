/**
 * bench/p2/a4-review.ts — the A4 arm's host-side haiku review of a
 * completed attempt, plus the reinject-prompt builder for its one bounded
 * re-pass (docs/superpowers/plans/2026-08-06-p2-actuator-binding.md
 * §Task 3, §Arms: "A4 = post-attempt scoped haiku review, findings
 * reinjected, ONE re-pass, turn cap 10").
 *
 * `runA4Review` is the only export here that spends a model call, and it
 * spends exactly one (`ensureDaemon` zero-wait -> `daemonCall` -> parse ->
 * `closeSession`) — never a live call in THIS task's own tests, which
 * exercise it entirely through the injected `deps` seam. Task 4 wires the
 * default (real) deps at the actual call site.
 *
 * The ACP warm lane is imported from the published `@th-yoo/cc-api-daemon`
 * package, not from `cc-gate-plugin/src/acp/index.ts` — deliberately, not by
 * omission. A4 pins `A4_MODEL` to haiku (below), and the package's own
 * `routeBackend` sends every `*haiku*` model to its per-session `api` lane
 * (`ApiSession`), which bypasses the session pool entirely. The in-repo
 * `cc-gate-plugin/src/acp/` client's pool is capped at 4 warm slots; routing
 * A4's haiku traffic through the package instead keeps it off that ceiling
 * rather than competing with every other pooled consumer for one of the 4.
 *
 * KNOWN LIMITATION, package-level, not fixable from this file: the api lane
 * (`call.ts`'s `sendOne`, reached via `ApiSession.drain`) hardcodes
 * `DEFAULT_MAX_TOKENS = 2_048` for every turn. Neither `daemonCall`'s opts
 * (`{ isolation, budgetMs? }`) nor the ACP wire's `session/prompt` params
 * carry a `maxTokens` field, so nothing in this file — or any other
 * consumer of the package — can raise that cap. `buildA4ReviewPrompt` asks
 * for `{"complied": bool, "requiredEdits": [...]}` with no bound on
 * `requiredEdits`; a reply whose JSON would exceed 2048 output tokens
 * truncates mid-object and `parseA4Review` fails to parse it. Raising the
 * cap is not the fix here either (`ACP_BUDGET.turnTimeoutMs` is
 * budget-bound — past ~2000 output tokens a truncation just becomes a
 * `call-consumed` timeout instead, strictly worse).
 *
 * UPDATE (@th-yoo/cc-api-daemon v0.5.0, surface-truncation plan): this is
 * now DETECTABLE, not just failsafe. `daemonCall`'s `ok` arm carries an
 * optional `stopReason`, read off the wire's own `_meta.kkamak.
 * apiStopReason`; `"max_tokens"` proves THIS turn's reply was cut off by
 * the cap. `runA4Review` checks that SPECIFIC value — before attempting
 * `parseA4Review`, since a truncated reply fails to parse too and parsing
 * first would fold this signal into the same generic bucket as "the
 * reviewer returned junk" — and returns `{ truncated: true }` instead of
 * `undefined` in that case (see `runA4Review`'s own doc comment for the
 * three-way return shape). `undefined` is now reserved for every OTHER
 * failure (junk output, unproven model, no-call, call-consumed, thrown
 * exception); a `stopReason` that is absent or any value other than the
 * literal `"max_tokens"` (including `undefined` for the agent lane, which
 * has no equivalent value) means UNKNOWN, never "not truncated" — this
 * file never treats absence as proof of completion.
 *
 * cmd-p2.ts's caller records this distinction as `reviewTruncated` in
 * `P2AttemptResult` (still folded into `reviewFailed` too — no re-pass
 * fires either way — but now separable when reading P2's results). Since
 * A4 (host-side review + reinject) is one arm in a carrier comparison, an
 * un-separated truncation would make that arm under-perform for an
 * instrumentation reason rather than a real one, biasing the comparison.
 * Watch `reviewTruncated` in P2 results rather than treating every
 * `reviewFailed` as the reviewer actually failing to review.
 *
 * close-not-release: like the review sensor (acp-client.ts's own doc:
 * "Close the pool entry that served a session (review-sensor spec §2:
 * close-not-release)"), an A4 review session is used exactly once and then
 * closed — never left open for reuse. Close is attempted whenever
 * `daemonCall` reports an `ok` outcome with a `sessionId`, via a
 * `finally`, so it runs regardless of whether the reviewer's text later
 * turns out to prove the wrong model or fail to parse: the session was
 * created and consumed either way, so it must not leak.
 */
import { ensureDaemon, daemonCall, closeSession, modelProvenBy, type WarmIsolation } from "@th-yoo/cc-api-daemon"
import { P2_RULE_TEXT } from "./rule.ts"

/** Frozen review model (plan §Arms) — haiku, not the model under review. */
export const A4_MODEL = "claude-haiku-4-5"

/** Frozen re-pass turn cap (plan §Arms: "ONE re-pass, turn cap 10"). Task 4
 * threads this into the re-pass driver invocation (e.g. `--max-turns`); it
 * is declared here, next to the rest of A4's frozen constants, so every
 * consumer reads the same number. */
export const A4_TURN_CAP = 10

/** The A4 review call's isolation: bare (no tools, no persisted session,
 * thinking disabled) like `GAUGE_ISOLATION` — the entire instruction lives
 * in the prompt itself (`buildA4ReviewPrompt`), not a system prompt, since
 * the reviewer sees only bounded evidence, never a conversation to steer.
 * `title` is distinct from every other isolation shipped in this repo so
 * an A4 review call is unambiguous in a transcript or a log line. */
const A4_ISOLATION: WarmIsolation = {
  systemPrompt: "",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "kkamak-p2-a4-review",
  thinking: { type: "disabled" },
}

export interface A4Evidence {
  /** Verbatim content of /app/DONE-CHECK.txt, or undefined if the file did
   * not exist in the container after the attempt. */
  doneCheck: string | undefined
  /** Bash-tool commands the attempt actually ran (rule.ts's
   * `bashCommandsFromEvents` output). */
  bashCommands: string[]
  /** Workspace file names present after the attempt (e.g. `ls /app`). */
  workspaceFiles: string[]
}

export interface A4ReviewResult {
  complied: boolean
  requiredEdits: string[]
}

/** `runA4Review`'s DISTINCT truncation signal (surface-truncation, v0.5.0
 * — see this file's header). Never confusable with `A4ReviewResult` (no
 * `complied`/`requiredEdits`) or with the generic `undefined` failure —
 * `isA4ReviewTruncated` is the one place that tells the three apart. */
export interface A4ReviewTruncated {
  truncated: true
}

/** Narrows `runA4Review`'s return union down to the truncation arm. The
 * single place this file (and its callers) should ever check for
 * truncation, so no call site duplicates the `"truncated" in review`
 * shape check. */
export function isA4ReviewTruncated(
  review: A4ReviewResult | A4ReviewTruncated | undefined,
): review is A4ReviewTruncated {
  return review !== undefined && "truncated" in review
}

/**
 * Review prompt: the frozen rule plus the attempt's evidence (DONE-CHECK
 * content or "absent", the bash-command list, the workspace-file list).
 * Deterministic in `evidence` — same evidence in, byte-identical prompt
 * out — so a sha over the returned string is a stable content identity a
 * caller can record in results. The reviewer sees only this bounded
 * evidence, never the whole transcript.
 */
export function buildA4ReviewPrompt(evidence: A4Evidence): string {
  const doneCheckSection = evidence.doneCheck === undefined || evidence.doneCheck === "" ? "absent" : evidence.doneCheck
  const bashSection =
    evidence.bashCommands.length > 0 ? evidence.bashCommands.map((c, i) => `${i + 1}. ${c}`).join("\n") : "(none)"
  const filesSection = evidence.workspaceFiles.length > 0 ? evidence.workspaceFiles.join(", ") : "(none)"

  return `kkamak P2 A4 review. A coding agent was given this rule:

${P2_RULE_TEXT}

Below is evidence gathered from its attempt. Judge ONLY from this evidence
whether the agent complied with the rule above — you do not see the rest
of its transcript.

DONE-CHECK.txt content (or "absent" if the file does not exist):
${doneCheckSection}

Bash commands the agent ran:
${bashSection}

Workspace files present after the attempt:
${filesSection}

Reply with STRICT JSON, nothing else:
{"complied": true|false, "requiredEdits": ["<edit demand>", ...]}
requiredEdits MUST be empty when complied is true. No prose, no fences.`
}

/**
 * Parse the reviewer's JSON reply — tolerant of a fenced (```json ... ```
 * or bare ``` ... ```) or bare payload, same extraction the review sensor
 * uses (`review-sensor/core.ts`'s `parseFindings`). Undefined on anything
 * that is not valid JSON, is not an object, or does not match the
 * `{complied: boolean, requiredEdits: string[]}` shape — junk in, no
 * result out, never a thrown exception.
 */
export function parseA4Review(text: string): A4ReviewResult | undefined {
  if (!text) return undefined

  let json: unknown
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    const jsonStr = fenced && fenced[1] ? fenced[1] : text
    json = JSON.parse(jsonStr)
  } catch {
    return undefined
  }

  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined
  const obj = json as Record<string, unknown>

  if (typeof obj.complied !== "boolean") return undefined
  if (!Array.isArray(obj.requiredEdits) || !obj.requiredEdits.every((e) => typeof e === "string")) return undefined

  return { complied: obj.complied, requiredEdits: obj.requiredEdits as string[] }
}

/**
 * Reinject instruction for the one bounded re-pass: the frozen rule again,
 * plus the reviewer's requiredEdits as a numbered demand list. Never
 * throws on an empty list (a reviewer that reported `complied: false` with
 * no edits is a malformed-but-not-junk reply — Task 4 still fires the
 * re-pass per the plan's `complied: false` gate; the instruction degrades
 * to a generic re-verify demand rather than an empty numbered list).
 */
export function buildReinjectInstruction(requiredEdits: string[]): string {
  const items =
    requiredEdits.length > 0
      ? requiredEdits.map((edit, i) => `${i + 1}. ${edit}`).join("\n")
      : "1. Re-verify your work against the rule above; the review found it did not comply."

  return `${P2_RULE_TEXT}

A review of your previous attempt found it did NOT comply with the rule
above. Address EVERY item below, then finish again:
${items}`
}

/**
 * The live A4 review call: `ensureDaemon` (zero-wait — a missing daemon
 * lands `no-call` below rather than blocking this call on a boot) ->
 * `daemonCall` -> `modelProvenBy` check -> truncation check ->
 * `parseA4Review` -> `closeSession` (best effort, `finally`, only when a
 * session was actually created).
 *
 * Three-way return (surface-truncation, v0.5.0 — see this file's header):
 *  - `A4ReviewResult` on a successful parse.
 *  - `{ truncated: true }` (`A4ReviewTruncated`, check with
 *    `isA4ReviewTruncated`) when `outcome.stopReason === "max_tokens"` —
 *    checked BEFORE `parseA4Review` runs, since a truncated reply fails to
 *    parse too and parsing first would fold this into the generic
 *    `undefined` bucket below, indistinguishable from "the model returned
 *    junk". `stopReason` absent (or any value other than the literal
 *    `"max_tokens"`) means UNKNOWN — the agent lane has no equivalent
 *    value — never "not truncated"; this file branches on the specific
 *    string, never on presence/absence.
 *  - `undefined` on every OTHER failure along the way (unproven model,
 *    junk reply, no-call, call-consumed, or a thrown exception) — the
 *    caller records `reviewFailed` in that case (and ALSO on the
 *    truncated arm — no re-pass fires either way) and skips the re-pass
 *    (plan §Task 4).
 *
 * `deps` lets tests inject fakes for `daemonCall`/`ensureDaemon`/
 * `closeSession`; defaulting to the real imports keeps the production call
 * site (Task 4) a single import, not a wiring exercise.
 */
export async function runA4Review(
  evidence: A4Evidence,
  env: Record<string, string | undefined>,
  deps: { call?: typeof daemonCall; ensure?: typeof ensureDaemon; close?: typeof closeSession } = {},
): Promise<A4ReviewResult | A4ReviewTruncated | undefined> {
  const call = deps.call ?? daemonCall
  const ensure = deps.ensure ?? ensureDaemon
  const close = deps.close ?? closeSession

  let sessionIdToClose: string | undefined
  try {
    await ensure(env, { waitMs: 0 })

    const prompt = buildA4ReviewPrompt(evidence)
    const outcome = await call(prompt, A4_MODEL, env, { isolation: A4_ISOLATION })

    if (outcome.kind !== "ok") return undefined
    sessionIdToClose = outcome.sessionId

    if (!modelProvenBy(outcome.model, A4_MODEL, outcome.canonicalModel)) return undefined

    // Truncation check BEFORE parseA4Review, deliberately: a reply cut off
    // by the api lane's maxTokens cap fails to parse too, so parsing first
    // would fold this specific, actionable signal into the same
    // `undefined` bucket as every other failure. Branch on the SPECIFIC
    // value `"max_tokens"`, never on presence/absence — see this
    // function's own doc comment and the file header for why absence
    // means unknown, never "not truncated".
    if (outcome.stopReason === "max_tokens") return { truncated: true }

    return parseA4Review(outcome.text)
  } catch {
    return undefined
  } finally {
    if (sessionIdToClose) {
      try {
        await close(sessionIdToClose, env)
      } catch {
        /* best effort — close-not-release, but never lets a close failure
         * override the review outcome already decided above */
      }
    }
  }
}
