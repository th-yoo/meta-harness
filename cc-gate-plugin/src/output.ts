import type { DeliveryMode, EmitPlan, StopDecision } from "./types.ts"

export function buildStopOutput(d: StopDecision, mode: DeliveryMode): EmitPlan {
  // Allow-family decisions are mode-independent
  if (d.kind === "allow") {
    return { exitCode: 0 }
  }

  if (d.kind === "allow-with-marker") {
    return {
      stdout: {
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: d.marker,
        },
      },
      exitCode: 0,
    }
  }

  if (d.kind === "allow-exhausted") {
    return {
      stdout: {
        systemMessage: d.message,
      },
      exitCode: 0,
    }
  }

  // Block decisions apply mode seam
  if (d.kind === "block") {
    switch (mode) {
      case "block-json":
        return {
          stdout: {
            decision: "block",
            reason: d.evidence,
          },
          exitCode: 0,
        }

      case "exit2-stderr":
        return {
          stderr: d.evidence,
          exitCode: 2,
        }

      case "block-json+context":
        return {
          stdout: {
            decision: "block",
            reason: d.evidence,
            hookSpecificOutput: {
              hookEventName: "Stop",
              additionalContext: d.evidence,
            },
          },
          exitCode: 0,
        }
    }
  }

  const _exhaustive: never = d
  return _exhaustive
}
