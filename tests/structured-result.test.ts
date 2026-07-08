// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";
import type { SingleResult, ThemeLike } from "../src/types.js";
import { collectText, mockTheme, ZERO_USAGE } from "./test-helpers.js";

/** Agent progress is not expanded (collapsed) */
const NOT_EXPANDED = false;

const { isTestCommand, createDefaultProgress, pushToolEvent, renderAgentProgress } = __internal;

// These tests verify multi-line (original) rendering mode
beforeEach(() => {
  __internal.renderConfig.mode = "multi-line";
});

afterEach(() => {
  __internal.renderConfig.mode = "compact";
});

describe("subagent structured result fields", () => {
  test("filesChanged deduplicates paths via Set", () => {
    const filesChangedSet = new Set<string>();
    filesChangedSet.add("src/a.ts");
    filesChangedSet.add("src/a.ts"); // duplicate
    filesChangedSet.add("src/b.ts");
    expect(Array.from(filesChangedSet)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("isTestCommand detects test commands", () => {
    expect(isTestCommand("npx vitest run")).toBe(true);
    expect(isTestCommand("npm test")).toBe(true);
    expect(isTestCommand("pnpm test --reporter=verbose")).toBe(true);
    expect(isTestCommand("echo hello")).toBe(false);
    expect(isTestCommand("npm run build")).toBe(false);
  });

  test("result with output renders in expanded view", () => {
    const progress = createDefaultProgress("worker", "implement feature", {});
    progress.status = "completed";
    const r = {
      agent: "worker",

      task: "implement feature",
      progress,
      output: "Created 3 files and fixed 2 bugs",
      filesChanged: ["src/a.ts", "src/b.ts", "src/c.ts"],
      testsRan: true,
      exitCode: 0,
      stderr: "",
      usage: { turns: 2, input: 5000, output: 2000, cacheRead: 0, cacheWrite: 0, cost: 0.05, contextTokens: 15000 },
      startTime: Date.now() - 60000,
      endTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as unknown as SingleResult,
      mockTheme as unknown as ThemeLike,
      true,
      0,
      false,
      undefined,
    ); // expanded
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const allText = texts.join("\n");
    // Expanded view should show output
    expect(allText).toContain("Created 3 files and fixed 2 bugs");
    // Header should show completed status
    expect(allText).toContain("✓");
    expect(allText).toContain("worker");
  });

  test("result with filesChanged and testsRan tracks correctly", () => {
    const progress = createDefaultProgress("worker", "fix bug", {});
    progress.status = "completed";
    pushToolEvent(progress, { tool: "bash", args: "$ npm test", toolCallId: "t1", status: "done" });
    pushToolEvent(progress, { tool: "write", args: "src/fix.ts", toolCallId: "t2", status: "done" });

    const r = {
      agent: "worker",

      task: "fix bug",
      progress,
      filesChanged: ["src/fix.ts"],
      testsRan: true,
      exitCode: 0,
      stderr: "",
      usage: { turns: 1, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 5000 },
      startTime: Date.now() - 30000,
      endTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as unknown as SingleResult,
      mockTheme as unknown as ThemeLike,
      NOT_EXPANDED,
      0,
      false,
      undefined,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const allText = texts.join("\n");
    // Tool log should show both tools
    expect(allText).toContain("npm test");
    expect(allText).toContain("src/fix.ts");
    expect(allText).toContain("2 tools");
  });

  test("result with stopReason error shows error details", () => {
    const progress = createDefaultProgress("worker", "failing task", {});
    progress.status = "failed";
    const r = {
      agent: "worker",

      task: "failing task",
      progress,
      stopReason: "error",
      errorMessage: "Process exited with code 1",
      exitCode: 1,
      stderr: "error: something failed",
      usage: { ...ZERO_USAGE },
      startTime: Date.now(),
      endTime: Date.now(),
    };
    const container = renderAgentProgress(
      r as unknown as unknown as SingleResult,
      mockTheme as unknown as ThemeLike,
      NOT_EXPANDED,
      0,
      false,
      undefined,
    );
    const texts = collectText(container as unknown as { children: Array<{ text?: string; children?: unknown[] }> });
    const allText = texts.join("\n");
    expect(allText).toContain("✗");
    expect(allText).toContain("[error]");
  });
});
