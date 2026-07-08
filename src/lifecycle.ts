// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ChildProcess } from "node:child_process";

// ── Parent PID Watchdog ─────────────────────────────────────────────────────
// Prevents orphaned nested subagents when the parent pi process is killed.
// On Unix, SIGTERM kills without firing process.on("exit").
// On Windows, TerminateProcess() (triggered by proc.kill()) skips all handlers.
// The watchdog polls the parent PID and self-terminates if it disappears.

const PARENT_PID_ENV = "PI_SUBAGENT_PARENT_PID";
const WATCHDOG_INTERVAL_MS = 5_000;

/**
 * Reads the parent PID from the environment.
 * Returns undefined if not set (root process, not a subagent child).
 */
export function getParentPid(): number | undefined {
  const raw = process.env[PARENT_PID_ENV];
  if (!raw) return undefined;
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/**
 * Monitors the parent process and self-terminates if it dies.
 *
 * When a parent pi process is killed (SIGTERM, SIGKILL, crash), its child
 * subagent processes become orphaned because process.on("exit") handlers
 * don't fire on signal kills. The watchdog detects this by polling the
 * parent PID and calling process.exit() when the parent is gone.
 */
/** Sentinel: no-op logger */
export const NOOP_LOGGER: (message: string) => void = () => {};

export class ParentWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private parentPid: number;
  private logger: (message: string) => void;

  constructor(parentPid: number, logger: (message: string) => void) {
    this.parentPid = parentPid;
    this.logger = logger;
  }

  /** Start polling for parent liveness. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.check(), WATCHDOG_INTERVAL_MS);
    // Don't prevent process exit if this is the only timer running
    if (this.timer.unref) this.timer.unref();
  }

  /** Stop polling. Call on session shutdown to clean up. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Check if parent is still alive. */
  private check(): void {
    try {
      // process.kill(pid, 0) throws if the process doesn't exist
      process.kill(this.parentPid, 0);
    } catch (err) {
      // Distinguish WHY the signal failed. Only ESRCH ("No such process") means the parent is
      // genuinely gone. EPERM ("Operation not permitted") means the process EXISTS but is
      // inaccessible (e.g. an elevated/system process, or PID reuse to a protected target) — on
      // Windows in particular this is reachable and must NOT be treated as a dead parent, or the
      // watchdog false-positives and `process.exit(1)`s a healthy subagent (silent exit-1, no
      // errorMessage — the same failure mode behind the parallel-crash incident). Keep polling.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ESRCH") {
        this.logger(
          `Parent liveness probe returned ${code ?? "unknown error"} (PID ${this.parentPid}) — ` +
            "process exists but is inaccessible; continuing to poll",
        );
        return;
      }
      this.logger(`Parent process (PID ${this.parentPid}) is dead — self-terminating to prevent orphan`);
      this.stop();
      process.exit(1);
    }
  }
}

// ── Process Registry ────────────────────────────────────────────────────────

/**
 * Tracks the child processes a parent has spawned so they can all be stopped
 * together at shutdown.
 *
 * Each child is recorded when it spawns and is dropped automatically once it
 * exits. On demand, every still-living child is asked to stop with SIGTERM;
 * children that have already exited are skipped silently.
 */
export class ProcessRegistry {
  private readonly children = new Set<ChildProcess>();

  /**
   * Records a spawned child so it will be stopped on demand. No-op if the child
   * is already tracked or has already exited.
   */
  register(child: ChildProcess): void {
    if (this.children.has(child)) return;
    if (!isAlive(child)) return;
    this.children.add(child);
    child.once("exit", () => {
      this.children.delete(child);
    });
  }

  /**
   * Sends SIGTERM to every still-living registered child. Children that have
   * already exited are skipped silently.
   */
  terminateAll(): void {
    for (const child of this.children) {
      if (!isAlive(child)) {
        this.children.delete(child);
        continue;
      }
      child.kill("SIGTERM");
    }
  }

  /** Number of children currently registered. */
  get size(): number {
    return this.children.size;
  }
}

/** `true` while the child has not yet exited. */
function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}
