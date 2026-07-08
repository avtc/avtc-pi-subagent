// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for inactivity-timer reset behavior.
 *
 * The inactivity timer ("kill if the subagent produces NO output for X seconds")
 * must reset on any event that represents genuine output from the subagent.
 * Streaming deltas (message_update with thinking_delta / text_delta) ARE output
 * they mean the model is actively generating tokens — so they must reset the timer.
 *
 * Without this, a model that generates a single long message (e.g. a thinking-heavy
 * model streaming reasoning for >inactivityTimeoutMs) gets killed mid-generation
 * even though it was actively streaming the whole time.
 */
import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import subagentExtension, { _resetAllTestHooks, _setDiscoverAgents, _setSpawn } from "../src/extension.js";
import type { SingleResult } from "../src/types.js";
import {
  createFakeProcess,
  createFakeProcessWithStdin,
  EXIT_CODE_FAILURE,
  EXIT_CODE_SUCCESS,
  injectEmptyModelConfig,
  setTestSettings,
} from "./test-helpers.js";

const spawnMock = vi.fn();
const discoverAgentsMock = vi.fn();

function registerTool() {
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
      sessionManager: { getSessionFile: () => "/test/session.jsonl", getLeafId: () => "leaf-123" },
    } as unknown as ExtensionCommandContext,
  };
}

const AGENTS = {
  agents: [
    {
      name: "worker",
      filePath: "/tmp/worker.md",
      systemPrompt: "system prompt",
      tools: ["read", "bash", "write", "edit", "grep", "find", "ls", "subagent"],
    },
  ],
  bundledAgents: [],
  projectAgentsDir: null,
  extensionAgentDirs: [],
  overrideNames: new Set(),
};

/** Emit a JSON event line on the fake process stdout. */
function emit(proc: ChildProcess, event: Record<string, unknown>): void {
  proc.stdout?.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
}

describe("inactivity timer reset on streaming deltas", () => {
  let tool: ToolDefinition;
  let ctx: ExtensionCommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    _setSpawn(spawnMock);
    _setDiscoverAgents(discoverAgentsMock);
    injectEmptyModelConfig();
    setTestSettings(null);
    discoverAgentsMock.mockReturnValue(AGENTS);
    ({ tool, ctx } = registerTool());
  });

  afterEach(() => {
    _resetAllTestHooks();
    delete process.env.PI_SETTINGS_SUBAGENT;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("thinking_delta streaming resets the inactivity timer (long message stays alive)", async () => {
    // Short inactivity window: 5s. We stream deltas every 4s so the gap between
    // deltas (4s) is UNDER the timeout, but total elapsed (8s) EXCEEDS it.
    // A correct implementation must keep the agent alive; the buggy one (no reset
    // on message_update) kills it at t=5s.
    vi.useFakeTimers();
    setTestSettings({ inactivityTimeoutMs: 5_000 });

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "think hard" }, undefined, vi.fn(), ctx);
    // Let the async spawn path complete and stdout handlers attach.
    await vi.advanceTimersByTimeAsync(50);

    // t≈0: first thinking delta. Timer was set at spawn; this must reset it.
    emit(proc, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Hmm" } });
    await vi.advanceTimersByTimeAsync(1);

    // Advance to t≈4000 — still under the 5s kill window only if the t=0 delta
    // reset the timer.
    await vi.advanceTimersByTimeAsync(4_000);

    // t≈4000: second delta. Resets the timer again (now due at t≈9000).
    emit(proc, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: " more" } });
    await vi.advanceTimersByTimeAsync(1);

    // Advance past the ORIGINAL timeout (total ≈8s). With the bug the kill fired
    // at t=5s; with the fix the timer was reset at t≈4000 and won't fire until t≈9000.
    await vi.advanceTimersByTimeAsync(4_000);

    // t≈8000: message completes normally.
    emit(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } });
    await vi.advanceTimersByTimeAsync(1);

    proc.emit("close", EXIT_CODE_SUCCESS);
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];

    // NOT killed by inactivity — completed normally.
    expect(r.exitCode).toBe(0);
    expect(r.errorMessage).toBeUndefined();
    expect(r.progress.status).toBe("completed");
  });

  test("text_delta streaming resets the inactivity timer", async () => {
    vi.useFakeTimers();
    setTestSettings({ inactivityTimeoutMs: 5_000 });

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "write a lot" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(50);

    // Stream text deltas spaced under the timeout, total exceeding it.
    for (let i = 0; i < 3; i++) {
      emit(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `chunk-${i} ` } });
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(3_000); // 3s gaps < 5s timeout
    }

    // Total elapsed ≈ 9s > 5s timeout — only survives if deltas reset the timer.
    emit(proc, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "chunk-0 chunk-1 chunk-2 " }] },
    });
    await vi.advanceTimersByTimeAsync(1);

    proc.emit("close", EXIT_CODE_SUCCESS);
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.exitCode).toBe(0);
    expect(r.errorMessage).toBeUndefined();
    expect(r.progress.status).toBe("completed");
  });

  test("genuine silence still triggers the inactivity kill", async () => {
    // Guard against the opposite regression: a truly silent subagent must still be killed.
    vi.useFakeTimers();
    setTestSettings({ inactivityTimeoutMs: 5_000 });

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "stall" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(50);

    // No events at all — advance well past the timeout.
    await vi.advanceTimersByTimeAsync(6_000);

    proc.emit("close", EXIT_CODE_FAILURE);
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];

    // Killed by inactivity.
    expect(r.errorMessage).toMatch(/inactivity/i);
    expect(proc.kill).toHaveBeenCalled();
  });
});

