// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Glob + specificity matching and per-matched-key rotation for the
 * `subagent-models` config (Phase 1 of the layered resolution).
 *
 * Matching (no special `-fork` logic — the suffix is just characters in the
 * agent name, so `*-fork` naturally wins over `*` on specificity):
 *  1. exact key (no wildcard) always wins over any glob;
 *  2. among globs: most literal (non-`*`) characters wins;
 *  3. tie on literal count → longest total key length wins;
 *  4. tie on length → declaration (config) order wins.
 *
 * Rotation: the counter is keyed by the WINNING matched config key (e.g. `*-fork`
 * or `plan-reviewer-fork`), not the agent name, so all agents matching the same
 * glob share one rotation pool (load-balancing across the array), while each
 * exact key has its own independent pool. Single-string (non-array) overrides
 * bypass rotation entirely (no counter advance). The counter lives on
 * `globalThis` so it survives module re-import during /reload but resets on a
 * full pi process restart (+ appendix user decision).
 */

import type { ModelOverride, SubagentModelConfig } from "./subagent-config.js";

// --- glob engine ---
export function isGlob(key: string): boolean {
  return key.includes("*");
}

// Memoize compiled globs: config keys are immutable for the config's lifetime, and
// findMatch calls compileGlob once per glob key per task (up to N*K per parallel
// batch). The cache avoids re-compiling the same regex on every task.
// Deliberate asymmetry vs. the config cache (invalidated on session_start because its backing
// disk content can change): regex compilation is a PURE function of the key string, so a
// cached entry is valid forever and the cache is bounded by the distinct glob-key
// count (typically <20). There is nothing to invalidate — unlike the config cache.
// So _globCache intentionally persists across
// session_start/reload and only dies on process restart. _resetGlobCache below is a
// test-only seam for symmetry with _resetRotationCounters; production never calls it.
const _globCache = new Map<string, RegExp>();

// Regex-special characters to escape in glob keys (everything except `*`). Hoisted to
// module scope so a fresh RegExp isn't allocated on every cache miss — it's a pure
// constant. See compileGlob for the full character-class explanation.
const SPECIAL_CHARS = /[.+?^${}()|[\]\\]/g;

export function compileGlob(key: string): RegExp {
  const cached = _globCache.get(key);
  if (cached) return cached;
  // Escape every regex-special character EXCEPT `*` (so only `*` is a wildcard),
  // then turn `*` into `.*` and anchor as a full match.
  // Character class: [.+?^${}|[\\] — '.', '+', '?', '^', '$', '{', '}',
  // '(', ')', '|', '[', ']', '\\'. The closing ']' of the class stays unescaped
  // (escaping it as \\] would prevent the class from terminating).
  const escaped = key.replace(SPECIAL_CHARS, "\\$&").replace(/\*/g, ".*");
  const re = new RegExp(`^${escaped}$`);
  _globCache.set(key, re);
  return re;
}

/** Count non-`*` (literal) characters in a key — the primary glob-specificity signal. */
function globLiteralLength(key: string): number {
  // Indexed loop (avoids a per-call iterator allocation that for...of would create).
  let n = 0;
  for (let i = 0; i < key.length; i++) if (key[i] !== "*") n++;
  return n;
}

interface Match {
  key: string;
  isExact: boolean;
  literalLen: number;
  totalLen: number;
}

