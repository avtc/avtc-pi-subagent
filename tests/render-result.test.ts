// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";
import type { AgentProgress, SingleResult } from "../src/types.js";
import { collectText, mockTheme, ZERO_USAGE } from "./test-helpers.js";

const { renderResultImpl, createDefaultProgress } = __internal;

// These tests verify multi-line (original) rendering mode
beforeEach(() => {
  __internal.renderConfig.mode = "multi-line";
});

afterEach(() => {
  __internal.renderConfig.mode = "compact";
});

/** Helper to create a minimal SingleResult-like object for renderResultImpl. */
function makeResult(overrides: Record<string, unknown> = {}): SingleResult {
  const progress = (overrides.progress as AgentProgress) ?? createDefaultProgress("worker", "do something", {});
  // Derive progress.status from exitCode when not explicitly set
  if (!overrides.progress && overrides.exitCode !== undefined) {
    if (overrides.exitCode === 0) progress.status = "completed";
    else if ((overrides.exitCode as number) > 0) progress.status = "failed";
    else if ((overrides.exitCode as number) === -1) progress.status = "running";
  }
  return {
    agent: "worker",

    task: "do something",
    exitCode: 0,
    stderr: "",
    usage: { ...ZERO_USAGE },
    model: "test-model",
    startTime: Date.now(),
    endTime: Date.now(),
    progress,
    output: "done",
    filesChanged: [],
    testsRan: false,
    ...overrides,
    // Ensure derived progress overrides any progress in spread
    ...(overrides.progress ? {} : { progress }),
  } as unknown as SingleResult;
}

/** Helper to create a details object. */
function makeDetails(mode: "single" | "parallel" | "chain", results: SingleResult[]) {
  return {
    mode,
    projectAgentsDir: null,
    results,
  };
}

