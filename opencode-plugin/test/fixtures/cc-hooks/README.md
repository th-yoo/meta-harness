# cc-hooks fixtures

Recorded hook stdin JSON shapes from claude 2.1.207 (Task L6 live probes).
Provenance: scratchpad/cc-verify/logs/{SessionStart,UserPromptSubmit,PreToolUse,PostToolUse,Stop}.log
captured by scratchpad/cc-verify/hooks/log_hook.sh. Each file is the exact inner
stdin object one hook process received. Tests override `cwd` and `session_id`
to point at hermetic tmp dirs; every other field is verbatim from the probes.
The two `*-crafted.json` files carry a real shape with a synthesized `prompt`
(the probes never typed an /mh-* slash command).
