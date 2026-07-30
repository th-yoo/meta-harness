---
description: Initialize kkamak gate.json with auto-detected test command
---

# kkamak init — Set up gate.json

> Token-free alternative: `bun "${CLAUDE_PLUGIN_ROOT:-cc-gate-plugin}/src/init-cli.ts" [--check <cmd>] [--gauge] [--force] [--dry-run]` detects and writes gate.json without a model call — use this command only when you want the interactive walkthrough.

You are helping the user set up kkamak, a gate that runs a verification check when Claude finishes responding after edits. Follow these steps:

## Step 1: Detect the test command

Read the current repo to find a cheap verification command. Check in this order:
1. Look for `/package.json` at the repo root. If it exists, read it and check the `scripts` object. Prefer a `test` script if present; accept `lint`, `check`, or similar verification commands.
2. If there's a `bun.lock` file or `@types/bun` reference (meaning the project uses Bun), suggest `bun test` if no npm script is found.
3. If no test command is detectable, say so and skip to Step 4.

**Important:** Do NOT scan Makefile, pyproject.toml, justfile, or other build systems yet (deferred for v0.2).

## Step 2: Propose gate.json

If you found a test command, compose this JSON structure:

```json
{
  "check": "<detected command>",
  "rounds": 2
}
```

Replace `<detected command>` with what you found (e.g., `npm test`, `bun test`, `npm run check`). This will run the check after Claude finishes editing.

Show the proposed gate.json to the user in a code block. Explain briefly: this runs when Claude finishes responding—keep it cheap (2–5 sec, not full builds).

**Then ask:** "Approve this gate.json? (y/n)"

Wait for the user's response before proceeding.

## Step 3: Write gate.json (approval only)

If the user approves:
1. Write `gate.json` at the repo root with the proposed JSON.
2. After writing, suggest: "Consider adding `.km/` to your `.gitignore` (kkamak's runtime state). Would you like me to do that? (y/n)"
3. If user says yes, add `.km/` to `.gitignore` if not already present.
4. Report success: "✓ gate.json written. Gate is now active."

If the user declines, stop and say "Skipped gate.json setup."

## Step 4: No test command found

If you couldn't detect a command:
1. Say so: "No test command detected in package.json or bun.lock."
2. Show this template:
   ```json
   {
     "check": "<your verification command here>",
     "rounds": 2
   }
   ```
3. Ask the user: "What command should I use to verify your work?" (E.g., `npm test`, `make check`, `python -m pytest`, etc.)
4. Once they tell you, use that value and proceed as in Step 2.

---

## Tone & Context

- Keep explanations brief and practical.
- The check runs automatically after Claude edits—it should be **cheap** (a fast lint or unit-test suite, not a full build or deployment).
- This is v0.1; other build systems (Makefile, pyproject, justfile) are deferred.
- If at any point the user wants to skip or stop, honor that.
