import { test, expect } from "bun:test"
import * as fs from "node:fs"; import * as path from "node:path"; import * as os from "node:os"
import { exportRuleChecks } from "../src/rule-checks-export.ts"
import { exportHookRules } from "../src/hook-rules-export.ts"
import { recordToStores } from "../src/bench/record.ts"
import { parseRevalBlock, revalidate, type RevalClaim } from "../src/bench/convention-audit.ts"

// KNOWN-HOLE(MH-1) — census: docs/loop-probes/debt-instrument-20260822/census.md.
// Single-layer exporters are last-writer-wins: a transition on a layer with no
// checks/rules (project-global here) wipes the .km tables another layer
// (mh-build) just populated. Unskip when exports become union-across-layers or
// otherwise clobber-safe; this test then pins the fix.
test.skip("KNOWN-HOLE(MH-1): project-global export preserves another layer's .km tables", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mh-hole-mh1-"))
  const mkStore = (bullets: unknown[]) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-hole-mh1-store-"))
    fs.mkdirSync(path.join(root, "active"), { recursive: true })
    fs.writeFileSync(path.join(root, "active", "playbook.json"),
      JSON.stringify({ schemaVersion: 1, nextId: 99, bullets }))
    return root
  }
  const mhBuild = mkStore([{ id: "b1", text: "When X, do Y.", helpful: 0, harmful: 0,
    addedBy: "v1", status: "active", createdAt: "2026-08-22T00:00:00Z",
    check: { cmd: "true", timeoutMs: 1000, state: "shadow", liveEligible: true } }])
  const pg = mkStore([]) // project-global: no checks, no rules — the wiping layer
  exportRuleChecks(repo, mhBuild)
  const before = JSON.parse(fs.readFileSync(path.join(repo, ".km", "rule-checks.json"), "utf8"))
  expect(before.rules).toHaveLength(1)
  // the transition event on the other layer:
  exportRuleChecks(repo, pg)
  exportHookRules(repo, pg)
  const after = JSON.parse(fs.readFileSync(path.join(repo, ".km", "rule-checks.json"), "utf8"))
  expect(after.rules).toHaveLength(1) // DESIRED: mh-build's check survives
})

// Recursively finds every *.ndjson file under any "traj" directory below `root`.
function findTrajFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
      } else if (e.isFile() && dir.endsWith(`${path.sep}traj`) && e.name.endsWith(".ndjson")) {
        found.push(p)
      }
    }
  }
  walk(root)
  return found
}

// KNOWN-HOLE(MH-3) — census row MH-3; measured 2026-08-20 (resume.md warning
// block): layers="none" makes layerStoreRoots return [], so the traj write
// inside the store loop never executes — --save-all-traj silently no-ops and
// mechanism evidence is unrecoverable. Unskip when record.ts persists
// trajectories independently of layer stores (or refuses the combination
// loudly); this test then pins the fix.
test.skip("KNOWN-HOLE(MH-3): layers=none with saveAllTraj still persists the trajectory somewhere", () => {
  const metaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mh-hole-mh3-"))
  const events = [{ t: "text" as const, text: "hi" }]

  let threwLoudly = false
  try {
    recordToStores("t", "sess-mh3", true, 2, {}, "m", "", "none", metaRoot, false, "", {}, {}, events, true)
  } catch {
    threwLoudly = true
  }

  // At unskip, tighten threwLoudly to a refusal-shaped error (e.g.
  // /layers|traj/i.test(String(e))) — a bare catch means ANY future
  // recordToStores signature drift turns this marker green without the hole
  // being fixed.

  const trajFilesFound = findTrajFiles(metaRoot).length
  expect(trajFilesFound > 0 || threwLoudly).toBe(true)
})

