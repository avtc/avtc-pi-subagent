// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Loader for the entire `avtc-pi-subagent` section of settings.json.
 *
 * Caching strategy: module-level `let` cache + session_start invalidation
 * (NOT globalThis/mtime). Reads the `avtc-pi-subagent` section, parsing BOTH the
 * model-routing keys (`subagent-models`, `default-model`) AND the agent-control
 * keys (`subagent-tools`, `tool-sets`, `hidden-agents`, `disabled-agents`).
 *
 * Settings files:
 *  global: <globalDir>/settings.json where globalDir is typically ~/.pi/agent
 *  project: <cwd>/.pi/settings.json
 *
 * Merge: `subagent-models` merges per-key (project overrides global); the scalar
 * `default-model` is present-wins; `subagent-tools` deep-merges per key
 * (add/block union deduped, only project-replaces-global); `tool-sets` merges
 * per-name (project replaces global); `hidden-agents`/`disabled-agents` union
 * deduped.
 *
 * Error handling: the loader COLLECTS structural/validation errors into an
 * `errors` array and NEVER throws. It runs on BOTH the child enforcement path
 * (which throws to surface errors visibly) AND the model-resolution path
 * (where a throw would break all dispatch). Only the consumer (enforcement)
 * decides to throw.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

const moduleLog = log.child("subagent-config");

export type ModelOverride = string | string[];

export interface SubagentModelConfig {
  "subagent-models": Record<string, ModelOverride>;
  "default-model": string | null;
}

/** A tool-policy entry: add (union into base), block (remove), only (whitelist replace). */
export interface ToolPolicy {
  add?: string[];
  block?: string[];
  only?: string[];
}

/** The full `avtc-pi-subagent` section of settings.json. */
export interface SubagentConfig extends SubagentModelConfig {
  "subagent-tools"?: Record<string, ToolPolicy>;
  "tool-sets"?: Record<string, string[]>;
  "hidden-agents"?: string[];
  "disabled-agents"?: string[];
}

/** Reserved sentinel matching every tool. Never expanded by the loader — survives to enforcement. */
const ALL_SENTINEL = "$all";

function emptyConfig(): SubagentConfig {
  return { "subagent-models": {}, "default-model": null };
}

// --- model string validation (rejects non-strings and syntactic junk) ---
function isValidModelString(val: unknown): val is string {
  if (typeof val !== "string" || val.length === 0) return false;
  const idx = val.indexOf("/");
  return idx > 0 && idx < val.length - 1;
}

function validateDefaultModel(val: unknown): string | null {
  if (val == null) return null;
  if (isValidModelString(val)) return val;
  moduleLog.warn(`Skipping invalid default-model: ${JSON.stringify(val)}`);
  return null;
}

function validateOverrides(raw: Record<string, unknown> | undefined): Record<string, ModelOverride> {
  const out: Record<string, ModelOverride> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === "string") {
      if (isValidModelString(val)) out[key] = val;
      else moduleLog.warn(`Invalid model string for "${key}": ${JSON.stringify(val)} — skipped`);
    } else if (Array.isArray(val)) {
      const valid = val.filter(isValidModelString);
      if (valid.length !== val.length)
        moduleLog.warn(`Some models for "${key}" invalid — kept ${valid.length}/${val.length}`);
      if (valid.length > 0) out[key] = valid;
    } else {
      moduleLog.warn(`Invalid model override for "${key}" — skipped`);
    }
  }
  return out;
}

// --- path resolution: GLOBAL and PROJECT differ ---
function globalSettingsPath(globalDir: string | null): string | null {
  if (!globalDir) return null;
  return join(globalDir, "settings.json");
}

function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

/** Read + parse the `avtc-pi-subagent` section. A malformed file surfaces a parse error (NOT silently
 *  swallowed): the read returns `{ section: null, error }` so buildConfig can push it to `errors`. */
function readSubagentSection(
  filePath: string | null,
  origin: string,
): { section: Record<string, unknown> | null; error: string | null } {
  if (!filePath) return { section: null, error: null };
  try {
    if (!existsSync(filePath)) return { section: null, error: null };
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    const section = (parsed as Record<string, unknown> | null)?.["avtc-pi-subagent"];
    if (section && typeof section === "object") {
      return { section: section as Record<string, unknown>, error: null };
    }
    if (section === undefined) return { section: null, error: null };
    return { section: null, error: `${origin}: \`avtc-pi-subagent\` section is not an object` };
  } catch (err) {
    return { section: null, error: `${origin}: ${err instanceof Error ? err.message : err}` };
  }
}

