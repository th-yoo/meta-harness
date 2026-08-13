// A1 cycle-tagging (2026-08-13): the test-path heuristic + cycle-tag
// derivation. The load-bearing pins: (1) absence rules — {} whenever the
// touched set is empty or truncated; (2) the heuristic is telemetry-only
// (no import of classify.ts from any decision path is asserted in
// stop.test.ts); (3) a malformed override falls back, never throws.
import { test, expect } from "bun:test"
import {
  DEFAULT_TEST_PATH_PATTERN,
  compileTestPathPattern,
  isTestPath,
  computeCycleTags,
} from "../src/core/classify.ts"

// -- heuristic ---------------------------------------------------------

test("default pattern: directory conventions match", () => {
  for (const p of [
    "test/foo.ts",
    "tests/foo.py",
    "src/__tests__/bar.tsx",
    "pkg/spec/thing.rb",
    "a/b/specs/x.js",
  ]) expect(isTestPath(p)).toBe(true)
})

test("default pattern: filename conventions match", () => {
  for (const p of [
    "src/foo.test.ts",
    "src/foo.spec.js",
    "src/foo_test.go",
    "src/foo-test.ts",
    "test.ts",
    "spec.rb",
    "deep/dir/test.py",
  ]) expect(isTestPath(p)).toBe(true)
})

test("default pattern: source files do not match", () => {
  for (const p of [
    "src/foo.ts",
    "src/attest.ts",           // 'test' inside a word, not a segment
    "src/contest/bar.ts",      // ditto as a directory
    "src/latest.config.js",
    "protester.md",
    "src/inspect.ts",          // 'spec' inside a word
  ]) expect(isTestPath(p)).toBe(false)
})

test("override pattern wins over default", () => {
  const re = compileTestPathPattern("^checks/")
  expect(isTestPath("checks/foo.ts", re)).toBe(true)
  expect(isTestPath("test/foo.ts", re)).toBe(false)
})

test("malformed override compiles to undefined (fallback), never throws", () => {
  expect(compileTestPathPattern("([")).toBeUndefined()
  expect(compileTestPathPattern("")).toBeUndefined()
  expect(compileTestPathPattern(undefined)).toBeUndefined()
  // the default itself must always compile
  expect(compileTestPathPattern(DEFAULT_TEST_PATH_PATTERN)).toBeDefined()
})

// -- cycle-tag derivation ----------------------------------------------

test("impl-only cycle: implOnly true, sameTurnCoEdit false", () => {
  const tags = computeCycleTags({ touchedPaths: ["src/a.ts", "src/b.ts"] })
  expect(tags).toEqual({ implOnly: true, sameTurnCoEdit: false })
})

test("co-edit cycle: implOnly false, sameTurnCoEdit true", () => {
  const tags = computeCycleTags({ touchedPaths: ["src/a.ts", "test/a.test.ts"] })
  expect(tags).toEqual({ implOnly: false, sameTurnCoEdit: true })
})

test("test-only cycle: both false (set trusted, answer is no)", () => {
  const tags = computeCycleTags({ touchedPaths: ["test/a.test.ts"] })
  expect(tags).toEqual({ implOnly: false, sameTurnCoEdit: false })
})

test("no paths → {} (fields ABSENT, not false)", () => {
  expect(computeCycleTags({})).toEqual({})
  expect(computeCycleTags({ touchedPaths: [] })).toEqual({})
})

test("truncated set → {} even with paths present", () => {
  const tags = computeCycleTags({
    touchedPaths: ["src/a.ts"],
    touchedTruncated: true,
  })
  expect(tags).toEqual({})
})

test("override pattern flows through computeCycleTags", () => {
  // under the override, src/a.ts is the 'test' file and checks/ is not code
  const tags = computeCycleTags({ touchedPaths: ["src/a.ts"] }, "^src/")
  expect(tags).toEqual({ implOnly: false, sameTurnCoEdit: false })
  // malformed override falls back to the default heuristic
  const fallback = computeCycleTags({ touchedPaths: ["src/a.ts"] }, "([")
  expect(fallback).toEqual({ implOnly: true, sameTurnCoEdit: false })
})

// -- fix wave (review round 1): kkamak-parity semantics -------------------

test("case-insensitive like the kkamak kernel: Tests/ and Spec/ match", () => {
  expect(isTestPath("Tests/UnitTest1.cs")).toBe(true)
  expect(isTestPath("src/Spec/Thing.cs")).toBe(true)
  expect(isTestPath("SRC/FOO.TEST.TS")).toBe(true)
})

test("override pattern is also case-insensitive", () => {
  const re = compileTestPathPattern("^checks/")
  expect(isTestPath("Checks/foo.ts", re)).toBe(true)
})

test("plural filename forms match (kkamak parity)", () => {
  expect(isTestPath("tests.ts")).toBe(true)
  expect(isTestPath("src/foo_tests.go")).toBe(true)
  expect(isTestPath("src/component.specs.ts")).toBe(true)
})

test("backslash paths normalize before matching (kkamak parity)", () => {
  expect(isTestPath("src\\__tests__\\foo.ts")).toBe(true)
  expect(isTestPath("src\\foo.ts")).toBe(false)
})
