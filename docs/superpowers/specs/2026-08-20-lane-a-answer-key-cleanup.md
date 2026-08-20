# Lane-A answer-key cleanup — spec (2026-08-20)

## Why

`CLAUDE.md` §1 (the generality rule, `92b88dd`) rules task-specific answers in
the harness to be cheating. A bias audit of shipped machinery (2026-08-20)
found three violations, all in the lane-A convention-audit path, one previously
unknown:

1. **`offset-reciprocal`** (`5e3df53`, `lane-a-v4`) — a whitelist op added
   because one trap needed it. Its rationale is REFUTED: the raman task's own
   oracle is `shift = 1e7/x` at argmax (real peak 6327.285 → 1580.46, plain
   `reciprocal`, already whitelisted). The models fabricated a laser-offset
   story on baseline x-values; the op was built for the fabrication without
   checking their claims against the artifact. Named in §1 as an example of
   what not to do.
2. **Prompt line 31** (same commit) — a paragraph teaching the Raman-shift
   family (`shift = laser_wavenumber - unit/wavelength`, laser wavenumber as
   CONSTANT, 1e7-vs-1e8 unit lore). Domain physics encoded in the harness.
3. **Prompt line 15 — NEW finding, predates F4** (present since `a97156a`,
   lane-a-v2): the inline-arithmetic example is `1e7 / 6327.285 = 1580.6` —
   the raman fixture's exact peak x-value and its correct G-band answer,
   shipped to the auditor of every task. A literal answer key. Hypothesis
   (recorded, not claimed): this example seeded the models' 1e7 fixation the
   adherence probe measured ("every model attempt used 1e7 on Angstrom
   data"), i.e. the contamination may have manufactured the evidence F4 was
   built on.

## What

1. **Revert `5e3df53` whole** — op, UNIT parser branch, whitelist entry,
   prompt paragraph, tests. `git revert` applies cleanly (verified by
   dry-run; no later commits touch the three files).
2. **Replace the line-15 example** with domain-neutral arithmetic that
   teaches the *format* (show your work inline) and no transform family and
   no fixture value: `4096 / 8 = 512`.
3. **Bump `AUDIT_PROMPT_VERSION` to `lane-a-v5`.** The revert alone restores
   the string `lane-a-v3`, but the prompt then changes again (line 15), and a
   version string must never be reused for different bytes — the audit trail
   keys provenance on it. `lane-a-v4` is retired, never to be reused.
4. **Regression pin**: a test that the shipped prompt contains none of the
   removed leak strings (`6327.285`, `1580`, `Raman`, `laser`, `graphene`,
   `1e7`, `offset-reciprocal`). This is a pin on a specific retraction (like
   the sibling's vacuity-pinning regression test), not a general leak
   detector — a general detector would itself need an answer list and is out
   of scope.
5. **Retraction record**: `docs/loop-probes/f4-retraction-20260820/
   retraction.md` — the false rationale, the oracle evidence, the line-15
   contamination and its hypothesis, and what the F4 *finding* still validly
   says (the whitelist genuinely cannot express two-op claims; what died is
   the conclusion that this trap class requires it).
6. **`docs/resume.md` update** — additive, top block; staged with
   `git add -p` / verified with `git diff --cached` (shared checkout).

## Non-goals

- The revalidator bypass redesign (canonical/delta ownership) — queue #2/#3,
  own spec.
- Applying O2 split-channels to the shipped prompt — queue #5, own go.
- A general answer-leak detector for prompts — would itself be an answer
  list.
- Any push to origin — needs its own go.

## Constraints

- Zero model/bench token spend — pure code + tests.
- Work directly on `main` (shared checkout: branch switching squats HEAD
  under the sibling session — measured 2026-08-20; recent lane commits land
  on main directly).
- Full opencode-plugin suite green after every task.
- Never `git add docs/resume.md` bare — `git add -p` or `git diff --cached`
  check first.

## Acceptance

- `applyTransform` whitelist is `{reciprocal, scale, offset, identity}`;
  `offset-reciprocal` absent from source and prompt.
- Prompt contains no raman-fixture value, no Raman/laser vocabulary, no 1e7.
- `AUDIT_PROMPT_VERSION === "lane-a-v5"`.
- Suite passes 0-fail; regression pin test present and passing.
- Retraction record committed; resume.md updated additively.
