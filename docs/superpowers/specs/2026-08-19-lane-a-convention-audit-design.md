# Lane A — convention-audit staging step (design)

**Status:** design, approved-in-chat 2026-08-19; increment-1 scope. Architectural.
**Evidence base:** the representation-trap arc (`docs/loop-probes/rep-audit-20260819/`,
`docs/loop-probes/census-20260819/`, `docs/loop-probes/census-e2e-20260819/`) and the
attack plan (`docs/2026-08-19-raman-attack.md` §4/§7). Decisions this spec encodes are
measured, not assumed — see "Grounding" below.

## 1. Purpose

Make an agent read the right representation convention (units, endianness, script,
address-base, extraction-scope, dialect) on tasks where mis-reading the convention is the
binding failure. A per-task **convention card** is generated at staging by an executing-tier
audit call and injected into the task instruction. This is a **task-level capability**, not a
proposer/playbook lesson: the card helps every arm equally and is byte-identical across A/B
arms, so it never contaminates the gate (same discipline as `agent-run.ts`'s `budgetLine`).

Ships behind a flag, **OFF by default** (the `review-sensor` ship-off precedent). First use is
measured (board lift, audit-on vs audit-off on representation-trap tasks), never silently armed.

## 2. Grounding (measured facts this design rests on)

- **Injection seam:** `agent-run.ts:147-167` reads `instruction.md`, then appends `budgetLine`
  — a CONTROLLED per-task constant kept OUT of the evolvable harness precisely so it cannot
  become an A/B lever. The card appends in the same place under the same discipline.
- **Detector generalizes** (census 2/2: toolpath-geometry, ELF format) and the
  **instruction-criteria clause** was validated end-to-end (elf-v3 PASS 2/2 → elf card arm
  5/5 vs 2/5, mechanism 5/5).
- **Content-gate is sound** (clean batch 12/12: 0 false positives on clean input incl. a
  domain-matched decoy; 4/4 trapped fire).
- **Auditor tier:** sonnet attributes; haiku detects-but-cannot-attribute → the audit call is
  sonnet, hardcoded.
- **Imperative rule (hedge-harvest law):** weak-tier consumers harvest a card's hedge as
  permission (gcode 4/5 shipped a decoy citing the card's "can't rule out"). Cards must phrase
  uncertainty as MANDATORY disambiguation, never open possibility. Folded into the audit prompt.
- **Leak-safety:** the auditor consumes `instruction.md` + task input files + world knowledge
  ONLY. Never `tests/`, `solution/`, expected outputs. Scope conventions are derivable from the
  instruction's own stated success criteria (elf case) — no reference access needed.

## 3. Architecture

One module, `opencode-plugin/src/bench/convention-audit.ts`, one entry point:

```
auditCard(paths: BenchPaths, task: string, opts): Promise<AuditResult>
  AuditResult = { card: string; rawAudit: string; verdict: "MISMATCH" }
              | { card: null; rawAudit: string; verdict: "NO_MISMATCH" | "ERROR" }
```

Pipeline (each a small internal fn, independently testable):

1. **sampler** `buildSample(paths, task) → string` — leak-safe. Reads `instruction.md` and the
   task's input files (Dockerfile-declared `COPY` sources under `<task>/environment/`, resolved
   the way `staging.ts` already parses them). Emits: instruction verbatim + a deterministic
   mechanical summary per input file (size, and for text: line count, a command/token histogram,
   column/coordinate ranges; for binary: `file`/`readelf`-style structural summary) + a
   head/tail excerpt. NEVER enumerates or reads `tests/`, `solution/`, `*.json` expected
   outputs. A guard rejects any path outside the allowlisted roots.
2. **auditCall** `runAudit(sample) → string` — headless `claude -p --model <SONNET>
   --output-format json`, mirroring the existing host-side call pattern
   (`adapters/claude-code/proposer-worker.ts`, `cc-host.ts`). Prompt = the frozen lane-A audit
   prompt (§4). Bounded timeout; a failed/empty call → `verdict: ERROR`, `card: null` (fail-safe:
   no injection, run proceeds exactly as audit-off).
3. **contentGate** `parseVerdict(raw) → "MISMATCH" | "NO_MISMATCH"` — reads the prompt's
   machine line `CONTENT VERDICT: {MISMATCH|NO MISMATCH}`. NO_MISMATCH (or unparseable) →
   `card: null` (quiet-on-clean).
4. **extractCard** `cardFrom(raw) → string` — the injectable card body (the audit's SURFACE +
   CONTENT + prescription, imperative by construction of the prompt). Returned verbatim; no
   host-side rewriting (verbatim discipline — hand edits void the end-to-end claim).

## 4. The frozen audit prompt (lane-A v1)

The `census-e2e` generator-prompt + compute clause + the instruction-criteria clause
(elf-v3, validated) + the imperative clause (hedge-harvest fix), plus the machine verdict line.
Stored as a repo constant (`convention-audit-prompt.txt`), version-stamped. Its three
load-bearing clauses:

- **compute:** numerically test each convention hypothesis against the sample before writing.
- **instruction-criteria:** also audit the instruction's success criteria for scope/deliverable
  ambiguities; where a broader reading is penalty-free under the stated scoring, name the
  dominant reading.
- **imperative (hedge-harvest fix):** every uncertainty must be written as a MANDATORY
  disambiguation step the solver must perform ("you MUST determine X from the file"), never as
  an unresolved possibility; explicitly name any decoy/label as NOT evidence.

## 5. Wiring

`agent-run.ts`: when `opts.conventionAudit` is set and `auditCard` returned a non-null card,
append the card after `budgetLine`, under an identical CONTROLLED-CONSTANT comment (per-task,
byte-identical across arms, NOT proposer-controlled). Cache the result per `(task)` for the
process so every arm/rep in one run injects the identical bytes and the audit call runs once.

`cmd-run.ts` / `cmd-ab.ts`: thread a `--convention-audit` boolean (default false) into the
per-task flow. When off, the code path is byte-identical to today.

## 6. Audit trail (leak-safety requirement)

For each task with the flag on, write `{task, promptVersion, sample, rawAudit, verdict, card}`
to a per-run audit-trail file under the results/log dir (host-side, not in-container). This is
the leak-safety record ("cue text stored with the trial") and the debugging surface. Never
written into the container / never visible to the grader.

## 7. Scoped OUT of increment 1 (designed, not built)

- **Mechanical propose-verify revalidator** (increment 2, the #1 follow-up): recompute the
  card's claimed transform table against the mechanical sample; reject a card whose winning row
  does not reproduce (rejects the gen4-r1 "confident-wrong" class). Deferred ONLY because the
  flag ships OFF and first use is measurement-gated — a wrong card cannot reach production
  silently. Until it exists, an audit-on run can inject a confident-wrong card; stated risk.
- Auto-running in the loop / board wiring beyond the flag.
- Per-task sampler specializations beyond the generic text/binary summary (the gcode
  text-object-row bug the sibling found — sampler must include in-object rows — is a sampler
  quality item folded into `buildSample`, but domain-specific samplers are out).

## 8. Testing

TDD, unit-first (the pipeline fns are pure over fixtures):
- `buildSample`: leak-safety is the critical test — assert it NEVER emits bytes from `tests/`/
  `solution/` even when those exist; assert deterministic output on a fixed fixture.
- `parseVerdict`: MISMATCH / NO MISMATCH / missing-line → null.
- `cardFrom`: extracts the body verbatim.
- `auditCard` integration: a recorded-audit fixture (no live model call in tests) → card or null.
- Wiring: `agent-run` appends the card after budgetLine when flag on + card non-null; byte-
  identical to today when off. A/B byte-identity across arms asserted.
- No live `claude -p` in the test suite; the audit call is injected (ExecFn seam) like the rest
  of the bench code.

## 9. Readiness caveats (on the record)

1. Reward-level significance is still weak (elf card reward p=0.083; the strong result is
   mechanism-level, p=0.024). This build ENABLES measuring the capability at board scale; it
   does not itself claim the win.
2. Without the increment-2 revalidator, an audit-on run can inject a confident-wrong card.
   Mitigated by ship-off + measurement-gated first use. Do not arm before increment 2.
