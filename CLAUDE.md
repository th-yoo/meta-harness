# Repository guidance

## What we are building: a GENERAL self-improving agent — not a TB2 solver

The benchmark is the measuring instrument, never the target. A solution that
works because we already knew this task's answer is **cheating** — a student who
memorized the test answers beforehand. It scores well and teaches the agent
nothing.

**The test, applied to every mechanism before it is built:** does this transfer
to a task we have never seen? If it only works because a human encoded this
task's answer into the harness, it is cheating however well it is engineered,
documented, or version-controlled.

**Cheating, by this rule** (all real examples from lane A, 2026-08-20):
- a **reference table** in the harness (a canonical spectral-line list) — that is
  the answer key; the line is 1580 only because we wrote 1580 in a file
- a **new op added because this trap needed it** (`offset-reciprocal`, the fifth
  member of a whitelist grown one entry per trap encountered)
- a **per-domain registry** where each new task type gets its own entry —
  memorizing tests one at a time and calling the collection generality

**The tell: FACT growth by incident is fitting.** Adding a fact in response to a
case that failed is indistinguishable from legitimate coverage when viewed from
the inside. MECHANISM growth is different and can be acceptable, but only when
each addition is independently validated against an oracle set AND a bad set.
"Declared and version-controlled" does not make an answer key legitimate — it
makes it auditable cheating.

**Legitimate**: transport and infrastructure fixes; format/wire contracts that
carry no task knowledge; and method — notably, *to test whether a check can fail,
build the input that should break it*.

**The harness's real job** is to make the model's claim FALSIFIABLE WITHOUT THE
HARNESS KNOWING THE ANSWER. World knowledge comes from the model; the harness
supplies redundancy. An over-determined fit (more anchors than fitted parameters)
is checkable with no reference table, which is the only mechanism found so far
that does not require pre-loading answers. Its scope is measured, not assumed:
it rejects ERROR (internal inconsistency), never DECEPTION (consistent
fabrication) — a wholly invented claim applied consistently passes every check
computed from the claim itself.

**The downstream-of-decision law** (three independent derivations, 2026-08-20:
lane B's six gcode checks, lane A's value-fabrication probe T6, and a
fresh-context architect review — each found it without the others):
**a statistic computed from the thing it audits cannot contradict it; a check
that cannot fail cannot inform.** The escape is always a prior from OUTSIDE
the artifact under audit — the task's own source, independent geometry, an
outcome the claimant does not control. Before trusting any check, ask what
would have to be true for it to fail, and whether anything outside the audited
claim supplies that. Corollary, measured the same day: a fixed defence list
grown one entry per attack found is this law at the meta level — derive
defences from the artifact's structure, never enumerate them by incident.

## Save shareable artifacts under the repo — not host-local paths

Any artifact meant to be reused, or used on another host, MUST live under the
git-tracked repo so it travels everywhere via `git push`/`pull`. This project runs
across multiple machines (WSL2 Linux box, MacBook); **cross-host transfer is
git-only** — host-local state does NOT transfer.

**Host-local — does NOT travel (never the source of truth for shared work):**
- `.kkamak/`, `~/.config/kkamak/` — runtime store (gitignored; pre-rename `.meta-harness/` + `~/.config/meta-harness` remain as back-compat symlinks)
- `/mnt/d/tmp/`, `/tmp/`, `$CLAUDE_JOB_DIR` — scratch scripts + temp files
- `~/.claude/` — personal memory
- `resource-profiles/` — deliberately host-class-keyed + gitignored

**Durable / shareable → commit under the repo:**
- loop artifacts (candidates, scores, ab-verdicts) → `term-bench2/store/` snapshot
  via **surgical, diff-first** sync (blind `store-sync.sh export` is the data-loss trap)
- reusable scripts / recipes / procedures → the repo (or transcribe the exact steps
  into `docs/resume.md` so they reconstruct on any host)
- design, state, decisions → `docs/` + the `docs/resume.md` handoff

**Live proof:** a paused k=5 ab partial left in `.kkamak/` on one host is
stranded — another host cannot resume it. If it needs sharing, it must reach the
committed snapshot.
