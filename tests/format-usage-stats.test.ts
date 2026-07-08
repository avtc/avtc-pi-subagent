// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";

const { formatUsageStats } = __internal;

describe("formatUsageStats", () => {
  const baseUsage = {
    input: 1000,
    output: 500,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.01,
    contextTokens: 21000,
  };

  test("includes context gauge with contextWindow denominator", () => {
    const result = formatUsageStats(baseUsage, undefined, undefined, 200000);
    expect(result).toContain("ctx:21k/200k");
  });

  test("includes context gauge without denominator when contextWindow undefined", () => {
    const result = formatUsageStats(baseUsage, undefined, undefined, undefined);
    expect(result).toContain("ctx:21k");
    expect(result).not.toContain("ctx:21k/");
  });

  test("omits context gauge when contextTokens is 0", () => {
    const result = formatUsageStats({ ...baseUsage, contextTokens: 0 }, undefined, undefined, 200000);
    expect(result).not.toContain("ctx:");
  });

  test("omits context gauge when contextTokens is undefined", () => {
    const usage = { ...baseUsage } as Record<string, unknown>;
    delete usage.contextTokens;
    const result = formatUsageStats(
      usage as unknown as {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
        contextTokens?: number | undefined;
        turns?: number | undefined;
      },
      undefined,
      undefined,
      200000,
    );
    expect(result).not.toContain("ctx:");
  });

  test("includes turns when provided", () => {
    const result = formatUsageStats({ ...baseUsage, turns: 3 }, "gpt-4", 45000, 200000);
    expect(result).toContain("3 turns");
  });

  test("includes model name when provided", () => {
    const result = formatUsageStats(baseUsage, "claude-3-opus", undefined, undefined);
    expect(result).toContain("claude-3-opus");
  });

  test("formats duration when elapsedMs provided", () => {
    const result = formatUsageStats(baseUsage, undefined, 90000, undefined);
    expect(result).toContain("00:01:30");
  });

  test("formats small token counts without k suffix", () => {
    const usage = { ...baseUsage, contextTokens: 500 };
    const result = formatUsageStats(usage, undefined, undefined, 4000);
    expect(result).toContain("ctx:500/4.0k");
  });

  test("formats large contextWindow with k suffix", () => {
    const result = formatUsageStats(baseUsage, undefined, undefined, 128000);
    expect(result).toContain("ctx:21k/128k");
  });
});
