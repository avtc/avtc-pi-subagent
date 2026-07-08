// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Subagent settings schema (5 fields), rendered via /subagent:settings command.
 */

import type { SettingsSchema } from "avtc-pi-settings-ui";
import { settingsFilePaths } from "avtc-pi-settings-ui";

export interface SubagentSettings {
  subagentTimeoutMs: number | null;
  inactivityTimeoutMs: number | null;
  subagentConcurrency: number | null; // null = Infinite
  maxSubagentDepth: number;
  spawnMode: "json" | "rpc"; // how subagent child processes run
}

/** Env var name for cross-process settings propagation. */
export const SUBAGENT_SETTINGS_ENV_VAR = "PI_SETTINGS_SUBAGENT";

/** Full settings schema in avtc-pi-settings-ui format. */
// ── Preset pairs (label → value). Order is the array order, immune to JS integer-index
// key reordering that previously scrambled Concurrency display (6→"4").

const TIMEOUT_PRESETS = [
  ["Infinite", null],
  ["30m", 1_800_000],
  ["1h", 3_600_000],
  ["3h", 10_800_000],
] as const;

const INACTIVITY_PRESETS = [
  ["Infinite", null],
  ["10m", 600_000],
  ["30m", 1_800_000],
  ["1h", 3_600_000],
] as const;

const CONCURRENCY_PRESETS = [
  ["Infinite", null],
  ["2", 2],
  ["4", 4],
  ["6", 6],
  ["10", 10],
] as const;

// ── Schema ──────────────────────────────────────────────────────────────────

export const SUBAGENT_SCHEMA: SettingsSchema = {
  settings: [
    {
      id: "subagentTimeoutMs",
      label: "Subagent timeout",
      description: "Maximum time a subagent can run. Infinite = no limit.",
      type: "duration",
      min: 1,
      defaultValue: 10_800_000,
      presets: TIMEOUT_PRESETS,
    },
    {
      id: "inactivityTimeoutMs",
      label: "Inactivity timeout",
      description: "Timeout for subagent inactivity (no output). Infinite = no limit.",
      type: "duration",
      min: 1,
      defaultValue: 600_000,
      presets: INACTIVITY_PRESETS,
    },
    {
      id: "subagentConcurrency",
      label: "Concurrency",
      description: "Max parallel subagents. Infinite = no limit.",
      type: "number",
      min: 1,
      defaultValue: 6,
      presets: CONCURRENCY_PRESETS,
    },
    {
      id: "maxSubagentDepth",
      label: "Max nesting depth",
      description: "Maximum depth of nested subagent calls.",
      type: "number",
      // No min bound: a child process receives parent-1, and 0 is the sentinel that blocks
      // further nesting (process-runner guards on ≤0). Enforcing min:1 would reset a child's
      // 0 → default 3, breaking the recursion guard.
      defaultValue: 3,
      presets: [
        ["1", 1],
        ["2", 2],
        ["3", 3],
        ["5", 5],
      ],
    },
    {
      id: "spawnMode",
      label: "Spawn mode",
      description:
        "How subagent processes run. JSON starts a fresh process for each subagent; RPC keeps the process alive between turns.",
      type: "string",
      defaultValue: "rpc",
      presets: [
        ["JSON", "json"],
        ["RPC", "rpc"],
      ],
    },
  ],
  tabs: [
    {
      label: "Subagents",
      settingIds: ["subagentTimeoutMs", "inactivityTimeoutMs", "subagentConcurrency", "maxSubagentDepth", "spawnMode"],
    },
  ],
  ...settingsFilePaths("avtc-pi-subagent"),
};
