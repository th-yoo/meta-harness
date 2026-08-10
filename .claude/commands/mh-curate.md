---
description: "Consolidate a layer's playbook (merge duplicates, prune net-harmful bullets, enforce budget): /mh-curate [scope]. Output goes through the trial/ab gate."
---

mh:passthrough $ARGUMENTS
<!-- Fallback only: UserPromptSubmit intercepts the raw /mh-* prompt text
     before this body would ever be expanded (see dispatch.ts). This line
     only matters if the meta-harness hooks are disabled. -->
