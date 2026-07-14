# External practice mining — OpenClaw "vibe coding" best practices

Source: https://roboco.io/posts/openclaw-vibe-coding-best-practices/ (mined 2026-07-14).

**Why this doc:** the post describes, by hand, the loop meta-harness automates —
"add a rule to `AGENTS.md` whenever an agent fails" is exactly what the proposer
does from failure trajectories, but the post has **no regression gate** ("prompt
edits regressed in 5 of 7 iterations"), which is precisely what our
sentinels + McNemar `ab` exist to prevent. So the post is not a blueprint to
copy — it is a **rule corpus** to feed (or seed) our automated loop, plus
external validation of the architecture.

## Verdict

Mostly **validates** our architecture; ~4 concrete adoptable items. We diverge
where it matters: they hand-curate, we evolve under a statistical selection gate.

## Mapping — blog practice → our equivalent

| Blog best practice | Our system | Gap? |
|---|---|---|
| Living `AGENTS.md`, rules added reactively on failure | evolving `system.md`/playbook via propose (ACE ops) | we **automate** the reactive add |
| Research→Plan→Implement + plan-approval gate | squad **A→D→I→E** + gate2 | aligned |
| Star gateway daemon → agent instances, each own workspace + `SOUL/MEMORY/USER.md` | fleet **master (OpenClaw)** star topology + per-role stores | validates topology + per-node memory |
| Agents = managed juniors; human = taste/architecture | fleet role split (human-score architect; auto impl+eval) | aligned ([[fleet-roles-mh-mapping]]) |
| Conventional commits w/ subsystem scopes | already used repo-wide | could be a harness rule |
| AI-PR transparency (tool use, test level, logs) | provenance fields + trajectories | aligned |
| Automate no-taste ops (labeling, stale-close, secret scan) | CI gates + squad-propose cred-scrub | partial / orthogonal |

## Adoptable gaps

1. **Multi-agent collision rules as harness content.** For the real-repo fleet:
   adopt their *shared-workspace + discipline* model OR keep our *worktree
   isolation* (best-of-k B1, the registered write-merge primitive). Decision:
   **keep worktree isolation for parallel writers; adopt the collision *content*
   as `system.md` bullets for the shared-tree case.** Keep our gate regardless.
2. **Concrete prompt-anchoring bullets** — the highest-signal borrowable content;
   exactly the playbook the proposer should converge on (see seed list).
3. **Human/agent responsibility boundary as explicit policy** — manual for
   auth/payments/data/schema/security; agent for scaffolding/boilerplate.
   Belongs in the **master gate-policy + escalation taxonomy** (the "won't turn
   off ecmo" Refused case is this).
4. **`CLAUDE.md`→`AGENTS.md` symlink** — cross-driver (opencode/CC) compat.
   Trivial; we already run both drivers.

## Seed-bullet corpus (proposer diet / fallback seeds)

Concrete rules distilled from the post. **First test whether propose discovers
them from failure trajectories** (loop-1 v1). Divergence = a proposer-diet gap →
seed the missing ones into the account-global playbook.

**A. Read-before-write / plan discipline**
- Read the file(s) you are about to change before editing; never edit from memory.
- State the files you will modify and the expected change per file before writing code.
- Run the project's tests after each change; treat superficially-correct output as suspect until tested.

**B. Prompt / output anchoring**
- Emit only the modified functions, not the entire file.
- Keep diffs small and focused; one concern per change.
- Follow the patterns already present in the nearest sibling module.
- Respect explicit scope anchors (e.g. "payment flow only; never touch auth").

**C. Multi-agent collision (shared-tree case)**
- Check `git status` / `git diff` before modifying files.
- Each commit atomic and scoped; conventional `type(scope): desc`.
- Never `git stash`; never switch branches without an explicit request.
- If unexplained changes appear, assume another agent is working — continue, don't clobber.

**D. Responsibility boundary (master policy, not agent-editable)**
- Security-touching paths (auth, payments, data access, DB schema, permissions)
  require human confirmation → escalate rather than auto-apply.

## Where we go further

They curate by hand; we evolve `system.md` under a **selection gate** (trial /
exact McNemar + sentinels + held-out). Their reported pain — regressions from
prompt edits — is the exact failure mode our gate exists to prevent. See
[[static-loop-mechanics]] and `docs/improvement-loops.md`.

## Action (ties to loop-1)

After propose emits account-global v1, diff its playbook against the seed corpus
above. Items it discovered independently = validation; items missing = seed
candidates for a later round. Do NOT hand-seed before measuring what the loop
finds on its own (that's the whole experiment).
