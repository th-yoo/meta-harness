// Revalidation wire-format adherence probe — runner (pre-registration.md +
// amendment-01.md). Spends model calls: transport pre-step (1 throwaway) then
// TRAP x4 + CTRL x2 through the SHIPPED audit path (runAuditUncached ->
// daemonCall under AUDIT_ISOLATION, sonnet-5, toolless).
//
//   bun docs/loop-probes/reval-adherence-20260819/run-probe.ts [prestep|cells]
//
// RELATIVE imports, never host-absolute: this repo runs on more than one machine
// and travels by git alone. The specifiers are relative because this file lives
// outside opencode-plugin/, so bare package names would not resolve from here.
import {
  runAuditUncached,
  auditPrompt,
  buildSample,
  parseVerdict,
  cardFrom,
  parseRevalBlock,
  revalidate,
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
// FINDING F2: the shipped audit passes DEFAULT_BENCH_MODEL = "anthropic/claude-sonnet-5"
// (an opencode provider-qualified id) VERBATIM to the ACP wire. The proven live
// caller on this transport (a4-review.ts) uses a BARE CLI id ("claude-haiku-4-5");
// the prefixed form comes back terminal_reason=api_error. Overridable for the
// A/B that establishes this.
const MODEL = process.env.PROBE_MODEL ?? "claude-sonnet-5"

// KKAMAK_HOME + META_HARNESS_HOME are EXPLICIT, never inherited from the tmux
// server env (3rd env-inheritance trap, recorded in resume.md).
const env = {
  ...process.env,
  KKAMAK_HOME: `${REPO}/.kkamak`,
  META_HARNESS_HOME: `${REPO}/.kkamak`,
  ACP_TURN_TIMEOUT_MS: "120000",
}

// TRANSPORT DEFECT WORKAROUND (finding F1, see verdict.md). The shipped
// `runAuditUncached` sets ACP_TURN_TIMEOUT_MS=120000 in the daemon env, which
// makes the daemon advertise daemonWorstCaseMs = 32000-16000+120000 = 136000,
// while `daemonCall`'s client budget defaults to ACP_BUDGET.clientBudgetMs =
// 36000. acp-client.ts:266 refuses pre-send when `dw >= budgetMs` → a silent,
// zero-spend `no-call` on EVERY live audit call. The probe passes an explicit
// client budget that honors the `clientBudgetMs > daemonWorstCaseMs` contract
// so it can measure PROMPT adherence rather than re-measuring the defect.
const CLIENT_BUDGET_MS = 150_000

const ISO = {
  systemPrompt: "",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "kkamak-reval-adherence-prestep",
  thinking: { type: "disabled" },
} as any

/** D3: `daemonCall` cannot report a 429, so a non-ok outcome is transport-
 * ambiguous. One throwaway call first — abort at ZERO measured cells if the
 * lane is not live. */
async function prestep(): Promise<boolean> {
  const up = await ensureDaemon(env, { waitMs: 30_000 })
  console.log(`daemon up=${up}`)
  const o: any = await daemonCall("Reply with exactly: OK", MODEL, env, { isolation: ISO, budgetMs: CLIENT_BUDGET_MS })
  const proven = o.kind === "ok" ? modelProvenBy(o.model, MODEL, o.canonicalModel) : false
  console.log(`prestep kind=${o.kind} stop=${o.stopReason} model=${o.model} proven=${proven}`)
  console.log(`prestep text=${JSON.stringify((o.text ?? o.error ?? "").toString().slice(0, 300))}`)
  if (o.sessionId) { try { await closeSession(o.sessionId, env) } catch { /* best effort */ } }
  return o.kind === "ok" && proven
}

const CELLS: { tag: string; tbRoot: string; task: string; k: number }[] = [
  // raman-peak-report, NOT raman-fitting-gate: the gate task's instruction.md
  // embeds a full prior audit under an "ORDERING GATE — MANDATORY" directive
  // block, which hijacked the auditor (it executed the gate's numbered steps
  // instead of auditing). Those 4 cells are VOID, kept as out-VOID-gatetask-r*.
  { tag: "TRAP", tbRoot: `${REPO}/term-bench2/probe-tasks`, task: "raman-peak-report", k: 4 },
  { tag: "CTRL", tbRoot: `${REPO}/opencode-plugin/test/fixtures/conv-audit`, task: "clean", k: 2 },
]

/** The stimulus guard the VOID cells cost. A sample carrying audit prose or
 * imperative directives is not a clean stimulus — assert SEMANTICALLY, never
 * by one literal header string (the miss that voided 4 cells: the check
 * grepped "REFERENCE CARD", the task said "AUDIT:"). Throws BEFORE any spend. */
const CONTAMINANTS =
  /\bAUDIT\b|REFERENCE CARD|ORDERING GATE|MANDATORY|SURFACE\b|MISREADING|CONTENT VERDICT|canonical/i
function assertCleanStimulus(tag: string, sample: string): void {
  const hit = sample.match(CONTAMINANTS)
  if (hit) throw new Error(`stimulus ${tag} is contaminated (matched ${JSON.stringify(hit[0])}) — refusing to spend`)
}

/** The shipped audit isolation, field-for-field (convention-audit.ts's
 * AUDIT_ISOLATION), including its production `title`. */
const AUDIT_ISO = { ...ISO, title: "kkamak-lane-a-convention-audit" }

/** The shipped `runAuditUncached` pipeline re-expressed with F1 (client budget)
 * and F2 (bare model id) corrected, and NOTHING else changed: same
 * `buildSample`, same `auditPrompt()`, same isolation, same
 * parseVerdict/parseRevalBlock/revalidate/cardFrom. What the model sees is
 * byte-identical to production, so the FORMAT/CONTENT rungs measure the
 * prompt — not the two transport defects, which are reported separately and
 * whose fix lands exactly on this configuration. */
async function cells(only?: string) {
  for (const c of CELLS) {
    if (only && c.tag !== only) continue
    const { text: sample, truncated } = buildSample({ tbRoot: c.tbRoot } as any, c.task)
    assertCleanStimulus(c.tag, sample)
    for (let i = 1; i <= c.k; i++) {
      const name = `${c.tag}-r${i}`
      let sid: string | undefined
      let verdict: string
      let rawAudit = ""
      try {
        const o: any = await daemonCall(auditPrompt() + "\n\n" + sample, MODEL, env, {
          isolation: AUDIT_ISO,
          budgetMs: CLIENT_BUDGET_MS,
        })
        if (o.kind !== "ok") {
          verdict = `TRANSPORT:${o.kind}`
        } else {
          sid = o.sessionId
          rawAudit = o.text ?? ""
          verdict =
            o.stopReason === "max_tokens" || !modelProvenBy(o.model, MODEL, o.canonicalModel)
              ? `TRANSPORT:unproven-or-truncated(${o.stopReason})`
              : parseVerdict(rawAudit)
        }
      } finally {
        if (sid) { try { await closeSession(sid, env) } catch { /* best effort */ } }
      }

      const parsed = parseRevalBlock(rawAudit)
      const reval =
        parsed.kind === "claim" ? revalidate(parsed.claim, sample) : { ok: false, reason: `block-${parsed.kind}` }
      const rec = {
        cell: name,
        task: c.task,
        promptVersion: "lane-a-v3",
        model: MODEL,
        verdict,
        block: parsed.kind,
        claim: parsed.kind === "claim" ? parsed.claim : null,
        reval: reval.ok ? "PASS" : `FAIL:${(reval as any).reason}`,
        cardLen: verdict === "MISMATCH" ? cardFrom(rawAudit).length : 0,
        sampleLen: sample.length,
        truncated,
        rawAudit,
      }
      await Bun.write(`${OUT}/out-${name}.json`, JSON.stringify(rec, null, 2))
      console.log(`${name}: verdict=${rec.verdict} block=${rec.block} reval=${rec.reval} rawLen=${rawAudit.length}`)
    }
  }
}

/** Live end-to-end verification of the F1+F2 fixes through the SHIPPED path.
 *
 * Deliberately calls `runAuditUncached` itself with NO overrides — no
 * `budgetMs`, no model, no `ACP_TURN_TIMEOUT_MS` — so the shipped defaults are
 * what gets exercised. Before the fixes this returned `verdict: "ERROR"` with an
 * empty `rawAudit` and zero spend; the whole point of the probe's findings was
 * that tests could not tell that apart from a working call. One call, on the
 * smallest clean fixture. */
async function verify(): Promise<boolean> {
  const up = await ensureDaemon(env, { waitMs: 30_000 })
  console.log(`daemon up=${up}`)
  const verifyEnv = { ...process.env, KKAMAK_HOME: `${REPO}/.kkamak`, META_HARNESS_HOME: `${REPO}/.kkamak` }
  const r = await runAuditUncached({ tbRoot: `${REPO}/opencode-plugin/test/fixtures/conv-audit` } as any, "clean", verifyEnv)
  const ok = r.verdict !== "ERROR" && r.rawAudit.length > 0
  console.log(`verdict=${r.verdict} rawLen=${r.rawAudit.length} card=${r.card === null ? "null" : r.card.length} truncated=${r.truncated}`)
  console.log(`first line: ${JSON.stringify(r.rawAudit.split("\n").find((l) => l.trim()) ?? "")}`)
  console.log(ok ? "LIVE VERIFY: PASS — the shipped path reached the model" : "LIVE VERIFY: FAIL — still no live call")
  return ok
}

const mode = process.argv[2] ?? "prestep"
if (mode === "prestep") {
  process.exit((await prestep()) ? 0 : 1)
} else if (mode === "cells") {
  await cells(process.argv[3])
} else if (mode === "verify") {
  process.exit((await verify()) ? 0 : 1)
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}
