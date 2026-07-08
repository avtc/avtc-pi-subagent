// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { beforeEach, describe, expect, it } from "vitest";
import {
  _getGlobCacheSize,
  _resetGlobCache,
  _resetRotationCounters,
  rankBySpecificity,
  resolveSubagentModel,
} from "../src/model-resolution.js";
import { makeSubagentConfig } from "./test-helpers.js";

const cfg = makeSubagentConfig;

describe("model-resolution specificity", () => {
  beforeEach(() => {
    _resetRotationCounters();
    _resetGlobCache();
  });

  it("exact key beats glob", () => {
    const c = cfg({ "plan-reviewer": ["A"], "*": ["B"] }, null);
    expect(resolveSubagentModel("plan-reviewer", c)).toBe("A");
  });

  it("most-literal glob wins among globs", () => {
    const c = cfg({ "*-reviewer": ["A"], "*": ["B"] }, null);
    expect(resolveSubagentModel("plan-reviewer", c)).toBe("A");
  });

  it("*-fork beats * on a -fork name (suffix is just chars, no special logic)", () => {
    const c = cfg({ "*-fork": ["C"], "*": ["A", "B"] }, null);
    expect(resolveSubagentModel("plan-reviewer-fork", c)).toBe("C");
  });

  it("most literal chars wins among globs", () => {
    // plan-* has 5 literal chars (p,l,a,n,-); p* has 1 -> plan-* wins on literalLen.
    const c = cfg({ "plan-*": ["A"], "p*": ["B"] }, null);
    expect(resolveSubagentModel("plan-x", c)).toBe("A");
  });

  it("longest total length wins when literal char counts tie", () => {
    // *a* (1 literal, totalLen 3) vs a* (1 literal, totalLen 2) -> tie on literalLen,
    // so totalLen breaks the tie: *a* wins. Both must match the agent name 'ab'.
    const c = cfg({ "*a*": ["A"], "a*": ["B"] }, null);
    expect(resolveSubagentModel("ab", c)).toBe("A");
  });

  it("specificity beats declaration order even when the loser is declared first", () => {
    // Regression guard: the higher-tier specificity rules (literal count, then
    // total length) must win REGARDLESS of declaration order. A buggy
    // "first-declared-wins" resolver would pass every other specificity test (which
    // all declare the winner first) but fail these reversed-declaration cases.

    // Tier 2 (literal count) reversed: declare the LESS-literal key first.
    // plan-* (5 literals) beats p* (1 literal) even though p* is declared first.
    const literalReversed = cfg({ "p*": ["B"], "plan-*": ["A"] }, null);
    expect(resolveSubagentModel("plan-x", literalReversed)).toBe("A");

    // Tier 3 (total length) reversed: declare the SHORTER key first.
    // *a* (totalLen 3) beats a* (totalLen 2) even though a* is declared first.
    const lengthReversed = cfg({ "a*": ["B"], "*a*": ["A"] }, null);
    expect(resolveSubagentModel("ab", lengthReversed)).toBe("A");
  });

  it("declaration order wins when literal chars AND total length both tie", () => {
    // a*b (literals 'ab'=2, len 3) and ab* (literals 'ab'=2, len 3) both match the
    // agent 'ab' (a.*b matches 'ab' with .* empty; ab.* matches 'ab'). Tie on both
    // literalLen and totalLen -> the 4th sort key (declaration order) decides: the
    // FIRST-declared key wins.
    const firstWins = cfg({ "a*b": ["A"], "ab*": ["B"] }, null);
    expect(resolveSubagentModel("ab", firstWins)).toBe("A");
    // Reversing declaration order flips the winner.
    const reversedWins = cfg({ "ab*": ["B"], "a*b": ["A"] }, null);
    expect(resolveSubagentModel("ab", reversedWins)).toBe("B");
  });

  it("rankBySpecificity: exact wins, then most-literal, then longest, then decl order", () => {
    // Pure helper contract: most-specific first. Exact keys beat globs; among globs
    // more literal chars win; tie on literals -> longer total wins; tie on both -> decl order.
    expect(rankBySpecificity(["*", "worker", "w*"])).toEqual(["worker", "w*", "*"]);
    // plan-* (5 literals) beats p* (1 literal) regardless of input order.
    expect(rankBySpecificity(["p*", "plan-*"])).toEqual(["plan-*", "p*"]);
    // Tier 3: tie on literal count -> longer total length wins.
    // *a* (1 literal, totalLen 3) vs a* (1 literal, totalLen 2) -> *a* wins on length.
    expect(rankBySpecificity(["a*", "*a*"])).toEqual(["*a*", "a*"]);
    // Tier 4: equal specificity -> declaration order preserved.
    expect(rankBySpecificity(["a-*", "*-z"])).toEqual(["a-*", "*-z"]);
    expect(rankBySpecificity(["*-z", "a-*"])).toEqual(["*-z", "a-*"]);
  });

  it("returns undefined when no key matches", () => {
    const c = cfg({ foo: ["A"] }, null);
    expect(resolveSubagentModel("bar", c)).toBeUndefined();
  });

  it('escapes regex metacharacters in glob keys ("." is literal, not any-char)', () => {
    // `plan.*` must treat the `.` as a literal dot: matches `plan.<anything>` but
    // NOT `planX<anything>` (an unescaped `.` would match any char here).
    const c = cfg({ "plan.*": ["A"] }, null);
    expect(resolveSubagentModel("plan.reviewer", c)).toBe("A"); // literal dot matches
    expect(resolveSubagentModel("planXreviewer", c)).toBeUndefined(); // `.` must NOT act as any-char
  });

  it("escapes `[` / `]` in glob keys (brackets are literal, not a char class)", () => {
    // Guards known-issue #23 (the `]`-escape SyntaxError) and locks literal-bracket
    // behavior: `*[xy]*` must match the literal string containing `[xy]`, and must
    // NOT match `axb` (an unescaped `[xy]` would be a regex char class).
    const c = cfg({ "*[xy]*": ["A"] }, null);
    expect(resolveSubagentModel("a[xy]b", c)).toBe("A"); // literal brackets match
    expect(resolveSubagentModel("axb", c)).toBeUndefined(); // must NOT be a char class
  });

  it("expands EVERY `*` wildcard in a multi-wildcard key (global /g replace)", () => {
    // compileGlob must replace ALL `*` with `.*`, not just the first — i.e. the
    // `.replace(/\*/g, ".*")` must use the global flag. `*-reviewer-*` compiles to
    // `^.*-reviewer-.*$` under a correct global replace.
    const c = cfg({ "*-reviewer-*": ["A"] }, null);
    // Both wildcards expand: prefix `plan`, literal `-reviewer-`, suffix `fork`.
    expect(resolveSubagentModel("plan-reviewer-fork", c)).toBe("A");
    // Under a non-global (first-only) replace, the trailing `*` would stay literal
    // and `plan-reviewer-fork` (ends in `k`, not `*`) would NOT match — so this
    // assertion proves the second wildcard expanded too.
    // Missing the trailing `-<seg>` (no content after `-reviewer-`): no match.
    expect(resolveSubagentModel("plan-reviewer", c)).toBeUndefined();
  });
});

