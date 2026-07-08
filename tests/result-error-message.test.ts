// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";
import { createDefaultProgress } from "../src/progress-tracking.js";
/**
 * Unit tests for resultErrorMessage — the consumption-boundary sanitizer for failed-subagent
 * error text. The raw child stderr pipe accumulates unsanitized during the run; resultErrorMessage
 * is the single point where stderr (or errorMessage/output) becomes operator-visible, so it
 * sanitizes per-line (preserving multi-line structure) at completion.
 */
import type { SingleResult } from "../src/types.js";

const { resultErrorMessage, isResultError, parallelFailedReason } = __internal;

/** Minimal SingleResult-shaped object for the helper (it only reads errorMessage/stderr/output/exitCode/stopReason). */
function result(
  fields: Partial<{
    errorMessage: string | undefined;
    stderr: string;
    output: string;
    exitCode: number;
    stopReason: string;
  }>,
): SingleResult {
  return {
    agent: "test-agent",
    task: "test-task",
    exitCode: 1,
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    stopReason: "error",
    errorMessage: undefined,
    progress: createDefaultProgress("test-agent", "test-task", {}),
    output: "",
    filesChanged: [],
    testsRan: false,
    ...fields,
  };
}

describe("resultErrorMessage — consumption-boundary sanitization", () => {
  test("prefers errorMessage, then stderr, then output", () => {
    expect(resultErrorMessage(result({ errorMessage: "first", stderr: "second", output: "third" }))).toBe("first");
    expect(resultErrorMessage(result({ stderr: "second", output: "third" }))).toBe("second");
    expect(resultErrorMessage(result({ output: "third" }))).toBe("third");
    expect(resultErrorMessage(result({}))).toBe("(no output)");
  });

  test("strips ANSI/OSC/C0 control chars from a single-line errorMessage", () => {
    const r = result({ errorMessage: "\x1b[31mboom\x1b[0m \x1b]8;;https://evil\x07x" });
    expect(resultErrorMessage(r)).not.toContain("\x1b");
    expect(resultErrorMessage(r)).toContain("boom");
  });

  test("strips control chars per-line in multi-line stderr, preserving newlines", () => {
    // A multi-line stderr chunk (e.g. a verbose child's log). Each line is sanitized; the
    // newline structure is preserved so the operator sees the log shape.
    const r = result({
      stderr: "\x1b[31mline one\x1b[0m\nline two\x1b]8;;https://evil\x07\n\x07BEL line",
    });
    const out = resultErrorMessage(r);
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("]8;;");
    expect(out).toContain("\n"); // newlines preserved
    expect(out).toContain("line one");
    expect(out).toContain("line two");
    expect(out).toContain("BEL line");
  });

  test("no control chars in input → output identical (idempotent, no structure loss)", () => {
    const r = result({ stderr: "clean line one\nclean line two" });
    expect(resultErrorMessage(r)).toBe("clean line one\nclean line two");
  });

  test("strips embedded C0 (BEL/NUL/CR/VT) WITHIN individual lines while preserving the newline structure", () => {
    // The per-line split/map/join is what makes this correct: each line gets stripControlChars
    // independently, so C0 chars embedded mid-line are removed but the `\n` separators (re-added
    // by join) survive. Without per-line handling, a naive whole-string strip would collapse the
    // log into one line (newlines ARE C0 and would be stripped).
    const r = result({ stderr: "line1\x07bell\x1b[31mred\nline2\x00null\x0dcarriage\x0bvt" });
    const out = resultErrorMessage(r);
    // Newline structure preserved (two lines, one separator).
    expect(out.split("\n")).toEqual(["line1bellred", "line2nullcarriagevt"]);
    // No control bytes remain anywhere.
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
    expect(out).not.toContain("\x00");
    expect(out).not.toContain("\x0d");
    expect(out).not.toContain("\x0b");
  });
});

describe("isResultError", () => {
  test("non-zero exit, error, or aborted stopReason → error", () => {
    expect(isResultError(result({ exitCode: 1, stopReason: "end_turn" }))).toBe(true);
    expect(isResultError(result({ exitCode: 0, stopReason: "error" }))).toBe(true);
    expect(isResultError(result({ exitCode: 0, stopReason: "aborted" }))).toBe(true);
  });

  test("clean run → not an error", () => {
    expect(isResultError(result({ exitCode: 0, stopReason: "end_turn" }))).toBe(false);
  });
});

/**
 * parallelFailedReason surfaces a crash reason (errorMessage ‖ stderr) in the parallel summary's
 * `FAILED: …` annotation. The motivating bug: a subagent that crashed (non-zero exit, empty
 * errorMessage, stack trace in stderr) rendered as a bare `FAILED` with no explanation because
 * the summary only read errorMessage. stderr was captured but discarded.
 */
describe("parallelFailedReason — surfaces stderr when errorMessage is empty", () => {
  test("prefers errorMessage, then stderr; never falls back to output", () => {
    // errorMessage wins.
    expect(parallelFailedReason(result({ errorMessage: "killed", stderr: "trace" }))).toBe("killed");
    // Empty errorMessage → stderr surfaces (the crash-stack-trace case).
    expect(parallelFailedReason(result({ stderr: "TypeError: undefined is not a function" }))).toBe(
      "TypeError: undefined is not a function",
    );
    // output is intentionally NOT a fallback (it is rendered as the task body separately).
    expect(parallelFailedReason(result({ output: "some output" }))).toBe("");
    // Nothing at all → empty (caller renders a bare `FAILED`).
    expect(parallelFailedReason(result({}))).toBe("");
  });

  test("sanitizes per-line, preserving multi-line stack traces", () => {
    const r = result({ stderr: "\x1b[31mError: boom\x1b[0m\n    at foo (bar.ts:12)\n    at baz (qux.ts:7)" });
    const out = parallelFailedReason(r);
    expect(out).not.toContain("\x1b");
    expect(out).toContain("Error: boom");
    expect(out).toContain("at foo (bar.ts:12)");
    expect(out.split("\n").length).toBe(3); // multi-line structure preserved
  });

  test("caps excessively long stderr so it can't swamp the parallel summary", () => {
    const long = `Error: big\n${"x".repeat(2000)}`;
    const out = parallelFailedReason(result({ stderr: long }));
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toContain("Error: big");
  });
});
