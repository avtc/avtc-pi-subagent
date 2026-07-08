// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { EventEmitter } from "node:events";
/**
 * Integration tests for processLine event routing.
 *
 * These tests verify that JSON events emitted by child pi processes
 * are correctly routed through processLine to update SingleResult fields.
 *
 * Strategy: mock spawn to return a fake process, then emit real JSON events
 * through stdout. Verify the final SingleResult has correct progress, output,
 * filesChanged, testsRan, and usage fields.
 */
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import subagentExtension, { _resetAllTestHooks, _setDiscoverAgents, _setSpawn } from "../src/extension.js";
import type { SingleResult } from "../src/types.js";
import {
  createFakeProcessWithStdin as createFakeProcess,
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

async function waitForSpawn(): Promise<void> {
  const start = Date.now();
  while (spawnMock.mock.calls.length === 0 && Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 1));
  }
  if (spawnMock.mock.calls.length === 0) {
    throw new Error("spawn was never called within 2s — tool.execute() did not reach runSingleAgent");
  }
}

async function runWithEvents(
  tool: ToolDefinition,
  ctx: ExtensionCommandContext,
  events: Record<string, unknown>[],
  exitCode: number,
) {
  const proc = createFakeProcess();
  spawnMock.mockReturnValue(proc);
  discoverAgentsMock.mockReturnValue(AGENTS);

  const resultPromise = tool.execute("call-1", { agent: "worker", task: "test task" }, undefined, vi.fn(), ctx);
  await waitForSpawn();

  for (const event of events) {
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
  }

  proc.emit("close", exitCode);
  return resultPromise;
}

