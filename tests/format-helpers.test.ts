// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";
import { DEFAULT_MAX_PROSE_LINES } from "../src/progress-tracking.js";

const { formatTokens, formatDuration, truncateTask, extractLastProseLines, sanitizeMarkdownPreview, isCodeFence } =
  __internal;

describe("formatTokens", () => {
  test("0 returns '0'", () => {
    expect(formatTokens(0)).toBe("0");
  });

  test("999 returns '999' (below 1k threshold)", () => {
    expect(formatTokens(999)).toBe("999");
  });

  test("1000 returns '1.0k' (exact 1k boundary)", () => {
    expect(formatTokens(1000)).toBe("1.0k");
  });

  test("1500 returns '1.5k'", () => {
    expect(formatTokens(1500)).toBe("1.5k");
  });

  test("9999 returns '10.0k' (just below 10k)", () => {
    expect(formatTokens(9999)).toBe("10.0k");
  });

  test("10000 returns '10k' (exact 10k boundary, no decimal)", () => {
    expect(formatTokens(10000)).toBe("10k");
  });

  test("500000 returns '500k'", () => {
    expect(formatTokens(500000)).toBe("500k");
  });

  test("999999 returns '1000k' (just below 1M)", () => {
    expect(formatTokens(999999)).toBe("1000k");
  });

  test("1000000 returns '1.0M' (exact 1M boundary)", () => {
    expect(formatTokens(1000000)).toBe("1.0M");
  });

  test("2500000 returns '2.5M'", () => {
    expect(formatTokens(2500000)).toBe("2.5M");
  });
});

describe("formatDuration", () => {
  test("0ms returns '00:00:00'", () => {
    expect(formatDuration(0)).toBe("00:00:00");
  });

  test("999ms returns '00:00:00' (just below 1s)", () => {
    expect(formatDuration(999)).toBe("00:00:00");
  });

  test("1000ms returns '00:00:01' (exact 1s)", () => {
    expect(formatDuration(1000)).toBe("00:00:01");
  });

  test("59000ms returns '00:00:59'", () => {
    expect(formatDuration(59000)).toBe("00:00:59");
  });

  test("60000ms returns '00:01:00' (exact 1min)", () => {
    expect(formatDuration(60000)).toBe("00:01:00");
  });

  test("3599000ms returns '00:59:59'", () => {
    expect(formatDuration(3599000)).toBe("00:59:59");
  });

  test("3600000ms returns '01:00:00' (exact 1hr)", () => {
    expect(formatDuration(3600000)).toBe("01:00:00");
  });

  test("3661000ms returns '01:01:01' (1hr 1min 1s)", () => {
    expect(formatDuration(3661000)).toBe("01:01:01");
  });

  test("86400000ms returns '24:00:00' (1 day)", () => {
    expect(formatDuration(86400000)).toBe("24:00:00");
  });
});

describe("truncateTask", () => {
  test("expanded returns full task", () => {
    expect(truncateTask("short task", true)).toBe("short task");
  });

  test("expanded returns full long multiline task", () => {
    const long = `First line\nSecond line\nThird line very long ${"x".repeat(200)}`;
    expect(truncateTask(long, true)).toBe(long);
  });

  test("collapsed returns first line when multiline", () => {
    expect(truncateTask("First line\nSecond line", false)).toBe("First line");
  });

  test("collapsed does not truncate long first line (TUI wraps)", () => {
    const long = "A".repeat(300);
    expect(truncateTask(long, false)).toBe(long);
  });

  test("collapsed returns full single line", () => {
    const single = "Just one line";
    expect(truncateTask(single, false)).toBe(single);
  });

  test("collapsed returns empty string for empty task", () => {
    expect(truncateTask("", false)).toBe("");
  });
});

