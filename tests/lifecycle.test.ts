// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getParentPid, ParentWatchdog, ProcessRegistry } from "../src/lifecycle.js";

/** A minimal alive ChildProcess stub: exitCode/signalCode null, kill spy, emits 'exit'. */
function aliveProc(pid: number, killSpy: ((sig: string) => void) | null) {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    pid,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: (sig: string) => {
      if (killSpy) killSpy(sig);
      // Mark dead once killed
      return true;
    },
    once: (event: string, cb: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const cb of handlers.get(event) ?? []) cb(...args);
      return true;
    },
  } as unknown as ChildProcess & { emit: (e: string, ...a: unknown[]) => boolean };
}

describe("ProcessRegistry", () => {
  test("tracks registered processes", () => {
    const registry = new ProcessRegistry();
    registry.register(aliveProc(1, null));
    expect(registry.size).toBe(1);
  });

  test("forgets a process when it exits", () => {
    const registry = new ProcessRegistry();
    const proc = aliveProc(1, null);
    registry.register(proc);
    expect(registry.size).toBe(1);
    proc.emit("exit", 0, null);
    expect(registry.size).toBe(0);
  });

  test("terminateAll sends SIGTERM to all living registered processes", () => {
    const registry = new ProcessRegistry();
    const kills: string[] = [];
    registry.register(aliveProc(1, (sig) => kills.push(`1:${sig}`)));
    registry.register(aliveProc(2, (sig) => kills.push(`2:${sig}`)));
    registry.terminateAll();
    expect(kills).toEqual(["1:SIGTERM", "2:SIGTERM"]);
  });

  test("terminateAll skips already-dead processes", () => {
    const registry = new ProcessRegistry();
    const kills: string[] = [];
    const proc = aliveProc(1, (sig) => kills.push(`1:${sig}`));
    // Mark the process dead (already exited)
    (proc as { exitCode: number | null }).exitCode = 0;
    registry.register(proc);
    registry.terminateAll();
    expect(kills).toEqual([]);
  });
});

describe("getParentPid", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns undefined when PI_SUBAGENT_PARENT_PID is not set", () => {
    delete process.env.PI_SUBAGENT_PARENT_PID;
    expect(getParentPid()).toBeUndefined();
  });

  test("returns parsed PID when set", () => {
    process.env.PI_SUBAGENT_PARENT_PID = "12345";
    expect(getParentPid()).toBe(12345);
  });

  test("returns undefined for invalid values", () => {
    process.env.PI_SUBAGENT_PARENT_PID = "not-a-number";
    expect(getParentPid()).toBeUndefined();
  });

  test("returns undefined for zero or negative", () => {
    process.env.PI_SUBAGENT_PARENT_PID = "0";
    expect(getParentPid()).toBeUndefined();
    process.env.PI_SUBAGENT_PARENT_PID = "-1";
    expect(getParentPid()).toBeUndefined();
  });
});

describe("ParentWatchdog", () => {
  test("does not exit while parent is alive", () => {
    // Use this process's own PID — always alive during the test
    const watchdog = new ParentWatchdog(process.pid, () => {});
    watchdog.start();
    // If the watchdog incorrectly fired, process.exit would have killed the test
    expect(() => watchdog.stop()).not.toThrow();
  });

  test("calls process.exit when parent is dead", () => {
    // Find a PID that definitely doesn't exist (high number unlikely to be in use)
    const deadPid = 999_999;
    const logs: string[] = [];
    const watchdog = new ParentWatchdog(deadPid, (msg) => logs.push(msg));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("PROCESS_EXIT_CALLED");
    }) as (code?: string | number | null | undefined) => never);

    // Trigger a check manually by accessing the private method via a structural cast
    expect(() => (watchdog as unknown as { check: () => void }).check()).toThrow("PROCESS_EXIT_CALLED");
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("999999");

    exitSpy.mockRestore();
  });

  test("start/stop are idempotent", () => {
    const watchdog = new ParentWatchdog(process.pid, () => {});
    watchdog.start();
    watchdog.start(); // second start should be a no-op
    watchdog.stop();
    watchdog.stop(); // second stop should be a no-op
    expect(() => watchdog.stop()).not.toThrow();
  });

  test("EPERM (parent exists but inaccessible) does NOT self-terminate — keeps polling", () => {
    // process.kill(pid, 0) can return EPERM on Windows for elevated/system PIDs (or PID reuse to a
    // protected target). EPERM means the process EXISTS, so the watchdog must NOT treat it as dead
    // and process.exit(1) a healthy subagent. (The false-positive behind the parallel-crash incident.)
    const logs: string[] = [];
    const watchdog = new ParentWatchdog(42, (msg) => logs.push(msg));

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error("not permitted");
      err.code = "EPERM";
      throw err;
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("PROCESS_EXIT_SHOULD_NOT_BE_CALLED");
    }) as (code?: string | number | null | undefined) => never);

    // Must NOT throw (process.exit must not be invoked) and must NOT exit the process.
    expect(() => (watchdog as unknown as { check: () => void }).check()).not.toThrow();
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("inaccessible");
    expect(logs[0]).toContain("continuing to poll");

    killSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test("ESRCH (genuinely dead parent) still self-terminates", () => {
    // ESRCH ("No such process") is the only code that legitimately means the parent is gone.
    // Drive it explicitly via the spy so the test is independent of PID availability.
    const logs: string[] = [];
    const watchdog = new ParentWatchdog(777, (msg) => logs.push(msg));

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error("no such process");
      err.code = "ESRCH";
      throw err;
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("PROCESS_EXIT_CALLED");
    }) as (code?: string | number | null | undefined) => never);

    expect(() => (watchdog as unknown as { check: () => void }).check()).toThrow("PROCESS_EXIT_CALLED");
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("is dead");
    expect(logs[0]).toContain("777");

    killSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