describe("processLine event routing", () => {
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
    delete process.env.PI_SUBAGENT_FORK_MODE;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // --- Core routing tests ---

  test("tool_execution_start/end updates progress.recentTools and status", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "read", toolCallId: "tc1", args: { path: "src/foo.ts" } },
      { type: "tool_execution_end", toolName: "read", toolCallId: "tc1", isError: false },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
          usage: { input: 100, output: 50, totalTokens: 150 },
        },
      },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const details = result.details as { results: SingleResult[] };

    expect(details.results).toHaveLength(1);
    const r = details.results[0];
    expect(r.progress).toBeDefined();
    expect(r.progress.status).toBe("completed");
    expect(r.progress.recentTools).toHaveLength(1);
    expect(r.progress.recentTools[0].tool).toBe("read");
    expect(r.progress.recentTools[0].status).toBe("done");
    expect(r.output).toBe("Done");
  });

  test("tool_execution_start tracks filesChanged for write/edit", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "write", toolCallId: "tc1", args: { path: "src/new-file.ts" } },
      { type: "tool_execution_end", toolName: "write", toolCallId: "tc1" },
      { type: "tool_execution_start", toolName: "edit", toolCallId: "tc2", args: { file_path: "src/existing.ts" } },
      { type: "tool_execution_end", toolName: "edit", toolCallId: "tc2" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Edited" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.filesChanged).toBeDefined();
    expect(r.filesChanged).toContain("src/new-file.ts");
    expect(r.filesChanged).toContain("src/existing.ts");
  });

  test("filesChanged deduplicates same path across write and edit", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "write", toolCallId: "tc1", args: { path: "src/foo.ts" } },
      { type: "tool_execution_end", toolName: "write", toolCallId: "tc1" },
      { type: "tool_execution_start", toolName: "edit", toolCallId: "tc2", args: { file_path: "src/foo.ts" } },
      { type: "tool_execution_end", toolName: "edit", toolCallId: "tc2" },
      { type: "tool_execution_start", toolName: "write", toolCallId: "tc3", args: { path: "src/foo.ts" } },
      { type: "tool_execution_end", toolName: "write", toolCallId: "tc3" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.filesChanged).toHaveLength(1);
    expect(r.filesChanged).toEqual(["src/foo.ts"]);
  });

  test("tool_execution_start tracks testsRan for test commands", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "npx vitest run" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Tests pass" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    expect((result.details as { results: SingleResult[] }).results[0].testsRan).toBe(true);
  });

  test("testsRan stays false for non-test bash commands", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "git status" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" },
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc2", args: { command: "ls -la" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc2" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    expect((result.details as { results: SingleResult[] }).results[0].testsRan).toBe(false);
  });

  test("compaction_start/end creates synthetic tool event", async () => {
    const events = [
      { type: "compaction_start", reason: "threshold" },
      { type: "compaction_end", reason: "threshold", result: { tokensBefore: 85000 } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Compacted" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.progress.recentTools).toHaveLength(1);
    expect(r.progress.recentTools[0].tool).toBe("compacting");
    expect(r.progress.recentTools[0].status).toBe("done");
    expect(r.progress.recentTools[0].args).toContain("threshold");
    expect(r.progress.recentTools[0].args).toContain("compacted");
  });

  test("compaction_end aborted creates error status", async () => {
    const events = [
      { type: "compaction_start", reason: "overflow" },
      { type: "compaction_end", reason: "overflow", aborted: true, willRetry: true },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.progress.recentTools[0].status).toBe("error");
    expect(r.progress.recentTools[0].args).toContain("aborted");
    expect(r.progress.recentTools[0].args).toContain("retrying");
  });

  test("message_end extracts output and accumulates usage", async () => {
    const events = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "First turn" }],
          usage: { input: 500, output: 100, totalTokens: 600 },
          model: "test-model",
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Second turn" }],
          usage: { input: 300, output: 200, totalTokens: 500 },
        },
      },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.output).toBe("Second turn");
    expect(r.usage.input).toBe(800);
    expect(r.usage.output).toBe(300);
    expect(r.usage.turns).toBe(2);
    expect(r.model).toBe("test-model");
  });

  test("tool_execution_update populates nested children", async () => {
    const childProgress = {
      agent: "scout",

      status: "completed",
      task: "find files",
      recentTools: [],
      toolCount: 1,
      lastMessage: "",
    };

    const events = [
      {
        type: "tool_execution_start",
        toolName: "subagent",
        toolCallId: "tc1",
        args: { agent: "scout", task: "find files" },
      },
      {
        type: "tool_execution_update",
        toolName: "subagent",
        toolCallId: "tc1",
        partialResult: {
          details: {
            results: [{ progress: childProgress }],
          },
        },
      },
      { type: "tool_execution_end", toolName: "subagent", toolCallId: "tc1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Found files" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.progress.recentTools[0].children as unknown as Array<{ agent: string }>).toBeDefined();
    expect(r.progress.recentTools[0].children as unknown as Array<{ agent: string }>).toHaveLength(1);
    expect((r.progress.recentTools[0].children as unknown as Array<{ agent: string }>)[0].agent).toBe("scout");
  });

  // --- Edge case tests (no direct coverage in existing unit tests) ---

  test("tool_execution_update is no-op when toolCallId not found", async () => {
    const events = [
      {
        type: "tool_execution_start",
        toolName: "subagent",
        toolCallId: "tc1",
        args: { agent: "scout", task: "find files" },
      },
      {
        type: "tool_execution_update",
        toolName: "subagent",
        toolCallId: "nonexistent",
        partialResult: {
          details: {
            results: [
              {
                progress: {
                  agent: "scout",

                  status: "completed",
                  task: "x",
                  recentTools: [],
                  toolCount: 0,
                  lastMessage: "",
                },
              },
            ],
          },
        },
      },
      { type: "tool_execution_end", toolName: "subagent", toolCallId: "tc1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    // tc1 has no children since the update targeted a different toolCallId
    expect(r.progress.recentTools[0].children as unknown as Array<{ agent: string }>).toBeUndefined();
  });

  test("tool_execution_update is no-op when results have no progress", async () => {
    const events = [
      {
        type: "tool_execution_start",
        toolName: "subagent",
        toolCallId: "tc1",
        args: { agent: "scout", task: "find files" },
      },
      {
        type: "tool_execution_update",
        toolName: "subagent",
        toolCallId: "tc1",
        partialResult: {
          details: {
            results: [{ noProgress: true }],
          },
        },
      },
      { type: "tool_execution_end", toolName: "subagent", toolCallId: "tc1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.progress.recentTools[0].children as unknown as Array<{ agent: string }>).toBeUndefined();
  });

  test("progress status transitions: pending → running → completed", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "echo hi" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    expect((result.details as { results: SingleResult[] }).results[0].progress.status).toBe("completed");
  });

  test("exit code > 0 sets progress status to failed", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "npm test" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Tests failed" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 1);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.exitCode).toBe(1);
    expect(r.progress.status).toBe("failed");
  });

  test("tool_execution_end with isError: true marks tool status as error", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "bad-cmd" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1", isError: true },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Error occurred" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.progress.recentTools[0].status).toBe("error");
    expect(r.progress.status).toBe("completed");
  });

  test("non-assistant message_end does not update output or usage", async () => {
    const events = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Assistant output" }],
          usage: { input: 100, output: 50, totalTokens: 150 },
        },
      },
      {
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: "User message" }],
          usage: { input: 999, output: 999, totalTokens: 999 },
        },
      },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.output).toBe("Assistant output");
    expect(r.usage.input).toBe(100);
    expect(r.usage.turns).toBe(1);
  });

  test("message_end with only tool_call content does not overwrite output", async () => {
    const events = [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Initial output" }] } },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "tool_use", id: "tc1", name: "bash", input: {} }] },
      },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.output).toBe("Initial output");
  });

  test("tool_execution_end without toolCallId does not crash", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "echo hi" } },
      { type: "tool_execution_end", toolName: "bash" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.progress.recentTools[0].status).toBe("running");
    expect(r.progress.status).toBe("completed");
  });

  test("compaction_end with errorMessage creates error status", async () => {
    const events = [
      { type: "compaction_start", reason: "threshold" },
      { type: "compaction_end", reason: "threshold", errorMessage: "out of memory" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.progress.recentTools[0].status).toBe("error");
    expect(r.progress.recentTools[0].args).toContain("threshold");
    expect(r.progress.recentTools[0].args).toContain("out of memory");
  });

  test("compaction reason/errorMessage are sanitized before rendering in the tool log", async () => {
    // Compaction is RPC's core purpose, so its child-controlled fields (reason, errorMessage)
    // land in the live tool log via ToolEvent.args. A hostile/buggy child embedding ANSI must
    // be stripped before rendering — matching the posture of the other child-string paths.
    const osc = "\x1b]8;;https://evil.example\x07";
    const csi = "\x1b[31m";
    const events = [
      { type: "compaction_start", reason: `${csi}threshold` },
      { type: "compaction_end", reason: `${csi}threshold`, errorMessage: `${osc}boom` },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    const args = r.progress.recentTools[0].args;
    expect(args).not.toContain("\x1b");
    expect(args).not.toContain("]8;;");
    expect(args).not.toContain("[31m");
    // The benign text survives:
    expect(args).toContain("threshold");
    expect(args).toContain("boom");
  });

  test("compaction_end aborted without retry omits retrying suffix", async () => {
    const events = [
      { type: "compaction_start", reason: "overflow" },
      { type: "compaction_end", reason: "overflow", aborted: true, willRetry: false },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.progress.recentTools[0].status).toBe("error");
    expect(r.progress.recentTools[0].args).toContain("aborted");
    expect(r.progress.recentTools[0].args).not.toContain("retrying");
  });

  test("compaction_end success without result has no token reduction", async () => {
    const events = [
      { type: "compaction_start", reason: "manual" },
      { type: "compaction_end", reason: "manual" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.progress.recentTools[0].status).toBe("done");
    expect(r.progress.recentTools[0].tool).toBe("compacting");
    expect(r.progress.recentTools[0].args).toBe("manual");
  });

  test("compaction_end success with tokensBefore=0 shows 0 compacted", async () => {
    const events = [
      { type: "compaction_start", reason: "threshold" },
      { type: "compaction_end", reason: "threshold", result: { tokensBefore: 0 } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.progress.recentTools[0].status).toBe("done");
    expect(r.progress.recentTools[0].tool).toBe("compacting");
    expect(r.progress.recentTools[0].args).toContain("compacted");
  });

  test("stopReason: error sets progress status to failed even with exitCode 0", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "echo hi" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Error" }], stopReason: "error" },
      },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.stopReason).toBe("error");
    expect(r.progress.status).toBe("failed");
  });

  test("message_end with an error sets progress.errorVisible", async () => {
    // Transient error rendering: a turn/LLM error shows live during the run.
    const events = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "x" }],
          stopReason: "error",
          errorMessage: "500 boom",
        },
      },
    ];
    const result = await runWithEvents(tool, ctx, events, 0);
    expect((result.details as { results: SingleResult[] }).results[0].progress.errorVisible).toBe(true);
  });

  test("a thinking_delta after an error clears progress.errorVisible (recovered)", async () => {
    const events = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "x" }],
          stopReason: "error",
          errorMessage: "500 boom",
        },
      },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "retrying" } },
    ];
    const result = await runWithEvents(tool, ctx, events, 0);
    expect((result.details as { results: SingleResult[] }).results[0].progress.errorVisible).toBe(false);
  });

  test("a normal run leaves progress.errorVisible falsy", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "echo hi" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ];
    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.progress.errorVisible).toBeFalsy();
  });

  test("a message_end with stopReason 'aborted' sets progress.errorVisible (no errorMessage needed)", async () => {
    // The errorVisible condition has three terms; 'aborted' alone (no errorMessage) must trip it.
    const events = [
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "aborted" },
      },
    ];
    const result = await runWithEvents(tool, ctx, events, 0);
    expect((result.details as { results: SingleResult[] }).results[0].progress.errorVisible).toBe(true);
  });

  test("a message_end with stopReason 'error' and no errorMessage falls back to a generic Turn-error text", async () => {
    // stopReason 'error' WITHOUT an errorMessage: the mirrored nested-child error text falls back
    // to the generic "Turn error" string (the `?? "Turn error"` term). Existing error tests pair
    // stopReason 'error' WITH an errorMessage, so this fallback string was never exercised.
    const events = [
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "error" },
      },
    ];
    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.progress.errorVisible).toBe(true);
    expect(r.progress.error).toBe("Turn error");
  });

  test("a message_end with errorMessage (no error/aborted stopReason) sets progress.errorVisible", async () => {
    // The errorMessage term alone must trip errorVisible.
    const events = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "x" }],
          stopReason: "end_turn",
          errorMessage: "provider hiccup",
        },
      },
    ];
    const result = await runWithEvents(tool, ctx, events, 0);
    expect((result.details as { results: SingleResult[] }).results[0].progress.errorVisible).toBe(true);
  });

  test("a text_delta after an error clears progress.errorVisible (recovered)", async () => {
    // : errorVisible clears on the first thinking_delta OR text_delta. A model that
    // emits text before thinking must also clear it (sibling of the thinking_delta test).
    const events = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "x" }],
          stopReason: "error",
          errorMessage: "500 boom",
        },
      },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "retrying" } },
    ];
    const result = await runWithEvents(tool, ctx, events, 0);
    expect((result.details as { results: SingleResult[] }).results[0].progress.errorVisible).toBe(false);
  });

  test("a recovered error that completes cleanly also clears the mirrored progress.error text", async () => {
    // The delta-recovery clears BOTH errorVisible AND the mirrored progress.error (set so nested
    // children can render transient text). errorVisible is asserted above; progress.error must
    // ALSO clear and STAY cleared when the run completes successfully — otherwise finalize's
    // `errorMessage && status==="failed"` guard could leave stale transient text. This test drives
    // a full recover-and-complete: transient error → recover → clean end_turn → completed.
    const events = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "x" }],
          stopReason: "error",
          errorMessage: "500 boom",
        },
      },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "retrying" } },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "end_turn" },
      },
    ];
    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.progress.errorVisible).toBe(false);
    expect(r.progress.error).toBeUndefined();
    expect(r.progress.status).toBe("completed");
  });

  test("an error message_end DURING compaction does not set errorVisible (invariant #9)", async () => {
    // The !compactionInFlight guard on errorVisible prevents a red error from the aborted
    // compaction's message_end. Without the guard, deleting it would set errorVisible here.
    const events = [
      { type: "agent_start" },
      { type: "compaction_start", reason: "manual" },
      // While compactionInFlight is true, an aborted-turn message_end carries an error:
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "x" }],
          stopReason: "error",
          errorMessage: "aborted-by-compaction",
        },
      },
      { type: "compaction_end", reason: "manual", aborted: true },
      { type: "agent_end", stopReason: "end_turn" },
    ];
    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.progress.errorVisible).toBeFalsy();
  });

  test("fork+RPC delivers the fork instruction via stdin (not a positional arg)", async () => {
    // In fork mode the payload is the fork instruction (<fork-agent-context>+<fork-task>). For
    // RPC it must move to the stdin prompt command (like fresh mode's `Task:`), NOT stay as a
    // positional arg — otherwise the child would receive it twice / wrong channel. This covers
    // the rpcMessage = forkInstruction branch (process-runner.ts ~:404), the only RPC payload
    // path not exercised by the fresh-mode tests.
    setTestSettings({ spawnMode: "rpc" });
    process.env.PI_SUBAGENT_FORK_MODE = "fork";

    // A fork-capable sessionManager: resolveForkSessionFile calls
    // sessionManager.constructor.open(file).createBranchedSession(leafId).
    function ForkableSM() {}
    ForkableSM.open = () => ({ createBranchedSession: () => "/tmp/forked.jsonl" });
    const forkCtx = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: Object.assign(
        { getSessionFile: () => "/test/session.jsonl", getLeafId: () => "leaf-123" },
        { constructor: ForkableSM },
      ),
    };
    discoverAgentsMock.mockReturnValue({
      agents: [
        {
          name: "worker-fork",

          filePath: "/tmp/worker.md",
          systemPrompt: "system prompt",
          tools: ["read", "bash"],
        },
      ],
      bundledAgents: [],
      projectAgentsDir: null,
      extensionAgentDirs: [],
      overrideNames: new Set(),
    });

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    const resultPromise = tool.execute(
      "call-1",
      { agent: "worker-fork", task: "fork me" },
      undefined,
      vi.fn(),
      forkCtx as unknown as ExtensionCommandContext,
    );
    await waitForSpawn();

    const [_command, args] = spawnMock.mock.calls[0] as [string, string[], unknown];
    // The fork instruction is NOT pushed as a positional arg in RPC:
    expect(args.some((a) => a.includes("<fork-task>"))).toBe(false);
    expect(args.some((a) => a.includes("<fork-agent-context>"))).toBe(false);

    // The fork instruction IS delivered as the stdin prompt command message:
    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite) throw new Error("fake proc.stdin.write missing");
    const promptWrites = stdinWrite.mock.calls.map((c) => String(c[0])).filter((w) => w.includes(`"type":"prompt"`));
    expect(promptWrites).toHaveLength(1);
    const promptCmd = JSON.parse(promptWrites[0]) as {
      type: string;
      message: string;
      id: string;
      streamingBehavior: string;
    };
    expect(promptCmd).toMatchObject({ type: "prompt", id: "1", streamingBehavior: "followUp" });
    expect(promptCmd.message).toContain("<fork-task>");
    expect(promptCmd.message).toContain("fork me");
    expect(promptWrites[0]).toMatch(/\n$/);

    // Clean up the dangling run.
    proc.emit("close", EXIT_CODE_SUCCESS);
    await resultPromise;
  });

  test("throttle batches rapid emitUpdate calls within 150ms window", async () => {
    vi.useFakeTimers();

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);
    const onUpdate = vi.fn();

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "test task" }, undefined, onUpdate, ctx);

    await vi.advanceTimersByTimeAsync(20);

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        JSON.stringify({ type: "tool_execution_start", toolName: "read", toolCallId: "tc1", args: { path: "a.ts" } }) +
          "\n",
      ),
    );
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "tool_execution_end", toolName: "read", toolCallId: "tc1" })}\n`),
    );
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        JSON.stringify({ type: "tool_execution_start", toolName: "read", toolCallId: "tc2", args: { path: "b.ts" } }) +
          "\n",
      ),
    );
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "tool_execution_end", toolName: "read", toolCallId: "tc2" })}\n`),
    );

    await vi.advanceTimersByTimeAsync(1);

    const callsAfterEvents = onUpdate.mock.calls.length;
    expect(callsAfterEvents).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(160);

    const callsAfterThrottle = onUpdate.mock.calls.length;
    expect(callsAfterThrottle).toBeGreaterThan(callsAfterEvents);

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
        })}\n`,
      ),
    );
    await vi.advanceTimersByTimeAsync(1);

    proc.emit("close", EXIT_CODE_SUCCESS);
    const result = await resultPromise;

    expect((result.details as { results: SingleResult[] }).results[0].progress.status).toBe("completed");
    expect((result.details as { results: SingleResult[] }).results[0].progress.recentTools).toHaveLength(2);
  });

  test("non-JSON lines are silently ignored", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "echo hi" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ];

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "test task" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(events[0])}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from("This is not JSON\n"));
    (proc.stdout as EventEmitter).emit("data", Buffer.from("  \n"));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(events[1])}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(events[2])}\n`));
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    proc.emit("close", EXIT_CODE_SUCCESS);

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.progress.recentTools).toHaveLength(1);
    expect(r.progress.status).toBe("completed");
    expect(r.output).toBe("Done");
  });

  test("rpc `response` ack is silently filtered (no tool, no diagnostic pollution)", async () => {
    // RPC mode emits `response` acks (command/prompt preflight results) on stdout. These
    // are not agent activity — processLine must drop them at the top so they don't pollute
    // diagnostics (lastEventType/lastEventTime) or accidentally match a handler. No stdin
    // response is sent for a `response` ack (it's the child acking US, not a request).
    const realEvents = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "echo hi" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ];

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "test task" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    // A response ack carrying tool-shaped fields must NOT be processed as a tool event:
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "response", success: true, id: "1" })}\n`),
    );
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(realEvents[0])}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(realEvents[1])}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(realEvents[2])}\n`));
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    proc.emit("close", EXIT_CODE_SUCCESS);

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    // Exactly ONE tool (the real bash call) — the ack contributed nothing.
    expect(r.progress.recentTools).toHaveLength(1);
    expect(r.progress.recentTools[0]).toMatchObject({ tool: "bash" });
    expect(r.progress.status).toBe("completed");
    expect(r.output).toBe("Done");
    // No extension_ui_response was written for a plain response ack:
    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite) throw new Error("fake proc.stdin.write missing");
    const ackResponses = stdinWrite.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.includes("extension_ui_response"));
    expect(ackResponses).toHaveLength(0);
  });

  test("rpc extension_ui_request is auto-cancelled (cancelled:true response) and logged", async () => {
    // RPC mode's NATIVE generic-UI bridge: a child extension calling select/confirm/input/
    // editor emits {type:"extension_ui_request", id, method,...} and BLOCKS on a Promise
    // until the parent answers via stdin. The socket ui-bridge (used by ask-user_question)
    // does NOT use this path — it forwards tool payloads, not generic UI methods. So in
    // practice these shouldn't fire; if they do, auto-respond cancelled:true so the child
    // resolves to its defaultValue (== user pressed Esc) instead of hanging forever. Also
    // surface a note to stderr (visible misuse) and drop before diagnostics.
    const realEvents = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "echo hi" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ];

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "test task" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "extension_ui_request", id: "req-7", method: "select", title: "pick" })}\n`,
      ),
    );
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(realEvents[0])}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(realEvents[1])}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(realEvents[2])}\n`));
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    proc.emit("close", EXIT_CODE_SUCCESS);

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    // Auto-cancel written to stdin: exactly one extension_ui_response with the SAME id,
    // cancelled:true, newline-terminated.
    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite) throw new Error("fake proc.stdin.write missing");
    const uiResponses = stdinWrite.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.includes("extension_ui_response"));
    expect(uiResponses).toHaveLength(1);
    const parsed = JSON.parse(uiResponses[0]) as { type: string; id: string; cancelled: boolean };
    expect(parsed).toMatchObject({ type: "extension_ui_response", id: "req-7", cancelled: true });
    expect(uiResponses[0]).toMatch(/\n$/);
    // Surfaced to stderr (visible misuse), filtered from activity tracking (1 real tool):
    expect(r.stderr).toMatch(/extension_ui_request.*auto-cancelled/);
    expect(r.progress.recentTools).toHaveLength(1);
    expect(r.progress.status).toBe("completed");
  });

  test("rpc extension_ui_request without an id is logged but gets no response", async () => {
    // A fire-and-forget method (notify) or malformed request may carry no id. The handler must
    // still surface the stderr note (visible misuse) but must NOT write an extension_ui_response
    // (there's no id to satisfy the child's pending Promise — and these methods have no Promise).
    const realEvents = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "echo hi" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ];

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "test task" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "extension_ui_request", method: "notify" })}\n`),
    );
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(realEvents[0])}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(realEvents[1])}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(realEvents[2])}\n`));
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    proc.emit("close", EXIT_CODE_SUCCESS);

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite) throw new Error("fake proc.stdin.write missing");
    const uiResponses = stdinWrite.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.includes("extension_ui_response"));
    expect(uiResponses).toHaveLength(0); // no id → no response
    expect(r.stderr).toMatch(/extension_ui_request.*ignored, no id/); // fire-and-forget, not "auto-cancelled"
    expect(r.progress.recentTools).toHaveLength(1); // filtered from activity
  });

  test("rpc extension_ui_request after stdin closed is skipped, not written (no write-after-end)", async () => {
    // Regression: ERR_STREAM_WRITE_AFTER_END crash. After graceful shutdown ends stdin, the
    // child can still drain buffered stdout. A late extension_ui_request line arriving in that
    // window must NOT call proc.stdin.write (already ended → 'error' event → uncaughtException).
    // The isStdinOpen guard skips the write; the stderr note still fires so it isn't lost.
    // Here the prompt-preflight success:false path ends stdin synchronously, then the late
    // request is emitted — the same class of race as a settle-driven graceful shutdown.
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    // success:false → dispatchLine sets isStdinOpen=false and calls proc.stdin.end().
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "response", command: "prompt", success: false, error: "no model configured" })}\n`,
      ),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(proc.stdin?.end as ReturnType<typeof vi.fn>).toHaveBeenCalled();

    // Late ui request arriving AFTER stdin ended — must be skipped, not written.
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "extension_ui_request", id: "late-1", method: "select", title: "pick" })}\n`,
      ),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    proc.emit("close", EXIT_CODE_FAILURE);

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite) throw new Error("fake proc.stdin.write missing");
    const uiResponses = stdinWrite.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.includes("extension_ui_response"));
    expect(uiResponses).toHaveLength(0); // guard skipped the write (no write-after-end)
    expect(r.stderr).toMatch(/extension_ui_request.*auto-cancelled/); // stderr note still fires
  });

  test("rpc response ack with success:false concludes immediately (fail-fast on prompt preflight)", async () => {
    // RPC emits {type:"response", command:"prompt", success:false, error} when the prompt
    // preflight fails (e.g. model/session load error). Without fail-fast the parent would
    // hang for the full inactivity timeout; instead it concludes immediately.
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "response", command: "prompt", success: false, error: "no model configured" })}\n`,
      ),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinEnd) throw new Error("fake proc.stdin.end missing");
    expect(stdinEnd).toHaveBeenCalled();

    proc.emit("close", EXIT_CODE_FAILURE);

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.stopReason).toBe("error");
    expect(r.errorMessage).toBe("no model configured");
  });

  test("rpc response ack with success:false and no error field falls back to a generic message", async () => {
    // Covers the fallback branch: if the ack omits `error` (or sends a non-string), the
    // parent still concludes with a meaningful generic errorMessage.
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "response", command: "prompt", success: false })}\n`),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    expect(proc.stdin?.end as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    proc.emit("close", EXIT_CODE_FAILURE);

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.stopReason).toBe("error");
    expect(r.errorMessage).toBe("Prompt preflight failed");
  });

  test("rpc response ack with success:false and an empty-string error falls back to the generic message", async () => {
    // `error:""` is a distinct path from no error field: it passes the typeof-string guard but
    // has zero trimmed length, so the fallback branch fires. (A child probing the fallback could
    // send `{error:""}`.) Existing tests cover non-empty string (→ strip) and undefined (→ fallback)
    // but not the empty-string case.
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "response", command: "prompt", success: false, error: "" })}\n`),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    expect(proc.stdin?.end as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    proc.emit("close", EXIT_CODE_FAILURE);

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.stopReason).toBe("error");
    expect(r.errorMessage).toBe("Prompt preflight failed");
  });

  test("rpc response ack with success:true is ignored (no fail-fast, no activity)", async () => {
    // A successful prompt ack must NOT trigger fail-fast (only success:false does).
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinEnd) throw new Error("fake proc.stdin.end missing");

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "response", command: "prompt", success: true, id: "1" })}\n`),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(stdinEnd).not.toHaveBeenCalled(); // success:true → ignored, not fail-fast

    // Clean up the run so the test resolves (real agent_end + close).
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } })}\n`,
      ),
    );
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end" })}\n`));
    proc.emit("close", EXIT_CODE_SUCCESS);
    await resultPromise;
  });

  test("rpc synthesizes exitCode from stopReason (error → exit 1 / failed, clean → exit 0 / completed)", async () => {
    // RPC children always exit 0 on graceful stdin-close, so the parent must synthesize the
    // exit code from the final stopReason (carried by the final assistant message_end) for
    // SingleResult.exitCode + status to reflect failure.
    setTestSettings({ spawnMode: "rpc" });

    // --- error case ---
    let proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);
    let resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();
    const errEvents = [
      { type: "agent_start" },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "boom" }], stopReason: "error" },
      },
      { type: "agent_end" },
    ];
    for (const ev of errEvents) {
      (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(ev)}\n`));
      await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    }
    proc.emit("close", EXIT_CODE_SUCCESS); // child exits 0 despite the error
    let result = await resultPromise;
    let r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.stopReason).toBe("error");
    expect(r.exitCode).toBe(1); // synthesized, not the raw 0
    expect(r.progress.status).toBe("failed");

    // --- clean case ---
    proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    resultPromise = tool.execute("call-2", { agent: "worker", task: "t2" }, undefined, vi.fn(), ctx);
    await waitForSpawn();
    const okEvents = [
      { type: "agent_start" },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "end_turn" },
      },
      { type: "agent_end" },
    ];
    for (const ev of okEvents) {
      (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(ev)}\n`));
      await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    }
    proc.emit("close", EXIT_CODE_SUCCESS);
    result = await resultPromise;
    r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.exitCode).toBe(0);
    expect(r.progress.status).toBe("completed");

    // --- aborted stopReason case ---
    proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    resultPromise = tool.execute("call-3", { agent: "worker", task: "t3" }, undefined, vi.fn(), ctx);
    await waitForSpawn();
    const abortEvents = [
      { type: "agent_start" },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "aborted" },
      },
      { type: "agent_end", stopReason: "aborted" },
    ];
    for (const ev of abortEvents) {
      (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(ev)}\n`));
      await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    }
    proc.emit("close", EXIT_CODE_SUCCESS); // child exits 0 despite the abort
    result = await resultPromise;
    r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.stopReason).toBe("aborted");
    expect(r.exitCode).toBe(1); // the 'aborted' clause synthesizes exit 1
    expect(r.progress.status).toBe("failed");
  });

  test("rpc hard-killed by inactivity timeout synthesizes exit 1 / failed (not completed)", async () => {
    // The inactivity/absolute kill paths call resolveOnce(1) + set errorMessage but never set
    // stopReason. Without considering the raw exit code, RPC synthesis would yield 0/completed
    // for a force-killed child — the grep-hang scenario this feature exists to handle. The kill
    // path's resolveOnce(1) must drive the synthesized exit code too.
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "rpc", inactivityTimeoutMs: 1_000 });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(5);

    // A run starts, then goes silent (e.g. child hung on a grep call) past the inactivity timeout.
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    await vi.advanceTimersByTimeAsync(1_200); // > inactivityTimeoutMs → inactivity kill fires

    proc.emit("close", EXIT_CODE_FAILURE); // resolveOnce(1) → exit 1
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.errorMessage).toMatch(/inactivity/i);
    expect(r.exitCode).toBe(1); // synthesized from the kill's exit 1, not lost as 0
    expect(r.progress.status).toBe("failed");

    vi.useRealTimers();
  });

  test("a hard-kill after a transient error shows the kill reason, not stale transient text", async () => {
    // A transient turn error (500) sets progress.errorVisible + mirrors the text onto
    // progress.error (so nested children can render it). If the child then hangs and is
    // hard-killed BEFORE recovering (no first delta to clear errorVisible), the kill reason
    // must win: finalize must overwrite the stale transient progress.error with the kill
    // reason, else the render gate `p.error || r.errorMessage` shows the stale transient text.
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "rpc", inactivityTimeoutMs: 1_000 });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(5);

    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    // Transient 500 error: sets errorVisible + mirrors text onto progress.error.
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "x" }],
            stopReason: "error",
            errorMessage: "500 boom",
          },
        })}\n`,
      ),
    );
    // Child goes silent past the inactivity timeout → hard-killed. No recovery delta fired.
    await vi.advanceTimersByTimeAsync(1_200);

    proc.emit("close", EXIT_CODE_FAILURE);
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    // The kill reason must be the rendered error, not the stale "500 boom".
    expect(r.progress.error).toMatch(/inactivity/i);
    expect(r.progress.error).not.toMatch(/500 boom/);
    expect(r.errorMessage).toMatch(/inactivity/i);

    vi.useRealTimers();
  });

  test("rpc hard-killed by ABSOLUTE timeout synthesizes exit 1 / failed", async () => {
    // The inactivity kill is tested; the ABSOLUTE timeout is a distinct kill path
    // (fireAbsoluteTimeout — different errorMessage "timed out after Ns"). It must likewise
    // resolve exit 1 / failed, and (finalize) overwrite any stale transient progress.error.
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "rpc", subagentTimeoutMs: 5_000 });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(5);

    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    // Transient error first, then run out the absolute clock (absolute timer counts ALL elapsed time):
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "error", errorMessage: "500 boom" } })}\n`,
      ),
    );
    await vi.advanceTimersByTimeAsync(5_000); // > subagentTimeoutMs → absolute kill fires

    proc.emit("close", EXIT_CODE_FAILURE);
    const result = await resultPromise;
    const rr = (result.details as { results: SingleResult[] }).results[0];
    expect(rr.exitCode).toBe(1);
    expect(rr.progress.status).toBe("failed");
    expect(rr.errorMessage).toMatch(/timed out/i);
    // finalize overwrite: absolute reason wins, not stale transient "500 boom":
    expect(rr.progress.error).toMatch(/timed out/i);

    vi.useRealTimers();
  });

  test("rpc resumes after a cancelled MANUAL compaction (suppressed-agent_end stall)", async () => {
    // A tool-driven ctx.compact that gets cancelled takes the disconnect-before-abort path:
    // the aborted run's agent_end is suppressed (never reaches stdout), so the parent would
    // hang on activeRun forever. The aborted-manual compaction_end clears activeRun and, on
    // settle, the parent sends a bounded resume prompt instead of closing.
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(1);
    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite) throw new Error("fake proc.stdin.write missing");

    // A turn starts; the compaction aborts it and suppresses its agent_end (we emit NO agent_end).
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "compaction_start", reason: "manual" })}\n`),
    );
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "compaction_end", reason: "manual", aborted: true })}\n`),
    );
    await vi.advanceTimersByTimeAsync(1);

    // Settle fires → a resume prompt is written (NOT stdin.end).
    await vi.advanceTimersByTimeAsync(2_100);
    const resumeWrites = stdinWrite.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.includes(`"type":"prompt"`) && w.includes("resume-"));
    expect(resumeWrites).toHaveLength(1);
    expect(JSON.parse(resumeWrites[0]).message).toMatch(/continue/i);
    // streamingBehavior must be present so a session already streaming (e.g. a compaction
    // extension resumed the child in-process before this settle timer fired) queues the
    // resume as a followUp instead of throwing "Agent is already processing".
    expect(JSON.parse(resumeWrites[0]).streamingBehavior).toBe("followUp");

    // The resume turn starts (clears promptInFlight) and finishes normally.
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end" })}\n`));
    await vi.advanceTimersByTimeAsync(2_100);

    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinEnd) throw new Error("fake proc.stdin.end missing");
    expect(stdinEnd).toHaveBeenCalledTimes(1);

    proc.emit("close", EXIT_CODE_SUCCESS);
    await resultPromise;

    vi.useRealTimers();
  });

  test("rpc skips redundant resume when an in-process extension resumed the child after an aborted compaction", async () => {
    // feature-flow's compaction handler resumes the child in-process (sendUserMessage,
    // ~500ms) after an aborted manual compaction. The child's agent_start from that
    // resume arrives BEFORE the settle timer fires (~2000ms). That agent_start means the
    // stall is already resolved, so the settle timer must NOT send a redundant resume
    // (which would otherwise throw "Agent is already processing" while that turn streams,
    // or at minimum duplicate the continuation message).
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(1);
    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite) throw new Error("fake proc.stdin.write missing");

    // A turn starts; the compaction aborts it and suppresses its agent_end.
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "compaction_start", reason: "manual" })}\n`),
    );
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "compaction_end", reason: "manual", aborted: true })}\n`),
    );
    await vi.advanceTimersByTimeAsync(1);

    // The in-process extension resumes the child BEFORE settle fires — a new turn starts.
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    await vi.advanceTimersByTimeAsync(1);

    // Advance well past SETTLE_MS while the resumed turn runs (deltas keep it alive) then ends.
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end" })}\n`));
    await vi.advanceTimersByTimeAsync(2_100);

    // No resume prompt was written — the extension already resumed the child.
    const resumeWrites = stdinWrite.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.includes(`"type":"prompt"`) && w.includes("resume-"));
    expect(resumeWrites).toHaveLength(0);

    // The child concludes normally (stdin closed).
    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinEnd) throw new Error("fake proc.stdin.end missing");
    expect(stdinEnd).toHaveBeenCalledTimes(1);

    proc.emit("close", EXIT_CODE_SUCCESS);
    await resultPromise;

    vi.useRealTimers();
  });

  test("rpc auto-aborted compaction (reason:threshold) does NOT trigger a resume", async () => {
    // Auto-compaction runs in-loop between turns and emits a real agent_end, so an auto abort
    // must NOT be treated as a stall — settle closes stdin (no spurious resume).
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(1);
    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite) throw new Error("fake proc.stdin.write missing");

    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "compaction_start", reason: "threshold" })}\n`),
    );
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "compaction_end", reason: "threshold", aborted: true })}\n`),
    );
    await vi.advanceTimersByTimeAsync(2_100); // past SETTLE_MS

    // No resume prompt written for an auto abort.
    const resumeWrites = stdinWrite.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.includes(`"type":"prompt"`) && w.includes("resume-"));
    expect(resumeWrites).toHaveLength(0);

    proc.emit("close", EXIT_CODE_SUCCESS);
    await resultPromise;

    vi.useRealTimers();
  });

  test("rpc successful (non-aborted) manual compaction does NOT trigger a parent resume", async () => {
    // A successful compaction self-continues via the child's own session_compact handler
    // (feature-flow), so the parent must NOT send a resume. Only ABORTED manual compactions
    // (the suppressed-agent_end stall) trigger the resume.
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(1);
    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite) throw new Error("fake proc.stdin.write missing");

    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "compaction_start", reason: "manual" })}\n`),
    );
    // Successful compaction (aborted:false) → child self-continues with its own agent_start.
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "compaction_end", reason: "manual", aborted: false })}\n`),
    );
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end" })}\n`));
    await vi.advanceTimersByTimeAsync(2_100); // past SETTLE_MS after the self-continued turn

    // No resume prompt — only the original prompt command was ever written.
    const resumeWrites = stdinWrite.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.includes(`"type":"prompt"`) && w.includes("resume-"));
    expect(resumeWrites).toHaveLength(0);

    proc.emit("close", EXIT_CODE_SUCCESS);
    await resultPromise;

    vi.useRealTimers();
  });

  test("rpc resume is bounded: after MAX_RESUMES consecutive aborted-manual compactions, settle closes stdin", async () => {
    // A pathological child that keeps cancelling manual compactions must not loop forever.
    // After MAX_RESUMES (3) resume attempts, the next settle concludes (closes stdin).
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(1);
    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite) throw new Error("fake proc.stdin.write missing");
    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinEnd) throw new Error("fake proc.stdin.end missing");

    // Each iteration: an aborted-manual compaction (no agent_end) → settle → resume prompt.
    const abortManual = () => {
      (proc.stdout as EventEmitter).emit(
        "data",
        Buffer.from(`${JSON.stringify({ type: "compaction_start", reason: "manual" })}\n`),
      );
      (proc.stdout as EventEmitter).emit(
        "data",
        Buffer.from(`${JSON.stringify({ type: "compaction_end", reason: "manual", aborted: true })}\n`),
      );
    };

    const countResumeWrites = () =>
      stdinWrite.mock.calls.filter((c) => String(c[0]).includes(`"type":"prompt"`) && String(c[0]).includes("resume-"))
        .length;

    // 3 resumes (MAX_RESUMES) — each aborted-manual triggers a resume on settle.
    for (let i = 0; i < 3; i++) {
      abortManual();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(2_100);
    }
    expect(countResumeWrites()).toBe(3);
    expect(stdinEnd).not.toHaveBeenCalled();

    // A 4th aborted-manual compaction → settle now CLOSES (bound hit), no 4th resume.
    abortManual();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(countResumeWrites()).toBe(3); // still 3, not 4
    expect(stdinEnd).toHaveBeenCalledTimes(1);

    proc.emit("close", EXIT_CODE_SUCCESS);
    const result = await resultPromise;
    // Bound exhaustion is a genuine non-completion: the child couldn't make progress after
    // MAX_RESUMES resume attempts, so it reports FAILED with a descriptive errorMessage
    // (not a misleading "completed").
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.progress.status).toBe("failed");
    expect(r.exitCode).toBe(1);
    expect(r.errorMessage).toMatch(/stopped after 3 compaction-resume attempts/);
    expect(r.stderr).toMatch(/stopped after 3 compaction-resume attempts/);

    vi.useRealTimers();
  });

  test("rpc cascading resume: an aborted-manual compaction during a turn, then a real resumed run that completes", async () => {
    // The MAX_RESUMES test covers repeated suppressed-agent_end stalls. This variant exercises
    // the full-lifecycle path: a turn runs, gets an aborted-manual compaction (no agent_end),
    // parent resumes, the resumed turn runs to completion (agent_start → agent_end), and the
    // run concludes cleanly. Verifies activeRun/promptInFlight tracking across the resume.
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(1);
    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite) throw new Error("fake proc.stdin.write missing");
    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinEnd) throw new Error("fake proc.stdin.end missing");

    const countResumeWrites = () =>
      stdinWrite.mock.calls.filter((c) => String(c[0]).includes(`"type":"prompt"`) && String(c[0]).includes("resume-"))
        .length;

    // Initial turn runs, then is aborted mid-compaction (no agent_end for the aborted run).
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "compaction_start", reason: "manual" })}\n`),
    );
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "compaction_end", reason: "manual", aborted: true })}\n`),
    );
    await vi.advanceTimersByTimeAsync(2_100); // settle → resume prompt fires
    expect(countResumeWrites()).toBe(1);

    // The resumed turn runs to completion.
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "echo hi" } })}\n`,
      ),
    );
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" })}\n`),
    );
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } })}\n`,
      ),
    );
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end" })}\n`));
    await vi.advanceTimersByTimeAsync(2_100); // settle after agent_end → conclude

    expect(countResumeWrites()).toBe(1); // exactly one resume, no spurious second
    expect(stdinEnd).toHaveBeenCalledTimes(1);
    proc.emit("close", EXIT_CODE_SUCCESS);
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.progress.status).toBe("completed");
    // Per-attempt resume observability: the [rpc] diagnostic is emitted to stderr.
    expect(r.stderr).toMatch(/Manual compaction cancelled; resuming \(attempt 1\/3\)/);

    vi.useRealTimers();
  });

  test("rpc resumed turn that itself errors concludes via settle (no second resume)", async () => {
    // After a resume is sent, abortedManualCompaction is cleared. If the resumed turn then
    // errors (message_end stopReason 'error' + agent_end), the next settle must CLOSE stdin
    // (not send another resume) — otherwise an errored resumed turn would loop resumes. This
    // locks the clearing logic: a regression that re-sets abortedManualCompaction would cause
    // an infinite resume loop on errored resumed turns.
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(1);
    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite) throw new Error("fake proc.stdin.write missing");
    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinEnd) throw new Error("fake proc.stdin.end missing");

    const countResumeWrites = () =>
      stdinWrite.mock.calls.filter((c) => String(c[0]).includes(`"type":"prompt"`) && String(c[0]).includes("resume-"))
        .length;

    // Initial turn aborted mid-manual-compaction → settle sends resume #1.
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "compaction_start", reason: "manual" })}\n`),
    );
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "compaction_end", reason: "manual", aborted: true })}\n`),
    );
    await vi.advanceTimersByTimeAsync(2_100);
    expect(countResumeWrites()).toBe(1);

    // The resumed turn itself ERRORS out (not a clean completion).
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "provider 500" } })}\n`,
      ),
    );
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end" })}\n`));
    await vi.advanceTimersByTimeAsync(2_100); // settle after agent_end → conclude

    expect(countResumeWrites()).toBe(1); // still one resume — no second resume for the errored turn
    expect(stdinEnd).toHaveBeenCalledTimes(1); // concluded via graceful close
    proc.emit("close", EXIT_CODE_SUCCESS);
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.progress.status).toBe("failed"); // errored resumed turn → failed, not completed

    vi.useRealTimers();
  });

  test("rpc extension_error is surfaced to stderr and filtered from diagnostics", async () => {
    // RPC emits `extension_error` (rpc-mode.js onError hook) when any child extension
    // handler throws. Unlike the benign acks, this carries a real failure — it must be
    // surfaced (not silently lost) but still dropped before lastEventTime so it doesn't
    // pollute inactivity-kill diagnostics.
    const realEvents = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "echo hi" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ];

    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "test task" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "extension_error", extensionPath: "/some/ext", event: "session_start", error: "boom from extension" })}\n`,
      ),
    );
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(realEvents[0])}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(realEvents[1])}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(realEvents[2])}\n`));
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    proc.emit("close", EXIT_CODE_SUCCESS);

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    // The extension failure is surfaced, not lost:
    expect(r.stderr).toContain("boom from extension");
    // It was filtered from activity tracking — the run still completed normally and
    // exactly one real tool was recorded (extension_error contributed nothing):
    expect(r.progress.recentTools).toHaveLength(1);
    expect(r.progress.status).toBe("completed");
  });

  test("rpc extension_error without extensionPath omits the @ <path> suffix", async () => {
    // The ternary `extPath ? ` @ ${extPath}`: ""` missing-path branch (no `@`) is untested by the
    // sibling that always supplies an extensionPath.
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "extension_error", error: "noisy failure" })}\n`),
    );
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } })}\n`,
      ),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    proc.emit("close", EXIT_CODE_SUCCESS);

    const r = ((await resultPromise) as { details: { results: SingleResult[] } }).details.results[0];
    expect(r.stderr).toContain("[extension_error] noisy failure");
    expect(r.stderr).not.toMatch(/@/);
  });

  test("rpc extension_error with a non-string error object falls back to a stable string (no throw)", async () => {
    // A child extension can throw ANYTHING — incl. a non-string object. The typeof-guard +
    // try/catch must surface a stable string form and never break processLine.
    // NOTE: the circular-ref `catch` branch is genuinely unreachable via the JSONL stdout path
    // (JSON can't represent circular refs), so it's pure defense-in-depth for a future non-JSON
    // event source; this test covers the REACHABLE non-string-object path through JSON.stringify.
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "extension_error", extensionPath: "/x", error: { code: 503, kind: "object" } })}\n`,
      ),
    );
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } })}\n`,
      ),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    proc.emit("close", EXIT_CODE_SUCCESS);

    const r = ((await resultPromise) as { details: { results: SingleResult[] } }).details.results[0];
    // Non-string error is JSON.stringified exactly (the reachable path), no throw, surfaced:
    expect(r.stderr).toContain("[extension_error @ /x]");
    expect(r.stderr).toContain('{"code":503,"kind":"object"}');
  });

  test("rpc child-controlled strings are sanitized at the stderr/progress surfacing boundary", async () => {
    // Integration guard for stripControlChars WIRING: inject hostile ANSI/OSC payloads
    // through the real processLine paths and assert they are stripped before reaching
    // currentResult.stderr / progress.error. A regression removing any call site would fail.
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    const osc8 = "\x1b]8;;https://evil.example\x07spoof\x1b]8;;\x07"; // OSC 8 hyperlink
    const csi = "\x1b[2J\x1b[Hwipe"; // screen-wipe CSI
    // message_end.errorMessage carries the OSC payload (→ progress.error + errorMessage):
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "x" }],
            stopReason: "error",
            errorMessage: `${osc8}${csi}`,
          },
        })}\n`,
      ),
    );
    // extension_error.error carries a CSI payload (→ stderr):
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "extension_error", extensionPath: `/p${csi}`, error: `boom${csi}` })}\n`),
    );
    // extension_ui_request.method carries an OSC payload (→ stderr):
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "extension_ui_request", id: "r9", method: `${osc8}` })}\n`),
    );
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } })}\n`,
      ),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    proc.emit("close", EXIT_CODE_SUCCESS);

    const r = ((await resultPromise) as { details: { results: SingleResult[] } }).details.results[0];
    // No ESC byte survives anywhere it's surfaced to the operator terminal:
    expect(r.stderr).not.toContain("\x1b");
    expect(r.stderr).not.toContain("]8;;"); // OSC payload text stripped
    expect(r.stderr).not.toContain("[2J"); // CSI payload text stripped
    expect(r.errorMessage).not.toContain("\x1b");
    expect(r.errorMessage).toContain("spoof");
    expect(r.errorMessage).toContain("wipe");
    expect(r.progress.error).not.toContain("\x1b");
  });

  test("tool_execution_start without args uses empty object fallback", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1" },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.progress.recentTools).toHaveLength(1);
    expect(r.progress.recentTools[0].tool).toBe("bash");
    expect(r.progress.recentTools[0].status).toBe("done");
    expect(r.testsRan).toBe(false);
  });

  test("tool_execution_update for non-subagent tool is silently ignored", async () => {
    const events = [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "echo hi" } },
      {
        type: "tool_execution_update",
        toolName: "bash",
        toolCallId: "tc1",
        partialResult: {
          details: {
            results: [
              {
                progress: {
                  agent: "scout",

                  status: "completed",
                  task: "x",
                  recentTools: [],
                  toolCount: 0,
                  lastMessage: "",
                },
              },
            ],
          },
        },
      },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ];

    const result = await runWithEvents(tool, ctx, events, 0);
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.progress.recentTools).toHaveLength(1);
    expect(r.progress.recentTools[0].tool).toBe("bash");
    expect(r.progress.recentTools[0].status).toBe("done");
    expect(r.progress.recentTools[0].children as unknown as Array<{ agent: string }>).toBeUndefined();
  });

  test("status transitions are observable at intermediate states via onUpdate", async () => {
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);
    const onUpdate = vi.fn();

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "test task" }, undefined, onUpdate, ctx);
    await waitForSpawn();

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "tool_execution_start",
          toolName: "bash",
          toolCallId: "tc1",
          args: { command: "echo hi" },
        })}\n`,
      ),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    const runningCalls = onUpdate.mock.calls.filter((call: unknown[]) => {
      const details = (call[0] as { details?: { results?: Array<{ progress?: { status?: string } }> } }).details;
      return details?.results?.[0]?.progress?.status === "running";
    });
    expect(runningCalls.length).toBeGreaterThanOrEqual(1);

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" })}\n`),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
        })}\n`,
      ),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    proc.emit("close", EXIT_CODE_SUCCESS);

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.progress.status).toBe("completed");
    expect(runningCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("status transitions from pending to running on first thinking_delta (before any tool call)", async () => {
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);
    const onUpdate = vi.fn();

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "test task" }, undefined, onUpdate, ctx);
    await waitForSpawn();

    // Emit a thinking_delta BEFORE any tool_execution_start
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "Let me think about this..." },
        })}\n`,
      ),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    // Status should have transitioned to "running" due to the thinking delta
    const runningCalls = onUpdate.mock.calls.filter((call: unknown[]) => {
      const details = (call[0] as { details?: { results?: Array<{ progress?: { status?: string } }> } }).details;
      return details?.results?.[0]?.progress?.status === "running";
    });
    expect(runningCalls.length).toBeGreaterThanOrEqual(1);

    // Complete normally
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
        })}\n`,
      ),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    proc.emit("close", EXIT_CODE_SUCCESS);

    const result = await resultPromise;
    expect((result.details as { results: SingleResult[] }).results[0].progress.status).toBe("completed");
    // Thinking content should be captured
    expect((result.details as { results: SingleResult[] }).results[0].progress.lastThinking).toContain(
      "Let me think about this",
    );
  });

  test("status transitions from pending to running on first text_delta (before any tool call)", async () => {
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);
    const onUpdate = vi.fn();

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "test task" }, undefined, onUpdate, ctx);
    await waitForSpawn();

    // Emit a text_delta BEFORE any tool_execution_start
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Starting work..." },
        })}\n`,
      ),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    // Status should have transitioned to "running" due to the text delta
    const runningCalls = onUpdate.mock.calls.filter((call: unknown[]) => {
      const details = (call[0] as { details?: { results?: Array<{ progress?: { status?: string } }> } }).details;
      return details?.results?.[0]?.progress?.status === "running";
    });
    expect(runningCalls.length).toBeGreaterThanOrEqual(1);

    // Complete normally
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
        })}\n`,
      ),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    proc.emit("close", EXIT_CODE_SUCCESS);

    const result = await resultPromise;
    expect((result.details as { results: SingleResult[] }).results[0].progress.status).toBe("completed");
  });

  test("rpc spawn failure (proc 'error' event) resolves exit 1 / failed with a descriptive error message, not hang", async () => {
    // A distinct resolution path from 'close': proc.on('error') fires when the spawn itself
    // fails (e.g. ENOENT). It must resolveOnce(1) AND surface a descriptive errorMessage so the
    // parent never hangs and the operator sees why (not a silent exit:1/failed with no text).
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    proc.emit("error", new Error("spawn ENOENT"));

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.exitCode).toBe(1);
    expect(r.progress.status).toBe("failed");
    expect(r.errorMessage).toBe("Failed to start subagent process: spawn ENOENT");
  });

  test("rpc response ack with a non-prompt command is ignored (no fail-fast, invariant)", async () => {
    // Fail-fast requires command==="prompt" && success===false. A response for any other
    // command must be a no-op — the run is NOT concluded early.
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();
    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinEnd) throw new Error("fake proc.stdin.end missing");

    // A non-prompt response (success:false) must NOT trigger fail-fast:
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "response", command: "other", success: false, error: "ignored" })}\n`),
    );
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(stdinEnd).not.toHaveBeenCalled(); // ignored, not fail-fast
    // errorMessage/stopReason not set (no fail-fast):
    // Conclude via a normal run + close so the test resolves.
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } })}\n`,
      ),
    );
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end" })}\n`));
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    proc.emit("close", EXIT_CODE_SUCCESS);

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.progress.status).toBe("completed");
    expect(r.stopReason).not.toBe("error"); // the ignored response set nothing
  });

  test("multiple newline-separated JSON events in a single stdout chunk are all processed", async () => {
    // The stdout handler buffers + splits on '\n', then runs processLine per complete line. The OS
    // may coalesce several agent events into one pipe write, so a single `data` chunk can contain
    // multiple '\n'-separated JSON objects. The for-loop must process each. Every existing test
    // emits each event as its own `emit("data")` — this exercises the multi-line-in-one-chunk path.
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    // ONE chunk carrying TWO tool-execution events + a final message_end, newline-separated.
    const chunk = [
      JSON.stringify({
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "tc1",
        args: { command: "echo one" },
      }),
      JSON.stringify({ type: "tool_execution_start", toolName: "read", toolCallId: "tc2", args: { path: "a.ts" } }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
      }),
    ].join("\n");
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${chunk}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end" })}\n`));
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    proc.emit("close", EXIT_CODE_SUCCESS);

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    // BOTH tools from the single chunk were processed (the multi-line split + for-loop worked).
    expect(r.progress.recentTools.map((t) => t.tool)).toEqual(["bash", "read"]);
    expect(r.progress.status).toBe("completed");
  });

  test("a JSON event split across two stdout chunks is reassembled and processed once", async () => {
    // The handler keeps an incomplete trailing line in the buffer (`buffer = lines.pop`), so a
    // single JSON event split mid-object across two pipe writes is reassembled into one line and
    // processed exactly once (not dropped, not double-processed). This is the core RPC transport
    // robustness concern: pipe writes are arbitrarily delimited.
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    const full = JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tc1",
      args: { command: "echo split" },
    });
    const mid = Math.floor(full.length / 2);
    // First half — no trailing newline, so it stays buffered (incomplete line).
    (proc.stdout as EventEmitter).emit("data", Buffer.from(full.slice(0, mid)));
    // Second half + newline — completes the line; the handler joins it with the buffered first half.
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${full.slice(mid)}\n`));
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } })}\n`,
      ),
    );
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end" })}\n`));
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    proc.emit("close", EXIT_CODE_SUCCESS);

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    // The split event was reassembled → exactly one tool recorded (not zero/dropped, not two).
    expect(r.progress.recentTools).toHaveLength(1);
    expect(r.progress.recentTools[0].tool).toBe("bash");
    expect(r.progress.status).toBe("completed");
  });

  test("a final event with no trailing newline is flushed on close and still processed", async () => {
    // The close (and kill) handlers do `if (buffer.trim) processLine(buffer)` to flush a child's
    // LAST event that arrived WITHOUT a trailing '\n'. This is a real path (a child's final event
    // may not be newline-terminated, esp. under RPC's graceful stdin.end shutdown). Every other
    // test emits '\n'-terminated lines, so this flush was untested.
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    // A tool event with NO trailing newline — it stays in the buffer until the flush on close.
    const noNewline = JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tc1",
      args: { command: "echo flush" },
    });
    (proc.stdout as EventEmitter).emit("data", Buffer.from(noNewline));
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    proc.emit("close", EXIT_CODE_SUCCESS); // close handler flushes the un-terminated buffer

    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];
    // The non-newline-terminated event WAS processed by the close-handler flush.
    expect(r.progress.recentTools).toHaveLength(1);
    expect(r.progress.recentTools[0].tool).toBe("bash");
  });
});

