// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Fork logic for subagent sessions.
 *
 * Handles building fork instructions, creating forked tasks,
 * and registering a tool_call guard to restrict tools in forked sessions.
 *
 * The fork guard (registerForkToolGuard) is the fork-mode enforcement counterpart to the
 * fresh-mode setActiveTools path. A fork child inherits the parent's
 * FROZEN system prompt (with all tool definitions baked in for cache reuse), so it cannot
 * rebuild the prompt via setActiveTools without breaking the cache. Instead the guard matches
 * the effective tool set at call time against event.toolName (never enumerates getAllTools).
 */

import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { log } from "./log.js";
import { compileGlob, isGlob } from "./model-resolution.js";
import { deriveBase, failClosed, getValidatedPolicy } from "./tool-enforcement.js";

const moduleLog = log.child("fork");

/**
 * Suffix convention for fork-context agents.
 * Agents whose name ends with this suffix automatically receive a branched
 * session (inheriting the parent's conversation history) instead of starting
 * fresh.
 */
const FORK_AGENT_SUFFIX = "-fork";

/** Get the fork suffix constant. */
export function getForkAgentSuffix(): string {
  return FORK_AGENT_SUFFIX;
}

/**
 * Apply the -fork suffix for plain "fork" mode (PI_SUBAGENT_FORK_MODE=fork), so the
 * agent name encodes fork-ness and config glob matching (*-fork) can route it to
 * fork-safe model lists. Idempotent: a name already ending in -fork is returned
 * unchanged (prevents foo-fork-fork). No-op in new+fork mode (createForkedTask
 * already appends the suffix via duplication) or when fork mode is unset/other.
 */
export function applyForkSuffix(agentName: string, forkMode: string | undefined): string {
  if (forkMode !== "fork") return agentName;
  if (agentName.endsWith(FORK_AGENT_SUFFIX)) return agentName;
  return agentName + FORK_AGENT_SUFFIX;
}

/** Escape XML special characters in text content.
 * Used to prevent injection/breakage in <fork-agent-context> and <fork-task> XML blocks. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build a fork instruction message for cache-optimized forked subagents.
 * Packs the agent's system prompt and task into structured XML blocks
 * that become the last user message.
 *
 * The tool-restriction preamble is advisory (frontmatter-based); the authoritative
 * restriction is enforced at call time by the tool_call guard (registerForkToolGuard),
 * which composes the effective set from the validated policy + forwarded frontmatter tools.
 */
export function buildForkInstruction(agent: AgentConfig, task: string): string {
  const parts: string[] = [];

  // Session context — always present
  parts.push(
    "You are in a forked session with access to all conversation history. " +
      "You have access to all tools from the parent session, but per your role restrict yourself to: " +
      (agent.tools && agent.tools.length > 0 ? agent.tools.join(", ") : "all tools (no restriction specified)") +
      ".",
  );

  if (agent.systemPrompt.trim()) {
    parts.push(
      `<fork-agent-context role="${escapeXml(agent.name)}">\n\n${escapeXml(agent.systemPrompt)}\n\n</fork-agent-context>`,
    );
  }

  parts.push(`<fork-task>\n\n${escapeXml(task)}\n\n</fork-task>`);

  return parts.join("\n\n");
}

/**
 * Regex to match report file paths that need -fork suffix adjustment.
 * Used by createForkedTask and tests.
 */
export const REPORT_FILE_FORK_REGEX =
  /(-review-\d+-[\w-]+|-plan-review-\d+|-design-review-\d+|-plan-review|-design-review)\.md/g;

/**
 * Create a forked variant of a task for new+fork mode.
 * Adjusts report file paths with -fork suffix.
 */
export function createForkedTask(
  agentName: string,
  task: string,
  cwd: string | undefined,
): { agent: string; task: string; cwd?: string } {
  const forkedName = agentName + FORK_AGENT_SUFFIX;
  // Match report file paths and add -fork suffix
  const forkedTask = task.replace(REPORT_FILE_FORK_REGEX, "$1-fork.md");
  return { agent: forkedName, task: forkedTask, cwd };
}

/** Minimal structural shape of an ExtensionAPI, scoped to just the `on` registration the fork
 *  guard needs. Deliberately does NOT declare getAllTools — fork enforcement matches tool
 *  names at call time and never enumerates the tool registry. */
export interface ForkGuardPi {
  on: (
    event: "tool_call",
    handler: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallEventResult | undefined,
  ) => void;
}

/** A predicate over a tool name: true = allowed, false = blocked. */
type ToolPredicate = (toolName: string) => boolean;

// Injectable validated-policy getter (tests override to simulate a composition/resolution
// throw). Default delegates to the real cross-module stash reader.
let _getValidatedPolicy: () => ReturnType<typeof getValidatedPolicy> = getValidatedPolicy;