// Precomputed specificity-sorted key list, memoized per config object. The sort
// ordering is a PURE function of the config keys (isExact, literalLen, totalLen
// none depend on agentName), so it can be computed once per config and reused for
// every Phase-1 resolution in the session. Keyed by the config object identity: a
// config is reference-stable for the session (loadSubagentModelConfig returns the
// same cached object; buildConfig runs only on cache miss), and on session_start
// invalidation a NEW config object is built, so the stale entry becomes eligible
// for GC (WeakMap auto-collects it) — no manual invalidation needed.
// NOTE: unlike _globCache (which exposes a _resetGlobCache test seam), this WeakMap
// deliberately has NO test reset seam. Test isolation is automatic: every test
// constructs a fresh config object via cfg/makeSubagentConfig, which is a distinct
// WeakMap key, so stale entries from a prior test's config can never be hit (they
// GC once that config object goes out of scope). A manual _resetSortedKeysCache
// seam would be unused by production AND unused by tests (automatic isolation makes
// it unnecessary), so knip would flag it as dead code — hence omitted.
const _sortedKeysCache = new WeakMap<SubagentModelConfig, Match[]>();

/** Rank keys by the 4-tier specificity rule (most-specific first), preserving declaration
 *  order on ties (stable sort). Pure function of the key strings — config-agnostic, so any
 *  caller matching glob keys (exact > most-literal > longest > declaration-order) can reuse it.
 *  Tier 1: exact (non-glob) keys before globs; Tier 2: most literal (non-`*`) chars;
 *  Tier 3: longest total length; Tier 4: declaration order. */
export function rankBySpecificity(keys: string[]): string[] {
  return rankMatchesBySpecificity(keys).map((m) => m.key);
}

/** Compute the specificity triple per key and sort most-specific first (stable). The shared
 *  core of `rankBySpecificity` (keys only) and `getSortedKeys` (full triples, cached). */
function rankMatchesBySpecificity(keys: string[]): Match[] {
  const ranked = keys.map((key) => ({
    key,
    isExact: !isGlob(key),
    literalLen: globLiteralLength(key),
    totalLen: key.length,
  }));
  ranked.sort((a, b) => {
    if (a.isExact !== b.isExact) return a.isExact ? -1 : 1;
    if (a.literalLen !== b.literalLen) return b.literalLen - a.literalLen;
    if (a.totalLen !== b.totalLen) return b.totalLen - a.totalLen;
    return 0; // decl-order tiebreak preserved by stable sort
  });
  return ranked;
}

/** Compute (once per config) the keys of `subagent-models` pre-sorted by specificity:
 *  exact first, then most literal, then longest. Declaration order is preserved by
 *  Object.keys iteration and is the implicit final tiebreak (stable sort). */
function getSortedKeys(config: SubagentModelConfig): Match[] {
  const cached = _sortedKeysCache.get(config);
  if (cached) return cached;
  const sorted = rankMatchesBySpecificity(Object.keys(config["subagent-models"]));
  _sortedKeysCache.set(config, sorted);
  return sorted;
}

/** Find the single winning config key for `agentName` under the specificity rules.
 *  Zero-allocation hot path: iterates the precomputed sorted key list in specificity
 *  order and returns the first whose pattern matches. */
function findMatch(agentName: string, config: SubagentModelConfig): string | null {
  const sorted = getSortedKeys(config);
  for (let i = 0; i < sorted.length; i++) {
    const { key, isExact } = sorted[i];
    const hit = isExact ? key === agentName : compileGlob(key).test(agentName);
    if (hit) return key;
  }
  return null;
}

// --- per-matched-key rotation counter on globalThis ---
// Mirrors the codebase globalThis convention (src/extension.ts): typed cast,
// `?? new Map` init, then a stable local reference. Survives /reload; dies on
// process restart.
const _gt = globalThis as {
  __piSubagentRotation?: Map<string, number>;
};
_gt.__piSubagentRotation = _gt.__piSubagentRotation ?? new Map<string, number>();
const rotation: Map<string, number> = _gt.__piSubagentRotation;

/** Reset all rotation counters (test helper). */
export function _resetRotationCounters(): void {
  rotation.clear();
}

/** @internal Test-only seam: clear the glob-compile cache. Production never needs
 *  this (cached regexes are valid forever — see _globCache comment), but tests
 *  that assert on cache behavior call it for isolation, mirroring _resetRotationCounters. */
export function _resetGlobCache(): void {
  _globCache.clear();
}