describe("inactivity timer suspended during auto-retry backoff (both modes)", () => {
  let tool: ToolDefinition;
  let ctx: ExtensionCommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    _setSpawn(spawnMock);
    _setDiscoverAgents(discoverAgentsMock);
    injectEmptyModelConfig();
    setTestSettings(null);
    discoverAgentsMock.mockReturnValue(AGENTS);
    ({ tool, ctx } = registerTool());
  });

  afterEach(() => {
    _resetAllTestHooks();
    delete process.env.PI_SETTINGS_SUBAGENT;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test.each([
    ["json", createFakeProcess()],
    ["rpc", createFakeProcessWithStdin()],
  ] as const)("auto_retry_start suspends the inactivity timer (%s mode); auto_retry_end restores it", async (_mode, proc) => {
    vi.useFakeTimers();
    setTestSettings({ spawnMode: _mode === "rpc" ? "rpc" : undefined, inactivityTimeoutMs: 5_000 });
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "flaky" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(50);

    // Some activity, then a retry starts (e.g. a 500 from the provider with backoff).
    emit(proc, { type: "agent_start" });
    await vi.advanceTimersByTimeAsync(1);
    emit(proc, { type: "auto_retry_start" });
    await vi.advanceTimersByTimeAsync(1);

    // Advance WELL past the 5s inactivity window during the retry backoff — the
    // timer is suspended, so NO inactivity kill fires.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(proc.killed).toBe(false);

    // RPC: the done-detection settle must also hold during backoff (retryInFlight guard)
    // stdin is NOT closed mid-retry. (json has no stdin/settle)
    if (_mode === "rpc") {
      const stdinEnd = (proc as unknown as { stdin?: { end: ReturnType<typeof vi.fn> } }).stdin?.end;
      expect(stdinEnd).not.toHaveBeenCalled();
    }

    // Retry ends; the timer is restored. With no further events, advancing past the
    // window NOW fires the inactivity kill.
    emit(proc, { type: "auto_retry_end" });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(proc.kill).toHaveBeenCalled();

    proc.emit("close", EXIT_CODE_FAILURE);
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.errorMessage).toMatch(/inactivity/i);
  });

  test("the ABSOLUTE timeout is NOT suspended during auto-retry (fires across the retry window)", async () => {
    vi.useFakeTimers();
    // : only inactivityTimer is suspended on retry; absoluteTimer keeps running.
    // Short absolute timeout + a retry window longer than it → the absolute kill fires mid-retry.
    setTestSettings({ spawnMode: "json", subagentTimeoutMs: 5_000, inactivityTimeoutMs: 600_000 });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "stall" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(50);

    emit(proc, { type: "agent_start" });
    await vi.advanceTimersByTimeAsync(1);
    emit(proc, { type: "auto_retry_start" });
    await vi.advanceTimersByTimeAsync(1);

    // Advance past the 5s absolute timeout DURING the retry — the absolute kill MUST fire
    // (the implementation must only clear inactivityTimer, never absoluteTimer).
    await vi.advanceTimersByTimeAsync(6_000);
    expect(proc.kill).toHaveBeenCalled();

    proc.emit("close", EXIT_CODE_FAILURE);
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.errorMessage).toMatch(/timed out/i);
  });
});

