// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetSubagentConfig,
  invalidateSubagentConfig,
  loadSubagentConfig,
  loadSubagentModelConfig,
} from "../src/subagent-config.js";

describe("subagent-config", () => {
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "sub-g-"));
    projectDir = mkdtempSync(join(tmpdir(), "sub-p-"));
    _resetSubagentConfig();
  });
  afterEach(() => {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    _resetSubagentConfig();
  });

  const writeGlobal = (obj: unknown) =>
    writeFileSync(join(globalDir, "settings.json"), JSON.stringify({ "avtc-pi-subagent": obj }));
  const writeProject = (obj: unknown) => {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ "avtc-pi-subagent": obj }));
  };

  it("loads subagent-models from global settings", () => {
    writeGlobal({ "subagent-models": { "reviewer-testing": "test-provider/model-b" } });
    const cfg = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg["subagent-models"]?.["reviewer-testing"]).toBe("test-provider/model-b");
  });

  it("merges subagent-models per-key (project does not clobber global)", () => {
    writeGlobal({ "subagent-models": { "reviewer-quality": "a/1", "reviewer-testing": "b/2" } });
    writeProject({ "subagent-models": { "reviewer-security": "c/3" } });
    const cfg = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg["subagent-models"]).toEqual({
      "reviewer-quality": "a/1",
      "reviewer-testing": "b/2",
      "reviewer-security": "c/3",
    });
  });

  it("same key in global AND project -> project wins (per-key override)", () => {
    writeGlobal({ "subagent-models": { "reviewer-quality": "global/1" } });
    writeProject({ "subagent-models": { "reviewer-quality": "project/2" } });
    const cfg = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg["subagent-models"]?.["reviewer-quality"]).toBe("project/2");
  });

  it("default-model: project-overrides-global (present-wins)", () => {
    writeGlobal({ "default-model": "global/1" });
    writeProject({ "default-model": "project/1" });
    const cfg = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg["default-model"]).toBe("project/1");
  });

  it("default-model: global used when project absent", () => {
    writeGlobal({ "default-model": "global/1" });
    writeProject({}); // no default-model
    const cfg = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg["default-model"]).toBe("global/1");
  });

  it("default-model: project explicit null overrides global (present-wins)", () => {
    // buildConfig uses `"default-model" in projectSection` (presence, not truthiness).
    // A project that explicitly sets null must win over the global value, mirroring
    // the sibling repo's merge semantics. Guards against a future "simplification"
    // to truthiness that would silently drop this branch.
    writeGlobal({ "default-model": "global/1" });
    writeProject({ "default-model": null });
    const cfg = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg["default-model"]).toBeNull();
  });

  it("skips and logs invalid model strings (no '/', '/' at ends)", () => {
    writeGlobal({ "subagent-models": { good: "a/b", bad1: "noSlash", bad2: "/leadSlash", bad3: "trailSlash/" } });
    const cfg = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg["subagent-models"]?.good).toBe("a/b");
    expect(cfg["subagent-models"]?.bad1).toBeUndefined();
    expect(cfg["subagent-models"]?.bad2).toBeUndefined();
    expect(cfg["subagent-models"]?.bad3).toBeUndefined();
  });

  it("array override keeps valid members and drops invalid ones", () => {
    // validateOverrides array branch: filter isValidModelString members, warn on partial.
    writeGlobal({ "subagent-models": { "plan-reviewer": ["a/1", "noSlash", "b/2", "/leadSlash"] } });
    const cfg = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg["subagent-models"]?.["plan-reviewer"]).toEqual(["a/1", "b/2"]);
  });

  it("array override with ALL invalid members drops the key entirely", () => {
    // After filtering, an empty array is not kept (the key is absent).
    writeGlobal({ "subagent-models": { "plan-reviewer": ["noSlash", "/leadSlash"] } });
    const cfg = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg["subagent-models"]?.["plan-reviewer"]).toBeUndefined();
  });

  it("non-object value for a key is skipped", () => {
    writeGlobal({ "subagent-models": { "plan-reviewer": 12345 } });
    const cfg = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg["subagent-models"]?.["plan-reviewer"]).toBeUndefined();
  });

  it("malformed JSON file logs a warning and yields an empty config", () => {
    writeFileSync(join(globalDir, "settings.json"), "{ this is not valid json }}}");
    const cfg = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg["subagent-models"]).toEqual({});
    expect(cfg["default-model"]).toBeNull();
  });

  it("non-object `avtc-pi-subagent` section yields an empty config", () => {
    // parity with the standalone not-an-object guard.
    writeFileSync(join(globalDir, "settings.json"), JSON.stringify({ "avtc-pi-subagent": "not-an-object" }));
    const cfg = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg["subagent-models"]).toEqual({});
    expect(cfg["default-model"]).toBeNull();
  });

  it("invalid default-model warns and yields null", () => {
    writeGlobal({ "default-model": "noSlash", "subagent-models": { a: "x/y" } });
    const cfg = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg["default-model"]).toBeNull();
  });

  it("returns the cached object while on-disk content is unchanged", () => {
    writeGlobal({ "default-model": "a/1" });
    const cfg1 = loadSubagentModelConfig(globalDir, projectDir);
    // identical reload (no content change, no explicit invalidate) must hit the cache:
    // same object reference, proving the flag-guard short-circuit works.
    const cfg1b = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg1b).toBe(cfg1);
  });

  it("returns the cached object on the hot path without re-reading disk (O(1) cache hit)", () => {
    writeGlobal({ "default-model": "a/1" });
    const cfg1 = loadSubagentModelConfig(globalDir, projectDir);
    // Even if the on-disk file is deleted, the cached hit must NOT touch disk —
    // this is the performance guarantee: the flag guard returns before readSections().
    rmSync(join(globalDir, "settings.json"));
    const cfg1b = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg1b).toBe(cfg1); // same reference, no reload, no disk read
  });

  it("does NOT auto-reload mid-session without invalidation (cache is session-scoped)", () => {
    writeGlobal({ "default-model": "a/1" });
    const cfg1 = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg1["default-model"]).toBe("a/1");
    // Change content WITHOUT invalidating. The cache is session-scoped (invalidated
    // on session_start via invalidateSubagentConfig), so the hot path must NOT
    // re-read disk — it returns the stale-but-cached value until the next reload.
    writeGlobal({ "default-model": "a/2" });
    const cfg2 = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg2["default-model"]).toBe("a/1"); // stale cached value, not the new a/2
    expect(cfg2).toBe(cfg1); // same cached object
  });

  it("explicit invalidate also forces a reload", () => {
    writeGlobal({ "default-model": "a/1" });
    const cfg1 = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg1["default-model"]).toBe("a/1");
    writeGlobal({ "default-model": "a/2" });
    invalidateSubagentConfig();
    const cfg2 = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg2["default-model"]).toBe("a/2");
    expect(cfg2).not.toBe(cfg1);
  });

  it("absent→present transition: no global file, then appears after invalidate (first-time setup)", () => {
    // The most common real-world transition: config absent on first load, then a
    // user creates it. After invalidation the now-present config is returned.
    const cfg1 = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg1["subagent-models"]).toEqual({});
    expect(cfg1["default-model"]).toBeNull();
    writeGlobal({ "default-model": "a/1", "subagent-models": { worker: "p/m" } });
    invalidateSubagentConfig();
    const cfg2 = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg2["default-model"]).toBe("a/1");
    expect(cfg2["subagent-models"]?.worker).toBe("p/m");
    expect(cfg2).not.toBe(cfg1);
  });

  it("null globalDir skips the global section and yields an empty config (null contract)", () => {
    // The API accepts globalDir=null (defensive contract; production always passes a
    // real ~/.pi/agent path). null must not crash and must skip the global file.
    const cfg = loadSubagentModelConfig(null, projectDir);
    expect(cfg["subagent-models"]).toEqual({});
    expect(cfg["default-model"]).toBeNull();
  });

  it("handles missing settings.json (empty config)", () => {
    const cfg = loadSubagentModelConfig(globalDir, projectDir);
    expect(cfg["subagent-models"]).toEqual({});
    expect(cfg["default-model"]).toBeNull();
  });
});

