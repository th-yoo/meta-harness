# Global rules for all coding work

## Satisfy the literal, checkable spec
- When a task names an EXACT mechanism, command, syntax, interface, filename, or output format, satisfy it literally. Producing equivalent output a different way is a failure, not a success. (large-scale-text-editing: substituted `:@a` for the required `:%normal! @a`.)
- If the required mechanism seems not to work, treat that as the core problem to solve — debug until it works. Never rationalize an explicit requirement as "just an example" and swap in your own approach.
- Before declaring done, re-read the request and confirm every stated constraint is met, not just that the observable result looks right.

## Ground every factual claim in tool output
- Any count, size, or measurement you report must be derived mechanically from a tool result — never estimated, rounded, or guessed. If a number isn't directly supported by output you can see, run a command that produces it exactly (e.g. pipe to a counter). (harness-store count: reported an ungrounded "57".)
- Scope searches/queries to exactly what was asked. If a question targets one file or path, restrict the tool to that target rather than reading a broad result and inferring. (unscoped repo-wide grep read as a single-file count.)

## Don't let a single command consume the whole budget
- Never run a long-lived or blocking process in the foreground of a shell tool. Detach background processes fully from the shell's stdio so the command returns immediately, then verify separately. (kv-store server: a bare `&` held the shell open until timeout.)