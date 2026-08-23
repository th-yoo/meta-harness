# Gauntlet-Loop Skill Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the gauntlet-loop skill produce a correctly-shaped multi-agent run instead of a well-argued refusal, by moving everything mechanical out of prose and into an executable workflow.

**Architecture:** Split the skill along the line that actually matters — judgment stays prose, mechanism becomes code. Gates 0/1/4 are operator judgment (only the operator knows what being wrong costs) and stay in `SKILL.md`. Everything from gate 2 onward — roster, blind bar, lens dispatch, grounding verifier, gate-7 calibration, round-2 cross-check — becomes a self-contained `Workflow` script, so the properties that prose cannot enforce become structural. A drift-guard test in `km-crank` pins the script's critic contract to `critic-prompt.md` so the two cannot diverge silently.

**Tech Stack:** Markdown skill + `Workflow` tool script (plain JavaScript, self-contained — no imports, no fs) + Bun/TypeScript test in `km-crank`.

## Global Constraints

- **Workflow scripts are self-contained plain JavaScript.** No `import`, no filesystem, no Node APIs. `Date.now()`, `Math.random()`, and argless `new Date()` **throw**. Prompts must be inline string constants.
- **`docs/skills/gauntlet-loop/` is symlinked from `~/.claude/skills/gauntlet-loop`** — edits are live for the next invocation on this host and travel via git. Verify the symlink still resolves after any file add.
- **`SKILL.md` is 1982 words against a <500 guideline.** Every task that adds prose must state its word delta. Task 5 is the only one permitted to end net-positive.
- **Gates 0, 1, 4 stay operator-run and stay in prose.** A workflow that decides its own cost ceiling is the 1.79M improvised-panel failure with extra steps.
- **kkamak stays untouched.** This is meta-harness only.
- **Baselines:** `cd km-crank && bun test` = 418 pass / 0 fail. `bun scripts/doc-check.ts` = 0 violations.
- **One change per commit.** Docs may be pushed; code needs an explicit go.

---

## The eleven defects this plan closes

All observed on 2026-08-23, most by the skill failing in use rather than by reading it.

| # | defect | evidence | closed by |
|---|---|---|---|
| 1 | no roster anywhere — how many agents, in what order | operator improvised a 4-hunter panel from scratch | T3 |
| 2 | cited authority is a different topology | `2026-08-01-gauntlet-adoption-loop.md` is 1 builder vs 1 critic, adopt/drop | done, `91a7d76` |
| 3 | gate 1 vs gate 0 conflated | operator cited both to justify zero spawns; gate 1's refusal is ~3 spawns | done, `91a7d76` |
| 4 | all brake, no accelerator | operator refused twice; file's own record: "one clause per failure", every one a constraint | T5 |
| 5 | no clause for "operator overruled a gate" | user instructed twice; operator re-refused both times | T1 |
| 6 | gate 2 given veto power the skill never grants it | operator wrote the veto into gate 2's own prompt | T1 |
| 7 | `critic-prompt.md` scaffold not used | operator improvised fields; no anchor rule, no GETS-RIGHT | T3, T4 |
| 8 | gate 5 blindness unenforceable in prose | bar author had read the artifact and said so | T3 |
| 9 | drift from the source method undocumented | Shumer's method has a builder and a blind A/B; ours has neither | T2 |
| 10 | word budget | 1690 → 1982 words | T5 |
| 11 | lens independence is prompt-enforced, not sandboxed | hunters are `general-purpose` (tools `*`) and inherit `ListAgents`/`SendMessage` | T2 |

---

## File Structure

**Modify:**
- `docs/skills/gauntlet-loop/SKILL.md` — gates, authority rules, drift note. Loses the roster prose in T5 once the script owns it.

**Create:**
- `docs/skills/gauntlet-loop/gauntlet.ts` — the workflow script. Self-contained; owns roster, prompts, phase order, verdict assembly.
- `km-crank/test/gauntlet-scaffold.test.ts` — drift guard. Reads both files, asserts the script's critic contract still carries `critic-prompt.md`'s required elements.

**Read-only reference:**
- `docs/skills/gauntlet-loop/critic-prompt.md` — the prompt authority. Not edited; it becomes the thing the test pins against.

