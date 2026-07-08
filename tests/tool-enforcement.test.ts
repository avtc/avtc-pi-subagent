// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, AgentDiscoveryResult } from "../src/agents.js";
import type { SubagentConfig } from "../src/subagent-config.js";
import { _resetSubagentConfig } from "../src/subagent-config.js";
import {
  _resetToolEnforcementState,
  deriveBase,
  type EnforcementPi,
  enforceChildToolPolicy,
  getValidatedPolicy,
  type LoadSubagentConfig,
} from "../src/tool-enforcement.js";
import { resolveToolPolicy } from "../src/tool-resolution.js";

const discovery = (names: string[]): AgentDiscoveryResult => ({
  agents: names.map((name) => ({ name, description: "d", systemPrompt: "" })) as AgentConfig[],
  bundledAgents: [],
  projectAgentsDir: null,
  extensionAgentDirs: [],
  overrideNames: new Set<string>(),
});

/** Build a fake EnforcementPi with getAllTools returning the given tool names + a spy on setActiveTools. */
function fakePi(allNames: string[]): { pi: EnforcementPi; setActiveTools: ReturnType<typeof vi.fn> } {
  const setActiveTools = vi.fn();
  const pi: EnforcementPi = {
    getAllTools: vi.fn(() => allNames.map((name) => ({ name }) as unknown as ToolInfo)),
    setActiveTools,
  };
  return { pi, setActiveTools };
}

/** An in-memory config loader (never touches real global/project folders). */
function loader(config: SubagentConfig): () => { config: SubagentConfig; errors: string[] } {
  return () => ({ config, errors: [] });
}

const EMPTY_CONFIG: SubagentConfig = { "subagent-models": {}, "default-model": null };

const ALL_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls", "subagent", "todo_init", "todo_add"];

