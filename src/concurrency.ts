// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { getSubagentSettings } from "./settings-ui.js";

export function getSubagentConcurrency(): number {
  const { subagentConcurrency } = getSubagentSettings();
  // null = Infinite. The schema's min:1 guarantees any non-null value is already a positive
  // limit, so no defensive ≤0 fallback is needed here.
  return subagentConcurrency === null ? Number.MAX_SAFE_INTEGER : subagentConcurrency;
}

/** Format a concurrency limit for display. Returns "∞" for Infinite. */
export function formatConcurrencyLimit(limit: number): string {
  return limit >= Number.MAX_SAFE_INTEGER / 2 ? "∞" : String(limit);
}

/** A held concurrency slot. {@link release} is idempotent. */
export interface Admission {
  /**
   * Return this slot to the gate. Safe to call more than once: later calls are
   * no-ops — no double-counting, and never more than one waiter admitted.
   */
  release(): void;
}

/**
 * Caps how many async operations may run at once. The cap is not stored: it is
 * re-queried through a caller-supplied function on every acquire decision and
 * every release, so the limit can change mid-flight.
 *
 * Acquiring either takes a slot immediately (when fewer than the current cap are
 * inside) or waits — the returned promise stays pending until a release opens
 * room. Each admission hands back an idempotent {@link Admission.release};
 * releasing admits the single earliest waiting caller (FIFO) if there is room.
 */
export class ConcurrencyGate {
  private inside = 0;
  private readonly waiters: Array<() => void> = [];

  /**
   * @param getLimit Invoked on every acquire decision and every release to learn
   *                 the current cap. May return different values over time.
   */
  constructor(private readonly getLimit: () => number) {}

  /**
   * Request a slot. Resolves immediately with an {@link Admission} when
   * `inside < current cap`; otherwise the promise stays pending until a release
   * opens room, then resolves with the caller's own admission.
   */
  async acquire(): Promise<Admission> {
    if (this.inside < this.getLimit()) {
      this.inside++;
      return this.createAdmission();
    }
    // No room: park until a release admits us. The releaser increments
    // `inside` on our behalf before resolving — do not increment here.
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    return this.createAdmission();
  }

  /** Operations currently holding a slot. */
  get active(): number {
    return this.inside;
  }

  /** Operations waiting to acquire a slot. */
  get waiting(): number {
    return this.waiters.length;
  }

  /** Current cap (re-queried on every decision). */
  get limit(): number {
    return this.getLimit();
  }

  /** Builds an admission whose release runs at most once. */
  private createAdmission(): Admission {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.releaseSlot();
      },
    };
  }

  /**
   * One slot is returned: decrement, then admit exactly one earliest waiter
   * (FIFO) if any is waiting and there is now room under the current cap. If the
   * cap has dropped below `inside`, releases drain without admitting until
   * `inside < cap` again.
   */
  private releaseSlot(): void {
    this.inside--;
    if (this.waiters.length > 0 && this.inside < this.getLimit()) {
      const admit = this.waiters.shift();
      if (admit) {
        this.inside++;
        admit();
      }
    }
  }
}
