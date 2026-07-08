// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Per-invocation env vars that must NOT cascade to nested subagent processes.
 * These are consumed at the current process level and have no valid meaning
 * for child processes (which make their own independent decisions).
 *
 * `PI_SUBAGENT_IS_FORK` and `PI_SUBAGENT_TOOLS` are parent->child inputs set
 * explicitly per-spawn: a fork child's fresh grandchild must NOT inherit the fork
 * marker (it would wrongly self-restrict via the fork guard), and a whitelisted
 * parent's TOOLS must NOT leak to a whitelistless child (it would wrongly narrow
 * it). Both are deleted/overwritten per-spawn at the spawn boundary, and excluded
 * here as a belt-and-braces guard so any residual value from a higher level is
 * stripped before the per-spawn override is applied.
 */
const EXCLUDED_FROM_CASCADE = new Set([
  "PI_SUBAGENT_FORK_MODE", // Fork mode is a per-level orchestration decision
  "PI_SUBAGENT_IS_FORK", // Fork marker is a per-spawn parent->child input (see above)
  "PI_SUBAGENT_TOOLS", // Frontmatter whitelist is a per-spawn parent->child input (see above)
]);

/**
 * Build the environment for a subagent child process.
 *
 * The child inherits the FULL parent environment — a subagent is a trusted child
 * running the same user's task and needs the same environment as the main session
 * (same PATH, same shell-resolution vars like ProgramFiles, same toolchain config).
 * Filtering the child env to a subset (an allowlist) breaks cross-platform shell
 * resolution: e.g. dropping ProgramFiles made pi's getShellConfig skip Git Bash's
 * hardcoded path and fall back to `where bash.exe`, picking WSL on Windows — which
 * in turn made subagents emit /mnt/e/ paths that phantom-write via path.resolve.
 *
 * The ONLY exclusion is EXCLUDED_FROM_CASCADE (vars that are semantically per-level
 * orchestration decisions and must not leak to nested subagents).
 *
 * Per-spawn overrides (PI_SETTINGS_SUBAGENT with a depth-decremented budget,
 * PI_SUBAGENT_PARENT_PID, PI_SUBAGENT_CHILD_AGENT) are NOT applied
 * here — they are the caller's responsibility, set directly on the returned object.
 * This keeps buildSubagentEnv a pure inheritance policy.
 */
export function buildSubagentEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (EXCLUDED_FROM_CASCADE.has(key)) continue;
    env[key] = value;
  }

  return env;
}
