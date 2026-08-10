---
description: "Activate a candidate version: /mh-activate <scope> <vN> [--force]. Account scopes require a winning ab-verdict.json (use --force to override). Scope: role|project|role-global|account"
---

mh:passthrough $ARGUMENTS
<!-- Fallback only: UserPromptSubmit intercepts the raw /mh-* prompt text
     before this body would ever be expanded (see dispatch.ts). This line
     only matters if the meta-harness hooks are disabled. -->