describe("tool-enforcement", () => {
  const origEnv = process.env;
  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    delete process.env.PI_SUBAGENT_IS_FORK;
    delete process.env.PI_SUBAGENT_TOOLS;
    delete process.env.PI_SUBAGENT_TOOLS_ADD;
    _resetToolEnforcementState();
    _resetSubagentConfig();
  });
  afterEach(() => {
    _resetToolEnforcementState();
    _resetSubagentConfig();
    process.env = origEnv;
  });

  // : gate — top-level session (no CHILD_AGENT) never self-restricts
  it("no-op when PI_SUBAGENT_CHILD_AGENT is unset", () => {
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    expect(() =>
      enforceChildToolPolicy(
        pi,
        discovery(["worker"]),
        "/tmp/nonexistent-global",
        loader(EMPTY_CONFIG),
        resolveToolPolicy,
      ),
    ).not.toThrow();
    expect(setActiveTools).not.toHaveBeenCalled();
    expect(getValidatedPolicy()).toBeNull();
  });

  // /: fresh whitelisted child + block policy -> effective set excludes blocked tool
  it("fresh child applies add/block policy — blocked tool excluded from effective set", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK; // fresh
    process.env.PI_SUBAGENT_TOOLS = "read,write,bash";
    const cfg = {
      "subagent-models": {},
      "default-model": null,
      "subagent-tools": { worker: { block: ["bash"] } },
    };
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    enforceChildToolPolicy(pi, discovery(["worker"]), "/tmp/nonexistent-global", loader(cfg), resolveToolPolicy);
    const effective = setActiveTools.mock.calls[0]?.[0] as string[];
    expect(effective).toContain("read");
    expect(effective).toContain("write");
    expect(effective).not.toContain("bash"); // blocked — absent (clean prompt + hard floor)
  });

  // : tool-name glob expands via getAllTools
  it("fresh child expands tool-name globs via getAllTools", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK;
    process.env.PI_SUBAGENT_TOOLS = "read,bash";
    const cfg = {
      "subagent-models": {},
      "default-model": null,
      "subagent-tools": { worker: { add: ["todo_*"] } },
    };
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    enforceChildToolPolicy(pi, discovery(["worker"]), "/tmp/nonexistent-global", loader(cfg), resolveToolPolicy);
    const effective = setActiveTools.mock.calls[0]?.[0] as string[];
    expect(effective).toContain("read");
    expect(effective).toContain("bash");
    expect(effective).toContain("todo_init"); // glob-expanded
    expect(effective).toContain("todo_add");
  });

  //  silent drop: a literal tool name not in the registry is dropped from the effective set
  // (it cannot be activated). Pins that unknown tools never leak into setActiveTools.
  it("fresh child silently drops an add-listed tool not in the registry", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK;
    process.env.PI_SUBAGENT_TOOLS = "read";
    const cfg = {
      "subagent-models": {},
      "default-model": null,
      "subagent-tools": { worker: { add: ["read", "does_not_exist"] } },
    };
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    enforceChildToolPolicy(pi, discovery(["worker"]), "/tmp/nonexistent-global", loader(cfg), resolveToolPolicy);
    const effective = setActiveTools.mock.calls[0]?.[0] as string[];
    expect(effective).toContain("read");
    expect(effective).not.toContain("does_not_exist"); // silently dropped — not in registry
  });

  // : whitelistless + TOOLS_ADD -> base = all tools, NOT narrowed (TOOLS_ADD no-narrow invariant)
  it("whitelistless child + TOOLS_ADD -> base = all, setActiveTools NOT narrowed", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK;
    delete process.env.PI_SUBAGENT_TOOLS; // whitelistless
    process.env.PI_SUBAGENT_TOOLS_ADD = "todo_init"; // forced-add
    const cfg = { "subagent-models": {}, "default-model": null }; // no policy
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    enforceChildToolPolicy(pi, discovery(["worker"]), "/tmp/nonexistent-global", loader(cfg), resolveToolPolicy);
    const effective = setActiveTools.mock.calls[0]?.[0] as string[];
    // whitelistless => base = all tools; TOOLS_ADD is a no-op for whitelistless (no-narrow)
    expect(effective.sort()).toEqual([...ALL_TOOLS].sort());
  });

  // only-mode
  it("only-mode: fresh child restricts to exactly the only set", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "reviewer";
    delete process.env.PI_SUBAGENT_IS_FORK;
    process.env.PI_SUBAGENT_TOOLS = "read,write,bash";
    const cfg = {
      "subagent-models": {},
      "default-model": null,
      "subagent-tools": { reviewer: { only: ["read", "grep"] } },
    };
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    enforceChildToolPolicy(pi, discovery(["reviewer"]), "/tmp/nonexistent-global", loader(cfg), resolveToolPolicy);
    const effective = setActiveTools.mock.calls[0]?.[0] as string[];
    expect(effective.sort()).toEqual(["grep", "read"]);
  });

  // only-mode with $all -> all tools
  it("only-mode: $all expands to all tools", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "admin";
    delete process.env.PI_SUBAGENT_IS_FORK;
    process.env.PI_SUBAGENT_TOOLS = "read";
    const cfg = {
      "subagent-models": {},
      "default-model": null,
      "subagent-tools": { admin: { only: ["$all"] } },
    };
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    enforceChildToolPolicy(pi, discovery(["admin"]), "/tmp/nonexistent-global", loader(cfg), resolveToolPolicy);
    const effective = setActiveTools.mock.calls[0]?.[0] as string[];
    expect(effective.sort()).toEqual([...ALL_TOOLS].sort());
  });

  // : precedence — base=[read,git], add=[bash], block=[git] -> [read,bash]
  it("precedence — add/block/base compose to [read,bash]", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK;
    process.env.PI_SUBAGENT_TOOLS = "read,git";
    const cfg = {
      "subagent-models": {},
      "default-model": null,
      "subagent-tools": { worker: { add: ["bash"], block: ["git"] } },
    };
    const { pi, setActiveTools } = fakePi(["read", "git", "bash"]);
    enforceChildToolPolicy(pi, discovery(["worker"]), "/tmp/nonexistent-global", loader(cfg), resolveToolPolicy);
    const effective = setActiveTools.mock.calls[0]?.[0] as string[];
    expect(effective.sort()).toEqual(["bash", "read"]);
  });

  // : no config + TOOLS set -> exact tools; (whitelistless handled in)
  it("no config + TOOLS set -> effective = base tools", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK;
    process.env.PI_SUBAGENT_TOOLS = "read,write";
    const cfg = { "subagent-models": {}, "default-model": null }; // no subagent-tools
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    enforceChildToolPolicy(pi, discovery(["worker"]), "/tmp/nonexistent-global", loader(cfg), resolveToolPolicy);
    const effective = setActiveTools.mock.calls[0]?.[0] as string[];
    expect(effective.sort()).toEqual(["read", "write"]);
  });

  // $all in block (fresh path) -> blocks everything
  it("$all in block -> effective set is empty", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK;
    process.env.PI_SUBAGENT_TOOLS = "read,write";
    const cfg = {
      "subagent-models": {},
      "default-model": null,
      "subagent-tools": { worker: { block: ["$all"] } },
    };
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    enforceChildToolPolicy(pi, discovery(["worker"]), "/tmp/nonexistent-global", loader(cfg), resolveToolPolicy);
    const effective = setActiveTools.mock.calls[0]?.[0] as string[];
    expect(effective).toEqual([]);
  });
});

