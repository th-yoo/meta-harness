# Tier 3 — Interactive Plugin Loop Test Manual

Exercises the full evolution loop through the opencode TUI: score → auto-propose
→ trial → confirm/revert, plus the account-layer ab gate. Cannot be driven
headlessly (scoring is interactive), so follow this by hand.

Target layer: **project-role** (cheapest full loop — uses the 5-session trial
gate, no token-heavy `runner.py ab`).

Facts baked into this manual (from the code):
- Scoring fires on **session.idle**, once per substantive session. A session with
  0 turns, or 0 tool calls AND a <50-char response, is auto-skipped as degenerate.
- One score per session → to accumulate N scores, use N separate sessions.
- `PROJECT_ROLE_THRESHOLD = 5` → auto-propose fires when project-role hits 5 scored
  sessions and no trial is in flight. (Current count: **2**, so 3 more triggers it.)
- Proposer model is pinned to `anthropic/claude-opus-4-8` (runs in a background session).
- For project layers, propose/curate **auto-start a trial** (candidate live provisionally).
- `TRIAL_MIN_SESSIONS = 5` → trial confirms (keep candidate) or reverts (back to
  baseline) after 5 more scored sessions, decided in the idle hook.
- Scope keywords: `role`=project-role, `project`=project-global,
  `role-global`=account-role, `account`=account-global.

---

## Part 0 — Load the plugin fix (required first)

The `/mh-status` toast fix only takes effect after opencode reloads the plugin.

1. **Quit opencode entirely** (not just the session).
2. Reopen it in the repo: `cd ~/z2/meta-harness && opencode`.

---

## Part A — Verify /mh-status (the fix)

