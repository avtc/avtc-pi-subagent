// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * End-to-end RPC subagent lifecycle tests (mocked).
 *
 * Consolidation test proving the RPC protocol, done-detection state machine,
 * compaction resume work together through full lifecycle sequences: a fake pi child
 * process driven by real JSON events on stdout, with fake timers advancing the settle
 * state machine and a fake stdin capturing prompt/shutdown commands.
 *
 * Per-scenario unit coverage of these paths lives in processline-routing.test.ts; this
 * file walks each scenario as ONE cohesive sequence (prompt → ... → close) to catch
 * cross-phase interaction regressions (e.g. settle firing in the wrong window, the
 * resume loop, the cascade of spawnMode to nested children).
 */
import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import subagentExtension, { _resetAllTestHooks, _setDiscoverAgents, _setSpawn } from "../src/extension.js";
import type { SingleResult } from "../src/types.js";
import {
  createFakeProcessWithStdin as createFakeProcess,
  injectEmptyModelConfig,
  setTestSettings,
} from "./test-helpers.js";

const spawnMock = vi.fn();
const discoverAgentsMock = vi.fn();

/** Settle-timer duration + resume bound, mirroring process-runner.ts. The settle timer
 *  fires only when nothing is in flight (no activeRun / compactionInFlight / retryInFlight /
 *  promptInFlight). Advancing past SETTLE_MS in a quiet window concludes the run. */
const SETTLE_MS = 2_000;

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

