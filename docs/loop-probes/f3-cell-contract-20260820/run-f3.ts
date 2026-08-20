// F3 cell-contract probe — runner (pre-registration.md). Spends model calls:
// O2 x4 + O3 x4 = 8, on the shipped post-fix transport.
//
//   bun docs/loop-probes/f3-cell-contract-20260820/run-f3.ts cells [O2|O3]
//
// O1 needs no call — it is scored offline against the committed
// out-TRAP-r{1..4}.json cells by score-f3.ts.
import {
  auditPrompt,
  buildSample,
  parseVerdict,
  parseRevalBlock,
} from "../../../opencode-plugin/src/bench/convention-audit.ts"
import {
  ensureDaemon,
  daemonCall,
  closeSession,
  modelProvenBy,
} from "../../../opencode-plugin/node_modules/@th-yoo/cc-api-daemon/src/index.ts"
import { join } from "node:path"

const OUT = import.meta.dir
const REPO = join(OUT, "..", "..", "..")
const MODEL = process.env.PROBE_MODEL ?? "claude-sonnet-5"

const env = {
  ...process.env,
  KKAMAK_HOME: `${REPO}/.kkamak`,
  META_HARNESS_HOME: `${REPO}/.kkamak`,
  ACP_TURN_TIMEOUT_MS: "120000",
}
const CLIENT_BUDGET_MS = 150_000

const ISO = {
  systemPrompt: "", settingSources: [], settings: { autoMemoryEnabled: false },
  persistSession: false, strictMcpConfig: true, tools: [],
  title: "kkamak-lane-a-convention-audit", thinking: { type: "disabled" },
} as any

/** The shipped block spec, verbatim — the string both variants replace. */
const SHIPPED_TABLE =
  "| input | computed | canonical | discriminates |\n|---|---|---|---|\n" +
  "| <peak from the data> | <transform applied> | <known reference> | <misreading id> |\n" +
  "| <peak from the data> | <transform applied> | <known reference> | <misreading id> |"

/** O2 — split channels. Parser unchanged; the prompt sends the arithmetic to
 * prose above the block and makes the numeric contract explicit. */
const O2_TABLE =
  "| input | computed | canonical | discriminates |\n|---|---|---|---|\n" +
  "| <peak from the data> | <transform applied> | <known reference> | <misreading id> |\n" +
  "| <peak from the data> | <transform applied> | <known reference> | <misreading id> |\n" +
  "CELL CONTRACT — the block is READ BY A MACHINE, not by a person. Every cell in the first three columns must be a BARE DECIMAL NUMBER and nothing else: no units, no symbols, no ranges, no arithmetic, no arrows, no parentheses. Write `5811.9`, never `5811.9 (Å)`; write `1590.1`, never `1e7/532 - 1e7/581.19 = 1590.1`; write `1580`, never `1580-1590 cm^-1 (G band)`. If a reference is a range, pick the single number you are actually testing against. Show the arithmetic that produced each `computed` value in your prose ABOVE the block, where showing your work belongs — the inline-arithmetic rule applies THERE, and the block carries only the results."

/** O3 — derivation column. Both change: showing the work gets a home inside the
 * block, in a column the parser ignores. */
const O3_TABLE =
  "| input | computed | canonical | derivation | discriminates |\n|---|---|---|---|---|\n" +
  "| <peak from the data> | <transform applied> | <known reference> | <the arithmetic, shown> | <misreading id> |\n" +
  "| <peak from the data> | <transform applied> | <known reference> | <the arithmetic, shown> | <misreading id> |\n" +
  "CELL CONTRACT — `input`, `computed` and `canonical` must each be a BARE DECIMAL NUMBER and nothing else: no units, no symbols, no ranges, no arithmetic. Write `5811.9`, never `5811.9 (Å)`; write `1580`, never `1580-1590 cm^-1`. If a reference is a range, pick the single number you are actually testing against. The `derivation` column is where you SHOW the arithmetic that produced `computed` — the inline-arithmetic rule is satisfied there, in full, so the three numeric columns can stay machine-readable."

