import { describe, expect, test } from "bun:test"
import { renderDockerfile, renderInstruction, renderTaskToml, renderTestSh } from "../src/tb2-task"

describe("renderTaskToml", () => {
  const toml = renderTaskToml({
    name: "harvested-kkamak-20260731-101500",
    description: "Harvested blocked cycle: bun test failing after agent turn",
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
  test("python3 in the toolchain — repo scripts shell out to it; without it the check fails for image reasons, not harvested ones", () => {
    expect(df).toContain("python3")
  })
  test("initializes a git repo and commits the tree — checks that shell out to git need .git (47M probe defect 1)", () => {
    expect(df).toContain("git init")
    expect(df).toContain("git commit")
    // identity must be GLOBAL: repo-local config only covers /app, but test
    // suites create scratch repos and run bare `git merge` — without an
    // ambient identity those die "unable to auto-detect email" (exit 128)
    // before writing MERGE_HEAD, a failure class a dev host never sees
    expect(df).toContain("git config --global user.email")
    expect(df).toContain("git config --global user.name")
    // commit happens after the tree lands
    expect(df.indexOf("COPY repo/ /app/")).toBeLessThan(df.indexOf("git init"))
  })
  test("installs every package.json dir, not just the root — monorepo roots may have no package.json (47M probe defect 2)", () => {
    expect(df).toContain("-name package.json")
    expect(df).toContain("*/node_modules/*")
    expect(df).toContain("bun install --frozen-lockfile || bun install")
    // no bare root-only install line left behind
    expect(df).not.toMatch(/RUN bun install --frozen-lockfile \|\| bun install \|\| true\n/)
  })
  test("git commit precedes dependency install so node_modules never enters the commit", () => {
    expect(df.indexOf("git commit")).toBeLessThan(df.indexOf("-name package.json"))
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
  test("tar extraction failure fails closed: reward 0, exit before running the check (finding M6)", () => {
    expect(sh).toContain("if ! tar -xf /tests/pristine.tar -C /app; then")
    const tarFailIdx = sh.indexOf("if ! tar -xf /tests/pristine.tar -C /app; then")
    expect(tarFailIdx).toBeGreaterThanOrEqual(0)
    const failBranch = sh.slice(tarFailIdx)
    const exitIdx = failBranch.indexOf("exit 0")
    const rewardZeroIdx = failBranch.indexOf('echo 0 > /logs/verifier/reward.txt')
    const checkIdx = failBranch.indexOf("if ( bun test ); then")
    expect(rewardZeroIdx).toBeGreaterThan(0)
    expect(exitIdx).toBeGreaterThan(rewardZeroIdx)
    // the fail-closed branch's exit must precede the normal check invocation
    expect(exitIdx).toBeLessThan(checkIdx)
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
