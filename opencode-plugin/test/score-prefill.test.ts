import { test, expect } from "bun:test"
import { promptHumanScore, handleScoreCommand } from "../src/score.ts"

// Token-free: stubs client.tui so promptHumanScore's toast/clearPrompt/
// appendPrompt calls are captured instead of hitting a real TUI. Exercises
// the D4 maker-checker prefill param: default vs. judge-supplied prefill,
// and the toast copy that flags a judge suggestion.

function fakeClient() {
  const calls = {
    toastMessages: [] as string[],
    appendedTexts: [] as string[],
    clearCount: 0,
  }
  const client: any = {
    tui: {
      showToast: async ({ body }: any) => {
        calls.toastMessages.push(body.message)
      },
      clearPrompt: async () => {
        calls.clearCount++
      },
      appendPrompt: async ({ body }: any) => {
        calls.appendedTexts.push(body.text)
      },
    },
  }
  return { client, calls }
}

async function resolveShortly(sessionID: string, verdict: "good" | "bad" = "good") {
  // Give promptHumanScore's internal awaits (showToast/clearPrompt/appendPrompt)
  // a chance to run and register the pending resolver before we "type" the
  // slash command.
  await new Promise((r) => setTimeout(r, 10))
  handleScoreCommand("mh-score", verdict, sessionID)
}

test("promptHumanScore defaults to the plain /mh-score good prefill", async () => {
  const { client, calls } = fakeClient()
  const sessionID = "sess-default"

  const pending = promptHumanScore(client, sessionID, 5_000)
  await resolveShortly(sessionID)
  const result = await pending

  expect(calls.appendedTexts).toEqual(["/mh-score good"])
  expect(calls.toastMessages[0]).not.toContain("judge suggestion")
  expect(result).toEqual({ passed: true, note: "" })
})

test("promptHumanScore honors a custom judge prefill and flags it in the toast", async () => {
  const { client, calls } = fakeClient()
  const sessionID = "sess-prefill"
  const prefill = "/mh-score bad judge: looked wrong to me"

  const pending = promptHumanScore(client, sessionID, 5_000, prefill)
  await resolveShortly(sessionID, "bad")
  const result = await pending

  expect(calls.appendedTexts).toEqual([prefill])
  expect(calls.toastMessages[0]).toContain("judge suggestion — edit if wrong")
  expect(result).toEqual({ passed: false, note: "" })
})

test("promptHumanScore treats an explicit default-valued prefill as non-judge", () => {
  // Passing the literal default string should not be flagged as a judge
  // suggestion — only a prefill argument DIFFERENT from the default triggers
  // the "(judge suggestion — edit if wrong)" toast copy. This documents the
  // `prefill !== DEFAULT_PREFILL` check rather than `prefill !== undefined`.
  const { client, calls } = fakeClient()
  const sessionID = "sess-explicit-default"
  const pending = promptHumanScore(client, sessionID, 5_000, "/mh-score good")
  resolveShortly(sessionID)
  return pending.then(() => {
    expect(calls.toastMessages[0]).not.toContain("judge suggestion")
  })
})
