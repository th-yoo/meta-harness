---
description: "Show meta-harness per-layer state: active version, scores, in-progress trials, and pending candidate ab-verdicts."
---

mh:passthrough $ARGUMENTS
<!-- Fallback only: UserPromptSubmit intercepts the raw /mh-* prompt text
     before this body would ever be expanded (see dispatch.ts). This line
     only matters if the meta-harness hooks are disabled. -->
