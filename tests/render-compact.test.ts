// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";
import { DEFAULT_DEPTH, HEADER_VISIBLE, NO_COLLAPSED_TOOL_LIMIT } from "../src/rendering.js";
import type { SingleResult, SubagentDetails } from "../src/types.js";
import { collectText, mockTheme, ZERO_USAGE } from "./test-helpers.js";

/** Agent progress is not expanded (collapsed) */
const NOT_EXPANDED = false;

const {
  renderAgentProgress,
  renderResultImpl,
  createDefaultProgress,
  pushToolEvent,
  renderConfig,
  stripAnsi,
  stripMarkdownInline,
  extractLastMessageLine,
  truncateThemedLine,
} = __internal;

// These tests verify compact rendering mode
beforeEach(() => {
  renderConfig.mode = "compact";
});
afterEach(() => {
  renderConfig.mode = "compact";
});

function makeResult(overrides: Record<string, unknown> = {}): SingleResult {
  return {
    agent: "worker",

    task: "test task",
    exitCode: 0,
    stderr: "",
    usage: { ...ZERO_USAGE },
    model: undefined,
    stopReason: undefined,
    errorMessage: undefined,
    step: undefined,
    startTime: undefined,
    endTime: undefined,
    output: "",
    filesChanged: [],
    testsRan: false,
    ...overrides,
  } as unknown as SingleResult;
}

