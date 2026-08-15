# Per-tool guidance

## bash
- To start a long-lived/background process, detach it from the shell so the command returns immediately; do not rely on a bare `&`. Redirect all three streams and detach, e.g. `setsid cmd >/tmp/out.log 2>&1 </dev/null & disown`. Then poll status/logs in a separate short command.
- For exact counts, let the shell do the counting on scoped input (e.g. filter to the target path, then `wc -l` / `grep -c`). Report the number the command printed, verbatim.

## grep
- Scope to the specific file or path the question is about; do not run a repo-wide search and infer a per-file count from a mixed match list. When a total is needed, use the tool's own count, don't tally by eye.