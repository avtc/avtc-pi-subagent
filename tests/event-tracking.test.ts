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

describe("event tracking helpers", () => {
  test("pushToolEvent caps at MAX_RECENT_TOOLS", () => {
    const progress = createDefaultProgress("worker", "test", {});
    for (let i = 0; i < MAX_RECENT_TOOLS + 10; i++) {
      pushToolEvent(progress, { tool: "read", args: `file${i}.ts`, toolCallId: `id${i}`, status: "running" });
    }
    expect(progress.recentTools.length).toBe(MAX_RECENT_TOOLS);
    expect(progress.toolCount).toBe(MAX_RECENT_TOOLS + 10);
    // Oldest evicted — last entry should be the most recent
    expect(progress.recentTools[MAX_RECENT_TOOLS - 1].toolCallId).toBe(`id${MAX_RECENT_TOOLS + 9}`);
  });

  test("findToolEventByCallId returns matching event", () => {
    const progress = createDefaultProgress("worker", "test", {});
    pushToolEvent(progress, { tool: "read", args: "foo.ts", toolCallId: "abc", status: "running" });
    const found = findToolEventByCallId(progress, "abc");
    expect(found).toBeDefined();
    expect(found?.tool).toBe("read");
  });

  test("findToolEventByCallId returns undefined for missing id", () => {
    const progress = createDefaultProgress("worker", "test", {});
    expect(findToolEventByCallId(progress, "nonexistent")).toBeUndefined();
  });

  test("findCompactingEvent returns running compaction", () => {
    const progress = createDefaultProgress("worker", "test", {});
    pushToolEvent(progress, { tool: "compacting", args: "threshold", status: "running" });
    const found = findCompactingEvent(progress);
    expect(found).toBeDefined();
    expect(found?.tool).toBe("compacting");
  });

  test("findCompactingEvent skips done compaction", () => {
    const progress = createDefaultProgress("worker", "test", {});
    pushToolEvent(progress, { tool: "compacting", args: "threshold", status: "done" });
    expect(findCompactingEvent(progress)).toBeUndefined();
  });

  test("extractChildrenFromResults returns AgentProgress array", () => {
    const results = [
      { progress: createDefaultProgress("scout", "recon", {}) },
      { progress: createDefaultProgress("researcher", "search", {}) },
    ];
    const children = extractChildrenFromResults(results);
    expect(children).toHaveLength(2);
    expect(children[0].agent).toBe("scout");
  });

  test("compaction_end is handled gracefully when start was evicted", () => {
    const progress = createDefaultProgress("worker", "test", {});
    // Push a compaction_start event
    pushToolEvent(progress, { tool: "compacting", args: "threshold", status: "running" });
    expect(findCompactingEvent(progress)).toBeDefined();

    // Fill the buffer to evict the compaction_start
    for (let i = 0; i < MAX_RECENT_TOOLS; i++) {
      pushToolEvent(progress, { tool: "read", args: `file${i}.ts`, toolCallId: `id${i}`, status: "done" });
    }
    // compaction_start is now evicted
    expect(findCompactingEvent(progress)).toBeUndefined();

    // Rendering should still work — no crash, compaction just not shown
    // (compaction_end handler skips silently when findCompactingEvent returns undefined)
    expect(progress.recentTools.length).toBeLessThanOrEqual(MAX_RECENT_TOOLS);
    expect(progress.toolCount).toBe(MAX_RECENT_TOOLS + 1); // +1 for the evicted compaction
  });

  test("extractChildrenFromResults filters undefined progress", () => {
    // Second entry has no `progress` key — must be filtered out by the impl
    const results: Array<{ progress?: ReturnType<typeof createDefaultProgress> }> = [
      { progress: createDefaultProgress("scout", "recon", {}) },
      {},
    ];
    const children = extractChildrenFromResults(results);
    expect(children).toHaveLength(1);
  });

  test("extractChildrenFromResults returns empty for empty input", () => {
    expect(extractChildrenFromResults([])).toEqual([]);
  });

  test("extractChildrenFromResults returns empty when all progress are undefined", () => {
    const results = [{ progress: undefined }, { progress: undefined }];
    const children = extractChildrenFromResults(results);
    expect(children).toEqual([]);
  });
});