describe("extractLastProseLines", () => {
  test("returns last 3 non-empty lines", () => {
    const text = "Line1\nLine2\nLine3\nLine4\nLine5";
    expect(extractLastProseLines(text, DEFAULT_MAX_PROSE_LINES)).toBe("Line3\nLine4\nLine5");
  });

  test("returns fewer lines when less than 3", () => {
    const text = "Line1\nLine2";
    expect(extractLastProseLines(text, DEFAULT_MAX_PROSE_LINES)).toBe("Line1\nLine2");
  });

  test("skips empty lines", () => {
    const text = "Line1\n\nLine2\n\nLine3\n\nLine4";
    expect(extractLastProseLines(text, DEFAULT_MAX_PROSE_LINES)).toBe("Line2\nLine3\nLine4");
  });

  test("strips fenced code blocks", () => {
    const text = "Prose line\n```\ncode line1\ncode line2\n```\nAnother prose\nThird prose";
    expect(extractLastProseLines(text, DEFAULT_MAX_PROSE_LINES)).toBe("Prose line\nAnother prose\nThird prose");
  });

  test("returns empty string when only code blocks", () => {
    const text = "```\ncode line\n```\n```\nanother code\n```";
    expect(extractLastProseLines(text, DEFAULT_MAX_PROSE_LINES)).toBe("");
  });

  test("returns empty string for empty input", () => {
    expect(extractLastProseLines("", 3)).toBe("");
  });

  test("custom maxLines", () => {
    const text = "A\nB\nC\nD\nE";
    expect(extractLastProseLines(text, 2)).toBe("D\nE");
  });
});

describe("sanitizeMarkdownPreview", () => {
  test("returns text unchanged when no open code fence", () => {
    expect(sanitizeMarkdownPreview("Hello\nWorld")).toBe("Hello\nWorld");
  });

  test("closes single open code fence", () => {
    const text = "Line\n```\nstill in code";
    expect(sanitizeMarkdownPreview(text)).toBe("Line\n```\nstill in code\n```");
  });

  test("does not close matched code fence", () => {
    const text = "Before\n```\ncode\n```\nAfter";
    expect(sanitizeMarkdownPreview(text)).toBe(text);
  });

  test("closes nested open code fence", () => {
    const text = "```\n```\nouter code\nstill open";
    // First ``` opens, second ``` closes, so no open fence
    expect(sanitizeMarkdownPreview(text)).toBe(text);
  });

  test("closes triple open code fence", () => {
    const text = "```\n````\n```\nopen";
    // First ``` opens, second ``` closes, third ``` opens again
    expect(sanitizeMarkdownPreview(text)).toBe(`${text}\n\`\`\``);
  });
});

describe("isCodeFence", () => {
  test("detects plain fence", () => {
    expect(isCodeFence("```")).toBe(true);
  });

  test("detects fence with language identifier", () => {
    expect(isCodeFence("```typescript")).toBe(true);
    expect(isCodeFence("```python")).toBe(true);
  });

  test("ignores leading whitespace", () => {
    expect(isCodeFence("  ```")).toBe(true);
    expect(isCodeFence("\t```ts")).toBe(true);
  });

  test("returns false for non-fence lines", () => {
    expect(isCodeFence("some text")).toBe(false);
    expect(isCodeFence("```text")).toBe(true);
    expect(isCodeFence("`` text")).toBe(false);
    expect(isCodeFence('"""""" text')).toBe(false);
  });

  test("returns false for empty line", () => {
    expect(isCodeFence("")).toBe(false);
  });
});

describe("sanitizeMarkdownPreview with language fences", () => {
  test("handles language-identified fences correctly", () => {
    expect(sanitizeMarkdownPreview("```")).toBe("```\n```");
    expect(sanitizeMarkdownPreview("```python")).toBe("```python\n```");
    const matched = "```ts\ncode\n```";
    expect(sanitizeMarkdownPreview(matched)).toBe(matched); // matched, no close needed
  });

  test("handles 4-backtick fences", () => {
    // ```` opens, ```` closes — matched, no close needed
    const matched = "````\ncode\n````";
    expect(sanitizeMarkdownPreview(matched)).toBe(matched);
  });
});

describe("thinking preview with open code fences", () => {
  test("sanitizes thinking content with open code fence", () => {
    const thinking = "Analyzing code...\n```\ncode snippet\nmore analysis";
    const sanitized = sanitizeMarkdownPreview(thinking);
    // sanitizeMarkdownPreview adds a closing fence when an open one is detected
    expect(sanitized).toBe("Analyzing code...\n```\ncode snippet\nmore analysis\n```");
  });
});
