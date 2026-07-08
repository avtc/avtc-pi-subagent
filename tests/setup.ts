// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Global vitest setup for avtc-pi-subagent.
 *
 * Redirects the shared avtc-pi-logger file sink to a per-run temp directory so tests never
 * pollute the real `~/.pi/logs/avtc-pi-subagent/`. The real `log` singleton reads
 * `PI_LOGGER_DIR` at first import (precedence: explicit options > env > default), so setting
 * it here before any module under test is imported routes every `moduleLog` write to a temp dir.
 *
 * Per-file `vi.mock("../src/log.js", ...)` (see tests/helpers/mock-logger.ts) is still available
 * for tests that need to assert on log *calls* rather than just silence file output.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach } from "vitest";

const tempLogDir = mkdtempSync(path.join(tmpdir(), "avtc-pi-subagent-test-logs-"));
process.env.PI_LOGGER_DIR = tempLogDir;

// Each test starts with a clean child-enforcement + dispatch env so a test that drives
// session_start with a mock pi (lacking getAllTools/setActiveTools) never accidentally triggers
// real child-side tool-policy enforcement — which would call the real loader + pi.getAllTools()
// (undefined on a mock) and fail-closed (process.exit). Tests that exercise enforcement
// (tool-enforcement, spawn-env-forwarding) set these explicitly. PI_SUBAGENT_FORK_MODE is a
// dispatch input (fork suffixing); a leaked value would silently alter every subsequent test in
// the worker, so it is cleared globally here. PI_SETTINGS_SUBAGENT is also a dispatch input but
// is set per-test by setTestSettings(null) in file beforeEach (which runs after this global hook),
// so each file that sets it also deletes it in its own afterEach (belt-and-suspenders).
beforeEach(() => {
  delete process.env.PI_SUBAGENT_CHILD_AGENT;
  delete process.env.PI_SUBAGENT_IS_FORK;
  delete process.env.PI_SUBAGENT_TOOLS;
  delete process.env.PI_SUBAGENT_TOOLS_ADD;
  delete process.env.PI_SUBAGENT_FORK_MODE;
  // Reset the extension's one-time globalThis wiring guard so every test starts unwired.
  // pi re-evaluates the module fresh per test (jiti moduleCache:false) but globalThis persists, so
  // an entry call in one test would otherwise short-circuit entry calls in later tests (reload-safe
  // guard in src/extension.ts). Cleared here for the same reason the env vars above are.
  delete (globalThis as { __avtcPiSubagentWired?: boolean }).__avtcPiSubagentWired;
});