3. Type `/mh-status` and press Enter.
   - **Expect:** a toast (top-right) titled **Meta-Harness** showing 4 lines:
     ```
     account-global: active=v0 (2/2)
     project-global: active=v3 (2/2)
     account-role:   active=v0 (2/2)
     project-role:   active=v0 (2/2)
     ```
   - If the toast appears → the fix works; continue.
   - If still nothing → stop and tell me (showToast itself isn't rendering).

---

## Part B — Select the harness agent

4. New sessions start on **mh-build** automatically (`default_agent` in
   opencode.json). If you switch agents mid-session, the plugin now follows:
   - switch **to** an mh-* agent → toast `Harness active for mh-build from this
     turn…`; the session's fitness counters reset, and only work done **after**
     the switch is scored (pre-switch turns ran without the harness and are
     discarded from the signal).
   - switch **away** from an mh-* agent → toast `harness inactive; this session
     will no longer be scored`.
   - Verify any time: `/mh-status` shows `this session: agent=mh-build, scoring ON`,
     or `grep 'session.idle' ~/.local/share/opencode/log/opencode.log | tail -1`
     → `agent=mh-build`.
   - Note: after a switch you must still do **substantive work** (a tool call) —
     switching and going idle immediately is skipped as a degenerate session.

---

## Part C — Generate scored sessions → trigger propose

You need project-role to reach 5 scored sessions. It's at 2, so do **3 more**.
Make them substantive (the agent must use a tool — read/edit/bash), or they'll be
skipped. **Score at least one as `bad`** so a failing trajectory is captured — that
gives the proposer a real root cause to diagnose.

For each of the 3 sessions:

5. Start a **fresh session** (opencode: `/new`, or the new-session shortcut).
6. Give the agent a small real task, e.g.:
   - good-path: *"Create /tmp/mh_t1.txt containing the number of .py files under term-bench2, then read it back."*
   - fail-path (score this one bad): *"Count the tokens in term-bench2/manifest.json using `python` (not python3) and write the total to /tmp/mh_t2.txt."* (the agent may stumble; score it bad regardless if the result is wrong.)
7. When the agent finishes and the session goes idle, the plugin **pre-fills
   `/mh-score good` into the prompt box and shows a toast**. Edit it to `good` or
   `bad` (optionally `bad <short note>`), then press Enter.
   - **Expect toast:** `Score recorded: ✓ good` (or `✗ bad`) `(mh-build project-role: X/Y)`.

8. After the **3rd** new score (project-role total = 5), the idle hook auto-fires
   the proposer.
   - **Expect toast:** `Starting proposer for project-role → v1 ...` then, ~1 min
     later, **`Trial started: project-role v1 (baseline v0) — resolves after 5
     scored sessions`**.
   - (If you'd rather not wait for the 5th: run `/mh-propose role` manually at any
     point — same effect.)

9. `/mh-status` → project-role line should now read:
   `project-role: active=v1 (0/... ) [N bullets] | TRIAL v1 vs v0 (0/5)`.

---

## Part D — Confirm/revert the trial

10. Do **5 more** fresh substantive sessions (Part C steps 5–7), scoring each.
    Score them realistically — the trial keeps v1 only if its pass-rate ≥ baseline.
11. After the 5th trial score, the idle hook runs `resolveTrial`.
    - **Expect toast:** `Trial confirmed: project-role v1` (kept) **or**
      `Trial reverted: project-role → v0` (rolled back).
12. `/mh-status` → confirm the active version matches the resolution (v1 if
    confirmed, v0 if reverted; no more `TRIAL` marker).

---

## Part E — (Optional) Curate the playbook

13. `/mh-curate role` → curator (opus-4-8, background) dedups/prunes bullets and
    stages the result **as a new trial** (same gate as propose).
    - **Expect toast:** `curate cycle started ✓`, then a `Trial started` toast.
    - Resolve it with 5 more scored sessions (Part D).
    - Note: only run this when no trial is already in flight (`/mh-status` shows no
      TRIAL), else it's a no-op.

---

## Part F — Prove the account-layer ab gate (no tokens)

This demonstrates the Phase-1 gate refusing an unproven account candidate — and
also exercises the fixed error-toast path.

14. `/mh-activate account v1`
    - **Expect toast (error/red):** `no ab-verdict.json for account-global v1 —
      run "runner.py ab --layer account-global --candidate v1" first, or pass --force`.
    - (There is no account-global v1, and even if there were, without an accepted
      ab-verdict the gate refuses. This is the intended behavior.)

---

## Part G — Judge shadow-mode (optional)

This demonstrates the dense judge (Phase 4) in shadow mode: it scores sessions in
parallel with `/mh-score`, learning when to calibrate for maker-checker mode.

15. Enable the judge in `~/.config/opencode/.meta-harness/config.json`:
    ```json
    {"judgeModel": "openrouter/google/gemini-2.5-flash"}
    ```
    Restart opencode for the config to reload.

16. Run a few substantive sessions (with tool calls) and score them with `/mh-score good`
    or `/mh-score bad` as usual. The judge runs silently in the background.
    - **Look for:** after each session, check the opencode log:
      `grep 'judge' ~/.local/share/opencode/log/opencode.log | tail -5`
    - **Expect log lines** like: `[judge] AGREE/DISAGREE with human … calibration 3/20 @ 75%`
    - **In latest trace:** `session.meta-harness/traces/*.json` contains a `record.judge`
      field with the verdict.

17. In `/mh-status`, observe:
    - **Line at bottom:** shows judge calibration state if enabled (e.g.,
      `judge: 15/20 @ 82% (calibrated)` or `judge: 8/20 @ 65%`).
    - Once calibrated (≥20 sessions at ≥80%): `/mh-score` pre-fills with the judge's
      suggestion for you to approve or edit.

18. Check observability:
    - `python3 term-bench2/runner.py report-loop [--json]` → includes judge agreement
      window in the summary.
    - `cat ~/.config/opencode/.meta-harness/meta-metrics.jsonl | grep judge | tail -5`
      → judge events recorded (one per scored session when judgeModel is set).

---

## What to report back

For each part, tell me the toast text you saw (or "nothing"). Most useful:
- Part A: did the status toast render? (confirms the fix)
- Part C step 8: proposer + "Trial started" toasts?
- Part D step 11: confirmed or reverted?
- Part G (if run): judge log lines and calibration state in `/mh-status`?
- Any part where a toast was expected but nothing appeared.

If a step misbehaves, also grep the log for the ground truth:
`grep -E 'meta-harness|hook:event|hook:command|Trial|proposer|judge' ~/.local/share/opencode/log/opencode.log | tail -40`
