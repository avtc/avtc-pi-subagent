// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test, vi } from "vitest";
import { __internal } from "../src/extension.js";

const { createThrottle } = __internal;

describe("createThrottle", () => {
  test("calls fn immediately on first call", () => {
    const fn = vi.fn();
    const { throttled } = createThrottle(fn, 100);
    throttled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("coalesces rapid calls into at most one pending", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const { throttled } = createThrottle(fn, 100);

    throttled(); // immediate
    throttled(); // pending
    throttled(); // pending (overwrites)
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2); // original + 1 pending

    vi.useRealTimers();
  });

  test("flush fires pending immediately", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const { throttled, flush } = createThrottle(fn, 100);

    throttled(); // immediate
    throttled(); // pending
    flush();
    expect(fn).toHaveBeenCalledTimes(2);

    // Timer should be cleared, no extra call
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  test("flush is no-op when nothing pending", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const { flush } = createThrottle(fn, 100);

    flush();
    expect(fn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  test("resumes normal throttling after flush", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const { throttled, flush } = createThrottle(fn, 100);

    throttled();
    flush(); // clears timer + fires pending
    throttled(); // should fire immediately again
    expect(fn).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  test("deferred call uses latest args, not stale", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const { throttled } = createThrottle(fn, 100);

    throttled("first"); // immediate
    throttled("second"); // pending (args captured as ["second"])
    throttled("third"); // pending (args overwritten to ["third"])
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith("first");

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    // The deferred call must use the LATEST args ("third"), not stale ("second")
    expect(fn).toHaveBeenLastCalledWith("third");

    vi.useRealTimers();
  });
});
