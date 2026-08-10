---
description: "Trigger a meta-harness proposer. Scope: (none)=project-role, project=project-global, role-global=account-role, account=account-global"
---

mh:passthrough $ARGUMENTS
<!-- Fallback only: UserPromptSubmit intercepts the raw /mh-* prompt text
     before this body would ever be expanded (see dispatch.ts). This line
     only matters if the meta-harness hooks are disabled. -->