/** @internal Test-only seam: number of compiled globs currently cached. Lets tests
 *  assert memoization (a key compiled once is reused, not recompiled per resolve). */
export function _getGlobCacheSize(): number {
  return _globCache.size;
}

/** Pick from an override, rotating once per call when it is an array, keyed by `matchedKey`. */
function pickRotated(override: ModelOverride, matchedKey: string): string | undefined {
  if (!Array.isArray(override)) return override; // single string: no rotation, no counter advance
  if (override.length === 0) return undefined; // validation skips empties, but guard anyway
  const current = rotation.get(matchedKey) ?? 0;
  rotation.set(matchedKey, current + 1);
  return override[current % override.length];
}

/**
 * Resolve a subagent's model for Phase 1: match the agent name against the
 * `subagent-models` keys via specificity, then pick (rotating arrays). Returns
 * `undefined` when no key matches (so the layered resolver can fall through to
 * the next phase — ).
 */
export function resolveSubagentModel(agentName: string, config: SubagentModelConfig): string | undefined {
  // matchedKey is always a key present in config["subagent-models"] (findMatch
  // iterates Object.keys), so the lookup below is never undefined — no guard needed.
  const matchedKey = findMatch(agentName, config);
  if (matchedKey === null) return undefined;
  return pickRotated(config["subagent-models"][matchedKey], matchedKey);
}

/** A registered model-resolution hook (Phase 2), as exposed by addModelResolver.
 *
 *  INVARIANT: `explicitModel` is ALWAYS `undefined` when a hook is invoked. Phase 0
 *  of `resolveModelLayered` short-circuits on a truthy explicit `--model` param
 *  BEFORE any Phase 2 hook runs, so hooks are only reached when no explicit model
 *  was passed. The field remains in the context type for API stability, but hooks
 *  MUST NOT branch on it (doing so would re-implement Phase 0's job and is dead
 *  logic — see known-issue ). A Phase 2 hook should resolve purely from the
 *  agent name / external state. */
export type ModelResolverHook = (ctx: { agentName: string; explicitModel: string | undefined }) => string | undefined;

/**
 * The synchronous 5-phase precedence core that the `resolveModelForAgent`
 * closure delegates to. Extracted so the precedence ordering is directly testable
 * (the dispatch tests exercise the real closure via spawning, but cannot assert
 * phase order; this function lets a unit test pin it).
 *
 *  Phase 0: explicit `--model` param short-circuits.
 *  Phase 1: built-in subagent-models match (highest config priority).
 *  Phase 2: registered hooks, first-wins.
 *  Phase 3: built-in subagent default-model.
 *  Phase 4: fall through (return undefined; process-runner applies agent.model ?? parentModel).
 *
 * `modelConfig` and `hooks` are passed in (no settings.json disk read here — that
 * happens in the closure before calling this). NOTE: Phase 1 array matching DOES
 * advance the per-key rotation counter on globalThis (intended side effect, see
 * pickRotated); single-string matches and misses are side-effect-free.
 */
export function resolveModelLayered(
  agentName: string,
  explicitModel: string | undefined,
  modelConfig: SubagentModelConfig,
  hooks: readonly ModelResolverHook[],
): string | undefined {
  // Phase 0: explicit --model param short-circuits everything.
  if (explicitModel) return explicitModel;
  // Phase 1: built-in subagent-models match (highest config priority).
  const phase1 = resolveSubagentModel(agentName, modelConfig);
  if (phase1 !== undefined) return phase1;
  // Phase 2: registered hooks, first-wins.
  for (const resolver of hooks) {
    const result = resolver({ agentName, explicitModel });
    if (result !== undefined) return result;
  }
  // Phase 3: built-in subagent default-model.
  if (modelConfig["default-model"]) return modelConfig["default-model"];
  // Phase 4: fall through to agent.model ?? parentModel (process-runner.ts).
  return undefined;
}