describe("model-resolution glob-cache memoization", () => {
  beforeEach(() => {
    _resetRotationCounters();
    _resetGlobCache();
  });

  it("compiles each distinct glob key once, reusing across resolves (memoization)", () => {
    // findMatch iterates the specificity-sorted key list and short-circuits on the
    // first match, so only the WINNING glob is compiled for a given agent. To
    // exercise two distinct globs being compiled, resolve two agents that win on
    // DIFFERENT globs. If memoization works, the cache holds exactly the distinct
    // winning globs (here 2), NOT one entry per resolve call.
    const c = cfg({ "*-fork": ["F"], "*-other": ["O"] }, null);
    expect(resolveSubagentModel("reviewer-fork", c)).toBe("F");
    expect(resolveSubagentModel("worker-other", c)).toBe("O");
    // Repeat resolves — both already compiled; cache must not grow.
    expect(resolveSubagentModel("reviewer-fork", c)).toBe("F");
    expect(resolveSubagentModel("worker-other", c)).toBe("O");
    // Each distinct winning glob compiled exactly once.
    expect(_getGlobCacheSize()).toBe(2);
  });

  it("does not recompile an already-cached glob on subsequent resolves", () => {
    const c = cfg({ "plan-*": ["P"] }, null);
    resolveSubagentModel("plan-reviewer", c);
    const sizeAfterFirst = _getGlobCacheSize();
    resolveSubagentModel("plan-reviewer", c);
    resolveSubagentModel("plan-other", c);
    // Same glob key (plan-*) reused — cache size must not grow.
    expect(_getGlobCacheSize()).toBe(sizeAfterFirst);
  });

  it("exact (non-glob) keys are not cached", () => {
    // Exact keys have no wildcard, so compileGlob is never called for them; the
    // cache stays empty regardless of how many exact matches resolve.
    const c = cfg({ reviewer: ["R"] }, null);
    resolveSubagentModel("reviewer", c);
    resolveSubagentModel("reviewer", c);
    expect(_getGlobCacheSize()).toBe(0);
  });
});

