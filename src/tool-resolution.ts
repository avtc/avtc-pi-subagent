// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * PURE tool-policy resolution (Dimension 2). No I/O, no env access, no process.*.
 *
 * Input: the merged `SubagentConfig` (subagent-tools / hidden-agents / disabled-agents),
 * an agent name (the BASE name — `PI_SUBAGENT_CHILD_AGENT`), and the discovered agent
 * names (for the lint). Output: a resolved policy whose tokens are OPAQUE (literals,
 * tool-name globs, and the `$all` sentinel pass through unchanged — `base`/expansion is
 * the enforcement path's concern, not the resolver's.
 *
 * Modes (the `only`-absolute rule):
 *  - only-mode (>=1 matching key has `only`): no matching key may have add/block (else
 *  contradiction -> policy null + phaseBError); else result = the MOST-SPECIFIC
 *  matching `only` set.
 *  - add/block-mode (no matching key has `only`): walk matching keys least->most-specific
 *  with precedence-aware cancellation (a more-specific add cancels a less-specific block
 *  on the same token, and vice versa); most-specific applies last -> wins.
 *
 * NULL CONTRACT: `policy` is null IFF `phaseBError` is set. For no config / no matching
 * pattern -> NON-null `{mode:"addblock", add:[], block:[]}` (composes to base-only); NEVER
 * null, NEVER throws.
 */

import { compileGlob, isGlob, rankBySpecificity } from "./model-resolution.js";
import type { SubagentConfig, ToolPolicy } from "./subagent-config.js";

export type ResolvedPolicy = { mode: "only"; set: string[] } | { mode: "addblock"; add: string[]; block: string[] };

export interface ResolveResult {
  policy: ResolvedPolicy | null;
  warnings: string[];
  phaseBError: string | null;
}

const emptyAddBlockPolicy = (): ResolvedPolicy => ({ mode: "addblock", add: [], block: [] });

/** Does `agentName` match a config key (exact, or glob pattern)? */
function matchesKey(key: string, agentName: string): boolean {
  return isGlob(key) ? compileGlob(key).test(agentName) : key === agentName;
}

/**
 * Resolve the tool policy for `agentName` against the merged config. PURE (no I/O/env).
 * `discoveredAgentNames` is used only for the lint (globs matching zero agents -> warn).
 */
export function resolveToolPolicy(
  config: SubagentConfig,
  agentName: string,
  discoveredAgentNames: string[],
): ResolveResult {
  const tools = config["subagent-tools"] ?? {};

  //  lint (config-wide): an agent-name GLOB matching zero discovered agents is likely a typo.
  const warnings = collectUnusedGlobWarnings(config, discoveredAgentNames);

  // Find matching keys, ranked most-specific-first.
  const matchingKeys = rankBySpecificity(Object.keys(tools)).filter((k) => matchesKey(k, agentName));

  if (matchingKeys.length === 0) {
    return { policy: emptyAddBlockPolicy(), warnings, phaseBError: null };
  }

  // Split into only-keys and add/block-keys among the matching set.
  const onlyKeys = matchingKeys.filter((k) => tools[k].only !== undefined);
  const addBlockKeys = matchingKeys.filter((k) => tools[k].add !== undefined || tools[k].block !== undefined);

  // only-absolute rule: any matching only AND any matching add/block -> contradiction.
  if (onlyKeys.length > 0 && addBlockKeys.length > 0) {
    const phaseBError =
      `subagent-tools: "${agentName}" matches both an "only" pattern (${onlyKeys
        .map((k) => `"${k}"`)
        .join(", ")}) and an "add"/"block" pattern (${addBlockKeys.map((k) => `"${k}"`).join(", ")}); ` +
      `"only" is terminal/absolute — use "only" at the relevant level, or "add"/"block" at every level`;
    return { policy: null, warnings, phaseBError };
  }

  // only-mode: most-specific matching only set (onlyKeys is most-specific-first).
  if (onlyKeys.length > 0) {
    const set = [...(tools[onlyKeys[0]].only ?? [])];
    return { policy: { mode: "only", set }, warnings, phaseBError: null };
  }

  // add/block-mode: precedence-aware cancellation walk, least->most-specific.
  return { policy: composeAddBlock(matchingKeys, tools), warnings, phaseBError: null };
}

/**
 * Walk matching keys LEAST->most-specific, maintaining addSet/blockSet with cancellation:
 * a more-specific key's add removes the token from blockSet (cancels the less-specific
 * block), and a more-specific block removes it from addSet. Most-specific applies last.
 * Within a single key, add is applied before block (so block wins within an entry),
 * mirroring the formula `working = (working ∪ key.add) − key.block`.
 */
function composeAddBlock(matchingKeys: string[], tools: Record<string, ToolPolicy>): ResolvedPolicy {
  const addSet = new Set<string>();
  const blockSet = new Set<string>();
  // matchingKeys is most-specific-first; iterate least-first (reverse).
  for (let i = matchingKeys.length - 1; i >= 0; i--) {
    const policy = tools[matchingKeys[i]];
    // add then block (with cancellation), within this key.
    for (const tok of policy.add ?? []) {
      addSet.add(tok);
      blockSet.delete(tok); // more-specific add cancels less-specific block
    }
    for (const tok of policy.block ?? []) {
      blockSet.add(tok);
      addSet.delete(tok); // more-specific block cancels less-specific add
    }
  }
  return { mode: "addblock", add: [...addSet], block: [...blockSet] };
}

/** lint: warn about agent-name globs (in subagent-tools/hidden/disabled) matching zero
 *  discovered agents. Lint-only — never throws.  */
function collectUnusedGlobWarnings(config: SubagentConfig, discoveredAgentNames: string[]): string[] {
  const warnings: string[] = [];
  const globsByKey = collectAgentGlobs(config);
  for (const [section, globs] of Object.entries(globsByKey)) {
    for (const g of globs) {
      const anyMatch = discoveredAgentNames.some((name) => compileGlob(g).test(name));
      if (!anyMatch) {
        warnings.push(`${section}: glob "${g}" matches no discovered agent (likely a typo)`);
      }
    }
  }
  return warnings;
}

/** Collect agent-name globs (not exact keys) across the three agent-keyed config sections. */
function collectAgentGlobs(config: SubagentConfig): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const tools = config["subagent-tools"] ?? {};
  const toolGlobs = Object.keys(tools).filter(isGlob);
  if (toolGlobs.length) out["subagent-tools"] = toolGlobs;
  const hidden = (config["hidden-agents"] ?? []).filter(isGlob);
  if (hidden.length) out["hidden-agents"] = hidden;
  const disabled = (config["disabled-agents"] ?? []).filter(isGlob);
  if (disabled.length) out["disabled-agents"] = disabled;
  return out;
}