/** O4 — the combination: O3's derivation column + O2's bare-numeric contract +
 * the cross-check announced to the model. Tests whether declaring the check
 * fixes the constant inconsistency measured in O3 (2/4), or whether that
 * inconsistency is an F4 symptom the prompt cannot reach. */
const O4_TABLE =
  "| input | computed | canonical | derivation | discriminates |\n|---|---|---|---|---|\n" +
  "| <peak from the data> | <transform applied> | <known reference> | <the arithmetic, shown> | <misreading id> |\n" +
  "| <peak from the data> | <transform applied> | <known reference> | <the arithmetic, shown> | <misreading id> |\n" +
  "CELL CONTRACT — `input`, `computed` and `canonical` must each be a BARE DECIMAL NUMBER and nothing else: no units, no symbols, no ranges, no arithmetic. Write `5811.9`, never `5811.9 (\u00c5)`; write `1580`, never `1580-1590 cm^-1`. If a reference is a range, pick the single number you are actually testing against. The `derivation` column is where you SHOW the arithmetic that produced `computed`, in full, so the three numeric columns stay machine-readable.\n" +
  "CONSTANT CROSS-CHECK — the harness verifies MECHANICALLY that the number you wrote on the `CONSTANT:` line appears in EVERY row's `derivation`. Declare the ONE constant you actually divide or subtract with, and use that exact number in every derivation. If a row's derivation needs a different constant, then you do not have a single fixed constant and the claim is rejected — say so instead of declaring one constant and deriving with another."
const VARIANTS: Record<string, string> = { O2: O2_TABLE, O3: O3_TABLE, O4: O4_TABLE }

/** Reject the pre-registered contamination class before any spend. */
const CONTAMINANTS = /\bAUDIT\b|REFERENCE CARD|ORDERING GATE|MANDATORY|SURFACE\b|MISREADING|CONTENT VERDICT|canonical/i

async function cells(arm: string) {
  const table = VARIANTS[arm]
  if (!table) throw new Error(`unknown arm ${arm}`)
  const base = auditPrompt()
  if (!base.includes(SHIPPED_TABLE)) throw new Error("shipped table spec not found — prompt drifted, refusing to spend")
  const prompt = base.replace(SHIPPED_TABLE, table)

  const { text: sample, truncated } = buildSample({ tbRoot: `${REPO}/term-bench2/probe-tasks` } as any, "raman-peak-report")
  const hit = sample.match(CONTAMINANTS)
  if (hit) throw new Error(`stimulus contaminated (${JSON.stringify(hit[0])}) — refusing to spend`)

  for (let i = 1; i <= 4; i++) {
    const name = `${arm}-r${i}`
    let sid: string | undefined
    let verdict = ""
    let rawAudit = ""
    try {
      const o: any = await daemonCall(prompt + "\n\n" + sample, MODEL, env, { isolation: ISO, budgetMs: CLIENT_BUDGET_MS })
      if (o.kind !== "ok") verdict = `TRANSPORT:${o.kind}`
      else {
        sid = o.sessionId
        rawAudit = o.text ?? ""
        verdict = o.stopReason === "max_tokens" || !modelProvenBy(o.model, MODEL, o.canonicalModel)
          ? `TRANSPORT:unproven-or-truncated(${o.stopReason})`
          : parseVerdict(rawAudit)
      }
    } finally {
      if (sid) { try { await closeSession(sid, env) } catch { /* best effort */ } }
    }
    const strict = parseRevalBlock(rawAudit)
    await Bun.write(`${OUT}/out-${name}.json`, JSON.stringify(
      { cell: name, arm, task: "raman-peak-report", model: MODEL, verdict, strictBlock: strict.kind, sampleLen: sample.length, truncated, rawAudit }, null, 2))
    console.log(`${name}: verdict=${verdict} strictParse=${strict.kind} rawLen=${rawAudit.length}`)
  }
}

const mode = process.argv[2]
if (mode === "cells") {
  await ensureDaemon(env, { waitMs: 30_000 })
  await cells(process.argv[3] ?? "O2")
} else {
  console.error("usage: run-f3.ts cells [O2|O3]")
  process.exit(2)
}