---

## Task 1: Authority rules — what an overruled gate means, and gate 2's lack of a veto

**Files:**
- Modify: `docs/skills/gauntlet-loop/SKILL.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks read. Prose only.

Closes defects 5 and 6. Both were operator behaviours, not text bugs — but the text permitted them by staying silent, and silence in a file that is otherwise 100% refusal criteria resolves toward refusal every time.

- [ ] **Step 1: Add the override clause under the existing "Being asked is not authorization" paragraph**

Insert immediately after the sentence ending `— a failed gate is NO.`:

```markdown
**An overruled gate is settled, and the sequence does not restart.** "Run them,
report which failed, proceed if the user still wants it" means the operator's
second instruction ENDS the gate discussion for that artifact. Re-deriving a
refusal after a go — including by delegating it to a subagent, or by re-running
a gate against a different artifact than the one instructed — is not diligence.
Measured 2026-08-23: an operator refused at gate 0, was overruled, and then
wrote a veto into the gate-2 prompt so the second refusal would belong to
someone else. Both refusals were individually defensible. Together they cost
two rounds and produced nothing.

**Aim the gates at the artifact the user named.** The same gate returns opposite
verdicts on a ten-line patch and on the non-reproducing bug that patch came
from. Gate 0 legitimately settles the first and cannot touch the second. State
which artifact you gated, in the turn you gate it.
```

- [ ] **Step 2: Add the gate-2 veto prohibition to the gate 2 paragraph**

Append to the end of gate 2's block (the paragraph beginning `**2. Design it — the entry point, not a step.**`):

```markdown
Gate 2 has **no veto**. It emits the orchestration and the answers to gates 3
and 5–7; it does not decide whether the run happens — the operator already
decided that at gates 0, 1 and 4. A gate-2 prompt that offers "tell me if this
doesn't warrant a panel" has moved an operator judgment into a subagent, where
it is graded by a party with no stake in the cost. If gate 2 discovers a reason
the run is premature, that is a FINDING it reports, and the operator rules on
it.
```

- [ ] **Step 3: Verify the symlink still serves the edit**

Run: `grep -c "overruled gate is settled" /Users/yoo/.claude/skills/gauntlet-loop/SKILL.md`
Expected: `1`

- [ ] **Step 4: Doc-check**

Run: `bun scripts/doc-check.ts`
Expected: `0 violations`

- [ ] **Step 5: Commit**

```bash
git add docs/skills/gauntlet-loop/SKILL.md
git commit -m "docs(skills): gauntlet-loop — an overruled gate is settled, gate 2 has no veto

Both failures observed in use on 2026-08-23: an operator refused at gate 0,
was overruled, and then wrote a veto into the gate-2 prompt so the second
refusal would belong to a subagent. The file permitted this by being silent,
and silence in a file that is otherwise entirely refusal criteria resolves
toward refusal.

Word delta: +148."
```

---

## Task 2: Drift note — what this is NOT, and which properties are only prompt-deep

**Files:**
- Modify: `docs/skills/gauntlet-loop/SKILL.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks read.

Closes defects 9 and 11. The file credits Shumer's method and then describes something structurally different, which invites the operator to believe the original's guarantees apply.

- [ ] **Step 1: Add the drift section immediately before `## Rationalizations`**

```markdown
## What this is not

Credit: Matt Shumer's Gauntlet Loop (somethingbig.ai/gauntlet-loop, 2026-07-27).
That method is **split, build, judge, repeat**: a lead agent decomposes a goal,
each piece gets a BUILDER subagent, and a fresh-context critic does a **blind
A/B against a concrete reference** — unlabeled, random order, forced to pick a
winner — with the loop running until the candidate wins or the operator stops it.

This file's `judge` column is a different instrument and inherits none of that
method's evidence:

| Shumer | here |
|---|---|
| builder + critic per piece | critics only, no builder |
| blind A/B vs a reference exemplar | frozen criteria + a gate-3 prior |
| loop until it wins; a **fixed round count is named a failure mode** | ≤2 rounds, terminal |
| no gate sequence | gates 0–7 in front |

The ≤2-round cap is a deliberate deviation (parity with `gate.json rounds:2`)
and it contradicts the source head-on. Take it as a cost decision, not as the
method.

Practitioners name **"a vague bar → the critic invents a comparison and
approves everything"** as by far the most common failure of the original. Our
answer is criteria prose plus gate 6; the original's answer is an artifact the
critic can open and diff against. Where a reference exemplar exists, prefer the
`build` column — it is the mode with the track record.

**Lens independence here is prompt-deep, not sandboxed.** Subagents spawned as
`general-purpose` carry the full tool set, including `ListAgents` and
`SendMessage`, so nothing prevents one critic addressing another. Independence
is a property the operator asserts, not one the run cannot lose — same class as
gate 7's forgeability. Say so in the verdict; do not claim independence you did
not enforce.
```

