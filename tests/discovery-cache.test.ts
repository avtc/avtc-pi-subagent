// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for the per-cwd discoverAgents cache.
 *
 * discoverAgents reads several directories (bundled + each integration path + project
 * .pi/agents + user agents) on every call. The subagent tool calls it once per dispatch, so
 * re-reading disk per dispatch is wasteful. A cwd-keyed cache serves repeat calls within a
 * session and is invalidated on session_start (where _agentsPaths resets and :ready re-fires).
 */

import type { EventEmitter } from "node:events";
import type { ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, AgentDiscoveryResult } from "../src/agents.js";
import { _resetAllTestHooks, _setDiscoverAgents, _setLoadSubagentConfig } from "../src/extension.js";
import { _setSpawn } from "../src/process-runner.js";
import { injectEmptyModelConfig, registerSubagentExtension, setTestSettings } from "./test-helpers.js";

const WORKER: AgentConfig = { name: "worker", description: "d", systemPrompt: "", filePath: "/tmp/worker.md" };

/** A discovery result with the worker agent present. */
const discoveryWith = (agents: AgentConfig[]): AgentDiscoveryResult => ({
  agents,
  bundledAgents: agents,
  projectAgentsDir: null,
  extensionAgentDirs: [],
  overrideNames: new Set(),
});

describe("discoverAgents per-cwd cache", () => {
  let tool: ToolDefinition;
  let ctx: ExtensionCommandContext;
  let emitter: EventEmitter;

  const register = (discoverFn: { (): AgentDiscoveryResult; calls: number }): void => {
    // spawn throws so dispatches reject fast — discovery happens BEFORE spawn, so the cache
    // has already been consulted by the time spawn runs. The sentinel surfaces in the catch.
    _setSpawn(
      vi.fn((): never => {
        throw new Error("SPAWN");
      }),
    );
    _setDiscoverAgents(() => {
      discoverFn.calls++;
      return discoverFn();
    });
    _setLoadSubagentConfig(() => ({ config: { "subagent-models": {}, "default-model": null }, errors: [] }));

    const registrations: ToolDefinition[] = [];
    ({ emitter } = registerSubagentExtension({ registrations, sessionName: "discovery-cache-session" }));
    tool = registrations[0];
  };

  beforeEach(() => {
    _resetAllTestHooks();
    injectEmptyModelConfig();
    setTestSettings(null);
    ctx = { cwd: process.cwd(), hasUI: false } as unknown as ExtensionCommandContext;
  });

  afterEach(() => {
    _resetAllTestHooks();
    delete process.env.PI_SETTINGS_SUBAGENT;
  });

  it("dispatches with the same cwd reuse the cached discovery (one disk read, not per-dispatch)", async () => {
    const discover = Object.assign(() => discoveryWith([WORKER]), { calls: 0 });
    register(discover);

    // session_start computes discovery once for process.cwd() (cache cold -> warm).
    emitter.emit("session_start");
    const callsAfterSessionStart = discover.calls;

    // Two dispatches with the same ctx.cwd (== process.cwd()) must hit the cache: no extra
    // discoverAgents calls. Each dispatch reaches spawn (worker is not restricted) and rejects.
    await expect(tool.execute("id", { agent: "worker", task: "t" }, undefined, undefined, ctx)).rejects.toThrow(
      "SPAWN",
    );
    await expect(tool.execute("id", { agent: "worker", task: "t" }, undefined, undefined, ctx)).rejects.toThrow(
      "SPAWN",
    );

    expect(discover.calls).toBe(callsAfterSessionStart); // cached — zero extra reads
  });

  it("a different ctx.cwd misses the cache and reads again (cwd-keyed)", async () => {
    const discover = Object.assign(() => discoveryWith([WORKER]), { calls: 0 });
    register(discover);

    emitter.emit("session_start");
    const callsAfterSessionStart = discover.calls;

    // A different cwd is a different cache key -> one fresh read for that cwd.
    const otherCtx = { cwd: "/some/other/cwd", hasUI: false } as unknown as ExtensionCommandContext;
    await tool.execute("id", { agent: "worker", task: "t" }, undefined, undefined, otherCtx);
    expect(discover.calls).toBe(callsAfterSessionStart + 1);

    // A repeat of that other cwd is cached.
    await tool.execute("id", { agent: "worker", task: "t" }, undefined, undefined, otherCtx);
    expect(discover.calls).toBe(callsAfterSessionStart + 1);
  });

  it("session_start invalidates the cache (re-reads after a reload)", async () => {
    const discover = Object.assign(() => discoveryWith([WORKER]), { calls: 0 });
    register(discover);

    emitter.emit("session_start");
    const callsAfterFirst = discover.calls;

    // A dispatch populates the cache for process.cwd() (already warm from session_start, so
    // still callsAfterFirst).
    await expect(tool.execute("id", { agent: "worker", task: "t" }, undefined, undefined, ctx)).rejects.toThrow(
      "SPAWN",
    );
    expect(discover.calls).toBe(callsAfterFirst);

    // Another session_start (reload) invalidates -> the next session_start discover re-reads.
    emitter.emit("session_start");
    expect(discover.calls).toBeGreaterThan(callsAfterFirst);
  });
});
