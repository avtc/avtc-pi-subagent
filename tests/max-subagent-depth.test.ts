import type { EventEmitter } from "node:events";
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for maxSubagentDepth guard in the subagent extension.
 *
 * Verifies that spawn is blocked when depth is 0, allowed when > 0,
 * and that depth is decremented by 1 when passed to child processes.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import subagentExtension, { _resetAllTestHooks, _setDiscoverAgents, _setSpawn } from "../src/extension.js";
import type { SubagentSettings } from "../src/schema.js";
import {
  createFakeProcess,
  EXIT_CODE_SUCCESS,
  injectEmptyModelConfig,
  setTestSettings as sharedSetTestSettings,
} from "./test-helpers.js";

const spawnMock = vi.fn();
const discoverAgentsMock = vi.fn();

// Depth tests want a shorter inactivity timeout than the shared default (600_000ms); preset it
// here so the bare setTestSettings(null) calls below keep it.
function setTestSettings(overrides: Partial<SubagentSettings> | null): void {
  sharedSetTestSettings({ inactivityTimeoutMs: 120_000, ...(overrides ?? {}) });
}

function registerTool(): {
  tool: { execute: (id: string, params: unknown, ...rest: unknown[]) => Promise<unknown> };
  ctx: { cwd: string; hasUI: boolean };
} {
  let tool: { execute: (id: string, params: unknown, ...rest: unknown[]) => Promise<unknown> } | undefined;
  subagentExtension({
    registerTool: (t: unknown) => {
      tool = t as typeof tool;
    },
    on: vi.fn(),
    events: { on: vi.fn() },
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),
    getSessionName: vi.fn(() => "test-session"),
  } as unknown as Parameters<typeof subagentExtension>[0]);
  if (!tool) throw new Error("registerTool: subagentExtension did not register a tool");
  return {
    tool,
    ctx: {
      cwd: "/tmp",
      hasUI: false,
    },
  };
}

const MOCK_AGENTS = {
  agents: [
    {
      name: "worker",
      filePath: "/tmp/worker.md",
      description: "Test worker",
      systemPrompt: "You are a worker.",
    },
  ],
  bundledAgents: [],
  projectAgentsDir: null,
  extensionAgentDirs: [],
  overrideNames: new Set(),
};

function setupSpawn() {
  spawnMock.mockImplementation(() => {
    const proc = createFakeProcess();
    queueMicrotask(() => {
      (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "result", text: "ok" })}\n`));
      proc.emit("close", EXIT_CODE_SUCCESS);
    });
    return proc;
  });
}

describe("maxSubagentDepth guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setSpawn(spawnMock);
    _setDiscoverAgents(discoverAgentsMock);
    injectEmptyModelConfig();
    setTestSettings(null);
  });

  afterEach(() => {
    _resetAllTestHooks();
    delete process.env.PI_SETTINGS_SUBAGENT;
    vi.restoreAllMocks();
  });

  test("blocks spawn when maxSubagentDepth is 0", async () => {
    setTestSettings({ maxSubagentDepth: 0 });
    discoverAgentsMock.mockReturnValue(MOCK_AGENTS);
    setupSpawn();

    const { tool, ctx } = registerTool();
    const result = await tool.execute(
      "test-call-id",
      { agent: "worker", task: "do something" },
      undefined,
      undefined,
      ctx,
    );

    expect((result as { isError: boolean }).isError).toBe(true);
    const text = (result as { content: Array<{ text?: string }> }).content[0]?.text ?? "";
    expect(text).toContain("Max subagent depth reached");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("allows spawn when maxSubagentDepth > 0", async () => {
    setTestSettings({ maxSubagentDepth: 3 });
    discoverAgentsMock.mockReturnValue(MOCK_AGENTS);
    setupSpawn();

    const { tool, ctx } = registerTool();
    await tool.execute("test-call-id", { agent: "worker", task: "do something" }, undefined, undefined, ctx);

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test("decrements maxSubagentDepth by 1 in child env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    spawnMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { env?: Record<string, string | undefined> }) => {
        capturedEnv = opts?.env;
        const proc = createFakeProcess();
        queueMicrotask(() => {
          (proc.stdout as EventEmitter).emit(
            "data",
            Buffer.from(`${JSON.stringify({ type: "result", text: "ok" })}\n`),
          );
          proc.emit("close", EXIT_CODE_SUCCESS);
        });
        return proc;
      },
    );

    setTestSettings({ maxSubagentDepth: 3 });
    discoverAgentsMock.mockReturnValue(MOCK_AGENTS);

    const { tool, ctx } = registerTool();
    await tool.execute("test-call-id", { agent: "worker", task: "do something" }, undefined, undefined, ctx);

    expect(capturedEnv).toBeDefined();
    const childSettings = JSON.parse(capturedEnv?.PI_SETTINGS_SUBAGENT ?? "");
    expect(childSettings.maxSubagentDepth).toBe(2); // 3 - 1 = 2
  });

  test("passes maxSubagentDepth 1 as 0 to child", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    spawnMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { env?: Record<string, string | undefined> }) => {
        capturedEnv = opts?.env;
        const proc = createFakeProcess();
        queueMicrotask(() => {
          (proc.stdout as EventEmitter).emit(
            "data",
            Buffer.from(`${JSON.stringify({ type: "result", text: "ok" })}\n`),
          );
          proc.emit("close", EXIT_CODE_SUCCESS);
        });
        return proc;
      },
    );

    setTestSettings({ maxSubagentDepth: 1 });
    discoverAgentsMock.mockReturnValue(MOCK_AGENTS);

    const { tool, ctx } = registerTool();
    await tool.execute("test-call-id", { agent: "worker", task: "do something" }, undefined, undefined, ctx);

    const childSettings = JSON.parse(capturedEnv?.PI_SETTINGS_SUBAGENT ?? "");
    expect(childSettings.maxSubagentDepth).toBe(0); // child can't spawn further
  });

  test("passes PI_SUBAGENT_PARENT_PID to child process", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    spawnMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { env?: Record<string, string | undefined> }) => {
        capturedEnv = opts?.env;
        const proc = createFakeProcess();
        queueMicrotask(() => {
          (proc.stdout as EventEmitter).emit(
            "data",
            Buffer.from(`${JSON.stringify({ type: "result", text: "ok" })}\n`),
          );
          proc.emit("close", EXIT_CODE_SUCCESS);
        });
        return proc;
      },
    );

    setTestSettings({ maxSubagentDepth: 3 });
    discoverAgentsMock.mockReturnValue(MOCK_AGENTS);

    const { tool, ctx } = registerTool();
    await tool.execute("test-call-id", { agent: "worker", task: "do something" }, undefined, undefined, ctx);

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv?.PI_SUBAGENT_PARENT_PID).toBe(String(process.pid));
  });
});
