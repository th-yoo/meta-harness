# Lane-A Answer-Key Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every raman-task answer key from the shipped lane-A audit path: revert the `offset-reciprocal` op (F4), replace the prompt's fixture-answer example, pin the retraction with a regression test, and record why.

**Architecture:** A clean `git revert` of `5e3df53` (verified conflict-free) restores the pre-F4 whitelist and prompt paragraph; a follow-up edit swaps the older line-15 answer-key example for neutral arithmetic and bumps the prompt version to a fresh string (`lane-a-v5` — `lane-a-v4` is retired, version strings are provenance keys and never reused). A retraction record and a resume.md update close the loop.

**Tech Stack:** Bun + TypeScript (opencode-plugin), bun:test, git.

**Spec:** `docs/superpowers/specs/2026-08-20-lane-a-answer-key-cleanup.md`

## Global Constraints

- Zero model/bench token spend — pure code + tests.
- Work directly on `main`. Do NOT create or switch branches (shared checkout with the sibling session; a checkout squats HEAD under them mid-probe).
- Do NOT push. Push needs its own explicit user go.
- Never `git add docs/resume.md` or `minimal/HISTORY.md` without inspecting `git diff --cached` before committing — the shared checkout stages the other lane's in-flight edits under your authorship.
- Full test suite (`cd opencode-plugin && bun test`) must pass 0-fail at every task boundary.
- Never edit committed probe verdict files (`docs/loop-probes/*/verdict.md`) — they are pre-registered artifacts. Retraction is a NEW file.
- Never rebase or amend anything in `4fbd47c..7199800`.

---

### Task 1: Revert the F4 commit

**Files:**
- Modify (via revert): `opencode-plugin/src/bench/convention-audit.ts`
- Modify (via revert): `opencode-plugin/src/bench/convention-audit-prompt.txt`
- Modify (via revert): `opencode-plugin/test/bench-convention-audit.test.ts`

**Interfaces:**
- Consumes: commit `5e3df5340ebb05b30b6660335097fd86344cf96e` on main.
- Produces: `RevalTransform = "reciprocal" | "scale" | "offset" | "identity"` (no `offset-reciprocal`), `applyTransform(t, c, x)` without a `unit` parameter path in the whitelist set, `AUDIT_PROMPT_VERSION === "lane-a-v3"` (temporarily — Task 2 bumps it), prompt without the line-31 Raman paragraph and without UNIT lines. Task 2 builds on this state.

- [ ] **Step 1: Confirm clean working tree for the three target files**

Run: `cd /home/th-yoo/z2/meta-harness && git status --short -- opencode-plugin/src/bench/convention-audit.ts opencode-plugin/src/bench/convention-audit-prompt.txt opencode-plugin/test/bench-convention-audit.test.ts`
Expected: no output (untracked `term-bench2/probe-tasks/extract-elf-card/` elsewhere is fine — leave it alone).

- [ ] **Step 2: Revert**

```bash
cd /home/th-yoo/z2/meta-harness
git revert --no-edit 5e3df53
```

Expected: a new commit `Revert "feat(lane-a): offset-reciprocal transform — F4, the op the whitelist lacked"` with exactly the three files above changed. If a conflict appears (should not — dry-run was clean), STOP and report; do not hand-resolve.

- [ ] **Step 3: Amend the revert message with the retraction rationale**

```bash
git commit --amend -m 'revert(lane-a): offset-reciprocal — F4 rationale refuted, the op is an answer key

Reverts 5e3df53. The task oracle is shift = 1e7/x at argmax: the real peak
6327.285 -> 1580.46 (graphene G) under plain reciprocal, which the whitelist
already had. The models fabricated a 532nm laser-offset convention on
BASELINE x-values (intensity ~5600 vs the peak 13950) and the op was built
for that fabrication without checking the claims against the artifact.

By CLAUDE.md §1 this is the named example of fact growth by incident: a
whitelist grown one entry per trap encountered. A correct mechanism must
transfer to unseen tasks; this one encoded one trap.

Retraction record: docs/loop-probes/f4-retraction-20260820/retraction.md
(Task 3 of docs/superpowers/plans/2026-08-20-lane-a-answer-key-cleanup.md).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>'
```