// --- string-array helpers ---
function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every((v) => typeof v === "string");
}

/** Validate a ToolPolicy value, collecting structural errors. Returns `undefined` when invalid. */
function validateToolPolicy(val: unknown, key: string, origin: string, errors: string[]): ToolPolicy | undefined {
  if (val == null || typeof val !== "object" || Array.isArray(val)) {
    errors.push(`${origin}: subagent-tools["${key}"]: expected an object, got ${JSON.stringify(val)}`);
    return undefined;
  }
  const obj = val as Record<string, unknown>;
  const out: ToolPolicy = {};
  let valid = true;
  // Unknown operation keys (e.g. a typo 'ad' for 'add') are structural errors — without this
  // check they would silently parse to an empty policy, hiding the user's intent. Report EVERY
  // unknown op in the entry, not just the first.
  const KNOWN_OPS = new Set(["add", "block", "only"]);
  for (const op of Object.keys(obj)) {
    if (!KNOWN_OPS.has(op)) {
      errors.push(`${origin}: subagent-tools["${key}"].${op}: unknown operation (expected add, block, or only)`);
      valid = false;
    }
  }
  for (const op of ["add", "block", "only"] as const) {
    const v = obj[op];
    if (v === undefined) continue;
    if (!isStringArray(v)) {
      // collect ALL malformed ops in the entry (don't stop at the first)
      errors.push(`${origin}: subagent-tools["${key}"].${op}: expected a string array, got ${JSON.stringify(v)}`);
      valid = false;
      continue;
    }
    out[op] = [...v];
  }
  return valid ? out : undefined;
}

/** Validate the structural shape of a single section, collecting errors. Mutates `out`
 *  in place with the validated values. Unknown/typo keys are flagged. */
function validateSectionStructure(
  section: Record<string, unknown>,
  origin: string,
  out: SubagentConfig,
  errors: string[],
): void {
  for (const [key, val] of Object.entries(section)) {
    switch (key) {
      case "subagent-models":
      case "default-model":
        // validated by the model path (validateOverrides/validateDefaultModel) — skip here
        break;
      case "subagent-tools": {
        if (val == null || typeof val !== "object" || Array.isArray(val)) {
          errors.push(`${origin}: \`subagent-tools\` must be an object, got ${JSON.stringify(val)}`);
          break;
        }
        const tools: Record<string, ToolPolicy> = {};
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
          const policy = validateToolPolicy(v, k, origin, errors);
          if (policy) tools[k] = policy;
        }
        out["subagent-tools"] = tools;
        break;
      }
      case "tool-sets": {
        if (val == null || typeof val !== "object" || Array.isArray(val)) {
          errors.push(`${origin}: \`tool-sets\` must be an object, got ${JSON.stringify(val)}`);
          break;
        }
        const sets: Record<string, string[]> = {};
        for (const [setName, members] of Object.entries(val as Record<string, unknown>)) {
          if (setName.startsWith("$")) {
            errors.push(`${origin}: tool-sets key "${setName}" must not start with "$"`);
          }
          if (!isStringArray(members)) {
            errors.push(`${origin}: tool-sets["${setName}"]: expected a string array, got ${JSON.stringify(members)}`);
            continue;
          }
          // a tool-sets VALUE entry with a leading "$" is a stray $ref/reserved typo
          // ($all is valid only as an add/block/only-array token, never inside a set).
          // Report the error AND drop the member so it cannot reach $ref expansion regardless
          // of how the caller reacts to the collected errors.
          const filtered = members.filter((tok) => {
            if (tok.startsWith("$")) {
              errors.push(
                `${origin}: tool-sets["${setName}"] contains a "$"-prefixed token "${tok}"; "$" is reserved for add/block/only tokens, not inside sets`,
              );
              return false;
            }
            return true;
          });
          sets[setName] = filtered;
        }
        out["tool-sets"] = sets;
        break;
      }
      case "hidden-agents":
      case "disabled-agents": {
        if (!isStringArray(val)) {
          errors.push(`${origin}: \`${key}\` must be a string array, got ${JSON.stringify(val)}`);
          break;
        }
        out[key] = [...val];
        break;
      }
      default:
        errors.push(`${origin}: unknown key "${key}" in \`avtc-pi-subagent\` section`);
    }
  }
}

/** Expand `$name` refs in add/block/only arrays using `tool-sets`. `$all` is reserved and left
 *  untouched. Unknown refs (and the reserved `tool-sets.all`) are pushed to `errors`.
 *  Runs AFTER structural validation + merge so both direct strays and set-injected `$`-tokens
 *  are caught. */