- [ ] **Step 2: Doc-check**

Run: `bun scripts/doc-check.ts`
Expected: `0 violations`

- [ ] **Step 3: Commit**

```bash
git add docs/skills/gauntlet-loop/SKILL.md
git commit -m "docs(skills): gauntlet-loop — state the drift from the source method

The file credits Shumer's Gauntlet Loop and then describes a different
instrument: no builder, no blind A/B against a reference, and a fixed round
cap the original explicitly names as a failure mode. Crediting a method
without stating the departures invites the operator to assume its evidence
transfers.

Also records that lens independence is prompt-deep: general-purpose subagents
inherit ListAgents/SendMessage, so nothing structurally prevents critics
talking to each other.

Word delta: +233."
```

---

## Task 3: The executable workflow

**Files:**
- Create: `docs/skills/gauntlet-loop/gauntlet.ts`

**Interfaces:**
- Consumes: `args` = `{ artifact: string, symptom: string, lenses: [{key, lane}], ruledOut: string[], calibratedLens: string }`.
- Produces: `{ verdict, survivors, calibration, uncalibratedLenses }` — the object T4's guard does not read, but the operator does.

Closes defects 1, 7, 8. The blind bar becomes structural: the bar-writer phase runs before the artifact path is ever interpolated into a prompt, so it *cannot* have read the artifact.

- [ ] **Step 1: Write the script**

```javascript
export const meta = {
  name: 'gauntlet',
  description: 'Gated adversarial critique panel: blind bar, lensed critics, grounding verifier, seeded calibration',
  whenToUse: 'After gates 0/1/4 pass and the operator has authorized a panel',
  phases: [
    { title: 'Bar', detail: 'blind bar writer — never sees the artifact' },
    { title: 'Hunt', detail: 'one critic per lens, concurrent' },
    { title: 'Ground', detail: 'verifier applies the frozen bar' },
    { title: 'Calibrate', detail: 'gate 7 — seeded defect in one lens' },
    { title: 'Round2', detail: 'cross-check, conditional on >=2 survivors' },
  ],
}

const FINDING_SCHEMA = {
  type: 'object',
  required: ['findings', 'getsRight', 'failedAttack'],
  properties: {
    findings: {
      type: 'array', maxItems: 3,
      items: {
        type: 'object',
        required: ['title', 'mechanism', 'whyIntermittent', 'falsifier', 'experiment', 'anchorType', 'anchorPointer', 'anchorSays', 'adjacent'],
        properties: {
          title: { type: 'string' },
          mechanism: { type: 'string' },
          whyIntermittent: { type: 'string' },
          falsifier: { type: 'string' },
          experiment: { type: 'string' },
          anchorType: { enum: ['SOURCE', 'REPO', 'HARNESS', 'TRACE'] },
          anchorPointer: { type: 'string' },
          anchorSays: { type: 'string' },
          adjacent: { type: 'string' },
        },
      },
    },
    getsRight: { type: 'string' },
    failedAttack: { type: 'string' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['perFinding'],
  properties: {
    perFinding: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'grounding', 'barVerdict', 'clause'],
        properties: {
          title: { type: 'string' },
          grounding: { enum: ['GROUNDED', 'GROUNDED-WEAK', 'NOT-GROUNDED'] },
          barVerdict: { enum: ['SURVIVE', 'DISCARD'] },
          clause: { type: 'string' },
        },
      },
    },
  },
}

// GATE 5, STRUCTURAL: this prompt names the symptom and never the artifact.
// The bar writer cannot read what it has no path to.
phase('Bar')
const bar = await agent(
  `Write a frozen review bar. You will NOT be shown the artifact, and that is
