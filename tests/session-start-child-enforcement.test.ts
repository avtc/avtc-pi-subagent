// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Integration test: the real session_start handler self-restricts a child session.
 *
 * Proves the full wiring — session_start -> enforceChildToolPolicy(pi, discovery, ...) ->
 * pi.setActiveTools(effective) — fires for a process marked as a child (PI_SUBAGENT_CHILD_AGENT
 * set), with config injected via the loader seam. This is the integration counterpart to the
 * unit-level enforceChildToolPolicy tests.
 *
 * setup.ts deletes PI_SUBAGENT_CHILD_AGENT in its global beforeEach, so a child marker set here
 * never leaks into sibling tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, AgentDiscoveryResult } from "../src/agents.js";
import { _resetAllTestHooks, _setDiscoverAgents, _setLoadSubagentConfig } from "../src/extension.js";
import { injectEmptyModelConfig, registerSubagentExtension, setTestSettings } from "./test-helpers.js";

const WORKER: AgentConfig = { name: "worker", description: "d", systemPrompt: "", filePath: "/tmp/worker.md" };

const discoveryWith = (agents: AgentConfig[]): AgentDiscoveryResult => ({
  agents,
  bundledAgents: agents,
  projectAgentsDir: null,
  extensionAgentDirs: [],
  overrideNames: new Set(),
});

const EMPTY_CONFIG = { config: { "subagent-models": {}, "default-model": null }, errors: [] };

describe("session_start child self-restriction (integration)", () => {
  beforeEach(() => {
    _resetAllTestHooks();
    injectEmptyModelConfig();
    setTestSettings(null);
    _setDiscoverAgents(() => discoveryWith([WORKER]));
  });
  afterEach(() => {
    _resetAllTestHooks();
    delete process.env.PI_SETTINGS_SUBAGENT;
    // Belt-and-suspenders: setup.ts also clears CHILD_AGENT, but be explicit so this test's
    // child marker cannot leak even if run in isolation.
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    delete process.env.PI_SUBAGENT_IS_FORK;
    delete process.env.PI_SUBAGENT_TOOLS;
  });

  it("a child session self-restricts via setActiveTools when session_start fires on the real factory", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK; // fresh child
    process.env.PI_SUBAGENT_TOOLS = "read"; // base = {read}
    // No tool policy -> effective set == base == ["read"].
    _setLoadSubagentConfig(() => EMPTY_CONFIG);

    const setActiveTools = vi.fn();
    const { emitter } = registerSubagentExtension({
      sessionName: "child-self-restrict-session",
      extra: {
        getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "bash" }],
        setActiveTools,
      },
    });

    // Fire session_start: the handler runs enforceChildToolPolicy, which (fresh child, base
    // = {read}, no policy) calls setActiveTools(["read"]).
    emitter.emit("session_start", { reason: "startup" });

    expect(setActiveTools).toHaveBeenCalledTimes(1);
    expect(setActiveTools.mock.calls[0]?.[0]).toEqual(["read"]);
  });

  it("the top-level session (no CHILD_AGENT) does NOT self-restrict", () => {
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    _setLoadSubagentConfig(() => EMPTY_CONFIG);

    const setActiveTools = vi.fn();
    const { emitter } = registerSubagentExtension({
      sessionName: "top-level-session",
      extra: { getAllTools: () => [{ name: "read" }], setActiveTools },
    });

    emitter.emit("session_start", { reason: "startup" });

    // Top-level session is never self-restricted (only spawned children self-restrict):
    expect(setActiveTools).not.toHaveBeenCalled();
  });

  // Regression: the config injected via the loader seam MUST reach enforceChildToolPolicy.
  // A single shared config-loader seam means a block policy changes the effective set — proving
  // the injection flows through to setActiveTools (a split seam would silently read real
  // settings.json and ignore the injected policy).
  it("a block policy injected via the loader seam reaches enforcement (single-seam regression)", () => {
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    delete process.env.PI_SUBAGENT_IS_FORK; // fresh child
    process.env.PI_SUBAGENT_TOOLS = "read,write,bash"; // base = {read,write,bash}
    // Inject a policy that blocks 'bash' — if the seam is unified, bash is excluded.
    _setLoadSubagentConfig(() => ({
      config: { "subagent-models": {}, "default-model": null, "subagent-tools": { worker: { block: ["bash"] } } },
      errors: [],
    }));

    const setActiveTools = vi.fn();
    const { emitter } = registerSubagentExtension({
      sessionName: "seam-regression-session",
      extra: {
        getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "bash" }],
        setActiveTools,
      },
    });

    emitter.emit("session_start", { reason: "startup" });

    // The injected block policy took effect (bash excluded) — proving the seam injection reached
    // enforcement.
    expect(setActiveTools).toHaveBeenCalledTimes(1);
    const effective = setActiveTools.mock.calls[0]?.[0] as string[];
    expect(effective).toContain("read");
    expect(effective).toContain("write");
    expect(effective).not.toContain("bash"); // injected block policy reached enforcement
  });
});