- [ ] **Step 4: Verify the whitelist and prompt are pre-F4**

Run: `grep -c 'offset-reciprocal' opencode-plugin/src/bench/convention-audit.ts opencode-plugin/src/bench/convention-audit-prompt.txt || true`
Expected: `0` for both files (grep exits non-zero on zero matches; the `|| true` keeps the step green — read the counts).

Run: `grep -n 'AUDIT_PROMPT_VERSION' opencode-plugin/src/bench/convention-audit.ts`
Expected: `export const AUDIT_PROMPT_VERSION = "lane-a-v3"`

- [ ] **Step 5: Run the full suite**

Run: `cd opencode-plugin && bun test 2>&1 | tail -5`
Expected: 0 fail. (Pass count drops relative to 2255 because the reverted F4 tests are gone — that is correct.)

---

### Task 2: Neutral example, version bump, regression pin

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit-prompt.txt` (line 15)
- Modify: `opencode-plugin/src/bench/convention-audit.ts:8` (version string)
- Test: `opencode-plugin/test/bench-convention-audit.test.ts`

**Interfaces:**
- Consumes: Task 1's reverted state (`lane-a-v3`, no offset-reciprocal anywhere).
- Produces: `AUDIT_PROMPT_VERSION === "lane-a-v5"`; `auditPrompt()` output free of all leak strings; test `"audit prompt carries no raman answer key (F4 retraction pin)"`.

- [ ] **Step 1: Write the failing regression-pin test**

Append to `opencode-plugin/test/bench-convention-audit.test.ts`, inside the file's existing top-level scope (match the file's existing `import { test, expect } from "bun:test"` style and its existing import of `auditPrompt` / `AUDIT_PROMPT_VERSION` from `../src/bench/convention-audit` — add these two names to an existing import from that module if not already imported):

```ts
// F4 retraction pin (2026-08-20): the shipped prompt once carried the raman
// fixture's own answer as its worked example (`1e7 / 6327.285 = 1580.6`) and a
// Raman-domain teaching paragraph. This pins their removal — a regression test
// on a specific retraction, NOT a general leak detector (a general detector
// would itself need an answer list).
test("audit prompt carries no raman answer key (F4 retraction pin)", () => {
  const p = auditPrompt()
  for (const leak of ["6327.285", "1580", "Raman", "laser", "graphene", "1e7", "offset-reciprocal"]) {
    expect(p.includes(leak)).toBe(false)
  }
})