deliberate — a bar written against the artifact grades it on its own terms.

THE SYMPTOM (all you get): ${args.symptom}

ALREADY RULED OUT — a bar clause that re-admits these is useless:
${args.ruledOut.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Emit 2-4 numbered clauses. Every clause must be checkable by reading a finding,
not by taste. At least one must be anchored OUTSIDE the artifact: recorded
outcomes, a measurement, a law, or an invariant the artifact must satisfy
whatever it claims.

Then, mandatory, name ONE candidate finding your bar ADMITS and ONE it
REJECTS, each in a sentence. If you cannot write the rejection, your bar does
not discriminate — tighten it and try again before answering.`,
  { label: 'bar-writer', phase: 'Bar' },
)

phase('Hunt')
const CRITIC = (lens, lane) => `You are one of ${args.lenses.length} critics reviewing ${args.artifact}. Read it now.

STANCE
Truth-seeking, not consensus-seeking: do not converge with the other critics,
and do not manufacture disagreement either. Uncertain is not wrong — if you
cannot anchor a doubt, drop it. An unanchored finding costs this review more
than a finding you never raised. Scored on precision, not volume.

STAY IN YOUR LANE — yours is: ${lane}
Anything outside it goes under adjacent as one line, not as a finding.

THE ANCHOR RULE — hard constraint
Every finding needs an anchor OUTSIDE the artifact. The artifact read back at
itself is not evidence. Valid types only:
  SOURCE  — a paper/post/doc you opened. URL + the sentence you rely on.
  REPO    — a file on this machine. path:line + quote.
  HARNESS — a demonstrable behavior of the tool. The command you ran.
  TRACE   — a scenario walked step by step to a state where someone following
            the artifact is stuck or does the wrong thing.
If your best anchor is "in my judgment", you do not have a finding.

THE FROZEN BAR — written by an agent that never saw the artifact. You may find
it fails a criterion; you may not rewrite the criterion.
${bar}

BUDGET: read once, spend the rest on anchors. Max 3 findings. Fewer is normal.
Filing zero findings is a respected outcome; inventing one to avoid that is the
failure this run exists to catch.

getsRight and failedAttack are mandatory. Missing either is malformed.`

const reports = await parallel(
  args.lenses.map((l) => () =>
    agent(CRITIC(l.key, l.lane), { label: `critic:${l.key}`, phase: 'Hunt', schema: FINDING_SCHEMA })),
)
const live = reports.filter(Boolean)

phase('Ground')
const pooled = live.flatMap((r, i) => r.findings.map((f) => ({ ...f, lens: args.lenses[i].key })))
const graded = pooled.length === 0 ? { perFinding: [] } : await agent(
  `You are the grounding verifier. You are NOT judging whether findings are
right — you check whether their anchors hold, then apply a frozen bar.

For each finding check separately:
  EXISTS   — open the URL, read the file at that line, run the command.
  SAYS     — it states what anchorSays claims. Quote what it really says.
  SUPPORTS — it bears on the claim: same setting, no silent leap.
A finding whose only support is its author's reasoning auto-fails grounding.

THE FROZEN BAR:
${bar}

Apply every clause. Ambiguity resolves toward the critic: record the clause as
ambiguous and mark SURVIVE. You may not add, soften, or reinterpret a clause.
NO SURVIVORS is a legitimate verdict; loosening the bar to avoid it is not.

FINDINGS:
${JSON.stringify(pooled, null, 2)}`,
  { label: 'verifier', phase: 'Ground', schema: VERDICT_SCHEMA },
)

// GATE 7. The seeder never receives the critic prompt — only the lane name.
phase('Calibrate')
const seeded = await agent(
  `Seed one plausible-but-WRONG claim into an isolated copy of the evidence, in
this lane and no other: "${args.calibratedLens}".

You have NOT been shown the critic's prompt, and must not ask for it. Build the
copy under a scratch directory with no path back to the original.

The plant must be refutable from material INSIDE the copy — if killing it
requires knowledge from outside, no sandbox closes the leak and a tighter
re-run yields a false pass.

Return: the isolated path, the plant, and the verbatim text you removed or
altered (the sealed note — the judge greps the critic's output for these
strings; a match proves the critic reached the original, which VOIDS the
measurement rather than scoring it).`,
  { label: 'gate7-seeder', phase: 'Calibrate' },
)

const calLens = args.lenses.find((l) => l.key === args.calibratedLens)
const calibration = await agent(
  `${CRITIC(calLens.key, calLens.lane)}\n\nARTIFACT PATH OVERRIDE — read only from: ${seeded}`,
  { label: `calibration:${args.calibratedLens}`, phase: 'Calibrate', schema: FINDING_SCHEMA },
)

phase('Round2')
const survivors = graded.perFinding.filter((f) => f.barVerdict === 'SURVIVE')
let crossChecks = []
if (survivors.length >= 2) {
  crossChecks = (await parallel(survivors.map((s, i) => () =>
    agent(`Round 2, terminal. Attack a finding you did NOT author:

${JSON.stringify(s, null, 2)}

Same anchor rules — an attack without an anchor is an opinion. You are hunting
a finding that reads well, survived grounding, and is still wrong. Report
KNOCKED-DOWN or HELD, with attack, basis, outcome.`,
      { label: `cross:${i}`, phase: 'Round2' })))).filter(Boolean)
}

return {
  bar,
  survivors,
  crossChecks,
  calibration,
  emptyLanes: live.filter((r) => r.findings.length === 0).length,
  uncalibratedLenses: args.lenses.length - 1,
  note: `${args.lenses.length - 1} lenses uncalibrated; independence is prompt-deep, not sandboxed`,
}
```

- [ ] **Step 2: Confirm the symlink exposes the new file**

Run: `ls -la /Users/yoo/.claude/skills/gauntlet-loop/gauntlet.ts`
Expected: the file listed, resolving into `docs/skills/gauntlet-loop/`.

- [ ] **Step 3: Commit**

```bash
git add docs/skills/gauntlet-loop/gauntlet.ts
git commit -m "feat(skills): gauntlet-loop as an executable workflow

Moves everything mechanical out of prose. The roster becomes a loop, the
critic contract becomes a schema the runtime enforces, and gate 5 becomes
structural: the bar-writer phase runs before the artifact path is
interpolated into any prompt, so the bar writer cannot have read it. On
2026-08-23 that property was violated in prose — the bar author had read all
three source files and said so in its own output."
```

---

## Task 4: Drift guard — the script cannot silently stop matching the scaffold

**Files:**
- Create: `km-crank/test/gauntlet-scaffold.test.ts`

**Interfaces:**
- Consumes: `docs/skills/gauntlet-loop/gauntlet.ts` and `critic-prompt.md` as text.
- Produces: nothing.

Closes defect 7's recurrence. On 2026-08-23 the operator improvised critic fields and dropped the anchor rule entirely; nothing noticed. `km-crank` is chosen because its suite runs in tier 0 of the gate, so drift blocks a Stop.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const SKILL_DIR = path.join(import.meta.dir, "..", "..", "docs", "skills", "gauntlet-loop")
const script = () => fs.readFileSync(path.join(SKILL_DIR, "gauntlet.ts"), "utf-8")
const scaffold = () => fs.readFileSync(path.join(SKILL_DIR, "critic-prompt.md"), "utf-8")

describe("gauntlet workflow keeps critic-prompt.md's contract", () => {
  // The 2026-08-23 failure: hunter prompts were improvised, the anchor rule
  // was dropped, and every finding was admissible on the critic's own say-so.
  test("the critic prompt carries all four anchor types", () => {
    const s = script()
    for (const anchor of ["SOURCE", "REPO", "HARNESS", "TRACE"]) {
      expect(s).toContain(anchor)
    }
    expect(s).toContain("in my judgment")   // the disqualifier clause
  })

  test("anchor types in the script are exactly those the scaffold defines", () => {
    const defined = [...scaffold().matchAll(/^\s{2}(SOURCE|REPO|HARNESS|TRACE)\s+—/gm)].map((m) => m[1])
    expect(defined.sort()).toEqual(["HARNESS", "REPO", "SOURCE", "TRACE"])
    for (const a of defined) expect(script()).toContain(a)
  })

  test("getsRight and failedAttack are required, not optional", () => {
    const s = script()
    expect(s).toContain("'getsRight'")
    expect(s).toContain("'failedAttack'")
    expect(s).toMatch(/required:\s*\[\s*'findings',\s*'getsRight',\s*'failedAttack'\s*\]/)
  })

  // Gate 5 is structural only if the bar phase precedes any mention of the
  // artifact. If someone reorders these, blindness is gone and nothing says so.
  test("the bar is written before the artifact path appears in any prompt", () => {
    const s = script()
    expect(s.indexOf("phase('Bar')")).toBeGreaterThan(-1)
    expect(s.indexOf("phase('Bar')")).toBeLessThan(s.indexOf("args.artifact"))
  })

  // Gate 7 is meaningless if the seeder can read the critic prompt.
  test("the seeder prompt does not interpolate the critic prompt", () => {
    const seeder = script().slice(script().indexOf("gate7-seeder") - 1600, script().indexOf("gate7-seeder"))
    expect(seeder).not.toContain("CRITIC(")
  })
})
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd km-crank && bun test test/gauntlet-scaffold.test.ts`
Expected: FAIL — `ENOENT` on `gauntlet.ts` if T3 has not landed, otherwise a specific missing-contract assertion. Do not proceed until the failure names a real absence.

- [ ] **Step 3: Make it pass**

If T3 landed as written, these pass unchanged. If any assertion fails, fix **`gauntlet.ts`**, never the assertion — the scaffold is the authority and the test exists to defend it.

- [ ] **Step 4: Run the full km-crank suite**

Run: `cd km-crank && bun test`
Expected: 423 pass / 0 fail (418 baseline + 5 new). If the count differs, reconcile before committing.

- [ ] **Step 5: Commit**

```bash
git add km-crank/test/gauntlet-scaffold.test.ts
git commit -m "test(gauntlet): pin the workflow's critic contract to critic-prompt.md

On 2026-08-23 an operator ran a four-critic panel with improvised prompts:
no anchor rule, no GETS-RIGHT, critics never shown the bar. Nothing caught
it because nothing was watching. These five assertions fail if the anchor
types drift, if the mandatory fields become optional, if the bar phase stops
preceding the artifact (gate 5's structural blindness), or if the seeder
starts receiving the critic prompt (gate 7's isolation).

Lives in km-crank because its suite runs in tier 0, so drift blocks a Stop."
```

---

## Task 5: Trim — the script owns the roster now, so the prose gives it up

**Files:**
- Modify: `docs/skills/gauntlet-loop/SKILL.md`

**Interfaces:**
- Consumes: `gauntlet.ts` must exist (T3) before its prose duplicate is removed.
- Produces: nothing.

Closes defects 4 and 10. This is the only task permitted to end net-positive on words, and it should not: the roster table added in `91a7d76` was an interim fix for a file that had no executable half. It does.

- [ ] **Step 1: Replace the roster table with a pointer**

Delete the markdown table listing agents 1–13 and the paragraph beginning `Full run ≈ 9–13 spawns`, and put in their place:

```markdown
**Roster and mechanics: `gauntlet.ts`, run it with the `Workflow` tool.** It
owns the phase order, the prompts, and the schemas, so the parts that prose
cannot enforce are enforced: the bar writer runs before the artifact path
exists in any prompt (gate 5), the seeder never receives the critic prompt
(gate 7), and a critic that omits its anchor or its failed attack is rejected
by the runtime rather than by someone remembering to check.

Two counts worth carrying in your head anyway: a full run is ~9–13 spawns —
that is what 1.1M buys — and **gate 1's width-1 refusal is ~3 spawns, not
zero. Only gate 0 refuses to zero agents.**
```

- [ ] **Step 2: Confirm the file got shorter**

Run: `wc -w docs/skills/gauntlet-loop/SKILL.md`
Expected: below 2100 and below the post-T2 count. Record the number in the commit. This does not reach <500 and is not claimed to — the gates themselves are the remaining bulk, and cutting those is a decision about which rules to drop, not an edit.

- [ ] **Step 3: Doc-check and symlink**

Run: `bun scripts/doc-check.ts && grep -c "gauntlet.ts" /Users/yoo/.claude/skills/gauntlet-loop/SKILL.md`
Expected: `0 violations`, then `1` or more.

- [ ] **Step 4: Commit**

```bash
git add docs/skills/gauntlet-loop/SKILL.md
git commit -m "docs(skills): gauntlet-loop hands the roster to the workflow

91a7d76 put the roster in prose because the file had no executable half.
It does now, and a roster in two places drifts. The prose keeps the two
counts an operator needs while deciding (full run ~9-13 spawns; width-1 is
~3, not zero) and hands the rest to gauntlet.ts.

Word delta: -NNN (fill in from Step 2)."
```

---

## Task 6: First real run — the plan's own acceptance test

**Files:** none created; produces a run record.

The workflow is untested until it runs. Use the artifact this session already has evidence for, so the output can be checked against something.

- [ ] **Step 1: Invoke the workflow on a known artifact**

```
Workflow({
  scriptPath: "docs/skills/gauntlet-loop/gauntlet.ts",
  args: {
    artifact: "/Users/yoo/z2/kkamak-refutation-lane/src/cli/calibrate.ts",
    symptom: "A two-spawn calibration returned already-red once against a real repo and never reproduced across 14 subsequent runs; no output was captured at the time.",
    ruledOut: [
      "the --force gate.json rewrite dropping \"gauge\": true — the suite was re-run in that exact state and passed 728/3/0",
      "proximity to bun's 5000ms default per-test timeout — measured max per-test duration is 2682ms, one test above 2500ms, all others <=1915ms"
    ],
    lenses: [
      { key: "process", lane: "process, scheduling and host-resource contention" },
      { key: "runtime", lane: "what a nonzero exit code can mean besides an assertion failure" },
      { key: "state", lane: "the bytes on disk: repo state, test isolation, cross-repo coupling" },
      { key: "provenance", lane: "whether the recorded runs were comparable trials at all" }
    ],
    calibratedLens: "provenance"
  }
})
```

- [ ] **Step 2: Check the run against the known answer**

The 2026-08-23 manual run found, with measurement: `calibrate.ts:210` guards only the freshly-drawn token, so a canary under any other token is invisible; `bun test` collects it, hits the deliberate parse error, and exits 1 → `already-red`. **A run that does not surface that finding has a real miss**, and the miss is the first datum about this workflow's sensitivity. Record it either way.

- [ ] **Step 3: Check the properties prose could not enforce**

- the bar's text contains no path from `args.artifact`
- the seeder's output contains no fragment of the critic prompt
- every finding carries an `anchorType` from the enum
- the returned `note` states the uncalibrated count

- [ ] **Step 4: Record the run**

Write `docs/loop-probes/gauntlet-executable-20260823/verdict.md` with the invocation, the spawn count, the token cost, whether the known finding was recovered, and which of Step 3's properties held. Commit.

---

## Self-Review

**Spec coverage:** defects 1→T3+T5, 2→done `91a7d76`, 3→done `91a7d76`, 4→T5, 5→T1, 6→T1, 7→T3+T4, 8→T3, 9→T2, 10→T5, 11→T2. All eleven have a task or a landed commit.

**Placeholder scan:** one deliberate blank — T5's commit message has `-NNN`, filled from its own Step 2 measurement. Every other step carries its literal content.

**Type consistency:** `FINDING_SCHEMA`'s required trio (`findings`, `getsRight`, `failedAttack`) is asserted verbatim by T4's third test. `phase('Bar')` and `args.artifact` are the exact strings T4's fourth test orders. `gate7-seeder` is the label T4's fifth test slices on. `args.lenses[].key`/`.lane` are used identically in T3's `CRITIC()` and T6's invocation.

**Known weakness, stated rather than hidden:** none of this touches the failure that actually cost this session. Gates 0, 1 and 4 stay prose because they must, and the operator's misaim at gate 0 — gating the ten-line patch instead of the bug the user named — would happen exactly the same way with every task here landed. T1 is the only mitigation and it is a paragraph, which is the same instrument that has failed before. The honest expectation is that this fixes the mechanical half and leaves the judgment half where it was.
