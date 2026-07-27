import { describe, it, expect } from "bun:test"
import { buildStopOutput } from "../src/output.ts"
import type { DeliveryMode, StopDecision } from "../src/types.ts"

describe("buildStopOutput", () => {
  const modes: DeliveryMode[] = ["block-json", "exit2-stderr", "block-json+context"]

  describe("block decisions with mode seam", () => {
    const blockDecision: StopDecision = {
      kind: "block",
      evidence: "policy violation detected",
      round: 1,
      roundsMax: 3,
    }

    it("block + block-json", () => {
      const result = buildStopOutput(blockDecision, "block-json")
      expect(result).toEqual({
        stdout: {
          decision: "block",
          reason: "policy violation detected",
        },
        exitCode: 0,
      })
      expect(result.stderr).toBeUndefined()
    })

    it("block + exit2-stderr", () => {
      const result = buildStopOutput(blockDecision, "exit2-stderr")
      expect(result).toEqual({
        stderr: "policy violation detected",
        exitCode: 2,
      })
      expect(result.stdout).toBeUndefined()
    })

    it("block + block-json+context", () => {
      const result = buildStopOutput(blockDecision, "block-json+context")
      expect(result).toEqual({
        stdout: {
          decision: "block",
          reason: "policy violation detected",
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: "policy violation detected",
          },
        },
        exitCode: 0,
      })
      expect(result.stderr).toBeUndefined()
    })
  })

  describe("allow-family decisions are mode-independent", () => {
    it("allow returns identical output for all modes", () => {
      const allowDecision: StopDecision = { kind: "allow" }
      const results = modes.map((mode) => buildStopOutput(allowDecision, mode))

      // All results should be identical
      const first = results[0]!
      results.forEach((result) => {
        expect(result).toEqual(first)
      })

      // Verify the shape: plain allow has no stdout/stderr keys
      expect(first).toEqual({
        exitCode: 0,
      })
      expect(first.stdout).toBeUndefined()
      expect(first.stderr).toBeUndefined()
    })

    it("allow-with-marker returns identical output for all modes", () => {
      const allowMarkerDecision: StopDecision = {
        kind: "allow-with-marker",
        marker: "verification-checkpoint-1",
      }
      const results = modes.map((mode) => buildStopOutput(allowMarkerDecision, mode))

      // All results should be identical
      const first = results[0]!
      results.forEach((result) => {
        expect(result).toEqual(first)
      })

      // Verify the shape
      expect(first).toEqual({
        stdout: {
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: "verification-checkpoint-1",
          },
        },
        exitCode: 0,
      })
      expect(first.stderr).toBeUndefined()
    })

    it("allow-exhausted returns identical output for all modes", () => {
      const exhaustedDecision: StopDecision = {
        kind: "allow-exhausted",
        message: "gate rounds exhausted, proceeding",
      }
      const results = modes.map((mode) => buildStopOutput(exhaustedDecision, mode))

      // All results should be identical
      const first = results[0]!
      results.forEach((result) => {
        expect(result).toEqual(first)
      })

      // Verify the shape
      expect(first).toEqual({
        stdout: {
          systemMessage: "gate rounds exhausted, proceeding",
        },
        exitCode: 0,
      })
      expect(first.stderr).toBeUndefined()
    })
  })

  describe("edge cases", () => {
    it("block with empty evidence string", () => {
      const blockDecision: StopDecision = {
        kind: "block",
        evidence: "",
        round: 0,
        roundsMax: 1,
      }
      const result = buildStopOutput(blockDecision, "block-json")
      expect(result).toEqual({
        stdout: {
          decision: "block",
          reason: "",
        },
        exitCode: 0,
      })
    })

    it("allow-with-marker with special characters in marker", () => {
      const allowMarkerDecision: StopDecision = {
        kind: "allow-with-marker",
        marker: "marker-with-\n-newline-and-\t-tab",
      }
      const result = buildStopOutput(allowMarkerDecision, "block-json")
      expect(result).toEqual({
        stdout: {
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: "marker-with-\n-newline-and-\t-tab",
          },
        },
        exitCode: 0,
      })
    })

    it("allow-exhausted with multiline message", () => {
      const exhaustedDecision: StopDecision = {
        kind: "allow-exhausted",
        message: "rounds exhausted\nproceeding with caution\ncheck logs",
      }
      const result = buildStopOutput(exhaustedDecision, "exit2-stderr")
      expect(result).toEqual({
        stdout: {
          systemMessage: "rounds exhausted\nproceeding with caution\ncheck logs",
        },
        exitCode: 0,
      })
    })
  })
})
