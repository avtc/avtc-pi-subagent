// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/agents.js";
import { ConcurrencyGate } from "../src/concurrency.js";
import { _resetAllTestHooks, _setDiscoverAgents, _setLoadSubagentConfig } from "../src/extension.js";
import { ProcessRegistry } from "../src/lifecycle.js";
import { _resetSpawn, _setSpawn, NO_STEP, type RunSingleAgentOptions, runSingleAgent } from "../src/process-runner.js";
import type { SubagentConfig } from "../src/subagent-config.js";
import type { SingleResult, SubagentDetails } from "../src/types.js";
import {
  configWithGlobs,
  createFakeProcess,
  injectEmptyModelConfig,
  registerSubagentExtension,
  setTestSettings,
  spawnCalledPromise,
} from "./test-helpers.js";

const experimental: AgentConfig = {
  name: "experimental-x",
  description: "d",
  systemPrompt: "",
  filePath: "/tmp/exp.md",
  hideFromAgentsList: false,
};
const reviewer: AgentConfig = {
  name: "reviewer",
  description: "d",
  systemPrompt: "",
  filePath: "/tmp/rev.md",
  hideFromAgentsList: false,
};
const worker: AgentConfig = {
  name: "worker",
  description: "d",
  systemPrompt: "",
  filePath: "/tmp/worker.md",
  hideFromAgentsList: false,
};

const mkDetails = (results: SingleResult[]): SubagentDetails => ({ mode: "single", projectAgentsDir: null, results });

const NO_OPTIONS: RunSingleAgentOptions = {};

async function run(agentName: string, agents: AgentConfig[], options: RunSingleAgentOptions): Promise<SingleResult> {
  return runSingleAgent(
    process.cwd(),
    agents,
    agentName,
    "test task",
    undefined,
    NO_STEP,
    undefined,
    undefined,
    mkDetails,
    new ProcessRegistry(),
    new ConcurrencyGate(() => 1),
    "run-1",
    options,
  );
}

