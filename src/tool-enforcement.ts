// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Child-side tool-policy enforcement (session_start). Runs in EVERY child subagent
 * process (gated on PI_SUBAGENT_CHILD_AGENT), for BOTH fresh and fork modes.
 *
 * Pipeline:
 *  1. Validate the child's own policy (structural config errors + self-scoped
 *     contradiction via resolveToolPolicy) — runs at session_start for both modes.
 *     Stash the result so the fork guard (composed at first tool_call) reads it
 *     cross-module without re-validating.
 *  2. On validation failure -> degrade to base-only (the child keeps only its
 *     frontmatter base tools), THEN throw (pi runner catches -> emitError -> visible
 *     report).
 *  3. Fresh path -> enforce: derive base from env, expand tokens vs pi.getAllTools(),
 *     pi.setActiveTools(effective) (clean prompt + hard floor).
 *  4. Fork path -> RETURN after validation (guard enforces at first tool_call).
 *
 * Fail-closed: the enforcement step wraps setActiveTools in try/catch -> stderr +
 * log + process.exit(non-zero). Validation throws propagate to the pi runner (degrade).
 */

import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { AgentDiscoveryResult } from "./agents.js";
import { parseToolsAdd } from "./extra-tools.js";
import { log } from "./log.js";
import { compileGlob, isGlob } from "./model-resolution.js";
import type { SubagentConfig } from "./subagent-config.js";
import type { ResolvedPolicy, ResolveResult } from "./tool-resolution.js";

const moduleLog = log.child("tool-enforcement");

/** Minimal pi surface the enforcement path needs. */
export interface EnforcementPi {
  getAllTools(): ToolInfo[];
  setActiveTools(toolNames: string[]): void;
}

/** Discriminated base the child derives from the env the parent forwarded. */
export type Base = { kind: "concrete"; names: string[] } | { kind: "all" };

/** The stashed validated result the fork guard reads at first tool_call. */
export interface ValidatedPolicy {
  policy: ResolvedPolicy | null;
  degraded: boolean;
}

// Module-level stash. Set once at session_start; read by the fork guard at first
// tool_call. Process-lifetime (reset on extension reload via session_start re-run).
let _validatedPolicy: ValidatedPolicy | null = null;

/** Runtime getter: the fork guard reads the stashed validated result at first tool_call. */
export function getValidatedPolicy(): ValidatedPolicy | null {
  return _validatedPolicy;
}

/** @internal Test seam: stage the validated result (used by the fork-guard tests to avoid
 *  running the full session_start pipeline). */
export function _setValidatedPolicy(result: ValidatedPolicy | null): void {
  _validatedPolicy = result;
}

/** Config loader injected by the caller, so there is a SINGLE config-loader seam in the
 *  process (also consumed by buildDescription). Passing it as a parameter keeps enforcement
 *  from re-reading config behind a second hidden module seam. */
export type LoadSubagentConfig = (globalDir: string, cwd: string) => { config: SubagentConfig; errors: string[] };

/** Injected resolver (the pure `resolveToolPolicy` in production; overridable in tests). Wrapping it
 *  here (not behind a second hidden module seam) mirrors the loadConfig injection and lets tests
 *  force a resolver throw for the fail-closed defense test. */
export type ResolveToolPolicy = (
  config: SubagentConfig,
  agentName: string,
  discoveredAgentNames: string[],
) => ResolveResult;

/** @internal Test seam: clear module state (the validated-policy stash read by the fork guard). */
export function _resetToolEnforcementState(): void {
  _validatedPolicy = null;
}

/**
 * Derive the base tool set from the env the parent forwarded. Reads env ONLY — MUST NOT
 * call getAllTools (the fork guard reuses this and maps {kind:"all"} to an allow-all
 * predicate without enumerating tools).
 *
 *  - PI_SUBAGENT_TOOLS unset (whitelistless agent) -> {kind:"all"}
 *  - PI_SUBAGENT_TOOLS set -> {kind:"concrete", names = (TOOLS ∪ TOOLS_ADD) parsed}
 */
