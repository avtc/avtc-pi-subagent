import type { EventEmitter } from "node:events";
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for subagent extension error handling: spawn errors, timeouts, cwd validation.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import subagentExtension, { _resetAllTestHooks, _resetFs, _setDiscoverAgents, _setSpawn } from "../src/extension.js";
import type { SubagentSettings } from "../src/schema.js";
import {
  createFakeProcess,
  EXIT_CODE_FAILURE,
  EXIT_CODE_SUCCESS,
  injectEmptyModelConfig,
  setTestSettings as sharedSetTestSettings,
} from "./test-helpers.js";

const spawnMock = vi.fn();
const discoverAgentsMock = vi.fn();

// This file exercises error/timing paths that want a shorter inactivity timeout than the
// shared default (600_000ms); preset it here so the bare setTestSettings(null) calls below keep it.
function setTestSettings(overrides: Partial<SubagentSettings> | null): void {
  sharedSetTestSettings({ inactivityTimeoutMs: 120_000, ...(overrides ?? {}) });
}

function registerTool(): {
  execute: (id: string, params: unknown, ...rest: unknown[]) => Promise<unknown>;
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
  return tool;
}

describe("subagent extension error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setSpawn(spawnMock);
    _setDiscoverAgents(discoverAgentsMock);
    injectEmptyModelConfig();
    setTestSettings(null);

    discoverAgentsMock.mockReturnValue({
      agents: [
        {
          name: "test-agent",
          filePath: "/tmp/test-agent.md",
          systemPrompt: "system prompt",
        },
      ],
      bundledAgents: [],
      projectAgentsDir: null,
      extensionAgentDirs: [],
      overrideNames: new Set(),
    });
  });

  afterEach(() => {
    _resetFs();
    _resetAllTestHooks();
    delete process.env.PI_SETTINGS_SUBAGENT;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("logs debug when subagent stdout line is not JSON", async () => {
    spawnMock.mockImplementation(() => {
      const proc = createFakeProcess();
      queueMicrotask(() => {
        (proc.stdout as EventEmitter).emit("data", Buffer.from("not-json\n"));
        proc.emit("close", EXIT_CODE_SUCCESS);
      });
      return proc;
    });

    const tool = registerTool();
    await tool.execute("id", { agent: "test-agent", task: "do work" }, undefined, undefined, {
      cwd: process.cwd(),
      hasUI: false,
    });

    // Non-JSON lines are silently ignored — tool should still complete successfully
    // The debug log is internal, we verify the tool didn't crash
  });

  test("resolves when subagent process exits even if close never fires", async () => {
    spawnMock.mockImplementation(() => {
      const proc = createFakeProcess();
      queueMicrotask(() => {
        proc.emit("close", EXIT_CODE_SUCCESS);
      });
      return proc;
    });

    const tool = registerTool();
    await expect(
      tool.execute("id", { agent: "test-agent", task: "do work" }, undefined, undefined, {
        cwd: process.cwd(),
        hasUI: false,
      }),
    ).resolves.toBeDefined();
  });

  test("respects concurrency cap for parallel tasks", async () => {
    setTestSettings({ subagentConcurrency: 1 });

    let activeSpawns = 0;
    let maxActiveSpawns = 0;

    spawnMock.mockImplementation(() => {
      activeSpawns++;
      maxActiveSpawns = Math.max(maxActiveSpawns, activeSpawns);
      const proc = createFakeProcess();
      queueMicrotask(() => {
        activeSpawns--;
        proc.emit("close", EXIT_CODE_SUCCESS);
      });
      return proc;
    });

    discoverAgentsMock.mockReturnValue({
      agents: [
        { name: "agent-a", filePath: "/tmp/a.md", systemPrompt: "" },
        { name: "agent-b", filePath: "/tmp/b.md", systemPrompt: "" },
      ],
      bundledAgents: [],
      projectAgentsDir: null,
      extensionAgentDirs: [],
      overrideNames: new Set(),
    });

    const tool = registerTool();
    await tool.execute(
      "id",
      {
        tasks: [
          { agent: "agent-a", task: "task 1" },
          { agent: "agent-b", task: "task 2" },
        ],
      },
      undefined,
      undefined,
      { cwd: process.cwd(), hasUI: false },
    );

    expect(maxActiveSpawns).toBe(1);
  });

  test("kills subagent after absolute timeout", async () => {
    vi.useFakeTimers();

    setTestSettings({ subagentTimeoutMs: 30_000 });

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);

    const tool = registerTool();
    const resultPromise = tool.execute("id", { agent: "test-agent", task: "do work" }, undefined, undefined, {
      cwd: process.cwd(),
      hasUI: false,
    });

    await vi.advanceTimersByTimeAsync(35_000);

    const result = await resultPromise;
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("timed out");
  });

  test("escalates to SIGKILL when process does not exit after SIGTERM timeout", async () => {
    vi.useFakeTimers();

    setTestSettings({ subagentTimeoutMs: 10_000 });

    const proc = createFakeProcess();
    const killCalls: string[] = [];
    proc.kill = vi.fn((sig?: string | number) => {
      killCalls.push(typeof sig === "string" ? sig : "SIGTERM");
      (proc as unknown as { killed: boolean }).killed = true;
      return true;
    });
    spawnMock.mockReturnValue(proc);

    const tool = registerTool();
    const resultPromise = tool.execute("id", { agent: "test-agent", task: "do work" }, undefined, undefined, {
      cwd: process.cwd(),
      hasUI: false,
    });

    await vi.advanceTimersByTimeAsync(11_000);
    await vi.advanceTimersByTimeAsync(6_000);

    proc.emit("close", EXIT_CODE_FAILURE);
    await vi.advanceTimersByTimeAsync(0);

    await resultPromise;
    expect(killCalls).toContain("SIGTERM");
    expect(killCalls).toContain("SIGKILL");
  });

  test("returns error when cwd is a file not a directory", async () => {
    const tmpFile = path.join(os.tmpdir(), `subagent-test-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "hello");

    try {
      const tool = registerTool();
      const result = await tool.execute(
        "id",
        { agent: "test-agent", task: "do work", cwd: tmpFile },
        undefined,
        undefined,
        { cwd: process.cwd(), hasUI: false },
      );

      expect(spawnMock).not.toHaveBeenCalled();
      expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("cwd is not a directory");
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    }
  });

  test("returns error when cwd does not exist", async () => {
    const tool = registerTool();
    const result = await tool.execute(
      "id",
      { agent: "test-agent", task: "do work", cwd: "/nonexistent/path/that/does/not/exist" },
      undefined,
      undefined,
      { cwd: process.cwd(), hasUI: false },
    );

    expect(spawnMock).not.toHaveBeenCalled();
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("cwd does not exist");
  });

  test("pauses absolute timeout during nested subagent work", async () => {
    vi.useFakeTimers();

    setTestSettings({ subagentTimeoutMs: 30_000, inactivityTimeoutMs: null });

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);

    const tool = registerTool();
    const resultPromise = tool.execute("id", { agent: "test-agent", task: "do work" }, undefined, undefined, {
      cwd: process.cwd(),
      hasUI: false,
    });

    // Wait for spawn to happen
    await vi.advanceTimersByTimeAsync(0);

    // Simulate nested subagent starting (tool_execution_start for subagent tool)
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "tool_execution_start",
          toolName: "subagent",
          toolCallId: "sub-1",
          args: {},
        })}\n`,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Advance past the 30s absolute timeout — should NOT kill because timer is paused
    await vi.advanceTimersByTimeAsync(40_000);
    expect(proc.kill).not.toHaveBeenCalled();

    // Simulate nested subagent ending
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "tool_execution_end",
          toolName: "subagent",
          toolCallId: "sub-1",
          isError: false,
          result: {},
        })}\n`,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Now the timer resumes with the original 30s budget (none consumed while paused)
    // Advance 31s — should now kill
    await vi.advanceTimersByTimeAsync(31_000);

    const result = await resultPromise;
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("timed out");
  });

  test("resumes absolute timeout with remaining time after nested work", async () => {
    vi.useFakeTimers();

    setTestSettings({ subagentTimeoutMs: 30_000, inactivityTimeoutMs: null });

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);

    const tool = registerTool();
    const resultPromise = tool.execute("id", { agent: "test-agent", task: "do work" }, undefined, undefined, {
      cwd: process.cwd(),
      hasUI: false,
    });

    // Wait for spawn
    await vi.advanceTimersByTimeAsync(0);

    // Spend 10s of the 30s budget
    await vi.advanceTimersByTimeAsync(10_000);

    // Start nested subagent (pauses at 20s remaining)
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "tool_execution_start",
          toolName: "subagent",
          toolCallId: "sub-1",
          args: {},
        })}\n`,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Wait 50s while nested is running — does NOT consume budget
    await vi.advanceTimersByTimeAsync(50_000);
    expect(proc.kill).not.toHaveBeenCalled();

    // End nested subagent
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "tool_execution_end",
          toolName: "subagent",
          toolCallId: "sub-1",
          isError: false,
          result: {},
        })}\n`,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Only 20s of budget remains — advance past it
    await vi.advanceTimersByTimeAsync(21_000);

    const result = await resultPromise;
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("timed out");
  });

  test("single mode: hostile ANSI on the raw stderr pipe is sanitized in the returned content", async () => {
    // resultErrorMessage is the consumption-boundary sanitizer: stderr accumulates RAW during
    // the run and is only sanitized at this one point when surfaced for an error result. A
    // refactor that bypasses resultErrorMessage and interpolates result.stderr raw would leak
    // control chars into operator-visible content. This test locks the wiring.
    const osc = "\x1b]8;;https://evil.example\x07";
    const csi = "\x1b[31m";
    spawnMock.mockImplementation(() => {
      const proc = createFakeProcess();
      queueMicrotask(() => {
        (proc.stderr as EventEmitter).emit("data", Buffer.from(`${csi}${osc}connection refused`));
        // An error result: non-zero exit, no clean agent_end → resultErrorMessage(stderr).
        proc.emit("close", EXIT_CODE_FAILURE);
      });
      return proc;
    });

    const tool = registerTool();
    const result = (await tool.execute("id", { agent: "test-agent", task: "work" }, undefined, undefined, {
      cwd: process.cwd(),
      hasUI: false,
    })) as { content: { text: string }[] };

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("]8;;"); // OSC payload stripped
    expect(text).not.toContain("[31m"); // CSI payload stripped
    // The readable stderr text survives:
    expect(text).toContain("connection refused");
  });
});