describe("tool-enforcement: validation failure handling", () => {
  const origEnv = process.env;
  // Fail-closed spies restored in afterEach (not inline) so an assertion failure before the
  // restore cannot leak the process.exit/stderr mock across the isolate:false worker.
  let exitSpy: ReturnType<typeof vi.spyOn> | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;
  beforeEach(() => {
    process.env = { ...origEnv };
    _resetToolEnforcementState();
    _resetSubagentConfig();
  });
  afterEach(() => {
    exitSpy?.mockRestore();
    stderrSpy?.mockRestore();
    exitSpy = undefined;
    stderrSpy = undefined;
    _resetToolEnforcementState();
    _resetSubagentConfig();
    process.env = origEnv;
  });

  // : contradiction throws at session_start for BOTH fresh AND fork
  it("contradiction throws for a FRESH child (validation runs before the fork branch)", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK; // fresh
    process.env.PI_SUBAGENT_TOOLS = "read";
    const cfg = {
      "subagent-models": {},
      "default-model": null,
      "subagent-tools": { "*": { only: ["read"] }, worker: { add: ["write"] } },
    };
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    //  contradiction -> throws (pi runner catches -> emitError -> visible report).
    expect(() =>
      enforceChildToolPolicy(pi, discovery(["worker"]), "/tmp/nonexistent-global", loader(cfg), resolveToolPolicy),
    ).toThrow();
    // degraded stash
    expect(getValidatedPolicy()).toEqual({ policy: null, degraded: true });
    // fresh degrade path applied base-only BEFORE throwing — assert the EXACT base set was
    // activated (not merely that setActiveTools was called), pinning degrade = frontmatter only.
    expect(setActiveTools).toHaveBeenCalledTimes(1);
    expect(setActiveTools.mock.calls[0]?.[0]).toEqual(["read"]);
  });

  it("contradiction throws for a FORK child too (validation NOT skipped before the fork branch)", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    process.env.PI_SUBAGENT_IS_FORK = "1"; // fork
    process.env.PI_SUBAGENT_TOOLS = "read";
    const cfg = {
      "subagent-models": {},
      "default-model": null,
      "subagent-tools": { "*": { only: ["read"] }, worker: { add: ["write"] } },
    };
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    expect(() =>
      enforceChildToolPolicy(pi, discovery(["worker"]), "/tmp/nonexistent-global", loader(cfg), resolveToolPolicy),
    ).toThrow();
    // fork: degraded stash set (guard composes base-only); setActiveTools NOT called (fork prompt frozen)
    expect(getValidatedPolicy()).toEqual({ policy: null, degraded: true });
    expect(setActiveTools).not.toHaveBeenCalled();
  });

  // : a contradiction for ONE agent does not break another agent's spawn (self-scoped)
  it("a contradiction for reviewer does not break a worker spawn", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker"; // NOT reviewer
    delete process.env.PI_SUBAGENT_IS_FORK;
    process.env.PI_SUBAGENT_TOOLS = "read";
    const cfg = {
      "subagent-models": {},
      "default-model": null,
      // reviewer has a contradiction, worker does not
      "subagent-tools": { "*": { only: ["read"] }, reviewer: { add: ["write"] } },
    };
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    expect(() =>
      enforceChildToolPolicy(
        pi,
        discovery(["worker", "reviewer"]),
        "/tmp/nonexistent-global",
        loader(cfg),
        resolveToolPolicy,
      ),
    ).not.toThrow();
    // worker resolves cleanly (only-mode: * matches -> set=[read])
    expect(getValidatedPolicy()?.degraded).toBe(false);
    const effective = setActiveTools.mock.calls[0]?.[0] as string[];
    expect(effective).toEqual(["read"]);
  });

  // : enforcement failure (getAllTools throws) -> fail-closed exit, not a swallowed throw
  it("getAllTools throwing -> fail-closed (stderr + process.exit non-zero)", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK;
    process.env.PI_SUBAGENT_TOOLS = "read";
    const cfg = { "subagent-models": {}, "default-model": null };
    const pi: EnforcementPi = {
      getAllTools: vi.fn(() => {
        throw new Error("registry exploded");
      }),
      setActiveTools: vi.fn(),
    };
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("EXIT_CALLED");
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() =>
      enforceChildToolPolicy(pi, discovery(["worker"]), "/tmp/nonexistent-global", loader(cfg), resolveToolPolicy),
    ).toThrow("EXIT_CALLED");
    expect(exitSpy).toHaveBeenCalledWith(1); // non-zero, fail-closed
    // stderr carries the cause (visible to the parent, which reads stderr for the failure line).
    const stderrText = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(stderrText).toContain("enforcement failed");
    expect(stderrText).toContain("registry exploded");
  });

  //  degrade-path: a validation failure where the degrade setActiveTools ALSO throws -> fail-closed
  it("degrade-path setActiveTools failure -> fail-closed exit (not unrestricted)", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK;
    process.env.PI_SUBAGENT_TOOLS = "read";
    const cfg = {
      "subagent-models": {},
      "default-model": null,
      "subagent-tools": { "*": { only: ["read"] }, worker: { add: ["write"] } }, //  contradiction
    };
    const pi: EnforcementPi = {
      getAllTools: vi.fn(() => ALL_TOOLS.map((n) => ({ name: n }) as unknown as ToolInfo)),
      setActiveTools: vi.fn(() => {
        throw new Error("setActiveTools exploded");
      }),
    };
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("EXIT_CALLED");
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // degrade path: setActiveTools(base) throws -> fail-closed (NOT the validation throw which
    // would otherwise leave the child unrestricted).
    expect(() =>
      enforceChildToolPolicy(pi, discovery(["worker"]), "/tmp/nonexistent-global", loader(cfg), resolveToolPolicy),
    ).toThrow("EXIT_CALLED");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderrText = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(stderrText).toContain("enforcement failed");
    expect(stderrText).toContain("setActiveTools exploded");
  });

  //  errors (structural) also throw at session_start
  it("structural errors -> throw (degrade to base-only for fresh first)", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK;
    process.env.PI_SUBAGENT_TOOLS = "read";
    // loader that returns an error: config with a structural validation error
    const cfg = {
      config: { "subagent-models": {}, "default-model": null },
      errors: ['subagent-tools["worker"].add: expected a string array, got 123'],
    };
    const loadCfg = () => cfg;
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    expect(() =>
      enforceChildToolPolicy(pi, discovery(["worker"]), "/tmp/nonexistent-global", loadCfg, resolveToolPolicy),
    ).toThrow();
    expect(getValidatedPolicy()?.degraded).toBe(true);
    expect(setActiveTools).toHaveBeenCalledTimes(1); // base-only applied
    expect(setActiveTools.mock.calls[0]?.[0]).toEqual(["read"]); // exact base set
  });

  //  loader itself throws (not a returned error) -> degrade to base-only + throw (fail-closed,
  //  NOT fail-open). Defense-in-depth: any loader throw must keep the child restricted.
  it("loader throwing -> degrade to base-only + throw (not fail-open)", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK;
    process.env.PI_SUBAGENT_TOOLS = "read";
    const throwingLoader = (() => {
      throw new TypeError("boom from inside the loader");
    }) as unknown as LoadSubagentConfig;
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    // Must NOT propagate the raw loader throw (which session_start swallows -> fail-open).
    // Must degrade to base-only (child restricted) and then throw a visible error.
    expect(() =>
      enforceChildToolPolicy(pi, discovery(["worker"]), "/tmp/nonexistent-global", throwingLoader, resolveToolPolicy),
    ).toThrow();
    expect(getValidatedPolicy()?.degraded).toBe(true);
    expect(setActiveTools).toHaveBeenCalledTimes(1); // base-only applied BEFORE throwing
    expect(setActiveTools.mock.calls[0]?.[0]).toEqual(["read"]); // exact base set
  });

  //  resolver itself throws (e.g. a pathological glob tripping compileGlob) -> degrade to
  //  base-only + throw (fail-closed, NOT fail-open). Same fail-open consequence as a loader
  //  throw: a raw throw out of session_start is swallowed -> fresh child UNRESTRICTED.
  it("resolver throwing -> degrade to base-only + throw (not fail-open)", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK;
    process.env.PI_SUBAGENT_TOOLS = "read";
    const throwingResolver = (): never => {
      throw new TypeError("boom from inside the resolver");
    };
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    // Must NOT propagate the raw resolver throw (which session_start swallows -> fail-open).
    // Must degrade to base-only (child restricted) and then throw a visible error.
    expect(() =>
      enforceChildToolPolicy(
        pi,
        discovery(["worker"]),
        "/tmp/nonexistent-global",
        loader(EMPTY_CONFIG),
        throwingResolver,
      ),
    ).toThrow();
    expect(getValidatedPolicy()?.degraded).toBe(true);
    expect(setActiveTools).toHaveBeenCalledTimes(1); // base-only applied BEFORE throwing
    expect(setActiveTools.mock.calls[0]?.[0]).toEqual(["read"]); // exact base set
  });

  // Fork validation-only path: valid policy for fork -> stash set, no setActiveTools
  it("fork child with valid policy -> stash set, setActiveTools NOT called (guard handles enforcement)", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    process.env.PI_SUBAGENT_IS_FORK = "1";
    process.env.PI_SUBAGENT_TOOLS = "read,bash";
    const cfg = {
      "subagent-models": {},
      "default-model": null,
      "subagent-tools": { worker: { block: ["bash"] } },
    };
    const { pi, setActiveTools } = fakePi(ALL_TOOLS);
    expect(() =>
      enforceChildToolPolicy(pi, discovery(["worker"]), "/tmp/nonexistent-global", loader(cfg), resolveToolPolicy),
    ).not.toThrow();
    // stash holds the validated policy (guard composes at first tool_call)
    expect(getValidatedPolicy()?.degraded).toBe(false);
    expect(getValidatedPolicy()?.policy).toEqual({ mode: "addblock", add: [], block: ["bash"] });
    expect(setActiveTools).not.toHaveBeenCalled(); // fork prompt frozen
  });
});