describe("inactivity timer suspended during compaction (both modes)", () => {
  let tool: ToolDefinition;
  let ctx: ExtensionCommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    _setSpawn(spawnMock);
    _setDiscoverAgents(discoverAgentsMock);
    injectEmptyModelConfig();
    setTestSettings(null);
    discoverAgentsMock.mockReturnValue(AGENTS);
    ({ tool, ctx } = registerTool());
  });

  afterEach(() => {
    _resetAllTestHooks();
    delete process.env.PI_SETTINGS_SUBAGENT;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test.each([
    ["json", createFakeProcess()],
    ["rpc", createFakeProcessWithStdin()],
  ] as const)("compaction_start suspends the inactivity timer (%s mode); compaction_end restores it", async (_mode, proc) => {
    // Regression: a compaction that outlasts the inactivity window must NOT be killed
    // mid-compaction. The old behavior only RESET the timer (fresh window) on
    // compaction_start, so a >window compaction was SIGKILLed. The fix SUSPENDS the
    // timer (mirrors auto_retry_start) and compaction_end restores it.
    vi.useFakeTimers();
    setTestSettings({ spawnMode: _mode === "rpc" ? "rpc" : undefined, inactivityTimeoutMs: 5_000 });
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "big context" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(50);

    // Some activity, then a manual compaction starts.
    emit(proc, { type: "agent_start" });
    await vi.advanceTimersByTimeAsync(1);
    emit(proc, { type: "compaction_start", reason: "manual" });
    await vi.advanceTimersByTimeAsync(1);

    // Advance WELL past the 5s inactivity window during the compaction — the timer is
    // suspended, so NO inactivity kill fires.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(proc.killed).toBe(false);

    // RPC: the done-detection settle must also hold during compaction (compactionInFlight
    // guard) — stdin is NOT closed mid-compaction. (json has no stdin/settle)
    if (_mode === "rpc") {
      const stdinEnd = (proc as unknown as { stdin?: { end: ReturnType<typeof vi.fn> } }).stdin?.end;
      expect(stdinEnd).not.toHaveBeenCalled();
    }

    // Compaction ends; the timer is restored. With no further events, advancing past the
    // window NOW fires the inactivity kill.
    emit(proc, { type: "compaction_end", reason: "manual" });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(proc.kill).toHaveBeenCalled();

    proc.emit("close", EXIT_CODE_FAILURE);
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.errorMessage).toMatch(/inactivity/i);
  });

  test("the ABSOLUTE timeout is NOT suspended during compaction (fires across the compaction window)", async () => {
    // Mirrors the auto-retry absolute test: only inactivityTimer is suspended
    // on compaction; absoluteTimer keeps running. A compaction longer than the absolute
    // budget still kills.
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "json", subagentTimeoutMs: 5_000, inactivityTimeoutMs: 600_000 });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "stall" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(50);

    emit(proc, { type: "agent_start" });
    await vi.advanceTimersByTimeAsync(1);
    emit(proc, { type: "compaction_start", reason: "manual" });
    await vi.advanceTimersByTimeAsync(1);

    // Advance past the 5s absolute timeout DURING the compaction — the absolute kill MUST
    // fire (the implementation must only clear inactivityTimer, never absoluteTimer).
    await vi.advanceTimersByTimeAsync(6_000);
    expect(proc.kill).toHaveBeenCalled();

    proc.emit("close", EXIT_CODE_FAILURE);
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.errorMessage).toMatch(/timed out/i);
  });
});