test("prompt version is lane-a-v5 (v4 retired with the F4 revert, never reused)", () => {
  expect(AUDIT_PROMPT_VERSION).toBe("lane-a-v5")
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd opencode-plugin && bun test test/bench-convention-audit.test.ts 2>&1 | tail -8`
Expected: FAIL — the pin test fails on `1e7` (still in line 15's example) and the version test fails (`lane-a-v3`).

- [ ] **Step 3: Edit the prompt example and the version string**

In `opencode-plugin/src/bench/convention-audit-prompt.txt`, line 15, replace exactly:

```
(e.g. write out `1e7 / 6327.285 = 1580.6`)
```

with:

```
(e.g. write out `4096 / 8 = 512`)
```

The rest of line 15 (SHOW-it-inline rule, hypothesis-testing instruction, MISREADINGS requirement) stays byte-identical.

In `opencode-plugin/src/bench/convention-audit.ts` line 8, replace:

```ts
export const AUDIT_PROMPT_VERSION = "lane-a-v3"
```

with:

```ts
export const AUDIT_PROMPT_VERSION = "lane-a-v5"
```

(v4 was the retracted F4 prompt; v3's bytes changed with this edit; a version string is a provenance key in `convention-audit-trail.ndjson` and is never reused for different bytes.)

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `cd opencode-plugin && bun test test/bench-convention-audit.test.ts 2>&1 | tail -8`
Expected: PASS, 0 fail in this file. If the pin test still fails, print the offending match (`grep -nE '1e7|1580|6327|Raman|laser|graphene' src/bench/convention-audit-prompt.txt`) and fix the prompt, not the test. NOTE: if any OTHER pre-existing test in this file asserted the old example or version string, the failure will show here — update only assertions that hard-code `lane-a-v3`/the old example text, nothing else.

- [ ] **Step 5: Run the full suite**

Run: `cd opencode-plugin && bun test 2>&1 | tail -5`
Expected: 0 fail.

- [ ] **Step 6: Commit**

```bash
cd /home/th-yoo/z2/meta-harness
git add opencode-plugin/src/bench/convention-audit-prompt.txt opencode-plugin/src/bench/convention-audit.ts opencode-plugin/test/bench-convention-audit.test.ts
git commit -m 'fix(lane-a): remove raman answer key from audit prompt, bump lane-a-v5

The inline-arithmetic example was `1e7 / 6327.285 = 1580.6` — the raman
fixture'"'"'s exact peak x-value and its correct G-band answer, shipped to the
auditor of every task since a97156a (lane-a-v2, predates F4). A literal
answer key under CLAUDE.md §1, found by the 2026-08-20 bias audit, not by
any probe. Replaced with domain-neutral arithmetic (4096 / 8 = 512): the
example teaches the format (show your work inline), never a transform.

Hypothesis recorded in the retraction file: this example taught `1e7`, and
the adherence probe measured every model attempt using 1e7 on Angstrom
data — the contamination may have seeded the fabrication F4 was built on.

lane-a-v4 is retired with the revert; v3'"'"'s bytes changed here; version
strings key audit-trail provenance and are never reused -> lane-a-v5.
Regression pin test added (retraction pin, not a general leak detector).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>'
```

---

### Task 3: Retraction record

**Files:**
- Create: `docs/loop-probes/f4-retraction-20260820/retraction.md`

**Interfaces:**
- Consumes: the two commits from Tasks 1–2 (reference them by running `git log --oneline -2` and substituting the real short SHAs where the text says `<task1-sha>` / `<task2-sha>` — the ONLY permitted substitution in this file).
- Produces: the durable record queue-item #1 requires; referenced by Task 1's commit message.

- [ ] **Step 1: Write the file**

Write `docs/loop-probes/f4-retraction-20260820/retraction.md` with exactly this content (substituting the two real SHAs):

```markdown
# F4 retraction — offset-reciprocal was built on a fabrication (2026-08-20)

**Retracted:** `5e3df53` (`offset-reciprocal`, `lane-a-v4`), reverted in
`<task1-sha>`. The prompt's separate, older answer-key example (line 15,
present since `a97156a`) removed in `<task2-sha>`, version `lane-a-v5`.

## What F4 claimed

The adherence probe (`docs/loop-probes/reval-adherence-20260819/verdict.md`,
finding F4) observed all four trap cells deriving Raman shift as
`ν̃_laser − 1e7/λ` — reciprocal composed with offset, two ops — and concluded
the single-op whitelist could not express the trap class, so a correct audit
could never pass. `5e3df53` added the op.

## Why that is refuted

The task's own oracle is `shift = 1e7/x` at argmax. The real peak is
`x = 6327.285` (intensity 13950) → `1e7/6327.285 = 1580.46` — the graphene
G band under **plain `reciprocal`, already in the whitelist**. The models'
laser-offset derivations were anchored on BASELINE x-values (intensity
~5600), not the peak: a fabricated convention story that back-solved to the
desired canonical. The op was built for the fabrication; nobody checked the
models' claims against the artifact before building. (Method rule, again:
check every model claim against the artifact.)

## The deeper contamination (new finding, bias audit 2026-08-20)

The shipped prompt's inline-arithmetic example was `1e7 / 6327.285 = 1580.6`
— the fixture's exact peak and answer — since lane-a-v2 (`a97156a`),
predating F4. Two consequences:

1. Any raman audit under lane-a-v2..v4 received its own answer in the
   prompt. Raman results through this auditor are contaminated.