describe("tool-enforcement: deriveBase", () => {
  const origEnv = process.env;
  beforeEach(() => {
    process.env = { ...origEnv };
  });
  afterEach(() => {
    process.env = origEnv;
  });

  it("TOOLS unset -> {kind:all} (whitelistless)", () => {
    delete process.env.PI_SUBAGENT_TOOLS;
    delete process.env.PI_SUBAGENT_TOOLS_ADD;
    expect(deriveBase()).toEqual({ kind: "all" });
  });

  it("TOOLS unset + TOOLS_ADD set -> {kind:all} (TOOLS_ADD is a no-op for a whitelistless agent)", () => {
    // The whitelistless contract: TOOLS_ADD only force-adds to an EXISTING whitelist. A
    // whitelistless agent (no frontmatter tools) MUST NOT be narrowed by TOOLS_ADD — it stays
    // {kind:all}. Pins that the {kind:all} short-circuit never reads TOOLS_ADD.
    delete process.env.PI_SUBAGENT_TOOLS;
    process.env.PI_SUBAGENT_TOOLS_ADD = "todo_init";
    expect(deriveBase()).toEqual({ kind: "all" });
  });

  it("TOOLS + TOOLS_ADD -> {kind:concrete} with both unioned, parsed once", () => {
    process.env.PI_SUBAGENT_TOOLS = "read";
    process.env.PI_SUBAGENT_TOOLS_ADD = "todo_init";
    expect(deriveBase()).toEqual({ kind: "concrete", names: ["read", "todo_init"] });
  });

  it("TOOLS set, TOOLS_ADD unset -> concrete names from TOOLS only", () => {
    process.env.PI_SUBAGENT_TOOLS = "read,write";
    delete process.env.PI_SUBAGENT_TOOLS_ADD;
    expect(deriveBase()).toEqual({ kind: "concrete", names: ["read", "write"] });
  });

  it("TOOLS='' (empty string) -> {kind:concrete, names:[]} (an explicit EMPTY whitelist, NOT whitelistless)", () => {
    // An empty whitelist is distinct from an unset one: unset => {kind:all} (every tool),
    // empty => {kind:concrete, names:[]} (zero tools). This pins the distinction so a parent
    // that forwards an empty tool list cannot accidentally widen into all-tools.
    process.env.PI_SUBAGENT_TOOLS = "";
    delete process.env.PI_SUBAGENT_TOOLS_ADD;
    expect(deriveBase()).toEqual({ kind: "concrete", names: [] });
  });
});