/**
 * The inactivity timer is applied PER spawned subagent (each runSubagentProcess
 * owns its own inactivityTimer closure), so it is independent at every nesting
 * level. While a subagent runs the `subagent` tool (spawning one or more nested
 * subagents, including a parallel batch) it produces no model output of its own
 * it is blocked on the tool result. The inactivity timer MUST be paused for the
 * whole duration, otherwise a parent that waits longer than inactivityTimeoutMs
 * on its children gets SIGKILLed mid-wait.
 *
 * Mechanism: tool_execution_start clears (nulls) inactivityTimer for every tool,
 * and tool_execution_end restores it. The subagent-specific concern is the gap
 * between them: during nested execution the only events the parent sees are
 * tool_execution_update (aggregated child progress), which must NOT re-arm the
 * inactivity timer. If it did, a child that goes quiet between turns would get
 * its parent killed.
 */
describe("inactivity timer paused during the subagent tool (nested spawn)", () => {
  let tool: ToolDefinition;
  let ctx: ExtensionCommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    _setSpawn(spawnMock);
    _setDiscoverAgents(discoverAgentsMock);
    injectEmptyModelConfig();
    setTestSettings(null);
    discoverAgentsMock.mockReturnValue(AGENTS);
    ({ tool, ctx } = registerTool());
  });

  afterEach(() => {
    _resetAllTestHooks();
    delete process.env.PI_SETTINGS_SUBAGENT;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test.each([
    ["json", createFakeProcess()],
    ["rpc", createFakeProcessWithStdin()],
  ] as const)("inactivity timer is suspended for the full duration of the subagent tool (%s mode)", async (_mode, proc) => {
    vi.useFakeTimers();
    // 5s inactivity — a parallel nested batch that outlasts it must survive.
    setTestSettings({ spawnMode: _mode === "rpc" ? "rpc" : undefined, inactivityTimeoutMs: 5_000 });
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "delegate" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(50);

    // Agent produces some output (arms the inactivity timer), then starts a
    // subagent tool (spawning nested children).
    emit(proc, { type: "agent_start" });
    await vi.advanceTimersByTimeAsync(1);
    emit(proc, { type: "tool_execution_start", toolName: "subagent", toolCallId: "nested-1", args: {} });
    await vi.advanceTimersByTimeAsync(1);

    // Advance WELL past the 5s inactivity window while nested children run.
    // The timer must be suspended — NO kill fires.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(proc.killed).toBe(false);

    // Children stream aggregated progress up as tool_execution_update. This must
    // NOT re-arm the inactivity timer (a child going quiet would otherwise kill
    // the parent mid-batch).
    emit(proc, {
      type: "tool_execution_update",
      toolName: "subagent",
      toolCallId: "nested-1",
      partialResult: { details: { results: [] } },
    });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(proc.killed).toBe(false);

    // Nested batch completes — tool_execution_end restores the inactivity timer.
    emit(proc, { type: "tool_execution_end", toolName: "subagent", toolCallId: "nested-1", isError: false });
    await vi.advanceTimersByTimeAsync(1);

    // Now the timer is live again: a silent period past the window fires the kill.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(proc.kill).toHaveBeenCalled();

    proc.emit("close", EXIT_CODE_FAILURE);
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.errorMessage).toMatch(/inactivity/i);
  });
});
