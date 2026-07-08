// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for the processLine stream-line safety net.
 *
 * dispatchLine's body (JSON.parse aside) runs the entire event dispatch — agent/tool/message/
 * compaction handlers plus progress aggregation. An uncaught throw inside a `stdout.on("data")`
 * callback would escape to Node's event loop as an uncaughtException and terminate the subagent
 * process with a bare non-zero exit and no errorMessage — the silent-failure mode behind the
 * level-1 parallel-crash incident (FAILED with no explanation, stderr stack trace discarded by
 * the result-text builder).
 *
 * The safety net wraps dispatchLine: a throw is logged (avtc-pi logger) and the line dropped
 * instead of crashing the parent subagent, then the inactivity timer is re-armed defensively.
 *
 * We assert the OBSERVABLE outcome (recovery: the parent keeps running and processes later
 * events / exits cleanly) rather than log calls — logging is best-effort and this suite runs with
 * `isolate: false`, where per-file logger mocks are unreliable (modules are shared across files).
 *
 * To force a deterministic throw from a real dispatch helper, `stripControlChars` (called by the
 * compaction_start handler) is overridden via a module mock gated on a flag — decoupled from any
 * specific handler so the test stays valid if individual holes are later guarded.
 */
import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import subagentExtension, { _resetAllTestHooks, _setDiscoverAgents, _setSpawn } from "../src/extension.js";
import type { SingleResult } from "../src/types.js";
import { createFakeProcess, EXIT_CODE_SUCCESS, injectEmptyModelConfig, setTestSettings } from "./test-helpers.js";

// Flag flipped to force stripControlChars to throw. Hoisted so the (hoisted) vi.mock factory can
// close over it without referencing a not-yet-initialized top-level binding.
const { stripFlag } = vi.hoisted(() => ({ stripFlag: { shouldThrow: false } }));

// Override stripControlChars to throw on demand — forces a throw out of dispatchLine's
// compaction_start handler. All other rendering exports are preserved. stripFlag defaults to
// false so this passes through to the real implementation for every other test file (this suite
// runs with isolate: false, so modules are shared — the gate keeps the override contained).
vi.mock("../src/rendering.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rendering.js")>();
  return {
    ...actual,
    stripControlChars: (s: string) => {
      if (stripFlag.shouldThrow) throw new Error("forced stripControlChars failure");
      return actual.stripControlChars(s);
    },
  };
});

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

function emit(proc: ChildProcess, event: Record<string, unknown>): void {
  proc.stdout?.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
}

describe("processLine stream-line safety net", () => {
  let tool: ToolDefinition;
  let ctx: ExtensionCommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    stripFlag.shouldThrow = false;
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
    stripFlag.shouldThrow = false;
  });

  test("a throw from a dispatch helper is recovered — does not crash the subagent", async () => {
    vi.useFakeTimers();

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);

    const resultPromise = tool.execute(
      "call-1",
      { agent: "worker", task: "compact then finish" },
      undefined,
      vi.fn(),
      ctx,
    );
    await vi.advanceTimersByTimeAsync(50);

    // 1) A normal delta first — proves the stream is healthy pre-fault.
    emit(proc, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Hmm" } });
    await vi.advanceTimersByTimeAsync(1);

    // 2) Arm the fault and emit compaction_start, whose handler calls stripControlChars → throws.
    //    Without the safety net this throw escapes the stdout "data" handler as an uncaughtException
    //    and crashes the subagent (non-zero exit, no errorMessage). With it, the line is dropped.
    stripFlag.shouldThrow = true;
    emit(proc, { type: "compaction_start", reason: "overflow" });
    await vi.advanceTimersByTimeAsync(1);

    // 3) Disarm the fault and emit a normal event — proves recovery (the parent kept running
    //    instead of crashing). If the safety net had let the throw escape, the process would be
    //    dead and this event would never be processed.
    stripFlag.shouldThrow = false;
    emit(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "still alive" } });
    await vi.advanceTimersByTimeAsync(1);

    emit(proc, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "still alive" }] },
    });
    await vi.advanceTimersByTimeAsync(1);

    proc.emit("close", EXIT_CODE_SUCCESS);
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];

    // Completed normally — the fault did NOT crash the subagent, and the post-fault event WAS
    // processed (output reflects "still alive", proving recovery rather than a silent death).
    expect(r.exitCode).toBe(0);
    expect(r.errorMessage).toBeUndefined();
    expect(r.output).toBe("still alive");
  });

  test("safety net re-arms the inactivity timer so a recovered fault can't masquerade as inactivity", async () => {
    vi.useFakeTimers();
    setTestSettings({ inactivityTimeoutMs: 5_000 });

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "fault then idle" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(50);

    // Faulting line is dropped — but it WAS an "activity" line that would have reset the timer.
    // The safety net re-arms the timer defensively so the dropped activity doesn't read as
    // genuine inactivity downstream.
    stripFlag.shouldThrow = true;
    emit(proc, { type: "compaction_start", reason: "overflow" });
    await vi.advanceTimersByTimeAsync(1);
    stripFlag.shouldThrow = false;

    // Close well within the inactivity window — confirms the timer was re-armed (a recovered
    // fault did not leave the subagent on a fast path to an inactivity kill).
    emit(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
    await vi.advanceTimersByTimeAsync(1);

    proc.emit("close", EXIT_CODE_SUCCESS);
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.exitCode).toBe(0);
    // No inactivity-kill message — the dropped activity line did not register as inactivity.
    expect(r.errorMessage).toBeUndefined();
  });
});
