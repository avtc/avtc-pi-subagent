// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";
import { DEFAULT_DEPTH, HEADER_VISIBLE, NO_COLLAPSED_TOOL_LIMIT } from "../src/rendering.js";
import type { SingleResult } from "../src/types.js";
import { collectText as collectTexts, mockTheme, ZERO_USAGE } from "./test-helpers.js";

const { renderAgentProgress, createDefaultProgress, pushToolEvent } = __internal;

// These tests verify multi-line (original) rendering mode
beforeEach(() => {
  __internal.renderConfig.mode = "multi-line";
});

afterEach(() => {
  __internal.renderConfig.mode = "compact";
});

describe("renderAgentProgress nested rendering", () => {
  test("renders 2-level nesting: worker → scout with model and turns on child", () => {
    const workerProgress = createDefaultProgress("worker", "implement feature", {});
    workerProgress.status = "running";

    const scoutProgress = createDefaultProgress("scout", "find files", {});
    scoutProgress.status = "completed";
    scoutProgress.model = "test-provider/model-b";
    scoutProgress.usage = {
      turns: 5,
      input: 3000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.003,
      contextTokens: 3200,
    };
    scoutProgress.startTime = Date.now() - 60000;
    scoutProgress.endTime = Date.now();

    pushToolEvent(workerProgress, {
      tool: "subagent",
      args: "scout",
      toolCallId: "s1",
      status: "done",
      children: [scoutProgress],
    });

    const r = {
      agent: "worker",

      progress: workerProgress,
      model: undefined,
      usage: { turns: 1, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 3000 },
      startTime: Date.now() - 30000,
      endTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    expect(container).toBeDefined();
    expect(container.children.length).toBeGreaterThan(0);

    const texts = collectTexts(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const allText = texts.join("\n");

    // Header should contain worker agent name
    expect(allText).toContain("worker");
    // Tool log should contain subagent call
    expect(allText).toContain("subagent");
    // Nested child (scout) should appear inline
    expect(allText).toContain("scout");
    // Nested child header should show model name
    expect(allText).toContain("test-provider/model-b");
    // Nested child should show turns
    expect(allText).toContain("5");
    // Nested child should show elapsed time
    expect(allText).toContain("00:01:");
    // Nested child should show usage stats
    expect(allText).toContain("3.0k");
    expect(allText).toContain("200");
  });

  test("renders 2-level nesting: worker → scout", () => {
    const workerProgress = createDefaultProgress("worker", "implement feature", {});
    workerProgress.status = "running";

    const scoutProgress = createDefaultProgress("scout", "find files", {});
    scoutProgress.status = "completed";

    pushToolEvent(workerProgress, {
      tool: "subagent",
      args: "scout",
      toolCallId: "s1",
      status: "done",
      children: [scoutProgress],
    });

    const r = {
      agent: "worker",

      progress: workerProgress,
      model: undefined,
      usage: { turns: 1, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 3000 },
      startTime: Date.now() - 30000,
      endTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    expect(container).toBeDefined();
    expect(container.children.length).toBeGreaterThan(0);

    const texts = collectTexts(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const allText = texts.join("\n");

    // Header should contain worker agent name
    expect(allText).toContain("worker");
    // Tool log should contain subagent call
    expect(allText).toContain("subagent");
    // Nested child (scout) should appear inline
    expect(allText).toContain("scout");
  });

  test("renders failed agent with error message", () => {
    const progress = createDefaultProgress("worker", "failing task", {});
    progress.status = "failed";

    const r = {
      agent: "worker",

      progress,
      model: "test-model",
      stopReason: "error",
      errorMessage: "Command timed out",
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
      endTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    expect(container).toBeDefined();
    expect(container.children.length).toBeGreaterThan(0);

    const texts = collectTexts(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const allText = texts.join("\n");

    // Failed status icon should appear
    expect(allText).toContain("✗");
    // Error stop reason should be shown
    expect(allText).toContain("error");
    // Error message content should be shown
    expect(allText).toContain("Command timed out");
  });

  test("renders 3-level nesting: worker → scout → researcher", () => {
    // Level 3: researcher (leaf)
    const researcherProgress = createDefaultProgress("researcher", "search docs", {});
    researcherProgress.status = "completed";

    // Level 2: scout with nested researcher
    const scoutProgress = createDefaultProgress("scout", "find files", {});
    scoutProgress.status = "completed";
    pushToolEvent(scoutProgress, {
      tool: "subagent",
      args: "researcher",
      toolCallId: "r1",
      status: "done",
      children: [researcherProgress],
    });

    // Level 1: worker with nested scout
    const workerProgress = createDefaultProgress("worker", "implement feature", {});
    workerProgress.status = "running";
    pushToolEvent(workerProgress, {
      tool: "subagent",
      args: "scout",
      toolCallId: "s1",
      status: "done",
      children: [scoutProgress],
    });

    const r = {
      agent: "worker",

      progress: workerProgress,
      model: undefined,
      usage: { turns: 1, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 3000 },
      startTime: Date.now() - 30000,
      endTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    expect(container).toBeDefined();
    expect(container.children.length).toBeGreaterThan(0);

    const texts = collectTexts(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const allText = texts.join("\n");

    // All three agent names should appear
    expect(allText).toContain("worker");
    expect(allText).toContain("scout");
    expect(allText).toContain("researcher");

    // Verify indentation levels
    // depth=0 (worker): header starts with status icon, no leading spaces
    const spinnerRegex = /[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807]/;
    const workerLine = texts.find(
      (t) => t.includes("worker") && (spinnerRegex.test(t) || t.includes("▶")), // spinner (collapsed) or ▶ (full)
    );
    expect(workerLine).toBeDefined();
    if (!workerLine) throw new Error("no worker line");
    expect(
      workerLine.startsWith("○") ||
        spinnerRegex.test(workerLine[0]) ||
        workerLine[0] === "▶" ||
        workerLine.startsWith("✓") ||
        workerLine.startsWith("✗"),
    ).toBe(true);

    // depth=1 (scout): header starts with 2-space indent
    const scoutLine = texts.find((t) => t.includes("scout") && t.includes("✓"));
    expect(scoutLine).toBeDefined();
    expect(scoutLine?.startsWith("  ✓")).toBe(true);

    // depth=2 (researcher): header starts with 4-space indent
    const researcherLine = texts.find((t) => t.includes("researcher") && t.includes("✓"));
    expect(researcherLine).toBeDefined();
    expect(researcherLine?.startsWith("    ✓")).toBe(true);
  });

  test("renders pending status with hollow circle icon", () => {
    const progress = createDefaultProgress("worker", "waiting to start", {});
    progress.status = "pending";
    // No tools, no thinking — just header + usage

    const r = {
      agent: "worker",

      progress,
      model: "test-model",
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
      endTime: undefined,
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    expect(container).toBeDefined();
    expect(container.children.length).toBeGreaterThan(0);

    const texts = collectTexts(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const allText = texts.join("\n");

    // Pending status icon ○ should appear
    expect(allText).toContain("○");
    // Agent name should appear
    expect(allText).toContain("worker");
    // Model should appear
    expect(allText).toContain("test-model");
    // No tools count shown when toolCount is 0
    expect(allText).not.toContain("0 tools");
    // Elapsed time shown even without endTime (ticks live from startTime)
    expect(allText).toContain("00:00:00");
  });

  test("renders with minimal progress object", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "pending";
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
      endTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    expect(container).toBeDefined();
    expect(container.children.length).toBeGreaterThan(0);

    const texts = collectTexts(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const allText = texts.join("\n");

    // Should show agent name and pending status icon
    expect(allText).toContain("worker");
    expect(allText).toContain("○");
  });

  test("renders context gauge in usage line when contextWindow is set", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "completed";
    progress.contextWindow = 200000;

    const r = {
      agent: "worker",

      progress,
      model: "test-model",
      usage: { turns: 1, input: 5000, output: 2000, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 21000 },
      startTime: Date.now() - 10000,
      endTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    expect(container).toBeDefined();

    const texts = collectTexts(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const allText = texts.join("\n");

    // Usage line should contain context gauge with denominator
    expect(allText).toContain("21k/200k");
  });

  test("renders context gauge without denominator when contextWindow is undefined", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "completed";
    // contextWindow left undefined (default)

    const r = {
      agent: "worker",

      progress,
      model: "test-model",
      usage: { turns: 1, input: 5000, output: 2000, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 21000 },
      startTime: Date.now() - 10000,
      endTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    expect(container).toBeDefined();

    const texts = collectTexts(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const allText = texts.join("\n");

    // Usage line should contain context gauge without denominator
    expect(allText).toContain("21k");
    expect(allText).not.toContain("21k/");
  });
});