describe("compact rendering mode", () => {
  test("renders 3 lines per agent: header, tool, message", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "running";
    pushToolEvent(progress, { tool: "bash", args: "$ npm test", status: "running", toolCallId: "tc1" });
    progress.lastMessage = "I'll run the tests now.";

    const r = makeResult({ progress, output: "I'll run the tests now." });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    ); // collapsed
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });

    // Should have at least 3 lines: header, tool, message
    expect(texts.length).toBeGreaterThanOrEqual(3);

    // Line 1: header with agent name
    expect(texts[0]).toContain("worker");

    // Line 2: last tool
    expect(texts[1]).toContain("bash");

    // Line 3: last message
    expect(texts[2]).toContain("run the tests");
  });

  test("header includes model, turns, tools, tokens, timer", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "running";
    pushToolEvent(progress, { tool: "bash", args: "$ npm test", status: "done", toolCallId: "tc1" });
    pushToolEvent(progress, { tool: "edit", args: "src/fix.ts", status: "running", toolCallId: "tc2" });

    const r = makeResult({
      progress,
      model: "claude-sonnet",
      usage: {
        turns: 3,
        input: 12000,
        output: 5000,
        cacheRead: 200000,
        cacheWrite: 0,
        cost: 0.05,
        contextTokens: 15000,
      },
      startTime: Date.now() - 30000,
      endTime: Date.now(),
    });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const header = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> })[0];

    expect(header).toContain("worker");
    expect(header).toContain("claude-sonnet");
    expect(header).toContain("3"); // turns
    expect(header).toContain("2 tools");
    // Token/cost/duration parts may be trimmed on narrow terminals (80 cols)
    // Just verify at least some stats appear
    const hasStats = ["12k", "5.0k", "R200k", "$0.0500", "00:00:30"].some((s) => header.includes(s));
    expect(hasStats).toBe(true);
  });

  test("shows running spinner icon", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "running";
    const r = makeResult({ progress });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    // Header should start with a braille spinner character
    const header = texts[0];
    expect(header).toBeTruthy();
    // Spinner is one of the braille dots
    const spinnerChars = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807";
    expect(spinnerChars).toContain(header[0]);
  });

  test("shows completed checkmark", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "completed";
    const r = makeResult({ progress });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const header = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> })[0];
    expect(header).toContain("✓");
  });

  test("shows failed cross", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "failed";
    const r = makeResult({ progress, stopReason: "error" });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const header = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> })[0];
    expect(header).toContain("✗");
    expect(header).toContain("[error]");
  });

  test("last tool line shows → arrow for all statuses", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "running";
    pushToolEvent(progress, { tool: "bash", args: "$ npm test", status: "running", toolCallId: "tc1" });

    const r = makeResult({ progress });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const toolLine = texts[1];
    expect(toolLine).toContain("→");
    expect(toolLine).toContain("bash");
    expect(toolLine).toContain("npm test");

    // Also check done status uses → arrow
    const progress2 = createDefaultProgress("worker", "test task", {});
    progress2.status = "running";
    pushToolEvent(progress2, { tool: "edit", args: "src/fix.ts", status: "done", toolCallId: "tc1" });
    const r2 = makeResult({ progress: progress2 });
    const container2 = renderAgentProgress(r2, mockTheme, NOT_EXPANDED, 0, false, undefined);
    const toolLine2 = collectText(
      container2 as unknown as { children: Array<{ text?: string; children?: unknown[] }> },
    )[1];
    expect(toolLine2).toContain("→");
    expect(toolLine2).toContain("edit");

    // Error status also uses → arrow
    const progress3 = createDefaultProgress("worker", "test task", {});
    progress3.status = "running";
    pushToolEvent(progress3, { tool: "bash", args: "$ fail", status: "error", toolCallId: "tc1" });
    const r3 = makeResult({ progress: progress3 });
    const container3 = renderAgentProgress(r3, mockTheme, NOT_EXPANDED, 0, false, undefined);
    const toolLine3 = collectText(
      container3 as unknown as { children: Array<{ text?: string; children?: unknown[] }> },
    )[1];
    expect(toolLine3).toContain("→");
  });

  test("shows no tool line when running but no tools yet", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "running";

    const r = makeResult({ progress });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.some((t) => t.includes("→"))).toBe(false);
  });

  test("last message line extracted from output", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "running";
    pushToolEvent(progress, { tool: "bash", args: "$ npm test", status: "done", toolCallId: "tc1" });

    const r = makeResult({ progress, output: "First line\nSecond line\nThird line with important info" });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const msgLine = texts[2];
    expect(msgLine).toContain("Third line with important info");
  });

  test("falls back to lastThinking when no output", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "running";
    pushToolEvent(progress, { tool: "bash", args: "$ npm test", status: "done", toolCallId: "tc1" });
    progress.lastThinking = "Let me analyze the test results...";

    const r = makeResult({ progress, output: "" });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const msgLine = texts[2];
    expect(msgLine).toContain("analyze the test results");
  });

  test("context window shown in header", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "running";
    progress.contextWindow = 200000;

    const r = makeResult({
      progress,
      usage: { turns: 1, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 50000 },
    });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const header = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> })[0];
    expect(header).toContain("50k/200k");
  });

  test("error message shown on separate line for failed agent", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "failed";
    progress.error = "Process exited with code 1";

    const r = makeResult({ progress });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.some((t) => t.includes("Error: Process exited with code 1"))).toBe(true);
  });

  test("transient errorVisible renders the error live during a running agent", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "running"; // NOT failed — mid-run
    progress.errorVisible = true;
    const r = makeResult({ progress, errorMessage: "500 boom" });

    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.some((t) => t.includes("Error: 500 boom"))).toBe(true);
  });

  test("transient error hidden once errorVisible cleared (recovered, with thinking text)", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "running";
    progress.errorVisible = false; // cleared by the first delta of the recovered turn
    progress.lastThinking = "Okay, retrying the request...";
    const r = makeResult({ progress, errorMessage: "500 boom" });

    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.some((t) => t.includes("Error:"))).toBe(false);
  });

  test("hard failure (status failed, errorVisible unset) still renders the error", () => {
    // Regression guard: hard failures (inactivity/absolute kills) set errorMessage + status=failed
    // but never fire message_end, so errorVisible is never set — the status==='failed' term must
    // keep rendering the error.
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "failed";
    // errorVisible intentionally unset
    const r = makeResult({ progress, errorMessage: "Subagent killed after 600s of inactivity" });

    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.some((t) => t.includes("Error: Subagent killed after 600s of inactivity"))).toBe(true);
  });

  test("expanded mode still uses multi-line rendering regardless of renderConfig", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "completed";
    pushToolEvent(progress, { tool: "bash", args: "$ npm test", status: "done", toolCallId: "tc1" });
    pushToolEvent(progress, { tool: "edit", args: "src/fix.ts", status: "done", toolCallId: "tc2" });

    const r = makeResult({ progress, output: "All tests passed" });
    const container = renderAgentProgress(r, mockTheme, true, 0, false, undefined); // expanded
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });

    // Expanded mode should show full tool log (both tools), not compact 3-line
    expect(texts.some((t) => t.includes("npm test"))).toBe(true);
    expect(texts.some((t) => t.includes("src/fix.ts"))).toBe(true);
  });
});

