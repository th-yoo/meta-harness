---
description: "Rate the last session: /mh-score good|bad [note]  (accepted: good/bad/1/0/yes/no)"
---

mh:passthrough $ARGUMENTS
<!-- Fallback only: UserPromptSubmit intercepts the raw /mh-* prompt text
     before this body would ever be expanded (see dispatch.ts). This line
     only matters if the meta-harness hooks are disabled. -->