export function deriveBase(): Base {
  const tools = process.env.PI_SUBAGENT_TOOLS;
  if (tools === undefined) return { kind: "all" };
  const joined = [tools, process.env.PI_SUBAGENT_TOOLS_ADD].filter(Boolean).join(",");
  return { kind: "concrete", names: parseToolsAdd(joined) };
}

/**
 * session_start enforcement pipeline. No-op unless PI_SUBAGENT_CHILD_AGENT is set
 * (the top-level interactive session is never self-restricted).
 *
 * `loadConfig` is injected by the caller — the SINGLE config-loader seam in the process
 * (also consumed by buildDescription). Tests inject an in-memory loader directly here.
 */
export function enforceChildToolPolicy(
  pi: EnforcementPi,
  discovery: AgentDiscoveryResult,
  globalSettingsDir: string,
  loadConfig: LoadSubagentConfig,
  resolvePolicy: ResolveToolPolicy,
): void {
  // Gate: only spawned children self-restrict (the top-level interactive session is
  // never self-restricted).
  const childAgent = process.env.PI_SUBAGENT_CHILD_AGENT;
  if (!childAgent) return;

  const isFork = process.env.PI_SUBAGENT_IS_FORK === "1";
  const discoveredAgentNames = discovery.agents.map((a) => a.name);

  // Structural validation: load config + collect structural errors (global + project — the global `*`
  // policy cascades at every depth, so the child reads both like the parent does).
  // The loader itself is wrapped: a throw inside the loader (e.g. a bug in config parsing) must
  // degrade to base-only + throw (fail-closed), NOT propagate raw — session_start would swallow a
  // raw throw and leave a fresh-mode child UNRESTRICTED (fail-open).
  let config: SubagentConfig;
  let phaseAErrors: string[];
  try {
    const loaded = loadConfig(globalSettingsDir, process.cwd());
    config = loaded.config;
    phaseAErrors = loaded.errors;
  } catch (e) {
    config = { "subagent-models": {}, "default-model": null };
    phaseAErrors = [`subagent config loader threw: ${e instanceof Error ? e.message : String(e)}`];
  }

  // Contradiction check: resolve this child's own policy (self-scoped contradiction check).
  // The resolver is wrapped: a raw throw here (e.g. a pathological glob tripping compileGlob)
  // is swallowed by session_start and would leave a fresh-mode child UNRESTRICTED (fail-open) —
  // the same fail-open consequence the loader wrap above guards against. Treat a resolver
  // throw as a validation failure so the degrade-to-base-only + visible-throw path applies.
  let policy: ResolvedPolicy | null;
  let phaseBError: string | null;
  let warnings: string[];
  try {
    ({ policy, phaseBError, warnings } = resolvePolicy(config, childAgent, discoveredAgentNames));
  } catch (e) {
    policy = null;
    phaseBError = `tool-policy resolver threw: ${e instanceof Error ? e.message : String(e)}`;
    warnings = [];
  }
  for (const w of warnings) moduleLog.warn(w);

  const hasValidationFailure = phaseAErrors.length > 0 || phaseBError !== null;

  // Stash the validated result (canonical shape). On failure, degraded.
  _validatedPolicy = { policy: hasValidationFailure ? null : policy, degraded: hasValidationFailure };

  // On validation failure -> degrade to base-only, then throw (visible report).
  if (hasValidationFailure) {
    const reasons = [...phaseAErrors, ...(phaseBError ? [phaseBError] : [])];
    degradeAndThrow(pi, isFork, reasons.join("; ")); // always throws
  }

  // Fork path: validation done — the fork guard composes+enforces at first tool_call.
  if (isFork) return;

  // Fresh path: enforce now (clean prompt + hard floor), fail-closed. policy is non-null here
  // (the null contract: policy is null IFF phaseBError set; we passed the validation check).
  if (policy) enforceFreshFailClosed(pi, policy);
}