describe("compact nested rendering", () => {
  test("nested child header shows model, turns, and elapsed time from AgentProgress fields", () => {
    const workerProgress = createDefaultProgress("worker", "task", {});
    workerProgress.status = "running";
    pushToolEvent(workerProgress, { tool: "bash", args: "$ npm test", status: "done", toolCallId: "tc1" });

    // Add nested child with model, usage, startTime set on AgentProgress
    const lastTool = workerProgress.recentTools[workerProgress.recentTools.length - 1];
    const scoutProgress = createDefaultProgress("researcher", "verify", {});
    scoutProgress.status = "running";
    scoutProgress.model = "test-provider/model-b";
    scoutProgress.usage = { turns: 12, input: 5000 };
    scoutProgress.startTime = Date.now() - 4200000; // 70 minutes ago
    pushToolEvent(scoutProgress, { tool: "read", args: "setup.ts", status: "done", toolCallId: "tc2" });
    lastTool.children = [scoutProgress];

    const r = makeResult({ progress: workerProgress });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const allText = texts.join("\n");

    // Nested child header should show model name
    expect(allText).toContain("test-provider/model-b");
    // Should show turns count (12⟳)
    expect(allText).toContain("12⟳");
    // Should show elapsed time (ticking while running)
    expect(allText).toContain("01:10:");
  });

  test("nested child transient errorVisible renders its error under the child header", () => {
    // : nested children apply the same transient-error logic. A grandchild's
    // mid-run error (errorVisible, status running) must render its red Error line under the
    // nested-child header, not just at top level. Guards against a future childToResult
    // mapping that drops errorVisible for nested children.
    const workerProgress = createDefaultProgress("worker", "task", {});
    workerProgress.status = "running";
    pushToolEvent(workerProgress, { tool: "bash", args: "$ npm test", status: "done", toolCallId: "tc1" });
    const lastTool = workerProgress.recentTools[workerProgress.recentTools.length - 1];

    // Nested child with a transient error (running, errorVisible, its own errorMessage).
    const childProgress = createDefaultProgress("researcher", "verify", {});
    childProgress.status = "running"; // NOT failed — mid-run
    childProgress.errorVisible = true;
    childProgress.error = "grandchild 503";
    pushToolEvent(childProgress, { tool: "read", args: "setup.ts", status: "done", toolCallId: "tc2" });
    lastTool.children = [childProgress];

    const r = makeResult({ progress: workerProgress });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.some((t) => t.includes("Error: grandchild 503"))).toBe(true);
  });

  test("nested child hard-failure (status failed + progress.error) renders its error", () => {
    // Sibling of the transient case above, but for the terminal-failure path: a nested child
    // with status='failed' (e.g. hard-killed). childToResult hardcodes errorMessage:undefined,
    // so nested rendering gets its error text ONLY from progress.error (the mirrored text).
    // The recursive getErrorLine gate must surface it for status='failed' too, not just errorVisible.
    const workerProgress = createDefaultProgress("worker", "task", {});
    workerProgress.status = "running";
    pushToolEvent(workerProgress, { tool: "bash", args: "$ npm test", status: "done", toolCallId: "tc1" });
    const lastTool = workerProgress.recentTools[workerProgress.recentTools.length - 1];

    const childProgress = createDefaultProgress("researcher", "verify", {});
    childProgress.status = "failed"; // terminal failure (e.g. hard-killed)
    childProgress.error = "Subagent killed after 600s of inactivity"; // mirrored onto progress.error
    pushToolEvent(childProgress, { tool: "read", args: "setup.ts", status: "done", toolCallId: "tc2" });
    lastTool.children = [childProgress];

    const r = makeResult({ progress: workerProgress });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    expect(texts.some((t) => t.includes("Error: Subagent killed after 600s of inactivity"))).toBe(true);
  });

  test("renders nested children with tree prefixes", () => {
    const workerProgress = createDefaultProgress("worker", "implement feature", {});
    workerProgress.status = "running";
    pushToolEvent(workerProgress, { tool: "bash", args: "$ npm test", status: "done", toolCallId: "tc1" });

    // Add nested child via tool event children
    const lastTool = workerProgress.recentTools[workerProgress.recentTools.length - 1];
    const scoutProgress = createDefaultProgress("scout", "research feature", {});
    scoutProgress.status = "running";
    pushToolEvent(scoutProgress, { tool: "grep", args: "/pattern/ in src/", status: "running", toolCallId: "tc2" });
    lastTool.children = [scoutProgress];

    const r = makeResult({ progress: workerProgress });
    const container = renderAgentProgress(
      r,
      mockTheme,
      NOT_EXPANDED,
      DEFAULT_DEPTH,
      HEADER_VISIBLE,
      NO_COLLAPSED_TOOL_LIMIT,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });

    // Should have both parent and child headers
    const allText = texts.join("\n");
    expect(allText).toContain("worker");
    expect(allText).toContain("scout");

    // Child should have tree-line prefix (├─ or └─)
    const childLines = texts.filter((t) => t.includes("scout"));
    expect(childLines.length).toBeGreaterThan(0);
    // The child header should contain a tree prefix character
    expect(childLines[0]).toMatch(/[├└]/);
  });
});

