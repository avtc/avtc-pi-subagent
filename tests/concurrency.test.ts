// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for the concurrency module's consumer-owned behavior: the ConcurrencyGate
 * semaphore (admission/queueing/release) and the formatConcurrencyLimit display helper.
 *
 * getSubagentConcurrency itself is thin glue over the settings handle (it maps the
 * schema's null = Infinite to a concrete runtime sentinel); the settings reading,
 * normalization, defaults, and null semantics are settings-ui's responsibility and
 * are not re-tested here.
 */
import { describe, expect, test } from "vitest";
import { ConcurrencyGate, formatConcurrencyLimit } from "../src/concurrency.js";

describe("ConcurrencyGate", () => {
  test("allows up to limit concurrent acquisitions", async () => {
    const gate = new ConcurrencyGate(() => 2);
    const release1 = await gate.acquire();
    const release2 = await gate.acquire();
    expect(gate.active).toBe(2);
    expect(gate.waiting).toBe(0);
    release1.release();
    release2.release();
  });

  test("queues when limit is reached", async () => {
    const gate = new ConcurrencyGate(() => 1);
    const release1 = await gate.acquire();
    expect(gate.active).toBe(1);

    let acquired = false;
    const pendingAcquire = gate.acquire().then((admission) => {
      acquired = true;
      return admission;
    });

    // Give microtask a chance to resolve
    await new Promise((r) => setTimeout(r, 0));
    expect(acquired).toBe(false);
    expect(gate.waiting).toBe(1);

    release1.release();
    const release2 = await pendingAcquire;
    expect(acquired).toBe(true);
    expect(gate.active).toBe(1);
    expect(gate.waiting).toBe(0);
    release2.release();
  });

  test("processes queue in FIFO order", async () => {
    const gate = new ConcurrencyGate(() => 1);
    const order: number[] = [];

    const release1 = await gate.acquire();

    const p2 = gate.acquire().then((a) => {
      order.push(2);
      return a;
    });
    const p3 = gate.acquire().then((a) => {
      order.push(3);
      return a;
    });

    release1.release();
    const r2 = await p2;
    r2.release();
    const r3 = await p3;
    r3.release();

    expect(order).toEqual([2, 3]);
  });

  test("double release is safe", async () => {
    const gate = new ConcurrencyGate(() => 1);
    const admission = await gate.acquire();
    admission.release();
    admission.release(); // should not throw or double-decrement
    expect(gate.active).toBe(0);
  });

  test("limit changes dynamically via callback", async () => {
    let currentLimit = 2;
    const gate = new ConcurrencyGate(() => currentLimit);

    const release1 = await gate.acquire();
    const release2 = await gate.acquire();
    expect(gate.active).toBe(2);
    expect(gate.limit).toBe(2);

    // Reduce limit to 1 — new acquire should queue (2 already inside, cap now 1)
    currentLimit = 1;
    let acquired = false;
    const pendingAcquire = gate.acquire().then((admission) => {
      acquired = true;
      return admission;
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(acquired).toBe(false);
    expect(gate.waiting).toBe(1);
    expect(gate.limit).toBe(1);

    // Still over the lowered cap (1 inside, cap 1) — releasing one must NOT admit
    // the waiter, otherwise the gate would exceed the new cap.
    release1.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(acquired).toBe(false);

    // Once occupancy drains below the cap, the waiter is admitted.
    release2.release();
    const release3 = await pendingAcquire;
    expect(acquired).toBe(true);
    expect(gate.active).toBe(1);
    release3.release();
  });
});

describe("formatConcurrencyLimit", () => {
  test("returns string representation of number", () => {
    expect(formatConcurrencyLimit(6)).toBe("6");
    expect(formatConcurrencyLimit(1)).toBe("1");
    expect(formatConcurrencyLimit(32)).toBe("32");
  });

  test("returns ∞ for MAX_SAFE_INTEGER", () => {
    expect(formatConcurrencyLimit(Number.MAX_SAFE_INTEGER)).toBe("∞");
  });

  test("returns ∞ for values at or above half of MAX_SAFE_INTEGER", () => {
    expect(formatConcurrencyLimit(Number.MAX_SAFE_INTEGER / 2)).toBe("∞");
    expect(formatConcurrencyLimit(Number.MAX_SAFE_INTEGER / 2 + 1)).toBe("∞");
  });

  test("returns number for values below half of MAX_SAFE_INTEGER", () => {
    expect(formatConcurrencyLimit(Number.MAX_SAFE_INTEGER / 2 - 1)).toBe(String(Number.MAX_SAFE_INTEGER / 2 - 1));
  });
});
