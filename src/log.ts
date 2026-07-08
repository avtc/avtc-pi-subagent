// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Root subagent logger.
 *
 * Thin wrapper over the shared `avtc-pi-logger` library. The implementation (file backend,
 * rotation, retention, level formatting) lives in the library; this module only owns the
 * pi-subagent singleton.
 *
 * Logs land at `~/.pi/logs/avtc-pi-subagent/<YYYY-MM-DD>.log` (date-partitioned, with size
 * roll-over + age-based retention — all handled by the library). Best-effort: a logging
 * failure never throws to the host.
 *
 * Per-module scoped loggers are derived via `log.child("<module>")` in each module, so every
 * log line is tagged with its origin without a second sink.
 */

import { createLogger, NO_ERROR } from "avtc-pi-logger";

/** No custom logger options — use library defaults. */
const NO_LOGGER_OPTIONS: Parameters<typeof createLogger>[1] = null;

/** Root subagent logger — writes to ~/.pi/logs/avtc-pi-subagent/<date>.log (best-effort). */
export const log = createLogger("avtc-pi-subagent", NO_LOGGER_OPTIONS);

/** Re-exported library sentinel: the value to pass `log.error`'s required error-cause
 *  argument when there is no caught exception (a config-level report). */
export { NO_ERROR };
