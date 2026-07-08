// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";
import { DEFAULT_DEPTH, HEADER_VISIBLE, NO_COLLAPSED_TOOL_LIMIT, SUPPRESS_HEADER } from "../src/rendering.js";
import type { SingleResult } from "../src/types.js";
import { collectText, mockTheme, ZERO_USAGE } from "./test-helpers.js";

const { renderAgentProgress, createDefaultProgress, pushToolEvent } = __internal;

// These tests verify multi-line (original) rendering mode
beforeEach(() => {
  __internal.renderConfig.mode = "multi-line";
});

afterEach(() => {
  __internal.renderConfig.mode = "compact";
});

describe("renderAgentProgress", () => {
  test("renders header with completed status", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "completed";
    const r = {
      agent: "worker",

      progress,
      model: "test-model",
      usage: { turns: 5, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 5000 },
      startTime: Date.now() - 60000,
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
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const header = texts.find((t) => t.includes("worker") && t.includes("✓"));
    expect(header).toBeDefined();
    expect(header).toContain("test-model");
    expect(header).toContain("5⟳");
  });

  test("renders tool log with running marker", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running";
    pushToolEvent(progress, { tool: "bash", args: "npm test", toolCallId: "t1", status: "running" });
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const toolLine = texts.find((t) => t.includes("bash"));
    expect(toolLine).toBeDefined();
    expect(toolLine).toContain("→");
    expect(toolLine).toContain("npm test");
  });

  test("skips thinking line when lastMessage is empty", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "completed";
    // lastMessage is "" by default
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
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    // Should have header + usage, but no empty thinking line
    const emptyLines = texts.filter((t) => t.trim() === "");
    expect(emptyLines.length).toBe(0);
  });

  test("renders nested children under parent tool row", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running";
    const childProgress = createDefaultProgress("scout", "recon", {});
    childProgress.status = "completed";
    pushToolEvent(progress, {
      tool: "subagent",
      args: "scout",
      toolCallId: "s1",
      status: "done",
      children: [childProgress],
    });
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    // Should contain both parent tool and child agent header
    const parentLine = texts.find((t) => t.includes("subagent"));
    const childHeader = texts.find((t) => t.includes("scout") && t.includes("✓"));
    expect(parentLine).toBeDefined();
    expect(childHeader).toBeDefined();
  });

  test("renders error message for failed agent", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "failed";
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      stopReason: "error",
      errorMessage: "Something went wrong",
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
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const errorLine = texts.find((t) => t.includes("Something went wrong"));
    expect(errorLine).toBeDefined();
    const header = texts.find((t) => t.includes("[error]"));
    expect(header).toBeDefined();
  });

  test("transient errorVisible renders the error live during a running agent", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running"; // NOT failed — mid-run
    progress.errorVisible = true;
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      errorMessage: "500 boom",
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
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.find((t) => t.includes("Error: 500 boom"))).toBeDefined();
  });

  test("transient error hidden once errorVisible cleared (recovered)", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running";
    progress.errorVisible = false; // cleared by the first delta of the recovered turn
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      errorMessage: "500 boom",
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
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.find((t) => t.includes("Error:"))).toBeUndefined();
  });

  test("hard failure (status failed, errorVisible unset) still renders the error", () => {
    // Regression guard: hard failures never fire message_end, so errorVisible is never set —
    // the status==='failed' term must keep rendering the error.
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "failed";
    // errorVisible intentionally unset
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      errorMessage: "Subagent killed after 600s of inactivity",
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
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.find((t) => t.includes("Error: Subagent killed after 600s of inactivity"))).toBeDefined();
  });

  test("renders aborted stopReason in header for failed agent", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "failed";
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      stopReason: "aborted",
      errorMessage: "Subagent was aborted",
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
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    // Header should show [aborted] stopReason
    const header = texts.find((t) => t.includes("[aborted]"));
    expect(header).toBeDefined();
    // Error message should be rendered
    const errorMsg = texts.find((t) => t.includes("Subagent was aborted"));
    expect(errorMsg).toBeDefined();
    // Failed icon (✗) should be present
    const failedIcon = texts.find((t) => t.includes("✗"));
    expect(failedIcon).toBeDefined();
  });

  test("renders expanded view with output at depth=0, skips task (already shown by renderCall)", () => {
    const progress = createDefaultProgress("worker", "do the thing", {});
    progress.status = "completed";
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      output: "Task completed successfully",
      usage: { turns: 1, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
      startTime: Date.now(),
      endTime: Date.now(),
    };
    const container = renderAgentProgress(r as unknown as SingleResult, mockTheme, true, 0, false, undefined); // expanded
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    // Task is rendered as a dim text line (no "Task:" label)
    const taskBody = texts.find((t) => t === "do the thing");
    expect(taskBody).toBeDefined();
    // Output markdown is still rendered
    const output = texts.find((t) => t.includes("Task completed successfully"));
    expect(output).toBeDefined();
  });

  test("expanded mode: Markdown output is rendered", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "completed";
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      output: "Task completed successfully",
      usage: { turns: 3, input: 5000, output: 2000, cacheRead: 1000, cacheWrite: 500, cost: 0.01, contextTokens: 0 },
      startTime: Date.now(),
      endTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      true,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const markdownIdx = container.children.findIndex((c: unknown) => c instanceof Markdown);
    expect(markdownIdx).toBeGreaterThan(-1);
    // Usage stats are in header, not a separate line
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const header = texts.find((t) => t.includes("3⟳"));
    expect(header).toBeDefined();
  });

  test("expanded view freezes live stats while running (no turns/io/ctx/elapsed in header)", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running";
    pushToolEvent(progress, { tool: "bash", args: "npm test", toolCallId: "t1", status: "running" });
    const r = {
      agent: "worker",

      progress,
      model: "test-model",
      usage: { turns: 7, input: 12_000, output: 3_000, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 9_000 },
      startTime: Date.now() - 90_000,
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      true, // expanded
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const header = texts.find((t) => t.includes("worker"));
    expect(header).toBeDefined();
    // Static fields stay
    expect(header).toContain("test-model");
    // Live stats are omitted while running so the header is byte-stable (scroll-safe)
    expect(header).not.toContain("7⟳");
    expect(header).not.toContain("↑");
    expect(header).not.toContain("↓");
    expect(header).not.toContain("ctx:");
    expect(header).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  test("expanded view shows live stats once completed (unfrozen)", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "completed";
    const r = {
      agent: "worker",

      progress,
      model: "test-model",
      usage: { turns: 7, input: 12_000, output: 3_000, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 9_000 },
      startTime: Date.now() - 90_000,
      endTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      true, // expanded
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const header = texts.find((t) => t.includes("worker"));
    expect(header).toContain("7⟳");
    expect(header).toContain("↑");
  });

  test("collapsed (non-expanded) running view still shows live stats (freeze is expanded-only)", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running";
    const r = {
      agent: "worker",

      progress,
      model: "test-model",
      usage: { turns: 7, input: 12_000, output: 3_000, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 9_000 },
      startTime: Date.now() - 90_000,
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false, // collapsed
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const header = texts.find((t) => t.includes("worker"));
    expect(header).toContain("7⟳");
    expect(header).toContain("↑");
  });

  test("expanded mode: renders lastThinking when output is empty (italic-wrapped)", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running";
    progress.lastThinking = "Analyzing the code...\nChecking for issues";
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      output: "",
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      true,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const markdownIdx = container.children.findIndex((c: unknown) => c instanceof Markdown);
    expect(markdownIdx).toBeGreaterThan(-1);
    // Non-output content is italic-wrapped to differentiate from real output
    const mdChild = container.children[markdownIdx] as { text?: string };
    expect(mdChild.text).toContain("*Analyzing the code...*" as string);
  });

  test("expanded mode: falls back to lastMessage when output and lastThinking are empty", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running";
    progress.lastMessage = "This is the last message";
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      output: "",
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      true,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const markdownIdx = container.children.findIndex((c: unknown) => c instanceof Markdown);
    expect(markdownIdx).toBeGreaterThan(-1);
  });

  test("does not render expanded content at depth > 0", () => {
    const progress = createDefaultProgress("worker", "do the thing", {});
    progress.status = "completed";
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      output: "Task completed successfully",
      usage: { turns: 1, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
      startTime: Date.now(),
      endTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      true,
      1,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    ); // depth=1
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const taskLabel = texts.find((t) => t === "Task:");
    expect(taskLabel).toBeUndefined();
  });

  test("suppressHeader=true skips header line", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "completed";
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
      SUPPRESS_HEADER,
      NO_COLLAPSED_TOOL_LIMIT,
    ); // suppressHeader
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const header = texts.find((t) => t.includes("worker") && t.includes("✓") && t.includes("0 tools"));
    expect(header).toBeUndefined();
  });

  test("renders preview markdown from output in collapsed mode (last 3 lines, live-scrolling)", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running";
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      output: "Line one\nLine two\nLine three\nLine four\nLine five",
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    ); // collapsed
    // Should have a Markdown child with the preview
    const hasMarkdown = container.children.some((c: unknown) => c instanceof Markdown);
    expect(hasMarkdown).toBe(true);
  });

  test("renders thinking preview when output is empty", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running";
    progress.lastThinking = "Analyzing the code...\nChecking for issues\nWriting a report";
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      output: undefined,
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    ); // collapsed
    const hasMarkdown = container.children.some((c: unknown) => c instanceof Markdown);
    expect(hasMarkdown).toBe(true);
  });

  test("preview line hidden in expanded mode (Markdown shown instead)", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running";
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      output: "Some output text",
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
    };
    const container = renderAgentProgress(r as unknown as SingleResult, mockTheme, true, 0, false, undefined); // expanded
    // In expanded mode, the preview Text element should NOT be present
    // (full markdown is shown instead via Markdown component)
    const previewText = container.children.find(
      (c: unknown) => c instanceof Text && (c as unknown as { text: string }).text.includes("Some output text"),
    );
    expect(previewText).toBeUndefined();
  });

  test("preview includes Spacer at depth=0", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running";
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      output: "thinking...",
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const hasSpacer = container.children.some((c: unknown) => c instanceof Spacer);
    // Full mode no longer uses Spacer — preview uses tree prefix instead
    expect(hasSpacer).toBe(false);
    const hasMarkdown = container.children.some((c: unknown) => c instanceof Markdown);
    expect(hasMarkdown).toBe(true);
  });

  test("preview omits Spacer at depth > 0", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running";
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      output: "thinking...",
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      1,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const spacers = container.children.filter((c: unknown) => c instanceof Spacer);
    expect(spacers.length).toBe(0);
    const hasMarkdown = container.children.some((c: unknown) => c instanceof Markdown);
    expect(hasMarkdown).toBe(true);
  });

  test("tool log: done status shows two-space prefix", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running";
    pushToolEvent(progress, { tool: "read", args: "src/foo.ts", toolCallId: "t1", status: "done" });
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const toolLine = texts.find((t) => t.includes("read"));
    expect(toolLine).toBeDefined();
    // Done status: → prefix (flat indent, no tree)
    expect(toolLine).toMatch(/^→ read: src\/foo\.ts/);
    expect(toolLine).not.toContain("✗");
  });

  test("tool log: error status shows ✗ prefix", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "running";
    pushToolEvent(progress, { tool: "bash", args: "npm test", toolCallId: "t1", status: "error" });
    const r = {
      agent: "worker",

      progress,
      model: undefined,
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as SingleResult,
      mockTheme,
      false,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const toolLine = texts.find((t) => t.includes("bash"));
    expect(toolLine).toBeDefined();
    // Error status: → prefix + "tool: args" format (color=error)
    expect(toolLine).toContain("→");
    expect(toolLine).toMatch(/→ bash: npm test/);
    expect(toolLine).not.toContain("▸");
  });

  test("tool log: compaction done shows compacting tool with args", () => {
    const progress = createDefaultProgress("worker", "test", {});
    progress.status = "completed";
    pushToolEvent(progress, { tool: "compacting", args: "threshold: 85k compacted", toolCallId: "c1", status: "done" });
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
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const toolLine = texts.find((t) => t.includes("compacting"));
    expect(toolLine).toBeDefined();
    // Compaction done: → prefix (flat indent, no tree)
    expect(toolLine).toMatch(/^→ compacting: threshold: 85k compacted/);
  });

  describe("collapsed tool log truncation", () => {
    test("single mode (depth=0, no limit): shows last 10 tools when not expanded", () => {
      const progress = createDefaultProgress("worker", "test", {});
      progress.status = "completed";
      // Push 15 tool events
      for (let i = 1; i <= 15; i++) {
        pushToolEvent(progress, { tool: "read", args: `file${i}.ts`, toolCallId: `t${i}`, status: "done" });
      }
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
      ); // not expanded, no explicit limit
      const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
      // Should show "... 5 earlier tools" (15 - 10 = 5)
      const skipped = texts.find((t) => t.includes("5 earlier tools"));
      expect(skipped).toBeDefined();
      // Should show tools 6–15 (last 10)
      const toolLines = texts.filter((t) => t.includes("read:"));
      expect(toolLines.length).toBe(10);
      expect(toolLines[0]).toContain("file6.ts");
      expect(toolLines[toolLines.length - 1]).toContain("file15.ts");
    });

    test("single mode (depth=0, no limit): shows all tools when expanded", () => {
      const progress = createDefaultProgress("worker", "test", {});
      progress.status = "completed";
      for (let i = 1; i <= 15; i++) {
        pushToolEvent(progress, { tool: "read", args: `file${i}.ts`, toolCallId: `t${i}`, status: "done" });
      }
      const r = {
        agent: "worker",

        progress,
        model: undefined,
        usage: { ...ZERO_USAGE },
        startTime: Date.now(),
        endTime: Date.now(),
      };
      const container = renderAgentProgress(r as unknown as SingleResult, mockTheme, true, 0, false, undefined); // expanded
      const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
      // No truncation message
      expect(texts.find((t) => t.includes("earlier tools"))).toBeUndefined();
      // All 15 tools shown
      const toolLines = texts.filter((t) => t.includes("read:"));
      expect(toolLines.length).toBe(15);
    });

    test("chain/parallel step (explicit limit=5): shows last 5 tools", () => {
      const progress = createDefaultProgress("worker", "test", {});
      progress.status = "completed";
      for (let i = 1; i <= 12; i++) {
        pushToolEvent(progress, { tool: "bash", args: `cmd${i}`, toolCallId: `t${i}`, status: "done" });
      }
      const r = {
        agent: "worker",

        progress,
        model: undefined,
        usage: { ...ZERO_USAGE },
        startTime: Date.now(),
        endTime: Date.now(),
      };
      const container = renderAgentProgress(r as unknown as SingleResult, mockTheme, false, 0, false, 5);
      const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
      // Should show "... 7 earlier tools" (12 - 5 = 7)
      const skipped = texts.find((t) => t.includes("7 earlier tools"));
      expect(skipped).toBeDefined();
      // Should show tools 8–12 (last 5)
      const toolLines = texts.filter((t) => t.includes("bash:"));
      expect(toolLines.length).toBe(5);
      expect(toolLines[0]).toContain("cmd8");
      expect(toolLines[toolLines.length - 1]).toContain("cmd12");
    });

    test("nested child (depth=1, no explicit limit): defaults to 5", () => {
      const progress = createDefaultProgress("worker", "test", {});
      progress.status = "completed";
      for (let i = 1; i <= 8; i++) {
        pushToolEvent(progress, { tool: "grep", args: `pattern${i}`, toolCallId: `t${i}`, status: "done" });
      }
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
        1,
        HEADER_VISIBLE,
        NO_COLLAPSED_TOOL_LIMIT,
      ); // depth=1, no explicit limit
      const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
      // Should show "... 3 earlier tools" (8 - 5 = 3)
      const skipped = texts.find((t) => t.includes("3 earlier tools"));
      expect(skipped).toBeDefined();
      // Should show tools 4–8 (last 5)
      const toolLines = texts.filter((t) => t.includes("grep:"));
      expect(toolLines.length).toBe(5);
      expect(toolLines[0]).toContain("pattern4");
    });

    test("no truncation when tool count <= limit", () => {
      const progress = createDefaultProgress("worker", "test", {});
      progress.status = "completed";
      for (let i = 1; i <= 10; i++) {
        pushToolEvent(progress, { tool: "read", args: `file${i}.ts`, toolCallId: `t${i}`, status: "done" });
      }
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
      ); // 10 tools, limit=10
      const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
      expect(texts.find((t) => t.includes("earlier tools"))).toBeUndefined();
      const toolLines = texts.filter((t) => t.includes("read:"));
      expect(toolLines.length).toBe(10);
    });
  });
});
