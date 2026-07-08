// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import os from "node:os";
import { describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";

const { extractToolArgsPreview } = __internal;
const HOME = os.homedir();

describe("extractToolArgsPreview", () => {
  test("bash: formats command with $ prefix", () => {
    const result = extractToolArgsPreview("bash", { command: "npm test" });
    expect(result).toBe("$ npm test");
  });

  test("bash: multi-line shows first line only", () => {
    const result = extractToolArgsPreview("bash", { command: "line1\nline2\nline3" });
    expect(result).toBe("$ line1 ... (+2 more lines)");
  });

  test("sanitizes child-controlled ANSI/OSC from the rendered preview", () => {
    // A hostile/buggy child embedding ANSI in a tool arg must not reach the operator terminal.
    const osc = "\x1b]8;;https://evil.example\x07";
    const csi = "\x1b[31m";
    expect(extractToolArgsPreview("bash", { command: `${csi}rm -rf${csi} ${osc}` })).not.toContain("\x1b");
    expect(extractToolArgsPreview("grep", { pattern: `${csi}evil${csi}` })).not.toContain("\x1b");
    expect(extractToolArgsPreview("subagent", { agent: `${osc}name` })).not.toContain("\x1b");
    // The default case uses JSON.stringify (already escapes C0); sanitize still leaves it clean:
    expect(extractToolArgsPreview("weird", { x: `${csi}` })).not.toContain("\x1b");
  });

  test("read: formats with path and line range", () => {
    const result = extractToolArgsPreview("read", { path: `${HOME}/src/foo.ts`, offset: 10, limit: 20 });
    expect(result).toContain("~/src/foo.ts");
    expect(result).toContain("10-29");
  });

  test("read: no offset/limit shows path only", () => {
    const result = extractToolArgsPreview("read", { path: "src/bar.ts" });
    expect(result).toBe("src/bar.ts");
  });

  test("write: formats with path and line count", () => {
    const result = extractToolArgsPreview("write", { path: "src/foo.ts", content: "a\nb\nc" });
    expect(result).toBe("src/foo.ts (3 lines)");
  });

  test("edit: formats with path", () => {
    const result = extractToolArgsPreview("edit", { path: "src/foo.ts" });
    expect(result).toBe("src/foo.ts");
  });

  test("find: formats with pattern and path", () => {
    const result = extractToolArgsPreview("find", { pattern: "*.ts", path: "src" });
    expect(result).toBe("*.ts in src");
  });

  test("ls: formats with path", () => {
    const result = extractToolArgsPreview("ls", { path: "src/components" });
    expect(result).toBe("src/components");
  });

  test("grep: formats with pattern and path", () => {
    const result = extractToolArgsPreview("grep", { pattern: "TODO", path: "src" });
    expect(result).toBe("/TODO/ in src");
  });

  test("subagent: formats with agent name", () => {
    const result = extractToolArgsPreview("subagent", { agent: "scout", task: "do stuff" });
    expect(result).toBe("scout");
  });

  test("unknown tool: falls back to JSON preview", () => {
    const result = extractToolArgsPreview("custom_tool", { key: "value" });
    expect(result).toContain("key");
    expect(result).not.toContain("custom_tool");
  });

  test("truncates to 4000 chars", () => {
    const longContent = "x".repeat(5000);
    const result = extractToolArgsPreview("bash", { command: longContent });
    expect(result.length).toBeLessThanOrEqual(4100); // "$ " prefix + 4000 + "... +N more lines"
  });

  test("write: handles missing content gracefully", () => {
    const result = extractToolArgsPreview("write", { path: "src/foo.ts" });
    expect(result).toBe("src/foo.ts");
  });

  test("uses file_path fallback when path is absent", () => {
    const result = extractToolArgsPreview("read", { file_path: `${HOME}/src/bar.ts` });
    expect(result).toContain("~/src/bar.ts");
  });

  // Empty / missing args edge cases
  test("bash: empty command string", () => {
    const result = extractToolArgsPreview("bash", { command: "" });
    expect(result).toBe("$ ...");
  });

  test("bash: missing command key", () => {
    const result = extractToolArgsPreview("bash", {});
    expect(result).toBe("$ ...");
  });

  test("read: missing both path and file_path", () => {
    const result = extractToolArgsPreview("read", {});
    expect(result).toBe("...");
  });

  test("write: empty content", () => {
    const result = extractToolArgsPreview("write", { path: "out.ts", content: "" });
    expect(result).toBe("out.ts");
  });

  test("write: single-line content shows preview", () => {
    const result = extractToolArgsPreview("write", { path: "src/hello.ts", content: "export const hello = 'world';" });
    expect(result).toBe("src/hello.ts: export const hello = 'world';");
  });

  test("write: single-line content truncated at 60 chars", () => {
    const longLine = "x".repeat(80);
    const result = extractToolArgsPreview("write", { path: "out.ts", content: longLine });
    expect(result).toBe(`out.ts: ${"x".repeat(57)}...`);
    expect(result.length).toBeLessThan(80);
  });

  test("edit: missing both path and file_path", () => {
    const result = extractToolArgsPreview("edit", {});
    expect(result).toBe("...");
  });

  test("ls: missing path defaults to", () => {
    const result = extractToolArgsPreview("ls", {});
    expect(result).toBe(".");
  });

  test("find: missing pattern defaults to *", () => {
    const result = extractToolArgsPreview("find", { path: "src" });
    expect(result).toBe("* in src");
  });

  test("grep: empty pattern", () => {
    const result = extractToolArgsPreview("grep", { path: "src" });
    expect(result).toBe("// in src");
  });

  test("subagent: missing agent name", () => {
    const result = extractToolArgsPreview("subagent", { task: "do stuff" });
    expect(result).toBe("...");
  });
});
