import { test, expect } from "bun:test"
import { promptHumanScore, handleScoreCommand } from "../src/score.ts"
import type { HarnessHost } from "../src/host.ts"

// Token-free: stubs host.showScorePrompt so promptHumanScore's prompt-side
// call is captured instead of hitting a real TUI (the toast/clearPrompt/
// appendPrompt decomposition of showScorePrompt is OpencodeHost's job —
// covered by host-opencode.test.ts). Exercises the D4 maker-checker prefill
// param: default vs. judge-supplied prefill, and the copy that flags a judge
// suggestion, plus the pending-Promise/timeout machinery that stayed in
// score.ts.

function fakeHost() {
  const calls = {
    toastMessages: [] as string[],
    appendedTexts: [] as string[],
  }
  const host: HarnessHost = {
    platform: "fake",
    projectRoot: "/unused",
    log: async () => {},
    notify: async () => {},
    showScorePrompt: async (text, isJudgeSuggestion) => {
      calls.toastMessages.push(
        isJudgeSuggestion
          ? "Type /mh-score good  or  /mh-score bad (judge suggestion — edit if wrong)"
          : "Type /mh-score good  or  /mh-score bad",
      )
      calls.appendedTexts.push(text)
    },
    runTextAgent: async () => null,
    runTaskAgent: async () => null,
    exec: async () => ({ stdout: "", exitCode: 0 }),
  }
  return { host, calls }
}

async function resolveShortly(sessionID: string, verdict: "good" | "bad" = "good") {
  // Give promptHumanScore's internal awaits (showToast/clearPrompt/appendPrompt)
  // a chance to run and register the pending resolver before we "type" the
  // slash command.
  await new Promise((r) => setTimeout(r, 10))
  handleScoreCommand("mh-score", verdict, sessionID)
}

test("promptHumanScore defaults to the plain /mh-score good prefill", async () => {
  const { host, calls } = fakeHost()
  const sessionID = "sess-default"

  const pending = promptHumanScore(host, sessionID, 5_000)
  await resolveShortly(sessionID)
  const result = await pending

  expect(calls.appendedTexts).toEqual(["/mh-score good"])
  expect(calls.toastMessages[0]).not.toContain("judge suggestion")
  expect(result).toEqual({ passed: true, note: "" })
})

test("promptHumanScore honors a custom judge prefill and flags it in the toast", async () => {
  const { host, calls } = fakeHost()
  const sessionID = "sess-prefill"
  const prefill = "/mh-score bad judge: looked wrong to me"

  const pending = promptHumanScore(host, sessionID, 5_000, prefill)
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
  const { host, calls } = fakeHost()
  const sessionID = "sess-explicit-default"
  const pending = promptHumanScore(host, sessionID, 5_000, "/mh-score good")
  resolveShortly(sessionID)
  return pending.then(() => {
    expect(calls.toastMessages[0]).not.toContain("judge suggestion")
  })
})
