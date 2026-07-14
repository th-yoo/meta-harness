# Loop-1 state (first propose→ab, #5) — cross-host continuation note

Written 2026-07-14 to resume on another host. The bench code + splits + plan are
git-tracked (transfer); the **account store and personal memory are host-local
(do NOT transfer)** — see "What's host-local" below.

## Status

| step | state |
|------|-------|
| baseline (haiku, --layers account, k5) | ✅ **pass@5 = 16/42 = 0.381** (42/43; results file gitignored) |
| `split make --band 0.2,0.8 --sentinels 3 --folds 2` | ✅ `term-bench2/splits/loop1.json` — **14 band tasks** (2 folds ×7) + 3 sentinels |
| store-writing band run (k2, feeds proposer) | ✅ 4 failure trajectories into `account-global` v0 |
| **propose → account-global v1** | ✅ opus-4-8; playbook + diagnosis below |
| `ab` v0 vs v1 (paired McNemar) | ⬜ **NEXT** — ~3–5 hr, resumable |
| activate on accept | ⬜ |

## v1 content (preserved here — the candidate itself is host-local)

**diagnosis.json** (3 failures):
- `large-scale-text-editing` — **spec-misread**: substituted `:@a` for the required `:%normal! @a`, rationalized the explicit requirement as "just examples".
- `harness-store count` — **tool-misuse**: unscoped repo-wide grep → reported an ungrounded "57".
- `kv-store-grpc` — **tool-misuse**: backgrounded server (`python server.py &`) held the shell's stdio → bash tool blocked to timeout.

**v1 playbook (rendered system.md):**
- **Satisfy the literal, checkable spec** — when a task names an exact mechanism/command/syntax/format, satisfy it literally; equivalent output a different way is a failure; debug the required mechanism instead of swapping your own; re-read the request and confirm every constraint before declaring done.
- **Ground every factual claim in tool output** — no estimated/guessed counts; run a command that produces the exact number; scope searches to exactly the target file/path.
- **Don't let a single command consume the whole budget** — never run a long-lived/blocking process in the foreground of a shell tool; detach from stdio so the command returns immediately, verify separately.

## To resume `ab` on this (Linux) host

```
bun term-bench2/runner.ts ab --layer account-global --candidate v1 \
  --split-file term-bench2/splits/loop1.json --model anthropic/claude-haiku-4-5 --k 2 --resume
```
Defaults: alpha 0.05, nonregress-margin 0.05, min-tasks-before-stop 12, early-stop on. Then `report-loop`; `/mh-activate account v1` on accept (needs the accepted ab-verdict).

## What's host-local (NOT in git — blocks a clean MacBook continuation of ab)

- **Account store** `~/.config/meta-harness/global/` — v0 diet + **the v1 candidate**. The MacBook won't have v1.
- Baseline results file (gitignored).
- Personal memory `~/.claude/projects/.../memory/` (incl. `[[static-loop-mechanics]]`).

**On the MacBook, to run `ab` you need v1 in its store. Either:** (a) `scp -r ~/.config/meta-harness` from this host to the MacBook (fastest — carries v0 diet + v1); or (b) re-run the loop from the git-tracked split: store-writing band run → `/mh-propose account` (re-derives a v1 from fresh trajectories — will differ). Option (a) preserves THIS v1.

## Gotchas that bit us (also in `improvement-loops.md` §3)
- Account-scope propose needs `opencode.json` → `"permission": {"external_directory": "allow"}` (the account store is outside the worktree; without it the headless proposer hangs on a permission prompt). **Committed to `opencode.json`.**
- `--results-file` forces `--no-store`; store-writing runs aren't resumable; Phase-0 self-check can't piggyback.
