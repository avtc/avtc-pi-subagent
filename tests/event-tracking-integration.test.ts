// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";

const {
  createDefaultProgress,
  pushToolEvent,
  findToolEventByCallId,
  findCompactingEvent,
  extractChildrenFromResults,
  MAX_RECENT_TOOLS,
} = __internal;

describe("event tracking integration", () => {
  test("full lifecycle: pending → running → completed", () => {
    const progress = createDefaultProgress("worker", "implement feature X", {});
    expect(progress.status).toBe("pending");

    // First tool call transitions to running
    pushToolEvent(progress, { tool: "read", args: "src/foo.ts", toolCallId: "r1", status: "running" });
    expect(progress.status).toBe("pending"); // Status update happens in processLine, not pushToolEvent

    // Tool completes
    const event = findToolEventByCallId(progress, "r1");
    expect(event).toBeDefined();
    if (event) event.status = "done";

    expect(progress.recentTools).toHaveLength(1);
    expect(progress.recentTools[0].status).toBe("done");
  });

  test("compaction lifecycle: start → end with tokensBefore", () => {
    const progress = createDefaultProgress("worker", "test", {});
    pushToolEvent(progress, { tool: "compacting", args: "threshold", status: "running" });

    const compactEvent = findCompactingEvent(progress);
    expect(compactEvent).toBeDefined();

    if (compactEvent) {
      compactEvent.status = "done";
      compactEvent.args = "threshold: 85k compacted";
    }

    expect(findCompactingEvent(progress)).toBeUndefined(); // No longer running
  });

  test("compaction aborted with retry", () => {
    const progress = createDefaultProgress("worker", "test", {});
    pushToolEvent(progress, { tool: "compacting", args: "threshold", status: "running" });

    const compactEvent = findCompactingEvent(progress);
    if (compactEvent) {
      compactEvent.status = "error";
      compactEvent.args = "threshold: aborted (retrying…)";
    }

    // New compaction starts
    pushToolEvent(progress, { tool: "compacting", args: "threshold", status: "running" });
    expect(findCompactingEvent(progress)).toBeDefined();
  });

  test("nested children extraction from subagent results", () => {
    const childProgress = createDefaultProgress("scout", "find all TypeScript files", {});
    childProgress.status = "completed";

    const children = extractChildrenFromResults([{ progress: childProgress }]);
    expect(children).toHaveLength(1);
    expect(children[0].agent).toBe("scout");
    expect(children[0].status).toBe("completed");
  });

  test("recentTools eviction maintains toolCount", () => {
    const progress = createDefaultProgress("worker", "test", {});
    for (let i = 0; i < MAX_RECENT_TOOLS + 5; i++) {
      pushToolEvent(progress, { tool: "bash", args: `$ cmd${i}`, toolCallId: `c${i}`, status: "done" });
    }
    expect(progress.recentTools.length).toBe(MAX_RECENT_TOOLS);
    expect(progress.toolCount).toBe(MAX_RECENT_TOOLS + 5);
  });

  test("compaction start evicted before compaction_end", () => {
    const progress = createDefaultProgress("worker", "test", {});

    // Start a compaction
    pushToolEvent(progress, { tool: "compacting", args: "threshold", status: "running" });
    expect(findCompactingEvent(progress)).toBeDefined();

    // Fill recentTools to evict the compacting event
    for (let i = 0; i < MAX_RECENT_TOOLS; i++) {
      pushToolEvent(progress, { tool: "bash", args: `cmd${i}`, toolCallId: `evict${i}`, status: "done" });
    }

    // Compacting event should be evicted — compaction_end would skip gracefully
    expect(findCompactingEvent(progress)).toBeUndefined();
    // toolCount includes the compacting event + all bash events
    expect(progress.toolCount).toBe(MAX_RECENT_TOOLS + 1);
    // recentTools only holds MAX_RECENT_TOOLS
    expect(progress.recentTools.length).toBe(MAX_RECENT_TOOLS);
    // All remaining events are bash (compacting was evicted)
    expect(progress.recentTools.every((e) => e.tool === "bash")).toBe(true);
  });
});