describe("spawnMode", () => {
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

  test("spawnMode rpc spawns an rpc child (--mode rpc, piped stdin, no positional payload)", async () => {
    setTestSettings({ spawnMode: "rpc" });
    const events = [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }];
    await runWithEvents(tool, ctx, events, 0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [_cmd, spawnArgs, spawnOpts] = spawnMock.mock.calls[0];
    const flatArgs = spawnArgs as string[];
    expect(flatArgs).toContain("--mode");
    expect(flatArgs).toContain("rpc");
    expect(flatArgs).not.toContain("-p");
    expect(flatArgs.some((a) => a.startsWith("Task:"))).toBe(false); // payload delivered via stdin, not a positional arg
    // The system prompt stays an ARG (not the payload) — it must survive into RPC fresh mode
    // (the whole point of gating only the positional payload). Pin the fragile property:
    expect(flatArgs).toContain("--append-system-prompt");
    const stdio = (spawnOpts as { stdio?: unknown }).stdio;
    expect(stdio).toEqual(["pipe", "pipe", "pipe"]); // stdin must be a pipe for RPC
  });

  test("spawnMode rpc delivers the initial prompt as a stdin 'prompt' command (fresh mode)", async () => {
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);
    const resultPromise = tool.execute("call-1", { agent: "worker", task: "do the thing" }, undefined, vi.fn(), ctx);

    // Wait for spawn (the stdin write happens synchronously inside the Promise constructor
    // at spawn time, so once spawn fires the prompt command is already written).
    await waitForSpawn();

    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite) throw new Error("fake proc.stdin.write missing");
    expect(stdinWrite).toHaveBeenCalled();
    const writes = stdinWrite.mock.calls.map((c) => String(c[0]));
    // Exactly one prompt command; message carries the task as 'Task: …' (fresh mode),
    // newline-terminated JSONL.
    const promptLines = writes.filter((w) => w.includes('"type":"prompt"'));
    expect(promptLines).toHaveLength(1);
    const parsed = JSON.parse(promptLines[0]) as { type: string; message: string; id: string };
    expect(parsed.type).toBe("prompt");
    expect(parsed.id).toBe("1");
    expect(parsed.message).toContain("Task:");
    expect(parsed.message).toContain("do the thing");
    expect(promptLines[0]).toMatch(/\n$/); // newline-terminated JSONL

    // Let the run complete cleanly.
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } })}\n`,
      ),
    );
    proc.emit("close", EXIT_CODE_SUCCESS);
    const result = await resultPromise;
    expect((result.details as { results: SingleResult[] }).results[0].progress.status).toBe("completed");
  });

  test("spawnMode rpc settles (closes stdin) only after SETTLE_MS of idle post-agent_end", async () => {
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    // Let spawn + the initial-prompt stdin write flush (fake timers: advance past microtasks).
    await vi.advanceTimersByTimeAsync(1);
    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinEnd) throw new Error("fake proc.stdin.end missing");

    // Turn: agent_start -> agent_end. Between them the settle must NOT close stdin (activeRun).
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end" })}\n`));
    await vi.advanceTimersByTimeAsync(1_500); // < SETTLE_MS (2000)
    expect(stdinEnd).not.toHaveBeenCalled();

    // After the settle window elapses with nothing in flight, stdin is closed exactly once.
    await vi.advanceTimersByTimeAsync(1_000); // total >= SETTLE_MS past agent_end
    expect(stdinEnd).toHaveBeenCalledTimes(1);

    proc.emit("close", EXIT_CODE_SUCCESS);
    await resultPromise;
  });

  test("spawnMode rpc does NOT close stdin between consecutive turns (multi-turn self-continue)", async () => {
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(1);
    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinEnd) throw new Error("fake proc.stdin.end missing");

    // Turn 1
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end" })}\n`));
    await vi.advanceTimersByTimeAsync(1_900); // almost SETTLE_MS after turn 1
    expect(stdinEnd).not.toHaveBeenCalled();

    // Turn 2 (self-continue) starts before settle fires → resets the timer, stdin stays open
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end" })}\n`));
    await vi.advanceTimersByTimeAsync(1_900); // almost SETTLE_MS after turn 2
    expect(stdinEnd).not.toHaveBeenCalled();

    // Final idle beyond SETTLE_MS → close exactly once
    await vi.advanceTimersByTimeAsync(200);
    expect(stdinEnd).toHaveBeenCalledTimes(1);

    proc.emit("close", EXIT_CODE_SUCCESS);
    await resultPromise;
  });

  test("spawnMode rpc holds settle open during in-flight compaction (compactionInFlight)", async () => {
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(1);
    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinEnd) throw new Error("fake proc.stdin.end missing");

    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end" })}\n`));
    // A compaction fires after the turn — settle must NOT close stdin while it's in flight.
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "compaction_start", reason: "manual" })}\n`),
    );
    await vi.advanceTimersByTimeAsync(5_000); // well past SETTLE_MS
    expect(stdinEnd).not.toHaveBeenCalled(); // compactionInFlight holds

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "compaction_end", reason: "manual" })}\n`),
    );
    await vi.advanceTimersByTimeAsync(1_500); // < SETTLE_MS after compaction_end
    expect(stdinEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000); // >= SETTLE_MS after compaction_end
    expect(stdinEnd).toHaveBeenCalledTimes(1);

    proc.emit("close", EXIT_CODE_SUCCESS);
    await resultPromise;
  });

  test("spawnMode rpc promptInFlight holds settle across the startup gap (no agent_start yet)", async () => {
    vi.useFakeTimers();
    setTestSettings({ spawnMode: "rpc" });
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(1);
    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinEnd) throw new Error("fake proc.stdin.end missing");

    // Prompt written, NO agent_start yet — the settle is armed but promptInFlight must
    // hold it open (this is the load-bearing startup-gap guard; without it, SETTLE would
    // close stdin before the run starts). Advance WELL past SETTLE_MS → still open.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stdinEnd).not.toHaveBeenCalled();

    // Now the run starts: agent_start clears promptInFlight; agent_end + idle → close.
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`));
    (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify({ type: "agent_end" })}\n`));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(stdinEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000); // >= SETTLE_MS after agent_end
    expect(stdinEnd).toHaveBeenCalledTimes(1);

    proc.emit("close", EXIT_CODE_SUCCESS);
    await resultPromise;
  });

  test("absent spawnMode defaults to json and spawns normally (backward compat)", async () => {
    // No spawnMode in PI_SETTINGS_SUBAGENT → deserialize defaults to "json" → spawn path
    process.env.PI_SETTINGS_SUBAGENT = JSON.stringify({
      subagentTimeoutMs: 600_000,
      inactivityTimeoutMs: 600_000,
      subagentConcurrency: 6,
      maxSubagentDepth: 3,
    });
    const events = [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }];
    const result = await runWithEvents(tool, ctx, events, 0);
    expect(spawnMock).toHaveBeenCalledTimes(1); // json path, not the rpc placeholder
    expect((result.details as { results: SingleResult[] }).results[0].progress.status).toBe("completed");
  });

  test("spawnMode json unchanged (single-shot close → exitCode 0)", async () => {
    setTestSettings({ spawnMode: "json" });
    const events = [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }];
    const result = await runWithEvents(tool, ctx, events, 0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect((result.details as { results: SingleResult[] }).results[0].exitCode).toBe(0);
    expect((result.details as { results: SingleResult[] }).results[0].progress.status).toBe("completed");
  });

  test("spawnMode cascades to nested subagents via the settings spread", async () => {
    // spawnMode:'json' reaches the real spawn (rpc placeholder returns before it).
    // The settings spread ({...settings, maxSubagentDepth - 1 }) at the serialization
    // site is mode-agnostic, so proving it carries 'json' proves it carries 'rpc'.
    setTestSettings({ spawnMode: "json", maxSubagentDepth: 3 });
    const events = [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }];
    await runWithEvents(tool, ctx, events, 0);
    const spawnOpts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    const childSettings = JSON.parse(spawnOpts.env.PI_SETTINGS_SUBAGENT);
    expect(childSettings.spawnMode).toBe("json"); // cascades unchanged
    expect(childSettings.maxSubagentDepth).toBe(2); // decremented
  });
});