// KNOWN-HOLE(MH-21) — F3 2026-08-20: prompt-conformant cells carry
// units/derivations; parser demands bare numerics. Unskip when prompt and
// parser agree on one cell grammar.
//
// Two valid resolutions: (a) the parser learns to accept a derivation
// column — this cell then parses, unskip as-is; (b) O3's derivation-column
// shape is retired for good (O2 = the shipped fix per f3 verdict.md) — the
// contradiction is then moot: do NOT unskip; delete or re-point this marker
// recording why.
//
// Cell quoted VERBATIM (via `rawAudit`) from
// docs/loop-probes/f3-cell-contract-20260820/out-O3-r2.json — one of the "4
// UNPARSED cells" the probe's verdict.md documents: `O3 emits five columns;
// parseRevalBlock requires exactly four, so the shipped parser rejects it by
// construction.` The O3 prompt is the one that told the model to show its
// derivation (with units, e.g. "nm^-1") in its own column — this cell is
// fully conformant to that prompt, and the parser still rejects it.
test.skip("KNOWN-HOLE(MH-21): a prompt-conformant derivation cell parses instead of going malformed", () => {
  const recordedCell = "REVALIDATION:\nTRANSFORM: reciprocal\nCONSTANT: 5320000\nDELTA: 5\n| input | computed | canonical | derivation | discriminates |\n|---|---|---|---|---|\n| 5808.6 | 1580.4 | 1580 | 1/532 - 1/580.86 = 0.00187970 - 0.00172170 = 0.00015800 nm^-1; x1e7 = 1580.0 | MisreadingA_rawÅasCM1_falsified |\n| 6212.3 | 2699.9 | 2700 | 1/532 - 1/621.23 = 0.00187970 - 0.00160970 = 0.00027000 nm^-1; x1e7 = 2700.0 | MisreadingB_treatAsNM_falsified |"

  const parsed = parseRevalBlock(recordedCell)

  // DESIRED: the prompt told the model to emit exactly this shape (a
  // derivation column carrying its own units); the parser should read it as
  // a claim, not reject it as malformed.
  //
  // At unskip (branch a), tighten to a round-trip: landings[0] should be
  // {input: 5808.6, computed: 1580.4, canonical: 1580} — the
  // discriminant-only assert would pass a column-mis-mapping parser.
  expect(parsed.kind).toBe("claim")
})