/** @internal Test seam: override the validated-policy getter. */
export function _setGetValidatedPolicy(fn: () => ReturnType<typeof getValidatedPolicy>): void {
  _getValidatedPolicy = fn;
}

/** @internal Test seam: restore the real validated-policy getter. */
export function _resetForkGuardDeps(): void {
  _getValidatedPolicy = getValidatedPolicy;
}

/**
 * Register a tool_call handler that restricts which tools a forked subagent can invoke.
 *
 * Activation gate: the guard is registered at factory time and runs in every process, so it
 * MUST short-circuit (register no handler) unless PI_SUBAGENT_IS_FORK=1. Without this gate a
 * *:{block:[bash]} policy would block bash in the TOP-LEVEL session — compileGlob("*") matches
 * the empty string (CHILD_AGENT unset), violating "the top-level session is never
 * self-restricted". Fresh children are also exempt (they enforce via session_start setActiveTools).
 *
 * Lazy composition + cache: the effective set is composed at the FIRST tool_call from the
 * validated policy stashed at session_start (the contradiction check already ran there — never re-thrown here)
 * and cached for the process lifetime. Tokens (literals / globs / $all) are matched at call
 * time against event.toolName — no getAllTools enumeration.
 */
export function registerForkToolGuard(pi: ForkGuardPi): void {
  // Activation gate: only fork children enforce via the guard.
  if (process.env.PI_SUBAGENT_IS_FORK !== "1") return;

  let predicate: ToolPredicate | undefined; // closure-scoped, composed once at first tool_call

  pi.on("tool_call", (event, _ctx) => {
    if (!predicate) {
      try {
        predicate = composeForkPredicate();
      } catch (e) {
        // emitToolCall is uncaught; a raw throw would degrade per-call (beforeToolCall re-throws)
        // instead of failing closed. Match the enforcement-failure tier: stderr + exit so the
        // child is never left unrestricted.
        failClosed(e);
      }
    }
    // Wrap the EVALUATION too: an unexpected throw while matching event.toolName against the
    // effective set must fail CLOSED (stderr + exit), not degrade per-call. emitToolCall is
    // uncaught, so a raw throw would re-throw via beforeToolCall on every call, leaving the
    // child unrestricted between failures. The composition try/catch above does not cover this.
    let allowed = false;
    try {
      allowed = predicate(event.toolName);
    } catch (e) {
      failClosed(e);
    }
    if (allowed) return undefined; // allowed

    moduleLog.warn(`Fork tool guard blocked: ${event.toolName}`);
    return {
      block: true,
      reason: `Tool '${event.toolName}' is restricted by the fork tool policy.`,
    };
  });
}

/**
 * Compose the effective-set predicate for this fork child. Reads the validated policy stashed
 * at session_start + the base derived from the forwarded env (PI_SUBAGENT_TOOLS [+ TOOLS_ADD]).
 *
 *  - degraded (validation failed) OR null stash (validation never ran) -> base-only.
 *  - only-mode -> allow iff a token in the only-set matches (base is IGNORED — only is absolute).
 *  - add/block-mode -> (base-allows OR add-matches) AND NOT block-matches.
 *
 * Base discrimination: a whitelistless agent ({kind:"all"}) yields an allow-all base
 * predicate WITHOUT enumerating getAllTools. Tokens are matched at call time: $all -> always,
 * glob -> compileGlob(token).test(name), literal -> exact equality.
 */
function composeForkPredicate(): ToolPredicate {
  const validated = _getValidatedPolicy();
  const degraded = validated === null || validated.degraded;
  const policy = degraded ? null : validated.policy;

  const base = deriveBase();
  // Base tokens are tool-name tokens matched as patterns (literals/globs), consistent with
  // fresh mode's expandTokens — NOT a literal `.includes` match (which would silently no-op a
  // glob in the frontmatter whitelist).
  const baseAllows: ToolPredicate = base.kind === "all" ? () => true : (name) => matchesAny(base.names, name);

  // No policy (degraded, or validation never ran) -> base-only.
  if (policy === null) return baseAllows;

  if (policy.mode === "only") {
    return (name) => matchesAny(policy.set, name);
  }

  // add/block-mode: (base-allows OR add-matches) AND NOT block-matches.
  return (name) => (baseAllows(name) || matchesAny(policy.add, name)) && !matchesAny(policy.block, name);
}

/** Does any token match `name`? $all -> always; glob -> regex; literal -> exact. */
function matchesAny(tokens: string[], name: string): boolean {
  return tokens.some((tok) => tokenMatches(tok, name));
}

function tokenMatches(token: string, name: string): boolean {
  if (token === "$all") return true; // matches every tool
  return isGlob(token) ? compileGlob(token).test(name) : token === name;
}