describe("compact renderResultImpl", () => {
  test("single mode renders compact agent progress", () => {
    const progress = createDefaultProgress("worker", "test task", {});
    progress.status = "running";
    pushToolEvent(progress, { tool: "bash", args: "$ npm test", status: "running", toolCallId: "tc1" });

    const result = {
      details: {
        mode: "single",
        results: [makeResult({ progress, output: "Running tests..." })],
      },
    };
    const container = renderResultImpl(
      result as unknown as {
        details?: SubagentDetails | undefined;
        content?: { type: string; text?: string | undefined }[] | undefined;
      },
      false,
      mockTheme,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    // Should have compact 3-line layout
    expect(texts[0]).toContain("worker");
    expect(texts[1]).toContain("bash");
  });

  test("parallel mode renders all agents compact", () => {
    const p1 = createDefaultProgress("reviewer-quality", "review quality", {});
    p1.status = "running";
    pushToolEvent(p1, { tool: "read", args: "src/a.ts", status: "done", toolCallId: "tc1" });

    const p2 = createDefaultProgress("reviewer-testing", "review tests", {});
    p2.status = "running";
    pushToolEvent(p2, { tool: "bash", args: "$ npm test", status: "running", toolCallId: "tc2" });

    const result = {
      details: {
        mode: "parallel",
        results: [
          makeResult({ progress: p1, output: "Reviewing..." }),
          makeResult({ progress: p2, output: "Testing..." }),
        ],
      },
    };
    const container = renderResultImpl(
      result as unknown as {
        details?: SubagentDetails | undefined;
        content?: { type: string; text?: string | undefined }[] | undefined;
      },
      false,
      mockTheme,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const allText = texts.join("\n");

    // Should contain both agents
    expect(allText).toContain("reviewer-quality");
    expect(allText).toContain("reviewer-testing");
  });
});

describe("helper functions", () => {
  test("stripAnsi removes ANSI escape sequences", () => {
    const colored = "\x1b[32m✓\x1b[0m worker";
    expect(stripAnsi(colored)).toBe("✓ worker");
  });

  test("stripMarkdownInline removes bold, italic, code, links", () => {
    expect(stripMarkdownInline("**bold**")).toBe("bold");
    expect(stripMarkdownInline("*italic*")).toBe("italic");
    expect(stripMarkdownInline("`code`")).toBe("code");
    expect(stripMarkdownInline("[link](http://example.com)")).toBe("link");
    expect(stripMarkdownInline("## Heading")).toBe("Heading");
    expect(stripMarkdownInline("> quote")).toBe("quote");
  });

  test("extractLastMessageLine returns last non-empty prose line", () => {
    expect(extractLastMessageLine("line1\nline2\nline3")).toBe("line3");
    expect(extractLastMessageLine("line1\n\nline3")).toBe("line3");
    expect(extractLastMessageLine("```js\ncode\n```\nprose")).toBe("prose");
    expect(extractLastMessageLine("")).toBe("");
  });

  test("truncateThemedLine truncates themed string to width", () => {
    // With mock theme (no ANSI), truncation is straightforward
    const long = "a".repeat(100);
    const result = truncateThemedLine(long, 20);
    expect(result.length).toBeLessThanOrEqual(21); // 20 + ellipsis
    expect(result).toContain("…");
  });

  test("truncateThemedLine preserves short strings", () => {
    const short = "hello world";
    const result = truncateThemedLine(short, 80);
    expect(result).toBe(short);
  });
});
