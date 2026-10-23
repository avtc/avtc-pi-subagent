// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Post-run sweep of the suite's per-worker test-log dirs (created by tests/setup.ts —
 * see the comment there for why they cannot be removed in-worker: the logger caches
 * its baseDir per worker, and vitest kills workers without a clean process exit).
 * Runs as vitest globalSetup in the MAIN process; the RETURNED closure is vitest's
 * teardown hook and runs after the run ends.
 */
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "avtc-pi-subagent-test-logs-";

export default function setupTestLogSweep() {
  return () => {
    for (const entry of readdirSync(tmpdir())) {
      if (entry.startsWith(PREFIX)) {
        rmSync(join(tmpdir(), entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  };
}
