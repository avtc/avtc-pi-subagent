// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";

const {
  createDefaultProgress,
  pushToolEvent,
  getActiveNestedChild,
  mergePlaceholderIntoChildren,
  findToolEventByCallIdRecursive,
} = __internal;

describe("nested tool event routing", () => {
  test("getActiveNestedChild returns null when no subagent tool is running", () => {
    const parent = createDefaultProgress("worker", "task", {});
    parent.status = "running";
    pushToolEvent(parent, { tool: "bash", args: "npm test", toolCallId: "t1", status: "running" });
    expect(getActiveNestedChild(parent)).toBeNull();
  });

  test("getActiveNestedChild creates placeholder when subagent is running without children", () => {
    const parent = createDefaultProgress("worker", "task", {});
    parent.status = "running";
    pushToolEvent(parent, { tool: "subagent", args: "scout", toolCallId: "sub1", status: "running" });

    // No children yet — should create placeholder
    const child = getActiveNestedChild(parent);
    expect(child).not.toBeNull();
    if (!child) return;
    expect(child.agent).toBe("(nested)");
    expect(child.status).toBe("running");

    // Placeholder should be attached to subagent tool event
    const subTool = parent.recentTools.find((t) => t.tool === "subagent");
    if (!subTool?.children) return;
    expect(subTool.children).toHaveLength(1);
    expect(subTool.children[0]).toBe(child);
  });

  test("tool events routed to placeholder appear in parent's subagent children", () => {
    const parent = createDefaultProgress("worker", "task", {});
    parent.status = "running";
    pushToolEvent(parent, { tool: "subagent", args: "scout", toolCallId: "sub1", status: "running" });

    // Get placeholder child
    const child = getActiveNestedChild(parent);
    if (!child) {
      expect(child).not.toBeNull();
      return;
    }

    // Route tool event to child (simulating tool_execution_start)
    pushToolEvent(child, { tool: "ask_user_question", args: "favorite color?", toolCallId: "t1", status: "running" });

    // Parent should NOT have ask_user_question in its own tools
    expect(parent.recentTools.map((t) => t.tool)).toEqual(["subagent"]);
    expect(parent.toolCount).toBe(1);

    // Child should have the tool
    expect(child.recentTools.map((t) => t.tool)).toEqual(["ask_user_question"]);
    expect(child.toolCount).toBe(1);
  });

  test("mergePlaceholderIntoChildren merges buffered events into first real child", () => {
    const parent = createDefaultProgress("worker", "task", {});
    parent.status = "running";
    pushToolEvent(parent, { tool: "subagent", args: "scout", toolCallId: "sub1", status: "running" });

    // Get placeholder and buffer events
    const placeholder = getActiveNestedChild(parent);
    if (!placeholder) return;
    pushToolEvent(placeholder, { tool: "ask_user_question", args: "color?", toolCallId: "t1", status: "done" });
    pushToolEvent(placeholder, { tool: "bash", args: "ls", toolCallId: "t2", status: "running" });

    // Real child arrives from tool_execution_update
    const realChild = createDefaultProgress("scout", "find files", {});
    realChild.status = "running";
    pushToolEvent(realChild, { tool: "read", args: "foo.ts", toolCallId: "t3", status: "done" });

    const subTool = parent.recentTools.find((t) => t.tool === "subagent");
    if (!subTool) return;
    mergePlaceholderIntoChildren(subTool, [realChild]);

    // Real child should have buffered events prepended
    expect(realChild.recentTools.map((t) => t.tool)).toEqual([
      "ask_user_question", // from placeholder
      "bash", // from placeholder
      "read", // original
    ]);
    expect(realChild.toolCount).toBe(3);
  });

  test("findToolEventByCallIdRecursive finds events in nested children", () => {
    const parent = createDefaultProgress("worker", "task", {});
    parent.status = "running";
    pushToolEvent(parent, { tool: "subagent", args: "scout", toolCallId: "sub1", status: "running" });

    const child = getActiveNestedChild(parent);
    if (!child) return;
    pushToolEvent(child, { tool: "ask_user_question", args: "color?", toolCallId: "t1", status: "done" });

    // Should find tool in parent's own tools
    expect(findToolEventByCallIdRecursive(parent, "sub1")?.tool).toBe("subagent");

    // Should find tool in nested child's tools
    expect(findToolEventByCallIdRecursive(parent, "t1")?.tool).toBe("ask_user_question");

    // Should not find non-existent
    expect(findToolEventByCallIdRecursive(parent, "nonexistent")).toBeUndefined();
  });

  test("end-to-end: nested child tools not duplicated in parent", () => {
    const parent = createDefaultProgress("worker", "parent task", {});
    parent.status = "running";

    // 1. Parent calls subagent
    pushToolEvent(parent, { tool: "subagent", args: "scout", toolCallId: "sub1", status: "running" });

    // 2. Nested child fires tool events — route to active child
    const target = getActiveNestedChild(parent) || parent;
    pushToolEvent(target, { tool: "ask_user_question", args: "color?", toolCallId: "t1", status: "running" });

    const target2 = getActiveNestedChild(parent) || parent;
    pushToolEvent(target2, { tool: "bash", args: "ls", toolCallId: "t2", status: "done" });

    // 3. tool_execution_update brings real child
    const realChild = createDefaultProgress("scout", "find files", {});
    realChild.status = "running";
    const subTool = parent.recentTools.find((t) => t.tool === "subagent");
    if (!subTool) return;
    mergePlaceholderIntoChildren(subTool, [realChild]);
    subTool.children = [realChild];

    // Parent should only have subagent
    expect(parent.recentTools.map((t) => t.tool)).toEqual(["subagent"]);
    expect(parent.toolCount).toBe(1);

    // Real child should have the buffered tools
    expect(realChild.recentTools.map((t) => t.tool)).toEqual(["ask_user_question", "bash"]);
    expect(realChild.toolCount).toBe(2);
  });
});