describe("subagent-config: tool-policy + agent-control keys", () => {
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "sub-g-"));
    projectDir = mkdtempSync(join(tmpdir(), "sub-p-"));
    _resetSubagentConfig();
  });
  afterEach(() => {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    _resetSubagentConfig();
  });

  const writeGlobal = (obj: unknown) =>
    writeFileSync(join(globalDir, "settings.json"), JSON.stringify({ "avtc-pi-subagent": obj }));
  const writeProject = (obj: unknown) => {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ "avtc-pi-subagent": obj }));
  };

  // ---: parse the 4 new keys + cache + errors caching ---
  it("parses the 4 new keys from global + project", () => {
    writeGlobal({
      "subagent-tools": { "*": { block: ["bash"] } },
      "tool-sets": { readonly: ["read", "glob"] },
      "hidden-agents": ["debug-*"],
      "disabled-agents": ["experimental-*"],
    });
    writeProject({
      "subagent-tools": { worker: { add: ["bash"] } },
      "tool-sets": { write: ["edit"] },
      "hidden-agents": ["test-*"],
    });
    const { config, errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors).toEqual([]);
    expect(config["subagent-tools"]?.["*"]?.block).toEqual(["bash"]);
    expect(config["subagent-tools"]?.worker?.add).toEqual(["bash"]);
    expect(config["tool-sets"]?.readonly).toEqual(["read", "glob"]);
    expect(config["tool-sets"]?.write).toEqual(["edit"]);
    expect(config["hidden-agents"]).toEqual(["debug-*", "test-*"]);
    expect(config["disabled-agents"]).toEqual(["experimental-*"]);
  });

  it("cache hit returns same config + same errors as cache miss", () => {
    writeGlobal({ "subagent-tools": { "*": { only: ["read"] } }, "tool-sets": { all: ["x"] } }); // `all` clashes
    const first = loadSubagentConfig(globalDir, projectDir);
    const second = loadSubagentConfig(globalDir, projectDir);
    expect(second.config).toBe(first.config); // same cached object
    expect(second.errors).toBe(first.errors); // errors cached, not lost
    expect(first.errors.length).toBeGreaterThan(0); // the `all` clash surfaces
    expect(second.errors).toEqual(first.errors);
  });

  it("invalidateSubagentConfig forces a re-read", () => {
    writeGlobal({ "subagent-tools": { "*": { block: ["bash"] } } });
    const first = loadSubagentConfig(globalDir, projectDir);
    writeGlobal({ "subagent-tools": { "*": { block: ["read"] } } });
    const cached = loadSubagentConfig(globalDir, projectDir);
    expect(cached.config["subagent-tools"]?.["*"]?.block).toEqual(["bash"]); // stale
    invalidateSubagentConfig();
    const after = loadSubagentConfig(globalDir, projectDir);
    expect(after.config["subagent-tools"]?.["*"]?.block).toEqual(["read"]); // re-read
    expect(after.config).not.toBe(first.config);
  });

  // ---: $ref expands, $all survives ---
  it("$ref expands into add/block/only arrays", () => {
    writeGlobal({
      "tool-sets": { readonly: ["read", "glob"], git: ["bash"] },
      "subagent-tools": { reviewer: { only: ["$readonly", "$git"] } },
    });
    const { config, errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors).toEqual([]);
    expect(config["subagent-tools"]?.reviewer?.only).toEqual(["read", "glob", "bash"]);
  });

  it("a $ref matching an inherited prototype name is a structural error, not a throw", () => {
    // Guards against a fail-open vulnerability: sets?.[name] for an inherited Object.prototype
    // member (constructor/toString/hasOwnProperty/__proto__) returns a truthy non-iterable, so a
    // naive `expanded.push(...members)` would throw TypeError, escape the loader, and leave a
    // fresh-mode child UNRESTRICTED. The lookup must own-property + Array.isArray guard, turning
    // such a ref into a structural error instead of a throw.
    writeGlobal({
      "tool-sets": { readonly: ["read"] },
      "subagent-tools": { worker: { add: ["$constructor", "$toString", "$hasOwnProperty", "$__proto__"] } },
    });
    // Must not throw — a throw escapes the loader and leaves the child UNRESTRICTED.
    expect(() => loadSubagentConfig(globalDir, projectDir)).not.toThrow();
    const { config, errors } = loadSubagentConfig(globalDir, projectDir);
    // Each prototype-name ref surfaces as an undefined-tool-set error.
    expect(errors.some((e) => e.includes("$constructor"))).toBe(true);
    expect(errors.some((e) => e.includes("$toString"))).toBe(true);
    expect(errors.some((e) => e.includes("$hasOwnProperty"))).toBe(true);
    expect(errors.some((e) => e.includes("$__proto__"))).toBe(true);
    // No prototype members leak into the expanded array.
    expect(config["subagent-tools"]?.worker?.add).toEqual([]);
  });

  it("$all survives unexpanded as a sentinel", () => {
    writeGlobal({ "subagent-tools": { worker: { add: ["$all"] } } });
    const { config } = loadSubagentConfig(globalDir, projectDir);
    expect(config["subagent-tools"]?.worker?.add).toEqual(["$all"]); // NOT expanded
  });

  // ---: $all valid; tool-sets.all clashes ---
  it("{ only: ['$all'] } parses with no error", () => {
    writeGlobal({ "subagent-tools": { reviewer: { only: ["$all"] } } });
    const { config, errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors).toEqual([]);
    expect(config["subagent-tools"]?.reviewer?.only).toEqual(["$all"]);
  });

  it("user-defined tool-sets.all clashes with the reserved $all sentinel", () => {
    writeGlobal({ "tool-sets": { all: ["read"] } });
    const { errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors.some((e) => e.includes('"all"') && e.includes("reserved"))).toBe(true);
  });

  // ---: errors collected, never thrown; malformed subagent-tools doesn't zero models ---
  it("collects every error without throwing", () => {
    writeGlobal({
      "subagent-tools": {
        good: { add: ["read"] },
        bad: { add: "not-an-array" }, // non-array
      },
      "hidden-agents": 12345, // not an array
      "disabled-agents": ["ok"],
      typo: { x: 1 }, // unknown key
    });
    let result: { config: ReturnType<typeof loadSubagentConfig>["config"]; errors: string[] } | undefined;
    expect(() => {
      result = loadSubagentConfig(globalDir, projectDir);
    }).not.toThrow();
    expect(result?.errors.length).toBeGreaterThanOrEqual(3); // bad policy + hidden + typo
  });

  it("a malformed subagent-tools does NOT zero subagent-models (independent validation)", () => {
    writeGlobal({
      "subagent-models": { worker: "p/m" },
      "subagent-tools": { bad: { add: 123 } }, // invalid
    });
    const { config, errors } = loadSubagentConfig(globalDir, projectDir);
    expect(config["subagent-models"]?.worker).toBe("p/m"); // models intact
    expect(errors.some((e) => e.includes("bad"))).toBe(true); // tool error surfaced
  });

  // Op-level unknown keys: a typo'd operation (e.g. 'ad' for 'add') inside a valid agent
  // entry must be a structural error. Otherwise the typo silently parses to an empty policy —
  // a no-op that hides the user's intent.
  it("an unknown operation key (typo 'ad') inside an entry is a structural error", () => {
    writeGlobal({
      "subagent-tools": { reviewer: { ad: ["bash"] } }, // 'ad' typo for 'add'
    });
    const { errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors.some((e) => e.includes("ad") && e.includes("reviewer"))).toBe(true);
  });

  it("reports unknown ops alongside valid ones in the same entry", () => {
    writeGlobal({
      "subagent-tools": { reviewer: { add: ["read"], blcok: ["bash"] } }, // 'blcok' typo for 'block'
    });
    const { errors, config } = loadSubagentConfig(globalDir, projectDir);
    // The typo is reported (fail-loud)...
    expect(errors.some((e) => e.includes("blcok"))).toBe(true);
    // ...and the whole entry is dropped (consistent with malformed-array handling: any error in
    // an entry drops it; the enforcement path throws on structural errors anyway, degrading to
    // no-policy, so the entry is irrelevant once an error is reported).
    expect(config["subagent-tools"]?.reviewer).toBeUndefined();
  });

  it("malformed JSON is collected as a error (not silently swallowed)", () => {
    writeFileSync(join(globalDir, "settings.json"), "{ this is not valid json }}}");
    let errors: string[] = [];
    expect(() => {
      errors = loadSubagentConfig(globalDir, projectDir).errors;
    }).not.toThrow();
    expect(errors.some((e) => e.includes("global") && e.length > 0)).toBe(true);
  });

  it("a malformed PROJECT config attributes its errors to 'project settings.json' (origin tracked per level)", () => {
    // Distinct from a global-config error: the operator must see WHICH file is broken so they
    // know where to look. A bad subagent-tools/tool-sets/hidden/disabled in the project file is
    // attributed to the project origin, not the global one.
    writeProject({ "subagent-tools": { worker: { add: 123 } } }); // invalid: add must be a string array
    const { errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors.some((e) => e.includes("project settings.json"))).toBe(true);
    expect(errors.some((e) => e.includes("global settings.json"))).toBe(false);
  });

  it("non-object `avtc-pi-subagent` section surfaces an error", () => {
    writeFileSync(join(globalDir, "settings.json"), JSON.stringify({ "avtc-pi-subagent": "not-an-object" }));
    const { errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors.some((e) => e.includes("not an object"))).toBe(true);
  });

  // ---: glob key parses (agents aren't known at load — agent-match deferred) ---
  it("a glob agent-name key parses without error", () => {
    writeGlobal({ "subagent-tools": { "reviewer-*": { add: ["read"] } } });
    const { config, errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors).toEqual([]);
    expect(config["subagent-tools"]?.["reviewer-*"]?.add).toEqual(["read"]);
  });

  // ---: $-prefix discipline ---
  it("a tool-sets KEY with a leading $ is an error", () => {
    writeGlobal({ "tool-sets": { $mytools: ["read"] } });
    const { errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors.some((e) => e.includes('"$mytools"') && e.includes('"$"'))).toBe(true);
  });

  it("a tool-sets VALUE entry with a leading $ is an error AND dropped", () => {
    writeGlobal({ "tool-sets": { git: ["$git", "bash"] } });
    const { errors, config } = loadSubagentConfig(globalDir, projectDir);
    expect(errors.some((e) => e.includes('"$git"'))).toBe(true);
    // The stray $-prefixed member is dropped so it cannot reach $ref expansion later —
    // the surviving set keeps only the valid member.
    expect(config["tool-sets"]?.git).toEqual(["bash"]);
  });

  // ---: merge semantics ---
  it("tool-sets project-replaces-global per name", () => {
    writeGlobal({ "tool-sets": { shared: ["a", "b"] } });
    writeProject({ "tool-sets": { shared: ["x", "y"] } });
    const { config } = loadSubagentConfig(globalDir, projectDir);
    expect(config["tool-sets"]?.shared).toEqual(["x", "y"]); // project replaces, not union
  });

  it("hidden-agents / disabled-agents union deduped", () => {
    writeGlobal({ "hidden-agents": ["a-*", "shared"] });
    writeProject({ "hidden-agents": ["b-*", "shared"] });
    const { config } = loadSubagentConfig(globalDir, projectDir);
    expect(config["hidden-agents"]).toEqual(["a-*", "shared", "b-*"]);
  });

  it("subagent-tools add/block union + only replace", () => {
    writeGlobal({ "subagent-tools": { worker: { add: ["read"], block: ["bash"] } } });
    writeProject({ "subagent-tools": { worker: { add: ["git"], block: ["read"] } } });
    const { config } = loadSubagentConfig(globalDir, projectDir);
    expect(config["subagent-tools"]?.worker?.add).toEqual(["read", "git"]); // union deduped
    expect(config["subagent-tools"]?.worker?.block).toEqual(["bash", "read"]); // union deduped
  });

  it("subagent-tools only project-replaces-global", () => {
    writeGlobal({ "subagent-tools": { worker: { only: ["read"] } } });
    writeProject({ "subagent-tools": { worker: { only: ["read", "write"] } } });
    const { config } = loadSubagentConfig(globalDir, projectDir);
    expect(config["subagent-tools"]?.worker?.only).toEqual(["read", "write"]); // project replaces
  });

  it("post-merge only + add on the same key is an error", () => {
    writeGlobal({ "subagent-tools": { worker: { only: ["read"] } } });
    writeProject({ "subagent-tools": { worker: { add: ["write"] } } });
    const { config, errors } = loadSubagentConfig(globalDir, projectDir);
    // after merge the key has both only + add → error
    expect(errors.some((e) => e.includes('"worker"') && e.includes('"only"'))).toBe(true);
    // only wins the merge shape (add still present) — the contradiction is surfaced, not silently applied
    expect(config["subagent-tools"]?.worker).toBeDefined();
  });

  // --- undefined $ref ---
  it("undefined $ref is collected as an error", () => {
    writeGlobal({ "subagent-tools": { worker: { add: ["$nosuch"] } } });
    const { errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors.some((e) => e.includes('"$nosuch"'))).toBe(true);
  });

  // ---: delete-when-empty branch (default case: no hidden/disabled keys anywhere) ---
  it("hidden-agents / disabled-agents keys are absent when neither level defines them", () => {
    writeGlobal({ "subagent-models": { reviewer: "test-provider/model-b" } }); // some unrelated key
    const { config, errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors).toEqual([]);
    // the delete-when-empty branch fires: empty unions are dropped, not present as []
    expect(config["hidden-agents"]).toBeUndefined();
    expect(config["disabled-agents"]).toBeUndefined();
  });

  // ---: $ref expansion in the block array ---
  it("expands a $ref in the block array", () => {
    writeGlobal({
      "tool-sets": { dangerous: ["bash", "git"] },
      "subagent-tools": { reviewer: { block: ["$dangerous"] } },
    });
    const { config, errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors).toEqual([]);
    expect(config["subagent-tools"]?.reviewer?.block).toEqual(["bash", "git"]);
  });

  // ---: $ref expansion after global+project merge (set defined in one level, ref used in the other) ---
  it("expands a $ref whose set is defined in the other merge level", () => {
    writeGlobal({ "tool-sets": { shared: ["read", "glob"] } });
    writeProject({ "subagent-tools": { worker: { only: ["$shared"] } } });
    const { config, errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors).toEqual([]);
    // $shared resolves against the MERGED tool-sets (global defines it, project uses it)
    expect(config["subagent-tools"]?.worker?.only).toEqual(["read", "glob"]);
  });

  // --- within-entry contradiction ---
  it("within-entry only + add on the same key is a contradiction error", () => {
    writeGlobal({ "subagent-tools": { worker: { only: ["read"], add: ["write"] } } });
    const { errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors.filter((e) => e.includes('"worker"') && e.includes('"only"'))).toHaveLength(1);
  });

  it("collects ALL malformed ops in a single entry (not just the first)", () => {
    writeGlobal({ "subagent-tools": { worker: { add: 1, block: 2 } } });
    const { errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors.filter((e) => e.includes("worker"))).toHaveLength(2); // both add + block
  });

  // --- structural-shape branches ---
  it("non-object `subagent-tools` section is an error", () => {
    writeGlobal({ "subagent-tools": "not-an-object" });
    const { errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors.some((e) => e.includes("subagent-tools") && e.includes("object"))).toBe(true);
  });

  it("non-object `tool-sets` section is an error", () => {
    writeGlobal({ "tool-sets": 123 });
    const { errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors.some((e) => e.includes("tool-sets") && e.includes("object"))).toBe(true);
  });

  it("non-array tool-sets value is an error", () => {
    writeGlobal({ "tool-sets": { git: "not-an-array" } });
    const { errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors.some((e) => e.includes('"git"'))).toBe(true);
  });

  it("non-array disabled-agents is an error", () => {
    writeGlobal({ "disabled-agents": "not-an-array" });
    const { errors } = loadSubagentConfig(globalDir, projectDir);
    expect(errors.some((e) => e.includes("disabled-agents"))).toBe(true);
  });
});
