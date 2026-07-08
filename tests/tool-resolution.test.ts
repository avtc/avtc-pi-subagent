// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { SubagentConfig, ToolPolicy } from "../src/subagent-config.js";
import { resolveToolPolicy } from "../src/tool-resolution.js";

/** Build a minimal SubagentConfig with just the subagent-tools section. */
function toolsCfg(policies: Record<string, unknown>): SubagentConfig {
  return {
    "subagent-models": {},
    "default-model": null,
    "subagent-tools": policies as unknown as Record<string, ToolPolicy>,
  };
}

describe("tool-resolution: resolveToolPolicy", () => {
  // : no-config never throws; returns non-null empty addblock
  it("no subagent-tools key -> non-null empty addblock, never throws", () => {
    const config: SubagentConfig = { "subagent-models": {}, "default-model": null };
    let result: ReturnType<typeof resolveToolPolicy> | undefined;
    expect(() => {
      result = resolveToolPolicy(config, "worker", ["worker", "reviewer"]);
    }).not.toThrow();
    expect(result).toEqual({
      policy: { mode: "addblock", add: [], block: [] },
      warnings: [],
      phaseBError: null,
    });
  });

  it("no matching pattern -> non-null empty addblock", () => {
    const config = toolsCfg({ reviewer: { only: ["read"] } });
    const result = resolveToolPolicy(config, "worker", ["worker", "reviewer"]);
    expect(result.policy).toEqual({ mode: "addblock", add: [], block: [] });
    expect(result.phaseBError).toBeNull();
  });

  // Base-name matching: tool-policy keys match the agent's BASE name, never a fork-suffixed
  // name (unlike subagent-models, which matches the fork-suffixed name). A 'reviewer-fork' key
  // is therefore a silent no-op — it matches no agent (a forked agent still resolves as
  // 'reviewer'). Guards against a future regression to fork-suffixed matching.
  it("a fork-suffixed key ('reviewer-fork') is a no-op — tool-policy matches the base name only", () => {
    const config = toolsCfg({ "reviewer-fork": { only: ["read"] } });
    const result = resolveToolPolicy(config, "reviewer", ["reviewer"]);
    // The 'reviewer-fork' key did not match 'reviewer' -> empty addblock (no restriction).
    expect(result.policy).toEqual({ mode: "addblock", add: [], block: [] });
    expect(result.phaseBError).toBeNull();
  });

  // Conversely, a base-name key DOES apply to a forked agent (which resolves by base name).
  it("a base-name key applies even when the agent is forked (resolves by base name)", () => {
    const config = toolsCfg({ reviewer: { only: ["read"] } });
    const result = resolveToolPolicy(config, "reviewer", ["reviewer"]);
    expect(result.policy).toEqual({ mode: "only", set: ["read"] });
  });

  it("no-match result is a fresh object (mutating it does not corrupt future calls)", () => {
    const config: SubagentConfig = { "subagent-models": {}, "default-model": null };
    const r1 = resolveToolPolicy(config, "worker", ["worker"]);
    // a caller mutating its result must not poison the shared empty policy.
    if (r1.policy && r1.policy.mode === "addblock") r1.policy.add.push("INJECTED");
    const r2 = resolveToolPolicy(config, "reviewer", ["reviewer"]);
    expect(r2.policy).toEqual({ mode: "addblock", add: [], block: [] });
  });

  // : resolution picks matching keys by glob + specificity
  it("most-specific matching glob's op wins on a clashing token", () => {
    // worker matches *, worker — specificity orders them; worker (exact) wins the clash.
    const config = toolsCfg({ "*": { block: ["bash"] }, worker: { add: ["bash"] } });
    const r = resolveToolPolicy(config, "worker", ["worker"]);
    // worker's add cancels *'s block on bash -> bash in add, not block.
    expect(r.policy).toEqual({ mode: "addblock", add: ["bash"], block: [] });
  });

  // : explicit cancellation — *:{block:[todo_*]} + worker:{add:[todo_*]} -> worker keeps todo_*
  it("more-specific add cancels less-specific block", () => {
    const config = toolsCfg({ "*": { block: ["todo_*"] }, worker: { add: ["todo_*"] } });
    const r = resolveToolPolicy(config, "worker", ["worker", "researcher"]);
    expect(r.policy).toEqual({ mode: "addblock", add: ["todo_*"], block: [] });
    // researcher matches only * -> todo_* blocked.
    const r2 = resolveToolPolicy(config, "researcher", ["worker", "researcher"]);
    expect(r2.policy).toEqual({ mode: "addblock", add: [], block: ["todo_*"] });
  });

  // : same-entry add+block of the same token -> block wins (block is a veto over add).
  it("same-entry add+block of the same literal -> block wins, add excludes it", () => {
    const config = toolsCfg({ worker: { add: ["bash"], block: ["bash"] } });
    const r = resolveToolPolicy(config, "worker", ["worker"]);
    expect(r.policy).toEqual({ mode: "addblock", add: [], block: ["bash"] });
  });

  // : only terminal, most-specific only wins
  it("only-mode returns the most-specific matching only set", () => {
    const config = toolsCfg({ "reviewer-*": { only: ["read", "glob"] } });
    const r = resolveToolPolicy(config, "reviewer-1", ["reviewer-1"]);
    expect(r.policy).toEqual({ mode: "only", set: ["read", "glob"] });
  });

  // -multi: two matching only keys — most-specific wins, NOT merged
  it("multi: most-specific only wins over less-specific only (not merged)", () => {
    const config = toolsCfg({ "*": { only: ["read"] }, worker: { only: ["read", "write"] } });
    const r = resolveToolPolicy(config, "worker", ["worker", "researcher"]);
    expect(r.policy).toEqual({ mode: "only", set: ["read", "write"] }); // not [read], not merged
    // researcher matches only * -> [read].
    const r2 = resolveToolPolicy(config, "researcher", ["worker", "researcher"]);
    expect(r2.policy).toEqual({ mode: "only", set: ["read"] });
  });

  // : only:[] -> empty set; $all in block passes through
  it("only:[] yields an empty only set", () => {
    const config = toolsCfg({ locked: { only: [] } });
    const r = resolveToolPolicy(config, "locked", ["locked"]);
    expect(r.policy).toEqual({ mode: "only", set: [] });
  });

  it("$all token passes through opaque", () => {
    const config = toolsCfg({ admin: { only: ["$all"] } });
    const r = resolveToolPolicy(config, "admin", ["admin"]);
    expect(r.policy).toEqual({ mode: "only", set: ["$all"] }); // NOT expanded
  });

  it("$all in block passes through opaque", () => {
    const config = toolsCfg({ "*": { block: ["$all"] } });
    const r = resolveToolPolicy(config, "worker", ["worker"]);
    expect(r.policy).toEqual({ mode: "addblock", add: [], block: ["$all"] });
  });

  //  contradiction: cross-level only + add -> phaseBError, policy null
  it("cross-level only + add -> phaseBError, policy null", () => {
    const config = toolsCfg({ "*": { only: ["read"] }, worker: { add: ["write"] } });
    const r = resolveToolPolicy(config, "worker", ["worker", "researcher"]);
    expect(r.policy).toBeNull();
    expect(r.phaseBError).not.toBeNull();
    expect(r.phaseBError).toContain("only");
    // researcher matches only * -> not a contradiction.
    const r2 = resolveToolPolicy(config, "researcher", ["worker", "researcher"]);
    expect(r2.policy).toEqual({ mode: "only", set: ["read"] });
    expect(r2.phaseBError).toBeNull();
  });

  it("cross-level only + block -> phaseBError, policy null", () => {
    const config = toolsCfg({ worker: { only: ["read"] }, "*": { block: ["bash"] } });
    const r = resolveToolPolicy(config, "worker", ["worker"]);
    expect(r.policy).toBeNull();
    expect(r.phaseBError).not.toBeNull();
  });

  // : equal-specificity ties -> declaration order
  it("equal-specificity globs compose in declaration order (most-specific-declared-first walk)", () => {
    // a-* and *-z both have 2 literal chars, len 3 -> tie. Declaration order: a-* then *-z.
    // For add/block cancellation, least-specific-first walk means *-z (declared 2nd) is treated
    // as "less specific" (later in ranked = less specific). The key property: deterministic,
    // reproducible ordering derived from Object.keys.
    const config = toolsCfg({ "a-*": { block: ["x"] }, "*-z": { add: ["x"] } });
    const r = resolveToolPolicy(config, "a-z", ["a-z"]);
    // a-z matches both. rankBySpecificity keeps decl order on tie: [a-*, *-z] (most-first).
    // Walk least-first: *-z then a-*. *-z adds x; a-* blocks x (cancels) -> x blocked.
    expect(r.policy).toEqual({ mode: "addblock", add: [], block: ["x"] });
  });

  //  lint: glob matching zero discovered agents -> warning
  it("agent-name glob matching no discovered agent -> warning", () => {
    const config = toolsCfg({ "typo-*": { add: ["read"] } });
    const r = resolveToolPolicy(config, "worker", ["worker"]); // no agent matches typo-*
    expect(r.warnings.some((w) => w.includes('"typo-*"'))).toBe(true);
    expect(r.policy).toEqual({ mode: "addblock", add: [], block: [] });
  });

  it("exact key never warns (only globs linted)", () => {
    const config = toolsCfg({ worker: { add: ["read"] } });
    const r = resolveToolPolicy(config, "worker", ["worker"]);
    expect(r.warnings).toEqual([]);
  });

  //  lint: a MATCHING agent-name glob (reviewer-* with a discovered reviewer-1) warns nothing.
  it("agent-name glob matching a discovered agent -> no warning", () => {
    const config = toolsCfg({ "reviewer-*": { add: ["read"] } });
    const r = resolveToolPolicy(config, "reviewer-1", ["reviewer-1", "worker"]);
    expect(r.warnings).toEqual([]);
  });

  it("hidden-agents / disabled-agents globs also lint", () => {
    const config: SubagentConfig = {
      "subagent-models": {},
      "default-model": null,
      "hidden-agents": ["ghost-*"],
      "disabled-agents": ["dead-*"],
    };
    const r = resolveToolPolicy(config, "worker", ["worker"]);
    expect(r.warnings.some((w) => w.includes('"ghost-*"'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('"dead-*"'))).toBe(true);
  });
});
