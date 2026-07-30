import { describe, expect, test } from "bun:test"
import { renderDockerfile, renderInstruction, renderTaskToml, renderTestSh } from "../src/tb2-task"

describe("renderTaskToml", () => {
  const toml = renderTaskToml({
    name: "harvested-kkamak-20260731-101500",
    description: "Harvested blocked cycle: bun test failing after agent turn",
    check: "bun test",
    agentTimeoutSec: 900, verifierTimeoutSec: 300,
  })
  test("carries schema 1.1, name, harvested category, internet on", () => {
    expect(toml).toContain('schema_version = "1.1"')
    expect(toml).toContain('name = "terminal-bench/harvested-kkamak-20260731-101500"')
    expect(toml).toContain('category = "harvested"')
    expect(toml).toContain("allow_internet = true")
  })
  test("verifier and agent timeouts in correct sections", () => {
    expect(toml).toContain("[verifier]\ntimeout_sec = 300.0")
    expect(toml).toContain("[agent]\ntimeout_sec = 900.0")
  })
})

describe("renderDockerfile", () => {
  const df = renderDockerfile({})
  test("ubuntu 24.04 base, bun install, repo copied to /app", () => {
    expect(df).toContain("FROM ubuntu:24.04")
    expect(df).toContain("bun.sh/install")
    expect(df).toContain("COPY repo/ /app/")
    expect(df).toContain("WORKDIR /app")
  })
})

describe("renderTestSh", () => {
  const sh = renderTestSh({ check: "bun test" })
  test("tamper guard restores pristine test files before the check", () => {
    expect(sh).toContain("pristine.tar")
    expect(sh).toContain("( bun test )")
    expect(sh).toContain("/logs/verifier/reward.txt")
  })
  test("check command is not shell-mangled", () => {
    expect(renderTestSh({ check: 'bun test --filter "x y"' })).toContain('( bun test --filter "x y" )')
  })
  test("semicolon-chained check is wrapped in subshell", () => {
    expect(renderTestSh({ check: "make build; make test" })).toContain("( make build; make test )")
  })
})

describe("renderInstruction", () => {
  test("includes prompt context, check command, and failure excerpt", () => {
    const md = renderInstruction({
      check: "bun test",
      prompt: { firstUser: "build the parser", lastUser: "now make tests pass" },
      excerpt: "1 fail: parser.test.ts",
    })
    expect(md).toContain("build the parser")
    expect(md).toContain("bun test")
    expect(md).toContain("parser.test.ts")
  })
})
