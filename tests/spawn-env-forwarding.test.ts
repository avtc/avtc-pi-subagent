import type { EventEmitter } from "node:events";
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildSubagentEnv } from "../src/env.js";
import subagentExtension, {
  _resetDiscoverAgents,
  _setDiscoverAgents,
  _setLoadSubagentModelConfig,
} from "../src/extension.js";
import { _resetSpawn, _setSpawn } from "../src/process-runner.js";
import { createFakeProcess, MockSessionManager, setTestSettings, spawnCalledPromise } from "./test-helpers.js";

// Harness: mock spawn, drive the tool, capture the spawn (argv, options.env). The parent
// forwards PI_SUBAGENT_TOOLS (frontmatter whitelist) + PI_SUBAGENT_IS_FORK (fork flag) to the
// child; it does not resolve the child's tools.

function registerTool(): { tool: ToolDefinition; ctx: ExtensionCommandContext } {
  let tool: ToolDefinition | undefined;
  subagentExtension({
    registerTool: (t: ToolDefinition) => {
      tool = t;
    },
    on: vi.fn(),
    events: { on: vi.fn() },
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),
    getSessionName: vi.fn(() => "test-session"),
  } as unknown as ExtensionAPI);
  return {
    tool: tool as NonNullable<typeof tool>,
    ctx: {
      cwd: process.cwd(),
      hasUI: false,
      // Fork-mode dispatch reaches sessionManager.constructor.open to create a branched
      // session; a class-based mock gives the instance a real .constructor.open.
      sessionManager: new MockSessionManager(),
    } as unknown as ExtensionCommandContext,
  };
}

function makeAgent(name: string, tools: string[] | undefined) {
  return {
    name,
    description: "test agent",
    systemPrompt: "system prompt",
    tools,
    filePath: `/tmp/${name}.md`,
  };
}

async function dispatchAndCaptureEnv(
  agent: { name: string; tools?: string[] },
  fork: boolean,
): Promise<{ argv: string[]; env: Record<string, string | undefined> }> {
  const proc = createFakeProcess();
  const { promise: spawnCalled, mark } = spawnCalledPromise(2000);
  const spawnMock = vi.fn().mockImplementation(() => {
    mark();
    return proc;
  });
  _setSpawn(spawnMock);
  _setDiscoverAgents(
    vi.fn().mockReturnValue({
      agents: [agent],
      bundledAgents: [],
      projectAgentsDir: null,
      extensionAgentDirs: [],
      overrideNames: new Set(),
    }),
  );
  _setLoadSubagentModelConfig(() => ({ "subagent-models": {}, "default-model": null }));
  setTestSettings(null);
  const { tool, ctx } = registerTool();

  const resultPromise = tool.execute("call-1", { agent: agent.name, task: "t" }, undefined, vi.fn(), ctx);

  // Event-driven wait for spawn (replaces a hand-rolled 2s polling loop).
  await spawnCalled;

  const argv = spawnMock.mock.calls[0]?.[1] as string[];
  const options = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string | undefined> };

  // Resolve the dispatch (close the process).
  (proc.stdout as EventEmitter).emit("data", Buffer.from(""));
  (proc.stderr as EventEmitter).emit("data", Buffer.from(""));
  if (fork) {
    // fork mode: write prompt to stdin then close
    proc.emit("close", 0);
  } else {
    proc.emit("close", 0);
  }
  await resultPromise;

  return { argv, env: options.env };
}

describe("parent spawn path — tool/input forwarding (no --tools)", () => {
  beforeEach(() => {
    // ensure no stale leak from a prior test
    delete process.env.PI_SUBAGENT_TOOLS;
    delete process.env.PI_SUBAGENT_IS_FORK;
    delete process.env.PI_SUBAGENT_TOOLS_ADD;
    delete process.env.PI_SUBAGENT_FORK_MODE;
  });
  afterEach(() => {
    _resetSpawn();
    _resetDiscoverAgents();
    delete process.env.PI_SETTINGS_SUBAGENT;
    delete process.env.PI_SUBAGENT_TOOLS;
    delete process.env.PI_SUBAGENT_IS_FORK;
    delete process.env.PI_SUBAGENT_TOOLS_ADD;
    delete process.env.PI_SUBAGENT_FORK_MODE;
  });

  test("fresh whitelisted child: PI_SUBAGENT_TOOLS = frontmatter join, NO --tools argv", async () => {
    const agent = makeAgent("worker", ["read", "bash", "write"]);
    const { argv, env } = await dispatchAndCaptureEnv(agent, false);
    expect(argv).not.toContain("--tools");
    expect(env.PI_SUBAGENT_TOOLS).toBe("read,bash,write");
    expect(env.PI_SUBAGENT_CHILD_AGENT).toBe("worker");
    expect(env.PI_SUBAGENT_IS_FORK).toBeUndefined(); // fresh child
  });

  test("fresh whitelistless child: PI_SUBAGENT_TOOLS deleted (no stale leak)", async () => {
    // seed a stale value that must NOT leak to a whitelistless child
    process.env.PI_SUBAGENT_TOOLS = "stale-from-parent";
    const agent = makeAgent("researcher", undefined);
    const { argv, env } = await dispatchAndCaptureEnv(agent, false);
    expect(argv).not.toContain("--tools");
    expect(env.PI_SUBAGENT_TOOLS).toBeUndefined();
  });

  test("fresh child with empty tools[]: PI_SUBAGENT_TOOLS deleted (treated as whitelistless)", async () => {
    const agent = makeAgent("empty", []);
    const { env } = await dispatchAndCaptureEnv(agent, false);
    expect(env.PI_SUBAGENT_TOOLS).toBeUndefined();
  });

  test("PI_SUBAGENT_TOOLS_ADD passes through (contributor contract, not excluded)", async () => {
    process.env.PI_SUBAGENT_TOOLS_ADD = "todo_init";
    const agent = makeAgent("worker", ["read"]);
    const { env } = await dispatchAndCaptureEnv(agent, false);
    expect(env.PI_SUBAGENT_TOOLS_ADD).toBe("todo_init");
  });

  test("fork child: PI_SUBAGENT_IS_FORK = '1' (and TOOLS still forwarded)", async () => {
    // Fork dispatch: PI_SUBAGENT_FORK_MODE=fork suffixes the agent name (reviewer -> reviewer-fork);
    // resolveForkSessionFile returns a branched session so isFork is true. The parent forwards
    // the base frontmatter whitelist + the IS_FORK marker; the child branches enforcement via
    // the fork guard.
    process.env.PI_SUBAGENT_FORK_MODE = "fork";
    const agent = makeAgent("reviewer", ["read", "grep"]);
    const { env } = await dispatchAndCaptureEnv(agent, true);
    expect(env.PI_SUBAGENT_IS_FORK).toBe("1");
    expect(env.PI_SUBAGENT_TOOLS).toBe("read,grep");
  });

  test("PI_SUBAGENT_TOOLS is excluded from cascade (parent's value stripped before per-spawn set)", () => {
    // The cascade-exclusion policy excludes TOOLS so a whitelisted grandparent's value can't
    // leak through buildSubagentEnv to a whitelistless child. process-runner then sets or
    // deletes it explicitly per-spawn. Verify the exclusion directly via buildSubagentEnv.
    process.env.PI_SUBAGENT_TOOLS = "inherited-whitelist";
    const env = buildSubagentEnv();
    expect(env.PI_SUBAGENT_TOOLS).toBeUndefined();
  });
});