// KNOWN-HOLE(MH-24) — F6 2026-08-19
// (docs/loop-probes/reval-adherence-20260819/verdict.md): `revalidate`'s only
// input check is the range guard (`L.input < lo || L.input > hi`); it never
// compares a landing's input against the sample's head/tail rows, so a
// fabricated input inside the range but absent from what the sample actually
// shows sails through. F5 names the fabricated inputs verbatim: "Cited
// landing inputs 5811.9 / 5808.3 / 5808.5 / 6212.3 / 6204.6 are absent from
// the sample ... The sample is head-20 + tail-20 of a 1500-row file spanning
// 5800–7100 — the peak is in the middle, which the sample never shows". F6:
// "The fabricated inputs sit inside first-col-range=[5800, 7100], so the
// range guard passes them; they are *not* in the head/tail rows the sample
// shows. The un-built hardening item (b) — head/tail near-match on `input` —
// would have caught 3/4 of these." Spec §10's "implement or accept" choice
// resolves to implement. Unskip when head/tail near-match lands; this is its
// acceptance test.
//
// The landing pair below is quoted VERBATIM (via `rawAudit`) from
// `docs/loop-probes/f3-cell-contract-20260820/out-O2-r1.json` — the O2
// bare-numeric-cell arm run against the SAME stimulus (`raman-peak-report`),
// the one fully-parseable recorded instance of these fabricated inputs (the
// shipped-prompt cells that produced them are prose-derivation cells that
// parse as `malformed`, per MH-21/F3):
// `| 5808.5 | 1580.0 | 1580.0 | MisreadingA |` / `| 5811.9 | 1568.8 | 1580.0 |
// MisreadingB |`. TRANSFORM/CONSTANT here are test scaffolding, NOT quoted:
// the model's own recorded transform (`reciprocal`, `CONSTANT: 532`, per
// out-O2-r1.json) is real two-op physics that `applyTransform`'s single-op
// whitelist cannot land (that gap is the separate F4 hole) — `offset` with a
// constant fitted to landing 1 is used only so both quoted inputs reach
// `revalidate`'s landed-count branch, isolating the ONE guard this marker is
// about.
test.skip("KNOWN-HOLE(MH-24): revalidate rejects a landing whose input is absent from the sample's head/tail", () => {
  // Real head-20 / tail-20 lines, byte-identical to
  // term-bench2/probe-tasks/raman-peak-report/environment/task-deps/graphene.dat
  // (1500 rows, 5800.000000..7100.000000) — the actual stimulus `buildSample`
  // samples in production, and the file the fabricated inputs below were
  // fabricated against (F5/F6). Neither 5808.5 nor 5811.9 appears in either
  // window.
  const head = [
    "5800.000000\t5591.994975",
    "5800.867245\t5591.681351",
    "5801.734490\t5592.724343",
    "5802.601734\t5605.043619",
    "5803.468979\t5592.720429",
    "5804.336224\t5572.294956",
    "5805.203469\t5599.861654",
    "5806.070714\t5590.989060",
    "5806.937959\t5591.867611",
    "5807.805203\t5596.983762",
    "5808.672448\t5598.854089",
    "5809.539693\t5612.947774",
    "5810.406938\t5605.469356",
    "5811.274183\t5597.403477",
    "5812.141428\t5584.797758",
    "5813.008672\t5580.780016",
    "5813.875917\t5599.823113",
    "5814.743162\t5615.922887",
    "5815.610407\t5597.010891",
    "5816.477652\t5594.921226",
  ].join("\n")
  const tail = [
    "7083.522348\t5572.505255",
    "7084.389593\t5581.403199",
    "7085.256838\t5604.403201",
    "7086.124083\t5595.663024",
    "7086.991328\t5577.895013",
    "7087.858572\t5604.037467",
    "7088.725817\t5564.359884",
    "7089.593062\t5595.107820",
    "7090.460307\t5582.155817",
    "7091.327552\t5588.281204",
    "7092.194797\t5594.265416",
    "7093.062041\t5574.447166",
    "7093.929286\t5596.610626",
    "7094.796531\t5584.406223",
    "7095.663776\t5620.675629",
    "7096.531021\t5579.887655",
    "7097.398266\t5603.442272",
    "7098.265510\t5594.064237",
    "7099.132755\t5566.699366",
    "7100.000000\t5604.674129",
  ].join("\n")
  const sample = `lines=1500 top-tokens: (elided) first-col-range=[5800, 7100]\n--head--\n${head}\n--tail--\n${tail}`

  // input/canonical/discriminates quoted verbatim from out-O2-r1.json above.
  const claim: RevalClaim = {
    transform: "offset",
    constant: 7388.5, // scaffolding only — see comment block above
    delta: 5,
    landings: [
      { input: 5808.5, computed: 1580.0, canonical: 1580.0, discriminates: "MisreadingA" },
      { input: 5811.9, computed: 1568.8, canonical: 1580.0, discriminates: "MisreadingB" },
    ],
  }

  const outcome = revalidate(claim, sample)

  // DESIRED: a landing whose input is nowhere in the sample's head/tail
  // window should be rejected regardless of range-guard membership. Currently
  // ACCEPTS — the range guard is the only input check `revalidate` runs.
  //
  // At unskip, assert the rejection reason IS the head/tail guard (e.g.
  // reason matches /head|tail|sample/i) — revalidate already has six
  // rejection reasons and any NEW unrelated guard would otherwise green this
  // marker without near-match existing.
  expect(outcome.ok).toBe(false)
})