describe("model-resolution rotation", () => {
  beforeEach(() => {
    _resetRotationCounters();
    _resetGlobCache();
  });

  it("rotates an array per matched key, advancing once per call", () => {
    const c = cfg({ "*": ["A", "B", "C"] }, null);
    expect(resolveSubagentModel("agent1", c)).toBe("A");
    expect(resolveSubagentModel("agent2", c)).toBe("B"); // same glob pool -> next index
    expect(resolveSubagentModel("agent3", c)).toBe("C");
    expect(resolveSubagentModel("agent4", c)).toBe("A"); // wraps
  });

  it("exact key owns its own pool, separate from a matching glob", () => {
    const c = cfg({ "plan-reviewer-fork": ["C", "D"], "*-fork": ["C", "D"] }, null);
    // exact pool and *-fork pool are independent:
    expect(resolveSubagentModel("plan-reviewer-fork", c)).toBe("C"); // exact pool idx 0
    expect(resolveSubagentModel("quality-reviewer-fork", c)).toBe("C"); // *-fork pool idx 0 (not 1!)
    expect(resolveSubagentModel("security-reviewer-fork", c)).toBe("D"); // *-fork pool idx 1
  });

  it("single string (non-array) does NOT advance the counter", () => {
    const c = cfg({ "*": "ONLY" }, null);
    expect(resolveSubagentModel("a", c)).toBe("ONLY");
    expect(resolveSubagentModel("b", c)).toBe("ONLY");

    // A subsequent array resolve under the SAME glob pool (key `*`) must start at
    // index 0 — proving the single-string resolves above did NOT advance the counter.
    const c2 = cfg({ "*": ["X", "Y"] }, null);
    expect(resolveSubagentModel("c", c2)).toBe("X");
  });

  it("empty-array override yields undefined and does NOT advance the counter", () => {
    // pickRotated guards against an empty array (validation normally drops these,
    // but a config constructed directly via cfg() bypasses validation). The guard
    // must both return undefined AND leave the rotation counter untouched.
    const empty = cfg({ "agent-x": [] }, null);
    expect(resolveSubagentModel("agent-x", empty)).toBeUndefined();

    // Prove no counter advance: a subsequent 2-element array resolve under the SAME
    // matched key (`agent-x`) must start at index 0. If the empty-array resolve had
    // advanced the counter, this would return index 1 -> "Y".
    const twoElems = cfg({ "agent-x": ["X", "Y"] }, null);
    expect(resolveSubagentModel("agent-x", twoElems)).toBe("X");
  });
});
