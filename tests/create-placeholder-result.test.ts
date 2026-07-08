// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";

const { createPlaceholderResult } = __internal;

describe("createPlaceholderResult", () => {
  test("creates result with required fields and sensible defaults", () => {
    const r = createPlaceholderResult({
      agent: "worker",
      task: "do something",
    });
    expect(r.agent).toBe("worker");
    expect(r.task).toBe("do something");
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.model).toBeUndefined();
    expect(r.step).toBeUndefined();
    expect(r.startTime).toBeGreaterThan(0);
    expect(r.endTime).toBeUndefined();
    expect(r.output).toBe("");
    expect(r.filesChanged).toEqual([]);
    expect(r.testsRan).toBe(false);
    expect(r.progress).toBeDefined();
    expect(r.progress.agent).toBe("worker");
    expect(r.progress.status).toBe("pending");
  });

  test("applies optional overrides", () => {
    const now = Date.now();
    const r = createPlaceholderResult({
      agent: "scout",
      task: "search",
      exitCode: 1,
      stderr: "oops",
      model: "claude-sonnet-4",
      step: 2,
      startTime: now,
      endTime: now + 1000,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("oops");
    expect(r.model).toBe("claude-sonnet-4");
    expect(r.step).toBe(2);
    expect(r.startTime).toBe(now);
    expect(r.endTime).toBe(now + 1000);
  });

  test("passes progressOverrides to createDefaultProgress", () => {
    const r = createPlaceholderResult({
      agent: "worker",
      task: "fail",
      progressOverrides: { status: "failed", error: "boom" },
    });
    expect(r.progress.status).toBe("failed");
    expect(r.progress.error).toBe("boom");
  });

  test("usage is a fresh copy of ZERO_USAGE", () => {
    const r1 = createPlaceholderResult({
      agent: "a",
      task: "t1",
    });
    const r2 = createPlaceholderResult({
      agent: "b",
      task: "t2",
    });
    // Mutating one usage should not affect the other
    r1.usage.input = 999;
    expect(r2.usage.input).toBe(0);
  });
});