/** Degrade to base-only (the child keeps only its frontmatter base tools), then surface the error.
 *  Fresh: setActiveTools(base) fail-closed, then throw. Fork: stash degraded, then throw (guard
 *  composes base-only). */
function degradeAndThrow(pi: EnforcementPi, isFork: boolean, reason: string): void {
  if (!isFork) {
    // Fresh: apply base-only so the child is not unrestricted, fail-closed.
    try {
      pi.setActiveTools(deriveExpandedBase(pi.getAllTools().map((t) => t.name)));
    } catch (e) {
      failClosed(e);
    }
  }
  // Both modes throw so the pi runner reports the validation failure visibly.
  throw new Error(`subagent tool-policy validation failed: ${reason}`);
}

/** Fresh enforcement: expand base + policy tokens, compute the effective set, setActiveTools.
 *  Fail-closed: any exception -> stderr + log + process.exit(non-zero). */
function enforceFreshFailClosed(pi: EnforcementPi, policy: ResolvedPolicy): void {
  try {
    const allToolNames = pi.getAllTools().map((t) => t.name);
    const expandedBase = deriveExpandedBase(allToolNames);

    let effective: string[];
    if (policy.mode === "only") {
      effective = expandTokens(policy.set, allToolNames);
    } else {
      const expandedAdd = expandTokens(policy.add, allToolNames);
      const expandedBlock = expandTokens(policy.block, allToolNames);
      effective = minus(union(expandedBase, expandedAdd), expandedBlock);
    }
    pi.setActiveTools(effective);
  } catch (e) {
    failClosed(e);
  }
}

/** Derive the base (frontmatter ∪ TOOLS_ADD) and expand it against the known tool names.
 *  Shared by the degrade and fresh enforcement paths. */
function deriveExpandedBase(allToolNames: string[]): string[] {
  return expandBase(deriveBase(), allToolNames);
}

/** Expand a discriminated base to concrete tool names. {kind:"all"} -> allToolNames;
 *  {kind:"concrete"} -> expand each name/glob against allToolNames. */
function expandBase(base: Base, allToolNames: string[]): string[] {
  if (base.kind === "all") return [...allToolNames];
  return expandTokens(base.names, allToolNames);
}

/** Expand an array of tool tokens (literals / globs / $all) against the known tool names.
 *  `$all` -> every tool; a glob -> all matching; a literal -> itself (if present). */
function expandTokens(tokens: string[], allToolNames: string[]): string[] {
  const out = new Set<string>();
  for (const tok of tokens) {
    if (tok === "$all") {
      for (const n of allToolNames) out.add(n);
    } else if (isGlob(tok)) {
      const re = compileGlob(tok);
      for (const n of allToolNames) if (re.test(n)) out.add(n);
    } else if (allToolNames.includes(tok)) {
      out.add(tok);
    }
  }
  return [...out];
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function minus(a: string[], b: string[]): string[] {
  const block = new Set(b);
  return a.filter((n) => !block.has(n));
}

/** Hard-stop the process: write to stderr + log, then exit non-zero. Required for
 *  session_start failures where a raw throw would be swallowed by the pi runner (making
 *  a follow-up process.exit unreachable). Shared by enforcement failure and the agent-name
 *  collision hard-stop — the same session_start hard-stop tier. */
export function hardStop(message: string, cause: unknown): never {
  process.stderr.write(`${message}\n`);
  log.error(message, cause);
  process.exit(1);
}

/** Fail-closed: the enforcement contract. Write to stderr + log, then exit non-zero.
 *  Shared by the fresh session_start path AND the fork guard (same enforcement-failure tier). */
export function failClosed(e: unknown): never {
  hardStop(`subagent tool-policy enforcement failed: ${e instanceof Error ? e.message : String(e)}`, e);
}