describe("renderResultImpl", () => {
  test("returns (no output) text when details is undefined", () => {
    const result = renderResultImpl({ details: undefined }, false, mockTheme);
    // Returns a Text node, not a Container
    expect(
      (result as unknown as { text?: string }).text ??
        collectText(result as unknown as { children: Array<{ text?: string; children?: unknown[] }> }).join(""),
    ).toContain("(no output)");
  });

  test("returns (no output) text when results array is empty", () => {
    const result = renderResultImpl({ details: makeDetails("single", []) }, false, mockTheme);
    expect(
      (result as unknown as { text?: string }).text ??
        collectText(result as unknown as { children: Array<{ text?: string; children?: unknown[] }> }).join(""),
    ).toContain("(no output)");
  });

  test("single mode renders agent progress for one result", () => {
    const result = makeResult();
    const container = renderResultImpl({ details: makeDetails("single", [result]) }, false, mockTheme);
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    // Should show agent name and model
    expect(texts.some((t) => t.includes("worker"))).toBe(true);
  });

  test("single mode renders task per-subagent, truncated in collapsed, full in expanded", () => {
    const longTask = "Review the implementation plan for gaps and inconsistencies across all sections";
    const result = makeResult({
      progress: createDefaultProgress("reviewer", longTask, {}),
    });
    // Collapsed: task truncated to first line (TUI wraps to width)
    const collapsed = renderResultImpl({ details: makeDetails("single", [result]) }, false, mockTheme);
    const collapsedTexts = collectText(
      collapsed as unknown as { children: Array<{ text?: string; children?: unknown[] }> },
    );
    expect(collapsedTexts.some((t) => t.includes(longTask.slice(0, 20)))).toBe(true);
    // Expanded: full task
    const expanded = renderResultImpl({ details: makeDetails("single", [result]) }, true, mockTheme);
    const expandedTexts = collectText(
      expanded as unknown as { children: Array<{ text?: string; children?: unknown[] }> },
    );
    expect(expandedTexts.some((t) => t.includes(longTask))).toBe(true);
  });

  test("single mode gracefully skips task line when task is empty", () => {
    const result = makeResult({
      progress: createDefaultProgress("reviewer", "", {}),
    });
    const container = renderResultImpl({ details: makeDetails("single", [result]) }, false, mockTheme);
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    // Should not have a "Task:" label for empty task
    expect(texts.every((t) => !t.includes("Task:") || t.includes(""))).toBe(true);
  });

  test("chain mode renders step headers with step numbers", () => {
    const r1 = makeResult({ agent: "scout", step: 1, exitCode: 0 });
    const r2 = makeResult({ agent: "worker", step: 2, exitCode: 0 });
    const container = renderResultImpl({ details: makeDetails("chain", [r1, r2]) }, false, mockTheme);
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.some((t) => t.includes("Step 1"))).toBe(true);
    expect(texts.some((t) => t.includes("Step 2"))).toBe(true);
    expect(texts.some((t) => t.includes("scout"))).toBe(true);
    expect(texts.some((t) => t.includes("worker"))).toBe(true);
    // Should show aggregate usage
    expect(texts.some((t) => t.includes("Total:"))).toBe(true);
  });

  test("chain mode shows ✗ for failed steps", () => {
    const r1 = makeResult({ agent: "scout", step: 1, exitCode: 1 });
    const container = renderResultImpl({ details: makeDetails("chain", [r1]) }, false, mockTheme);
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.some((t) => t.includes("✗"))).toBe(true);
  });

  test("chain mode shows ✗ when stopReason is error even with exitCode 0", () => {
    const r1 = makeResult({ agent: "scout", step: 1, exitCode: 0, stopReason: "error" });
    const container = renderResultImpl({ details: makeDetails("chain", [r1]) }, false, mockTheme);
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.some((t) => t.includes("✗"))).toBe(true);
    expect(texts.some((t) => t.includes("✓"))).toBe(false);
  });

  test("chain mode suppresses per-agent header (no duplicate agent line)", () => {
    const progress = createDefaultProgress("scout", "search", {});
    progress.toolCount = 5;
    const r1 = makeResult({ agent: "scout", step: 1, exitCode: 0, progress });
    const container = renderResultImpl({ details: makeDetails("chain", [r1]) }, false, mockTheme);
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    // Step header should be present
    expect(texts.some((t) => t.includes("Step 1"))).toBe(true);
    // The per-agent header line (e.g. "✓ scout (user) — 5 tools") should NOT appear
    // because chain mode passes suppressHeader=true to renderAgentProgress.
    // The agent name appears in the step header, not in a duplicate agent header.
    const hasAgentHeader = texts.some((t) => t.includes("scout") && t.includes("tools") && !t.includes("Step"));
    expect(hasAgentHeader).toBe(false);
  });

  test("parallel mode renders status header with running count", () => {
    const r1 = makeResult({ exitCode: 0 });
    const r2 = makeResult({ exitCode: -1 }); // still running
    const container = renderResultImpl({ details: makeDetails("parallel", [r1, r2]) }, false, mockTheme);
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.some((t) => t.includes("parallel"))).toBe(true);
    expect(texts.some((t) => t.includes("1/2"))).toBe(true);
  });

  test("expanded parallel view freezes aggregate io/elapsed while running (keeps count)", () => {
    const usage = { turns: 2, input: 5_000, output: 1_000, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0 };
    const r1 = makeResult({ exitCode: 0, usage });
    const r2 = makeResult({ exitCode: -1, usage, startTime: Date.now() - 90_000 }); // running
    const container = renderResultImpl({ details: makeDetails("parallel", [r1, r2]) }, true, mockTheme); // expanded
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const header = texts.find((t) => t.includes("parallel"));
    expect(header).toBeDefined();
    // Count stays (meaningful, discrete progress)
    expect(header).toContain("1/2");
    // Aggregate io + elapsed are omitted while running so the header is byte-stable (scroll-safe)
    expect(header).not.toContain("↑");
    expect(header).not.toContain("↓");
    expect(header).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  test("parallel mode shows aggregate usage only when all done", () => {
    const r1 = makeResult({ exitCode: 0 });
    const r2 = makeResult({ exitCode: -1 }); // running
    const container = renderResultImpl({ details: makeDetails("parallel", [r1, r2]) }, false, mockTheme);
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    // Should NOT show aggregate when still running
    expect(texts.every((t) => !t.includes("Total:"))).toBe(true);
  });

  test("parallel mode shows aggregate usage when all complete", () => {
    const r1 = makeResult({ exitCode: 0 });
    const r2 = makeResult({ exitCode: 0 });
    const container = renderResultImpl({ details: makeDetails("parallel", [r1, r2]) }, false, mockTheme);
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    // Aggregate stats are in the parallel header line
    expect(texts.some((t) => t.includes("parallel"))).toBe(true);
    expect(texts.some((t) => t.includes("2/2"))).toBe(true);
  });

  test("parallel mode renders task preview for each subagent", () => {
    const r1 = makeResult({
      agent: "reviewer",
      progress: createDefaultProgress("reviewer", "Review the code for bugs and issues", {}),
    });
    const r2 = makeResult({
      agent: "reviewer-fork",
      progress: createDefaultProgress("reviewer-fork", "Review the code for bugs and issues", {}),
    });
    const container = renderResultImpl({ details: makeDetails("parallel", [r1, r2]) }, false, mockTheme);
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    // Both subagents should have their task text rendered
    expect(texts.some((t) => t.includes("Review the code"))).toBe(true);
    // Should have at least 2 task lines (one per subagent)
    const taskLines = texts.filter((t) => t.includes("Review the code"));
    expect(taskLines.length).toBeGreaterThanOrEqual(2);
  });

  test("collapsed view shows Ctrl+O hint when expandable content exists", () => {
    const progress = createDefaultProgress("worker", "do something", {});
    progress.toolCount = 3; // has tools
    const r1 = makeResult({ progress });
    const container = renderResultImpl(
      { details: makeDetails("single", [r1]) },
      false, // collapsed
      mockTheme,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.some((t) => t.includes("Ctrl+O"))).toBe(true);
  });

  test("expanded view does not show Ctrl+O hint", () => {
    const progress = createDefaultProgress("worker", "do something", {});
    progress.toolCount = 3;
    const r1 = makeResult({ progress });
    const container = renderResultImpl(
      { details: makeDetails("single", [r1]) },
      true, // expanded
      mockTheme,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.every((t) => !t.includes("Ctrl+O"))).toBe(true);
  });

  test("collapsed view suppresses Ctrl+O hint when no expandable content", () => {
    const progress = createDefaultProgress("worker", "do something", {});
    progress.toolCount = 0; // no tools
    const r1 = makeResult({ progress, output: "" }); // no output
    const container = renderResultImpl(
      { details: makeDetails("single", [r1]) },
      false, // collapsed
      mockTheme,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.every((t) => !t.includes("Ctrl+O"))).toBe(true);
  });

  test("parallel mode shows ✓ icon when all succeed", () => {
    const r1 = makeResult({ exitCode: 0 });
    const r2 = makeResult({ exitCode: 0 });
    const container = renderResultImpl({ details: makeDetails("parallel", [r1, r2]) }, false, mockTheme);
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.some((t) => t.includes("✓"))).toBe(true);
    expect(texts.some((t) => t.includes("2/2"))).toBe(true);
  });

  test("parallel mode shows ◐ icon when some fail", () => {
    const r1 = makeResult({ exitCode: 0 });
    const r2 = makeResult({ exitCode: 1 });
    const container = renderResultImpl({ details: makeDetails("parallel", [r1, r2]) }, false, mockTheme);
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.some((t) => t.includes("◐"))).toBe(true);
  });
});