/** Emit one JSON event on stdout and let the processLine microtask drain. */
async function emit(proc: ChildProcess, event: Record<string, unknown>) {
  (proc.stdout as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
  await new Promise<void>((r) => queueMicrotask(() => r()));
}

describe("RPC subagent end-to-end lifecycle", () => {
  let tool: ToolDefinition;
  let ctx: ExtensionCommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    _setSpawn(spawnMock);
    _setDiscoverAgents(discoverAgentsMock);
    injectEmptyModelConfig();
    setTestSettings({ spawnMode: "rpc" });
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

  test("happy path: prompt written → run → settle → stdin.close → exitCode 0", async () => {
    vi.useFakeTimers();
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "do work" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(20); // let the async spawn path resolve

    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite || !stdinEnd) throw new Error("fake proc.stdin missing");

    // 1) The initial prompt command was written to stdin: the fork payload that
    //    json mode passes as a positional arg is delivered as a stdin prompt command in RPC.
    const promptWrites = stdinWrite.mock.calls.map((c) => String(c[0])).filter((w) => w.includes(`"type":"prompt"`));
    expect(promptWrites).toHaveLength(1);
    const promptCmd = JSON.parse(promptWrites[0]) as { type: string; message: string; id: string };
    expect(promptCmd).toMatchObject({ type: "prompt", id: "1" });
    expect(promptCmd.message).toContain("do work");
    expect(promptWrites[0]).toMatch(/\n$/); // newline-terminated JSONL command
    expect(stdinEnd).not.toHaveBeenCalled(); // not closed yet — still running

    // 2) The child runs a full turn.
    await emit(proc, { type: "agent_start" });
    await emit(proc, {
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tc1",
      args: { command: "echo hi" },
    });
    await emit(proc, { type: "tool_execution_end", toolName: "bash", toolCallId: "tc1" });
    await emit(proc, { type: "agent_end", stopReason: "end_turn" });

    // 3) NOT closed immediately after agent_end — the settle timer is armed.
    expect(stdinEnd).not.toHaveBeenCalled();

    // 4) The quiet window elapses → settle concludes → stdin closed.
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 100);
    expect(stdinEnd).toHaveBeenCalledTimes(1);

    proc.emit("close", 0);
    const result = await resultPromise;

    const r = (result.details as { results: SingleResult[] }).results[0];
    expect(r.exitCode).toBe(0);
    expect(r.progress.status).toBe("completed");
    expect(r.progress.recentTools).toHaveLength(1);
    expect(r.progress.recentTools[0].tool).toBe("bash");
  });

  test("compaction self-continue: NOT closed between compaction_end and the continuation agent_start", async () => {
    // A SUCCESSFUL manual compaction self-continues via the child's own session_compact handler
    // (feature-flow). The parent must keep the run alive across the compaction_end →
    // continuation-agent_start window — settle must NOT close stdin there.
    vi.useFakeTimers();
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(20); // let the async spawn path resolve

    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinEnd) throw new Error("fake proc.stdin.end missing");

    await emit(proc, { type: "agent_start" });
    await emit(proc, { type: "compaction_start", reason: "manual" });
    await emit(proc, { type: "compaction_end", reason: "manual", aborted: false });

    // The settle window where a naive impl would close: compaction ended, no activeRun yet.
    // Advance PAST the full settle duration — the parent must still NOT close, because the
    // child self-continues (aborted:false means the continuation is expected, not a stall).
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
    expect(stdinEnd).not.toHaveBeenCalled();

    // The self-continuation turn arrives and finishes normally.
    await emit(proc, { type: "agent_start" });
    await emit(proc, { type: "agent_end", stopReason: "end_turn" });

    // Only NOW (quiet after the real continuation turn) does settle close.
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 100);
    expect(stdinEnd).toHaveBeenCalledTimes(1);

    proc.emit("close", 0);
    const result = await resultPromise;
    expect((result.details as { results: SingleResult[] }).results[0].exitCode).toBe(0);
    expect((result.details as { results: SingleResult[] }).results[0].progress.status).toBe("completed");
  });

  test("resume: aborted-manual compaction → settle writes a resume prompt → continuation → done", async () => {
    // A cancelled MANUAL ctx.compact() takes the disconnect-before-abort path: the aborted
    // run's agent_end is suppressed (never emitted), so the parent would hang on activeRun.
    // The aborted-manual compaction_end clears activeRun and, on settle, sends a bounded
    // resume prompt instead of closing.
    vi.useFakeTimers();
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(20); // let the async spawn path resolve

    const stdinWrite = proc.stdin?.write as ReturnType<typeof vi.fn> | undefined;
    const stdinEnd = proc.stdin?.end as ReturnType<typeof vi.fn> | undefined;
    if (!stdinWrite || !stdinEnd) throw new Error("fake proc.stdin missing");

    // A turn starts; the compaction aborts it and suppresses its agent_end (we emit NO agent_end).
    await emit(proc, { type: "agent_start" });
    await emit(proc, { type: "compaction_start", reason: "manual" });
    await emit(proc, { type: "compaction_end", reason: "manual", aborted: true });
    await vi.advanceTimersByTimeAsync(1);

    // Settle fires → a resume prompt is written (NOT stdin.end).
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 100);
    const resumeWrites = stdinWrite.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.includes(`"type":"prompt"`) && w.includes("resume-"));
    expect(resumeWrites).toHaveLength(1);
    const resumeCmd = JSON.parse(resumeWrites[0]) as { type: string; message: string; id: string };
    expect(resumeCmd.message).toMatch(/continue/i);
    expect(resumeCmd.id).toBe("resume-1");
    expect(stdinEnd).not.toHaveBeenCalled();

    // The resume turn starts (clears promptInFlight) and finishes normally → then settle closes.
    await emit(proc, { type: "agent_start" });
    await emit(proc, { type: "agent_end", stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 100);
    expect(stdinEnd).toHaveBeenCalledTimes(1);

    proc.emit("close", 0);
    const result = await resultPromise;
    expect((result.details as { results: SingleResult[] }).results[0].exitCode).toBe(0);
    expect((result.details as { results: SingleResult[] }).results[0].progress.status).toBe("completed");
  });

  test("error: final agent_end{stopReason:error} → synthesized exitCode 1 / failed", async () => {
    // RPC children exit 0 on graceful stdin-close even when the agent errored; the parent
    // synthesizes the exit code from the final stopReason.
    vi.useFakeTimers();
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    const resultPromise = tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await vi.advanceTimersByTimeAsync(20); // let the async spawn path resolve

    await emit(proc, { type: "agent_start" });
    await emit(proc, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "boom" }], stopReason: "error" },
    });
    await emit(proc, { type: "agent_end", stopReason: "error" });

    await vi.advanceTimersByTimeAsync(SETTLE_MS + 100);
    expect(proc.stdin?.end as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);

    proc.emit("close", 0); // child exits 0 despite the error
    const result = await resultPromise;
    const r = (result.details as { results: SingleResult[] }).results[0];

    expect(r.stopReason).toBe("error");
    expect(r.exitCode).toBe(1); // synthesized from stopReason, not the raw 0
    expect(r.progress.status).toBe("failed");
  });

  test("RPC cascade: nested children inherit spawnMode via the serialized settings", async () => {
    // spawnMode cascades through the PI_SETTINGS_SUBAGENT env var (process-runner.ts:456)
    // via the depth-decremented child-settings spread — NOT via EXCLUDED_FROM_CASCADE. The
    // json-only unit test in settings-serializer covers the spread mechanic in isolation;
    // this proves it for the real RPC spawn path: the child is spawned --mode rpc AND its
    // serialized settings carry spawnMode:"rpc" + a decremented maxSubagentDepth.
    const proc = createFakeProcess();
    spawnMock.mockReturnValue(proc);
    discoverAgentsMock.mockReturnValue(AGENTS);

    tool.execute("call-1", { agent: "worker", task: "t" }, undefined, vi.fn(), ctx);
    await waitForSpawn();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [_command, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string | undefined> },
    ];

    // (a) The child is spawned in RPC mode. Under vitest, getPiInvocation prefixes the
    //    worker script (process.argv[1]) to the args, so assert on the real flags: RPC adds
    //    "--mode" "rpc" and never the json-only "-p".
    expect(args).toContain("--mode");
    expect(args).toContain("rpc");
    expect(args).not.toContain("-p");

    // (b) The serialized child settings carry spawnMode:"rpc" and a decremented depth budget.
    const childSettings = JSON.parse(options.env.PI_SETTINGS_SUBAGENT ?? "{}") as {
      spawnMode: string;
      maxSubagentDepth: number;
    };
    expect(childSettings.spawnMode).toBe("rpc");
    expect(childSettings.maxSubagentDepth).toBe(2); // parent default 3 → child 2

    // Clean up the dangling run (never emit agent_end → no resolution). Clearing mocks +
    // resetting hooks in afterEach is sufficient; emit a close so the process handle drains.
    proc.emit("close", 0);
  });
});