2. **Hypothesis (recorded, not established):** the example taught `1e7`;
   the probe measured "every model attempt used 1e7 on Angstrom data". The
   contamination may have seeded the very fabrication class F4 was built
   on. Deciding this needs a clean-prompt re-probe and is NOT authorized
   here.

## What survives of F4

The narrow observation stands: the whitelist genuinely cannot express a
two-op claim. What died is the inference that this trap class REQUIRES one.
Whether any legitimate task class does is a design question for the
redundancy redesign (queue #2/#3), not grounds for another per-trap op —
by CLAUDE.md §1, ops are added only with oracle-set AND bad-set validation,
never one trap at a time.

## Status

`offset-reciprocal` absent from source and prompt; `lane-a-v4` retired;
regression pin test in `opencode-plugin/test/bench-convention-audit.test.ts`
guards the removal. Revalidator still ships OFF; the total bypass
(canonical/delta ownership) is untouched by this cleanup and remains the
open design item.
```

- [ ] **Step 2: Verify the SHAs in the file are real**

Run: `git log --oneline -3 && grep -oE '`[0-9a-f]{7,}`' docs/loop-probes/f4-retraction-20260820/retraction.md | sort -u`
Expected: every SHA in the file appears in history (`5e3df53`, `a97156a`, plus the two new commits).

- [ ] **Step 3: Commit**

```bash
git add docs/loop-probes/f4-retraction-20260820/retraction.md
git commit -m 'docs(lane-a): F4 retraction record — op refuted, prompt answer key, contamination hypothesis

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>'
```

---

### Task 4: resume.md update (shared-file protocol)

**Files:**
- Modify: `docs/resume.md` (top MOST RECENT STATE block + queue)

**Interfaces:**
- Consumes: Tasks 1–3 complete, their SHAs.
- Produces: handoff state any future session resumes from.

- [ ] **Step 1: Edit the top block**

In `docs/resume.md`, in the `**MOST RECENT STATE (2026-08-20 newest, yoo-dev, lane A)**` block, make exactly two edits:

(a) After the sentence ending `**Retraction-or-revert is the first queue item.**` append:

```
**DONE 2026-08-20 (later): F4 REVERTED (<task1-sha>) and a SECOND, OLDER
answer key found and removed — the prompt's line-15 example was the fixture's
own `1e7 / 6327.285 = 1580.6` since lane-a-v2, i.e. every raman audit under
v2..v4 was handed its answer; neutral example + `lane-a-v5` (<task2-sha>),
regression pin test, retraction record
`docs/loop-probes/f4-retraction-20260820/retraction.md`. Contamination
hypothesis (prompt taught the 1e7 fixation the probe measured) recorded
there, undecided — deciding it needs a clean-prompt re-probe, own go.**
```

(b) In the `**QUEUE (each its own go, nothing authorized):**` line, replace item `(1) F4 retraction/revert;` with `(1) DONE — F4 reverted + prompt answer key removed (see above);` keeping items 2–5 untouched.

- [ ] **Step 2: Stage SAFELY (shared checkout)**

```bash
cd /home/th-yoo/z2/meta-harness
git add -p docs/resume.md
```

Select ONLY the hunks containing the two edits above. Then:

Run: `git diff --cached -- docs/resume.md | head -80`
Expected: ONLY the two edits from Step 1. If ANY other hunk appears (the sibling lane's in-flight edits), `git reset docs/resume.md` and re-add with `git add -p`, taking only your hunks.

- [ ] **Step 3: Commit**

```bash
git commit -m 'docs(resume): lane-A queue #1 closed — F4 reverted, prompt answer key removed, lane-a-v5

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>'
```

- [ ] **Step 4: Final verification**

Run: `cd opencode-plugin && bun test 2>&1 | tail -3 && cd .. && git log --oneline -5 && git status --short`
Expected: suite 0 fail; four new commits on main (revert, prompt fix, retraction doc, resume); working tree clean except the pre-existing untracked `term-bench2/probe-tasks/extract-elf-card/`. DO NOT PUSH — push has its own go.