function expandRefs(config: SubagentConfig, setsOrigin: string, errors: string[]): void {
  const sets = config["tool-sets"];
  if (sets?.[ALL_SENTINEL.slice(1)] !== undefined) {
    errors.push(`${setsOrigin}: tool-sets key "all" clashes with the reserved "$all" sentinel`);
  }
  const tools = config["subagent-tools"];
  if (!tools) return;
  for (const [agentKey, policy] of Object.entries(tools)) {
    for (const op of ["add", "block", "only"] as const) {
      const arr = policy[op];
      if (!arr) continue;
      const expanded: string[] = [];
      for (const tok of arr) {
        if (tok === ALL_SENTINEL) {
          expanded.push(tok); // reserved: left as a sentinel for enforcement
          continue;
        }
        if (tok.startsWith("$")) {
          const name = tok.slice(1);
          // Own-property + array guard: a `$ref` whose name collides with an inherited
          // Object.prototype member (constructor/toString/hasOwnProperty/__proto__) must NOT
          // resolve to that truthy-but-non-iterable value — spreading it would throw and
          // escape the loader. Treat it as an undefined tool-set (a structural error).
          const members = sets && Object.hasOwn(sets, name) ? sets[name] : undefined;
          if (!Array.isArray(members)) {
            errors.push(`${setsOrigin}: subagent-tools["${agentKey}"].${op} references undefined tool-set "${tok}"`);
            continue;
          }
          expanded.push(...members);
          continue;
        }
        expanded.push(tok);
      }
      policy[op] = expanded;
    }
  }
}

/** Merge two configs (global + project) per the merge rules. Collects contradictions
 *  (a key with both `only` and `add`/`block` — whether from within one entry or composed across
 *  levels) into `errors`. */
function mergeConfigs(global: SubagentConfig, project: SubagentConfig, errors: string[]): SubagentConfig {
  const cfg = emptyConfig();
  // model fields: the models Record merges by spread (per-key, project overrides global);
  // default-model is resolved in buildConfig (present-wins) — here only the Record merges.
  cfg["subagent-models"] = { ...global["subagent-models"], ...project["subagent-models"] };

  // subagent-tools: deep-merge per key (add/block union deduped; only project-replaces-global)
  const gTools = global["subagent-tools"] ?? {};
  const pTools = project["subagent-tools"] ?? {};
  const toolKeys = new Set([...Object.keys(gTools), ...Object.keys(pTools)]);
  const mergedTools: Record<string, ToolPolicy> = {};
  for (const k of toolKeys) {
    const g = gTools[k];
    const p = pTools[k];
    if (g && p) {
      // only: project-replaces-global (project's only wins when present, else global's survives)
      const only = p.only ?? g.only;
      const add = dedupeStrings([...(g.add ?? []), ...(p.add ?? [])]);
      const block = dedupeStrings([...(g.block ?? []), ...(p.block ?? [])]);
      const entry: ToolPolicy = {};
      if (only) entry.only = [...only];
      if (add.length) entry.add = add;
      if (block.length) entry.block = block;
      mergedTools[k] = entry;
    } else {
      mergedTools[k] = { ...(p ?? g) };
    }
    // contradiction: only + add/block on the same composed key (within one entry OR composed
    // across global+project). Single source for this check — validateToolPolicy does NOT repeat it.
    const m = mergedTools[k];
    if (m.only && (m.add || m.block)) {
      errors.push(`subagent-tools["${k}"]: "only" cannot be combined with "add"/"block"`);
    }
  }
  if (Object.keys(mergedTools).length) cfg["subagent-tools"] = mergedTools;

  // tool-sets: per-name project-replaces-global
  const mergedSets: Record<string, string[]> = { ...(global["tool-sets"] ?? {}), ...(project["tool-sets"] ?? {}) };
  if (Object.keys(mergedSets).length) cfg["tool-sets"] = mergedSets;

  // hidden-agents / disabled-agents: union deduped
  cfg["hidden-agents"] = dedupeStrings([...(global["hidden-agents"] ?? []), ...(project["hidden-agents"] ?? [])]);
  cfg["disabled-agents"] = dedupeStrings([...(global["disabled-agents"] ?? []), ...(project["disabled-agents"] ?? [])]);
  if (cfg["hidden-agents"].length === 0) delete cfg["hidden-agents"];
  if (cfg["disabled-agents"].length === 0) delete cfg["disabled-agents"];

  return cfg;
}

function dedupeStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// --- module-level cache (flag-guarded, O(1) hot path) ---
// ONE cache holds the full parse result: config + errors. Both loaders read it so a cache
// hit returns the SAME errors as a miss (the enforcement degrade path depends on this).
// Invalidated on session_start (invalidateSubagentConfig). No inline content-snapshot
// comparison on the load path (would put disk I/O + JSON.stringify on every cache-hit call).
let _config: SubagentConfig = emptyConfig();
let _cachedErrors: string[] = [];
let _configLoaded = false;

function readSections(
  globalDir: string | null,
  cwd: string,
): {
  global: { section: Record<string, unknown> | null; error: string | null };
  project: { section: Record<string, unknown> | null; error: string | null };
} {
  return {
    global: readSubagentSection(globalSettingsPath(globalDir), "global settings.json"),
    project: readSubagentSection(projectSettingsPath(cwd), "project settings.json"),
  };
}

/** Parse + validate + merge both sections into a config, collecting all errors. Never throws. */
function buildConfig(sections: {
  global: { section: Record<string, unknown> | null; error: string | null };
  project: { section: Record<string, unknown> | null; error: string | null };
}): { config: SubagentConfig; errors: string[] } {
  const errors: string[] = [];
  const { global: gRead, project: pRead } = sections;

  // surface file-level read/parse errors first
  if (gRead.error) errors.push(gRead.error);
  if (pRead.error) errors.push(pRead.error);

  // validate structure of each present section (model fields validated separately below)
  const gValidated = emptyConfig();
  const pValidated = emptyConfig();
  if (gRead.section) validateSectionStructure(gRead.section, "global settings.json", gValidated, errors);
  if (pRead.section) validateSectionStructure(pRead.section, "project settings.json", pValidated, errors);

  // model fields: validate warns on invalid model strings (collects errors, does not throw)
  gValidated["subagent-models"] = validateOverrides(
    gRead.section?.["subagent-models"] as Record<string, unknown> | undefined,
  );
  pValidated["subagent-models"] = validateOverrides(
    pRead.section?.["subagent-models"] as Record<string, unknown> | undefined,
  );
  const dm =
    "default-model" in (pRead.section ?? {}) ? pRead.section?.["default-model"] : gRead.section?.["default-model"];
  // default-model: the project's value wins when present, else the global's. Validated after
  // merge (below) — mergeConfigs only merges the subagent-models Record.
  const cfg = mergeConfigs(gValidated, pValidated, errors);
  cfg["default-model"] = validateDefaultModel(dm);

  // expand $refs AFTER merge (so merge-composed arrays + set-injected tokens are both checked)
  expandRefs(cfg, "settings.json", errors);

  return { config: cfg, errors };
}

/** Load the FULL subagent config + collected errors, cached for the session (invalidated on
 *  session_start). Hot path is O(1): the flag guard returns before any disk I/O. Never throws. */
export function loadSubagentConfig(
  globalDir: string | null,
  cwd: string,
): { config: SubagentConfig; errors: string[] } {
  if (_configLoaded) return { config: _config, errors: _cachedErrors };
  const sections = readSections(globalDir, cwd);
  const built = buildConfig(sections);
  _config = built.config;
  _cachedErrors = built.errors;
  _configLoaded = true;
  // On a cache miss, surface collected errors to the log. The model-resolution path only
  // reads the model projection and would otherwise silently ignore a malformed config; the
  // enforcement path additionally reads `errors` directly and throws.
  for (const e of _cachedErrors) moduleLog.warn(e);
  moduleLog.info(
    `Subagent config loaded: ${Object.keys(_config["subagent-models"] ?? {}).length} subagent-models, ${Object.keys(_config["subagent-tools"] ?? {}).length} subagent-tools${_cachedErrors.length ? `, ${_cachedErrors.length} config error(s)` : ""}`,
  );
  return { config: _config, errors: _cachedErrors };
}

/** Load only the model-routing projection (subagent-models + default-model), cached.
 *  Kept as a separate function so the model-resolution path and its test mock are untouched
 *  by the new keys. Returns the SAME cached config object reference on cache
 *  hits (the SubagentModelConfig view is structural — extra keys are invisible to model
 *  consumers, and reference identity is preserved). */
export function loadSubagentModelConfig(globalDir: string | null, cwd: string): SubagentModelConfig {
  loadSubagentConfig(globalDir, cwd);
  return _config;
}

/** Invalidate the cache (e.g. on session_start) so the next load re-reads disk. */
export function invalidateSubagentConfig(): void {
  _configLoaded = false;
}

/** Reset the cache entirely (test helper). */
export function _resetSubagentConfig(): void {
  _config = emptyConfig();
  _cachedErrors = [];
  _configLoaded = false;
}
