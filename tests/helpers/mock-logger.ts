// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Logger } from "avtc-pi-logger";
/**
 * Shared logger mock factory for tests that need to assert on log *calls*.
 *
 * The mock mirrors the avtc-pi-logger `Logger` interface. `child()` returns the mock itself so
 * that a module-scoped `log.child("<module>")` logger resolves to the one shared set of spies,
 * letting a test assert on any module's output through a single set of methods.
 *
 * Use it via `vi.mock` of the log singleton (hoisted by vitest):
 *
 * ```ts
 * vi.mock("../src/log.js", async () => {
 *   const { createMockLogger } = await import("./helpers/mock-logger.js");
 *   return { log: createMockLogger() };
 * });
 * ```
 *
 * NOTE: asserting on log calls is rarely necessary — logging is best-effort and should not
 * drive behavior. Prefer asserting the observable outcome (returned value / thrown error).
 * Test-time file pollution is handled separately and globally by `tests/setup.ts` (it sets
 * `PI_LOGGER_DIR` to a temp dir), so the real sink never touches `~/.pi/logs` during tests.
 */
import { vi } from "vitest";

export type MockLogger = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
} & Logger;

/** Build a mock Logger whose methods are vi.fn spies. `child()` returns the mock itself. */
export function createMockLogger(): MockLogger {
  const mock: unknown = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  (mock as { child: ReturnType<typeof vi.fn> }).child.mockReturnValue(mock);
  return mock as MockLogger;
}
