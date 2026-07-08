// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";
import { mockTheme } from "./test-helpers.js";

const { renderCallImpl } = __internal;

describe("renderCall streaming", () => {
  test("single mode returns Text with agent name and scope only", () => {
    const result = renderCallImpl(
      { agent: "worker", task: "Implement the new feature and write tests for it" },
      mockTheme,
      { expanded: false },
    );
    expect(result).toBeInstanceOf(Text);
    const text = (result as unknown as { text: string }).text;
    expect(text).toContain("worker");
    // Task must NOT appear in renderCall — it's rendered per-subagent in renderResult
    expect(text).not.toContain("Implement");
  });

  test("single mode does not truncate or include task text", () => {
    const longTask = "A".repeat(80);
    const result = renderCallImpl({ agent: "worker", task: longTask }, mockTheme, { expanded: false });
    expect(result).toBeInstanceOf(Text);
    const text = (result as unknown as { text: string }).text;
    expect(text).not.toContain("A".repeat(80));
    expect(text).not.toContain("AAA...");
  });

  test("single mode expanded returns Text (not Container), agent only", () => {
    const result = renderCallImpl({ agent: "worker", task: "Do the full task body here" }, mockTheme, {
      expanded: true,
    });
    expect(result).toBeInstanceOf(Text);
    const text = (result as unknown as { text: string }).text;
    expect(text).toContain("worker");
    expect(text).not.toContain("Do the full task body here");
  });

  test("single mode expanded without task still shows agent", () => {
    const result = renderCallImpl({ agent: "worker" }, mockTheme, { expanded: true });
    expect(result).toBeInstanceOf(Text);
    const text = (result as unknown as { text: string }).text;
    expect(text).toContain("worker");
    expect(text).not.toContain("undefined");
  });

  test("parallel mode returns Text with task count only", () => {
    const result = renderCallImpl(
      {
        tasks: [
          { agent: "reviewer-quality", task: "Review code quality" },
          { agent: "reviewer-testing", task: "Review test coverage" },
        ],
      },
      mockTheme,
      {},
    );
    expect(result).toBeInstanceOf(Text);
    const text = (result as unknown as { text: string }).text;
    expect(text).toContain("parallel (2 tasks)");
    // Agent names and task text must NOT appear in renderCall
    expect(text).not.toContain("reviewer-quality");
    expect(text).not.toContain("Review");
  });

  test("chain mode returns Text with step count only", () => {
    const result = renderCallImpl(
      {
        chain: [
          { agent: "scout", task: "Find relevant files {previous}" },
          { agent: "worker", task: "Implement fix {previous}" },
        ],
      },
      mockTheme,
      {},
    );
    expect(result).toBeInstanceOf(Text);
    const text = (result as unknown as { text: string }).text;
    expect(text).toContain("chain (2 steps)");
    // Agent names and step details must NOT appear in renderCall
    expect(text).not.toContain("scout");
    expect(text).not.toContain("worker");
    expect(text).not.toContain("{previous}");
  });

  test("chain >3 steps shows count only, no truncation markers", () => {
    const result = renderCallImpl(
      {
        chain: [
          { agent: "scout", task: "Step 1" },
          { agent: "worker", task: "Step 2" },
          { agent: "reviewer", task: "Step 3" },
          { agent: "scout", task: "Step 4" },
          { agent: "worker", task: "Step 5" },
        ],
      },
      mockTheme,
      {},
    );
    expect(result).toBeInstanceOf(Text);
    const text = (result as unknown as { text: string }).text;
    expect(text).toContain("chain (5 steps)");
    // No numbered steps or truncation markers
    expect(text).not.toContain("1.");
    expect(text).not.toContain("+2 more");
  });

  test("parallel >3 tasks shows count only, no truncation markers", () => {
    const result = renderCallImpl(
      {
        tasks: [
          { agent: "reviewer-quality", task: "Quality review" },
          { agent: "reviewer-testing", task: "Testing review" },
          { agent: "reviewer-requirements", task: "Requirements review" },
          { agent: "reviewer-security", task: "Security review" },
          { agent: "reviewer-style", task: "Style review" },
        ],
      },
      mockTheme,
      {},
    );
    expect(result).toBeInstanceOf(Text);
    const text = (result as unknown as { text: string }).text;
    expect(text).toContain("parallel (5 tasks)");
    // No individual agents or truncation markers
    expect(text).not.toContain("reviewer-quality");
    expect(text).not.toContain("+2 more");
  });

  test("parallel exactly 3 tasks shows count only, no truncation", () => {
    const result = renderCallImpl(
      {
        tasks: [
          { agent: "reviewer-quality", task: "Quality review" },
          { agent: "reviewer-testing", task: "Testing review" },
          { agent: "reviewer-requirements", task: "Requirements review" },
        ],
      },
      mockTheme,
      {},
    );
    expect(result).toBeInstanceOf(Text);
    const text = (result as unknown as { text: string }).text;
    expect(text).toContain("parallel (3 tasks)");
    // No individual agent names
    expect(text).not.toContain("reviewer-quality");
    expect(text).not.toContain("more");
  });
});
