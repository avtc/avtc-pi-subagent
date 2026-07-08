// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";

const { extractLastMessage } = __internal;

describe("extractLastMessage", () => {
  test("extracts text from assistant message content", () => {
    const result = extractLastMessage({
      content: [{ type: "text", text: "I found the issue in the code." }],
    });
    expect(result).toBe("I found the issue in the code.");
  });

  test("strips fenced code blocks", () => {
    const result = extractLastMessage({
      content: [{ type: "text", text: "Here's the fix:\n```ts\nconst x = 1;\n```\nThat should work." }],
    });
    expect(result).toBe("Here's the fix: That should work.");
  });

  test("returns last 3 non-empty prose lines joined with space", () => {
    const text = "Line one.\nLine two.\nLine three.\nLine four.\nLine five.";
    const result = extractLastMessage({
      content: [{ type: "text", text }],
    });
    expect(result).toBe("Line three. Line four. Line five.");
  });

  test("truncates to 200 characters", () => {
    const text = "x".repeat(300);
    const result = extractLastMessage({
      content: [{ type: "text", text }],
    });
    expect(result.length).toBeLessThanOrEqual(200);
  });

  test("returns empty string when no text content parts", () => {
    const result = extractLastMessage({
      content: [{ type: "toolCall" }],
    });
    expect(result).toBe("");
  });

  test("concatenates multiple text parts", () => {
    const result = extractLastMessage({
      content: [
        { type: "text", text: "First part." },
        { type: "text", text: "Second part." },
      ],
    });
    expect(result).toContain("First part.");
    expect(result).toContain("Second part.");
  });

  test("handles code block with language tag", () => {
    const result = extractLastMessage({
      content: [{ type: "text", text: "Before.\n```typescript\nconst x: number = 1;\n```\nAfter." }],
    });
    expect(result).toBe("Before. After.");
  });

  test("handles multiple sequential code blocks", () => {
    const result = extractLastMessage({
      content: [{ type: "text", text: "Intro\n```js\nlet a = 1;\n```\nMiddle text\n```py\nb = 2\n```\nConclusion" }],
    });
    expect(result).toBe("Intro Middle text Conclusion");
  });

  test("handles unclosed code block (rest is discarded)", () => {
    const result = extractLastMessage({
      content: [{ type: "text", text: "Start\n```\nthis is inside unclosed block\nstill inside" }],
    });
    expect(result).toBe("Start");
  });

  test("handles indented code fence (leading whitespace)", () => {
    const result = extractLastMessage({
      content: [{ type: "text", text: "Before\n  ```\n  code\n  ```\nAfter" }],
    });
    expect(result).toBe("Before After");
  });

  test("does not treat inline single backticks as code fences", () => {
    const result = extractLastMessage({
      content: [{ type: "text", text: "Use `code` and `more` in text" }],
    });
    expect(result).toBe("Use `code` and `more` in text");
  });

  test("does not treat double backticks as code fences", () => {
    const result = extractLastMessage({
      content: [{ type: "text", text: "Use ``code`` here" }],
    });
    expect(result).toBe("Use ``code`` here");
  });
});
