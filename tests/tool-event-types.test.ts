// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";

describe("ToolEvent and AgentProgress types", () => {
  test("MAX_RECENT_TOOLS is 50", () => {
    expect(__internal.MAX_RECENT_TOOLS).toBe(50);
  });

  test("createDefaultProgress returns pending state", () => {
    const progress = __internal.createDefaultProgress("worker", "do something", {});
    expect(progress).toEqual({
      agent: "worker",

      status: "pending",
      task: "do something",
      recentTools: [],
      toolCount: 0,
      lastMessage: "",
      contextWindow: undefined,
    });
  });

  test("createDefaultProgress for error early-return", () => {
    const progress = __internal.createDefaultProgress("worker", "do something", {
      status: "failed",
    });
    expect(progress.status).toBe("failed");
  });

  test("createDefaultProgress error field defaults to undefined", () => {
    const progress = __internal.createDefaultProgress("worker", "do something", {});
    expect(progress.error).toBeUndefined();
  });

  test("createDefaultProgress error field set via overrides", () => {
    const progress = __internal.createDefaultProgress("worker", "do something", {
      error: "Something went wrong",
    });
    expect(progress.error).toBe("Something went wrong");
    // Other fields should still have defaults
    expect(progress.status).toBe("pending");
    expect(progress.agent).toBe("worker");
  });

  test("createDefaultProgress status and error both overridden", () => {
    const progress = __internal.createDefaultProgress("worker", "do something", {
      status: "failed",
      error: "Command exited with code 1",
    });
    expect(progress.status).toBe("failed");
    expect(progress.error).toBe("Command exited with code 1");
  });
});
