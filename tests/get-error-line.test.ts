// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Unit tests for getErrorLine — the single-source-of-truth render gate extracted so the
 * compact + multi-line renderers share one error-line decision. The gate is:
 *   (errorVisible || status === "failed") && (p.error || r.errorMessage) → return p.error || r.errorMessage
 * Tested here in isolation (vs indirectly through full-render tests) so regressions in the
 * gate logic are immediately visible without rendering infrastructure.
 */
import { describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";

const { getErrorLine } = __internal;

// Minimal shape helpers — getErrorLine reads only .error/.errorVisible/.status (progress)
// and .errorMessage (result), so we construct only those fields.
function prog(over: { error?: string; errorVisible?: boolean; status?: string }) {
  return { error: over.error, errorVisible: over.errorVisible, status: over.status } as Parameters<
    typeof getErrorLine
  >[0];
}
function res(errorMessage: string | undefined) {
  return { errorMessage } as Parameters<typeof getErrorLine>[1];
}

describe("getErrorLine", () => {
  test("errorVisible + progress error text → returns the progress error", () => {
    // A transient mid-run error: errorVisible set, text mirrored onto progress.error.
    expect(getErrorLine(prog({ error: "500 boom", errorVisible: true }), res(undefined))).toBe("500 boom");
  });

  test("status failed + result errorMessage (no progress.error) → returns the result errorMessage", () => {
    // A terminal hard-kill: status failed, errorMessage set, progress.error undefined.
    expect(getErrorLine(prog({ status: "failed" }), res("killed after 600s of inactivity"))).toBe(
      "killed after 600s of inactivity",
    );
  });

  test("status failed with no error text anywhere → undefined (failed but nothing to show)", () => {
    expect(getErrorLine(prog({ status: "failed" }), res(undefined))).toBeUndefined();
  });

  test("errorVisible false + status running + error text → undefined (text hidden without visibility)", () => {
    // Error text present but not yet surfaced (no errorVisible, not terminal) → hidden.
    expect(getErrorLine(prog({ error: "stale", status: "running" }), res(undefined))).toBeUndefined();
  });

  test("progress.error shadows result.errorMessage when both are present", () => {
    // The gate returns `p.error || r.errorMessage`: progress.error takes precedence. This is the
    // ordering that required finalize() to overwrite progress.error with the terminal errorMessage
    // (so a kill reason isn't shadowed by stale transient text).
    expect(getErrorLine(prog({ error: "transient", errorVisible: true }), res("terminal kill"))).toBe("transient");
  });

  test("status failed + progress.error only (errorMessage undefined) → returns progress.error", () => {
    // The nested-child path: childToResult hardcodes errorMessage:undefined, so the error text
    // lives only on progress.error and must still render.
    expect(getErrorLine(prog({ error: "nested failed", status: "failed" }), res(undefined))).toBe("nested failed");
  });
});
