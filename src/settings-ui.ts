// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The single, canonical subagent-settings handle.
 *
 * Registered once here (rather than in `extension.ts`) so that every module — including
 * `process-runner.ts`, which `extension.ts` imports and therefore cannot import back
 * without a cycle — reads settings through the same accessor. {@link initSubagentSettings}
 * is called from the extension's activate function (where `pi` is available); until then
 * the handle is `undefined`, which is fine because all reads happen at runtime (after
 * activate). Callers read {@link getSubagentSettings}; no consumer re-parses or
 * re-normalizes the env var.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsCommand, type SettingsHandle } from "avtc-pi-settings-ui";
import { SUBAGENT_SCHEMA, SUBAGENT_SETTINGS_ENV_VAR, type SubagentSettings } from "./schema.js";

let handle: SettingsHandle<SubagentSettings> | undefined;

/**
 * Test-only override for the settings read (DI/mock pattern): when set, {@link getSubagentSettings}
 * returns this instead of the real handle. Set up in tests before the SUT runs (like the other
 * `_set*` hooks); cleared by `_resetGetSubagentSettings` (called from `_resetAllTestHooks`).
 */
let _getSettingsOverride: (() => SubagentSettings) | null = null;

/** Test-only: inject a mock settings source (pass `null` to restore the real handle). */
export function _setGetSubagentSettings(fn: (() => SubagentSettings) | null): void {
  _getSettingsOverride = fn;
}

/** Test-only: clear the mock override (restore real-handle reads). */
export function _resetGetSubagentSettings(): void {
  _getSettingsOverride = null;
}

/**
 * Register the /subagent:settings command + modal and create the settings handle.
 * Must be called from the extension's activate function (needs `pi`). Loads settings
 * immediately (registration time) and on every session_start.
 */
export function initSubagentSettings(pi: ExtensionAPI): void {
  handle = registerSettingsCommand<SubagentSettings>(pi, SUBAGENT_SCHEMA, {
    commandName: "subagent:settings",
    title: "Subagent Settings",
    titleRight: "avtc-pi-subagent",
    envVar: SUBAGENT_SETTINGS_ENV_VAR,
  });
}

/** Read the current subagent settings (normalized by the schema). */
export function getSubagentSettings(): SubagentSettings {
  if (_getSettingsOverride) return _getSettingsOverride();
  if (!handle) throw new Error("subagent settings not initialized — initSubagentSettings not called");
  return handle.getSettings();
}
