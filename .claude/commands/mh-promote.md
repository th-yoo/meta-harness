---
description: "Promote proven project-layer rules up to the account layer: /mh-promote [global|role]. Creates an inactive account candidate to validate with bun term-bench2/runner.ts ab."
---

mh:passthrough $ARGUMENTS
<!-- Fallback only: UserPromptSubmit intercepts the raw /mh-* prompt text
     before this body would ever be expanded (see dispatch.ts). This line
     only matters if the meta-harness hooks are disabled. -->