describe("disabled-agents are spawn-rejected by policy", () => {
  beforeEach(() => {
    // Mock spawn to throw a sentinel, so a NON-disabled agent that reaches spawn surfaces a
    // distinct error (proving it got past the disabled check) instead of starting a real process.
    _setSpawn(() => {
      throw new Error("SPAWN_REACHED");
    });
    // runSingleAgent reads settings (maxSubagentDepth check) before spawn — mock the source so a
    // non-disabled agent reaches spawn without needing the real settings handle.
    setTestSettings(null);
  });
  afterEach(() => {
    _resetSpawn();
  });
  it("disabled glob matching the requested name -> placeholder, never spawns", async () => {
    const result = await run("experimental-x", [experimental, worker], {
      disabledAgentGlobs: ["experimental-*"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("disabled");
    expect(result.stderr).toContain("experimental-x");
  });

  it("disabled glob matching the resolved BASE name blocks a -fork variant", async () => {
    // Requested "reviewer-fork" resolves to base "reviewer"; a disabled glob on "reviewer" blocks it.
    const result = await run("reviewer-fork", [reviewer, worker], {
      disabledAgentGlobs: ["reviewer"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("disabled");
  });

  it("disabled glob matching the REQUESTED (fork-suffixed) name blocks it", async () => {
    const result = await run("reviewer-fork", [reviewer, worker], {
      disabledAgentGlobs: ["reviewer-fork"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("disabled");
  });

  it("non-disabled agent still spawns (disabled does not over-block)", async () => {
    // worker is not disabled — it must reach spawn. The throwing spawn mock surfaces the sentinel.
    await expect(run("worker", [experimental, worker], { disabledAgentGlobs: ["experimental-*"] })).rejects.toThrow(
      "SPAWN_REACHED",
    );
  });

  it("no disabled globs -> agent not disabled (passes the disabled check)", async () => {
    await expect(run("worker", [worker], NO_OPTIONS)).rejects.toThrow("SPAWN_REACHED");
  });
});

describe("unknown-agent error excludes hidden/disabled agents", () => {
  const hidden: AgentConfig = {
    name: "hidden-agent",
    description: "d",
    systemPrompt: "",
    filePath: "/tmp/h.md",
    hideFromAgentsList: false,
  };
  const disabled: AgentConfig = {
    name: "disabled-agent",
    description: "d",
    systemPrompt: "",
    filePath: "/tmp/dis.md",
    hideFromAgentsList: false,
  };

  it("unknown agent error lists only visible agents (no hidden/disabled names leaked)", async () => {
    const result = await run("nonexistent", [worker, hidden, disabled], {
      hiddenAgentGlobs: ["hidden-*"],
      disabledAgentGlobs: ["disabled-*"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("worker");
    expect(result.stderr).not.toContain("hidden-agent");
    expect(result.stderr).not.toContain("disabled-agent");
    // The placeholder carries errorMessage (consistent with disabled/depth guards) so
    // downstream consumers that read errorMessage see the failure cause.
    expect(result.errorMessage).toContain("Unknown agent");
  });
});

/** Build a full SubagentConfig with visibility globs (empty model section). */
describe("execute wires disabled globs into all dispatch modes", () => {
  const experimental: AgentConfig = {
    name: "experimental-x",
    description: "d",
    systemPrompt: "",
    filePath: "/tmp/exp.md",
  };
  const worker: AgentConfig = { name: "worker", description: "d", systemPrompt: "", filePath: "/tmp/worker.md" };
  let tool: ToolDefinition;
  let ctx: ExtensionCommandContext;
  const spawnMock = vi.fn();

  const register = (cfg: SubagentConfig): void => {
    // Install the _set* hooks BEFORE the extension factory runs: the factory builds the initial
    // tool description (which reads config globs), so the discover/config/spawn seams must be
    // in place first — otherwise factory-time buildDescription reads the developer's real
    // ~/.pi/agent/settings.json.
    _setSpawn(spawnMock);
    _setDiscoverAgents(() => ({
      agents: [experimental, worker],
      bundledAgents: [worker],
      projectAgentsDir: null,
      extensionAgentDirs: [],
      overrideNames: new Set(),
    }));
    _setLoadSubagentConfig(() => ({ config: cfg, errors: [] }));
    spawnMock.mockReturnValue(createFakeProcess());

    const registrations: ToolDefinition[] = [];
    registerSubagentExtension({ registrations, sessionName: "disabled-session" });
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

  it("single mode: disabled agent -> disabled placeholder, spawn not called", async () => {
    register(configWithGlobs({ disabled: ["experimental-*"] }));
    const result = (await tool.execute("id", { agent: "experimental-x", task: "t" }, undefined, undefined, ctx)) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    expect(spawnMock).not.toHaveBeenCalled();
    const text = result.content.map((c) => c.text ?? "").join("");
    expect(text).toContain("disabled");
    expect(text).toContain("experimental-x"); // the disabled agent's name, not a generic keyword
  });

  it("parallel mode: disabled agent -> disabled placeholder, spawn not called", async () => {
    register(configWithGlobs({ disabled: ["experimental-*"] }));
    const result = (await tool.execute(
      "id",
      { tasks: [{ agent: "experimental-x", task: "t" }] },
      undefined,
      undefined,
      ctx,
    )) as { content: Array<{ text?: string }> };
    expect(spawnMock).not.toHaveBeenCalled();
    const text = result.content.map((c) => c.text ?? "").join("");
    expect(text).toContain("disabled");
    expect(text).toContain("experimental-x");
  });

  it("chain mode: disabled agent -> disabled placeholder, spawn not called", async () => {
    register(configWithGlobs({ disabled: ["experimental-*"] }));
    const result = (await tool.execute(
      "id",
      { chain: [{ agent: "experimental-x", task: "t" }] },
      undefined,
      undefined,
      ctx,
    )) as { content: Array<{ text?: string }> };
    expect(spawnMock).not.toHaveBeenCalled();
    const text = result.content.map((c) => c.text ?? "").join("");
    expect(text).toContain("disabled");
    expect(text).toContain("experimental-x");
  });

  it("non-disabled agent in single mode -> spawn IS called (globs wired, not over-blocking)", async () => {
    register(configWithGlobs({ disabled: ["experimental-*"] }));
    // Event-driven wait for spawn (replaces a hand-rolled 2s polling loop). Wrap the shared
    // spawnMock so its first call resolves the promise.
    const { promise: spawnCalled, mark } = spawnCalledPromise(2000);
    const original = spawnMock.getMockImplementation();
    spawnMock.mockImplementation(() => {
      mark();
      return createFakeProcess();
    });
    // Fire execute (does not await — it blocks until the spawned process closes, which the fake
    // process never does on its own). Wait for spawn, emit close, then settle.
    const resultPromise = tool.execute("id", { agent: "worker", task: "t" }, undefined, undefined, ctx);
    await spawnCalled;
    expect(spawnMock).toHaveBeenCalled();
    if (original) spawnMock.mockImplementation(original);
    // Settle the in-flight execute by closing the spawned process.
    const proc = spawnMock.mock.results[spawnMock.mock.results.length - 1]?.value;
    proc?.emit("close", 0);
    await resultPromise;
  });
});
