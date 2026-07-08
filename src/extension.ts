// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Pi-subagent standalone extension entry point.
 *
 * Loaded by pi directly from package.json "pi" section.
 * Emits `pi-subagent:ready` event with add* API for host configuration.
 *
 * Merged from index.ts (tool registration) + extension.ts (settings,:ready event).
 * No circular dependencies - everything is in one file.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { AgentConfig, AgentDiscoveryResult } from "./agents.js";
import {
  discoverAgents as _realDiscoverAgents,
  findNearestDotPiSubdir as _realFindNearestDotPiSubdir,
  _resetAgentsPaths,
  _resetUserAgentsDir,
  addAgentsPaths,
  isVisible,
} from "./agents.js";
import { detectIntegrationCollisions, formatCollisionMessage } from "./collision-detection.js";
import { ConcurrencyGate, getSubagentConcurrency } from "./concurrency.js";
import {
  _resetForkGuardDeps,
  applyForkSuffix,
  buildForkInstruction,
  createForkedTask,
  escapeXml,
  getForkAgentSuffix,
  REPORT_FILE_FORK_REGEX,
  registerForkToolGuard,
} from "./fork.js";
import { _modelResolvers, _promptTransformers } from "./hooks.js";
import { getParentPid, ParentWatchdog, ProcessRegistry } from "./lifecycle.js";
import { log, NO_ERROR } from "./log.js";
import { type ModelResolverHook, resolveModelLayered } from "./model-resolution.js";
import {
  _resetFs,
  _resetSpawn,
  _setFs,
  _setSpawn,
  getSubagentSessionFile,
  mapWithConcurrencyLimit,
  NO_STEP,
  type RunSingleAgentOptions,
  runSingleAgent,
} from "./process-runner.js";
import {
  COLLAPSED_TOOL_COUNT_SINGLE,
  COLLAPSED_TOOL_COUNT_STEP,
  createDefaultProgress,
  createPlaceholderResult,
  createThrottle,
  extractChildrenFromResults,
  extractLastMessage,
  extractLastProseLines,
  findCompactingEvent,
  findToolEventByCallId,
  findToolEventByCallIdRecursive,
  getActiveNestedChild,
  isCodeFence,
  isTestCommand,
  MAX_RECENT_TOOLS,
  mergePlaceholderIntoChildren,
  pushToolEvent,
  resolveContextWindow,
  sanitizeMarkdownPreview,
} from "./progress-tracking.js";
import {
  extractLastMessageLine,
  extractToolArgsPreview,
  findLastToolEvent,
  formatDuration,
  formatTokens,
  formatUsageStats,
  getErrorLine,
  getTermWidth,
  renderAgentProgress,
  renderCallImpl,
  renderCompactAgentProgress,
  renderConfig,
  renderResultImpl,
  stripAnsi,
  stripControlChars,
  stripMarkdownInline,
  truncateTask,
  truncateThemedLine,
} from "./rendering.js";
import { _resetGetSubagentSettings, initSubagentSettings } from "./settings-ui.js";
import {
  _resetSkillResolution,
  addSkillPaths,
  injectSkills,
  readAndStripFrontmatter,
  resolveSkillContent,
} from "./skill-resolution.js";
import {
  _resetSubagentConfig,
  invalidateSubagentConfig,
  loadSubagentConfig,
  loadSubagentModelConfig,
} from "./subagent-config.js";
import { _resetToolEnforcementState, enforceChildToolPolicy, hardStop } from "./tool-enforcement.js";
import { resolveToolPolicy } from "./tool-resolution.js";
import type { SingleResult, SubagentDetails, ThemeLike } from "./types.js";
import { isResultError } from "./types.js";

/** globalThis flag guarding one-time wiring of the extension entry. The package may be both bundled
 *  into the avtc-pi umbrella and installed standalone; this sentinel prevents double-wiring when
 *  the same process loads it twice. Reload-safe: it resets on session_shutdown (see the entry), so
 *  a /reload (which re-evaluates the module fresh but preserves globalThis) can re-wire. */
const WIRED_KEY = "__avtcPiSubagentWired";
type GlobalWithWired = typeof globalThis & { [WIRED_KEY]?: boolean };

const MAX_PARALLEL_TASKS = 16;

/** Sentinel for buildDescription/refreshToolDescription's optional injected-discovery argument:
 *  pass this (not a bare `undefined`) at factory time when there is no discovery to inject (the
 *  function then discovers fresh). Named per the no-bare-literals convention. */
const NO_DISCOVERY_INJECTION: AgentDiscoveryResult | undefined = undefined;

// ── Injectable test hooks ──────────────────────────────────────────────────

/** Injectable discoverAgents — tests can override via _setDiscoverAgents */
let _discoverAgents: typeof _realDiscoverAgents = _realDiscoverAgents;

/** Per-cwd discovery cache. discoverAgents reads several directories (bundled + each
 *  integration path + project .pi/agents + user agents) on every call; the subagent tool calls
 *  it once per dispatch, so re-reading disk per dispatch is wasteful. Keyed by cwd (the
 *  overridable-cwd feature means ctx.cwd can differ from process.cwd()). Invalidated on
 *  session_start (where _agentsPaths is reset and :ready re-fires) and in the test reset hook. */
const _discoveryCache = new Map<string, AgentDiscoveryResult>();

function _cachedDiscover(cwd: string): AgentDiscoveryResult {
  const hit = _discoveryCache.get(cwd);
  if (hit) return hit;
  const result = _discoverAgents(cwd);
  _discoveryCache.set(cwd, result);
  return result;
}

/** @internal Invalidate the per-cwd discovery cache (session_start + test reset). */
export function _invalidateDiscoveryCache(): void {
  _discoveryCache.clear();
}
/** Injectable findNearestDotPiSubdir — tests can override via _setFindNearestDotPiSubdir */
let _findNearestDotPiSubdir: typeof _realFindNearestDotPiSubdir = _realFindNearestDotPiSubdir;

/** @internal Test hook to override discoverAgents */
export function _setDiscoverAgents(fn: typeof _realDiscoverAgents): void {
  _discoverAgents = fn;
  // A new discoverAgents function makes any cached result stale (the injection may return
  // different agents), so drop the cache whenever the seam is (re)installed.
  _invalidateDiscoveryCache();
}

export function _resetDiscoverAgents(): void {
  _discoverAgents = _realDiscoverAgents;
}

export function _setFindNearestDotPiSubdir(fn: typeof _realFindNearestDotPiSubdir): void {
  _findNearestDotPiSubdir = fn;
}

// Injectable subagent model-config loader (model projection from subagent-config) — tests override via _setLoadSubagentModelConfig
// so Phase 1/3 model resolution is deterministic and isolated from the developer's real
// ~/.pi/agent/settings.json (which may contain a live `avtc-pi-subagent` section).
let _loadSubagentModelConfig: typeof loadSubagentModelConfig = loadSubagentModelConfig;

/** @internal Test hook to override the subagent model-config loader (Phase 1/3 source). */
export function _setLoadSubagentModelConfig(fn: typeof loadSubagentModelConfig): void {
  _loadSubagentModelConfig = fn;
}

// Injectable FULL subagent-config loader (model projection + tool-policy + hidden/disabled
// agent globs) — tests override via _setLoadSubagentConfig so visibility-glob filtering is
// deterministic and isolated from the developer's real settings. In production this resolves
// to the cached loadSubagentConfig (cache HIT after first read — no repeated disk I/O across
// buildDescription / execute error paths).
let _loadSubagentConfig: typeof loadSubagentConfig = loadSubagentConfig;

/** @internal Test hook to override the full subagent-config loader (visibility globs source). */
export function _setLoadSubagentConfig(fn: typeof loadSubagentConfig): void {
  _loadSubagentConfig = fn;
}

/** Global settings directory (~/.pi/agent) — constant for the process lifetime. Hoisted to
 *  module scope so both the module-level visibility-glob loader and the factory's enforcement
 *  path share one source of truth. */
const globalSettingsDir = path.join(homedir(), ".pi", "agent");

// Re-export process runner test hooks
export { _resetFs, _setFs, _setSpawn };

// ── Tool parameter schema ──────────────────────────────────────────────────

const MODEL_OVERRIDE_DESCRIPTION =
  "Override model as provider/id (e.g. test-provider/model-b). Takes priority over agent frontmatter model.";

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
  model: Type.Optional(Type.String({ description: MODEL_OVERRIDE_DESCRIPTION })),
});

// ── Internal helpers ───────────────────────────────────────────────────────

/** Check if an agent is eligible for fork-duplication in new+fork mode.
 * Convention: any agent whose name contains "review" is considered a review agent. */
function isForkableAgent(agentName: string): boolean {
  return agentName.includes("review");
}

/** Best-effort error message from a failed result: errorMessage, then stderr, then output, then a placeholder.
 *  Sanitized at this consumption boundary (the single point where stderr becomes operator-visible): the
 *  raw stderr pipe accumulates unsanitized during the run and is only surfaced here for error results.
 *  Per-line sanitization preserves multi-line log structure (newlines) while stripping control chars
 *  (ANSI/OSC/C0) within each line. Doing it here (vs per-chunk at ingestion) also closes the
 *  ANSI-split-across-chunk gap, since the full stderr is assembled by completion. */
function resultErrorMessage(result: SingleResult): string {
  const raw = result.errorMessage || result.stderr || result.output || "(no output)";
  // Per-line sanitization preserves multi-line log structure (newlines) while stripping control
  // chars (ANSI/OSC/C0) within each line. For single-line input split/map/join is equivalent to a
  // plain stripControlChars, so no separate branch is needed.
  return raw
    .split("\n")
    .map((l) => stripControlChars(l))
    .join("\n");
}

/** Max characters of a crash reason surfaced in the parallel summary's FAILED annotation.
 *  Keeps a multi-line stderr stack trace (the usual crash payload) from swamping the summary
 *  the first lines carry the actionable signal (the thrown Error + top stack frame). */
const PARALLEL_FAILED_REASON_MAX = 500;

/** Concise failure reason for the parallel summary's `FAILED: …` annotation.
 *  Unlike {@link resultErrorMessage} (full, multi-line, includes output), this returns a
 *  sanitized, length-capped reason from `errorMessage` falling back to `stderr` ONLY — never
 *  `output`, which is already rendered as the task body. This closes the silent-failure gap where
 *  a crashed subagent (non-zero exit, empty `errorMessage`, stack trace in `stderr`) rendered as
 *  a bare `FAILED` with no explanation in the parallel summary. */
function parallelFailedReason(result: SingleResult): string {
  const raw = result.errorMessage || result.stderr || "";
  if (!raw.trim()) return "";
  const sanitized = raw
    .split("\n")
    .map((l) => stripControlChars(l))
    .join("\n")
    .trim();
  return sanitized.length > PARALLEL_FAILED_REASON_MAX
    ? `${sanitized.slice(0, PARALLEL_FAILED_REASON_MAX)}…`
    : sanitized;
}

/** Build the parallel-mode summary text + details from a results array. Shared by the new+parallel and parallel-only execution paths. */
function buildParallelSummary(
  results: SingleResult[],
  makeDetails: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails,
): {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
} {
  const successCount = results.filter((r) => r.exitCode === 0).length;
  const summaries = results.map((r, i) => {
    const output = r.output || "";
    const status = r.exitCode === 0 ? "completed" : "failed";
    const body = output || "(no output)";
    // Surface the failure reason (errorMessage ‖ stderr) so a crashed subagent — non-zero exit
    // with an empty errorMessage and its stack trace in stderr — is not rendered as a bare
    // `FAILED`. Falls back to stderr (sanitized + capped) via parallelFailedReason.
    const failedReason = status === "failed" ? parallelFailedReason(r) : "";
    return `=== Task ${i + 1}: ${r.agent} ===\n${failedReason ? `FAILED: ${failedReason}\n` : status === "failed" ? "FAILED\n" : ""}${body}`;
  });
  return {
    content: [
      {
        type: "text",
        text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
      },
    ],
    details: makeDetails("parallel")(results),
  };
}

// ---------------------------------------------------------------------------
// Hook arrays вЂ” imported from hooks.ts (shared with index.ts)
// ---------------------------------------------------------------------------

// Re-exported for convenience
export { _modelResolvers, _promptTransformers } from "./hooks.js";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// The /subagent:settings command + modal are registered in settings-ui.ts (a non-cyclic
// module) so that every consumer — including process-runner.ts, which this module imports —
// reads through the same accessor without a circular dependency.
export { getSubagentSettings } from "./settings-ui.js";

// ---------------------------------------------------------------------------
// Extension API
// ---------------------------------------------------------------------------

/** API object exposed to host extensions via pi.events. */
export interface PiSubagentApi {
  addPromptTransformer(
    fn: (
      systemPrompt: string,
      context: {
        agentName: string;
        task?: string;
        isFork: boolean;
      },
    ) => string | Promise<string>,
  ): void;
  addModelResolver(fn: ModelResolverHook): void;
  addSkillPaths(paths: string[]): void;
  addAgentsPaths(paths: string[], extensionName: string): void;
}

/** globalThis survives module re-import during /reload. */
const _gt = globalThis as {
  __piSubagentExtState?: {
    cachedApi: PiSubagentApi | null;
    unsubs: Array<() => void>;
  };
};

_gt.__piSubagentExtState = _gt.__piSubagentExtState ?? {
  cachedApi: null,
  unsubs: [],
};
const _state = _gt.__piSubagentExtState;

/** Track the active ProcessRegistry for the process-exit cleanup listener. The factory can be
 *  invoked many times (once in production, repeatedly across test files), but only ONE exit
 *  listener may be registered — otherwise repeated factory calls stack listeners and trigger
 *  Node's MaxListenersExceededWarning. The single listener terminates the most-recent registry
 *  (prior factory calls' registries are from completed work with no live spawns). */
let _activeRegistry: ProcessRegistry | null = null;
let _exitListenerRegistered = false;

/** Reset module state вЂ” called on test cleanup. */
export function _resetExtensionState(): void {
  for (const unsub of _state.unsubs) unsub();
  _state.unsubs.length = 0;
  _state.cachedApi = null;
  _promptTransformers.length = 0;
  _modelResolvers.length = 0;
}

/** Register an event handler on pi, returning an unsubscribe function. */
function safeOn(pi: ExtensionAPI, event: string, handler: (...args: unknown[]) => Promise<void> | void): () => void {
  const unsub = (pi.on as (event: string, handler: (...args: unknown[]) => unknown) => (() => void) | undefined)(
    event,
    handler,
  );
  return typeof unsub === "function" ? unsub : () => {};
}

/**
 * Agents the model is allowed to SEE in listings: everyone except those opted out via
 * `hide-from-agents-list: true` OR matched by a config-driven `hidden-agents` glob OR a
 * `disabled-agents` glob (disabled implies hidden). Hidden agents stay routable at runtime
 * (except disabled — those are spawn-rejected at dispatch) — they are only omitted from
 * model-facing lists (description + error responses).
 */
function visibleAgents(agents: AgentConfig[], hiddenGlobs: string[], disabledGlobs: string[]): AgentConfig[] {
  return agents.filter((a) => isVisible(a, hiddenGlobs, disabledGlobs));
}

/** Read the merged global+project visibility globs from the cached full subagent config.
 *  Cache HIT after first read — no repeated disk I/O across the description build and execute
 *  error paths. Returns empty arrays when no config / no keys (the common case). */
function loadVisibilityGlobs(): { hidden: string[]; disabled: string[] } {
  const { config } = _loadSubagentConfig(globalSettingsDir, process.cwd());
  return { hidden: config["hidden-agents"] ?? [], disabled: config["disabled-agents"] ?? [] };
}

/** Max length of an inlined agent description before truncation (bounds the line size). */
const AGENT_DESC_MAX = 60;

/**
 * Render the visible agents as a comma-joined `name (description)` list for the
 * model-facing announcements (tool description + error responses). The frontmatter
 * `description` disambiguates agents whose names alone are unclear (e.g. worker vs
 * implementer, general-reviewer vs quality-reviewer). Descriptions are truncated at
 * a word boundary to keep the line bounded.
 */
function formatVisibleAgentList(agents: AgentConfig[], hiddenGlobs: string[], disabledGlobs: string[]): string {
  const visible = visibleAgents(agents, hiddenGlobs, disabledGlobs);
  if (visible.length === 0) return "none";
  return visible
    .map((a) => {
      const desc = a.description?.trim();
      if (!desc) return a.name;
      if (desc.length <= AGENT_DESC_MAX) return `${a.name} (${desc})`;
      // Truncate at the last word boundary within the limit.
      const slice = desc.slice(0, AGENT_DESC_MAX);
      const cut = slice.lastIndexOf(" ");
      const head = cut > 0 ? slice.slice(0, cut) : slice;
      return `${a.name} (${head}…)`;
    })
    .join(", ");
}

export default function subagentExtension(pi: ExtensionAPI): void {
  // Reload-safe idempotency guard: once wired, subsequent invocations no-op. This lets the
  // package coexist when both bundled into the avtc-pi umbrella and installed standalone.
  // The flag resets on session_shutdown (end of this function) so a /reload — which re-evaluates
  // the module fresh but preserves globalThis — can re-wire instead of short-circuiting to dead.
  const g = globalThis as GlobalWithWired;
  if (g[WIRED_KEY]) return;
  g[WIRED_KEY] = true;

  // Clean up previous listeners on reload
  for (const unsub of _state.unsubs) unsub();
  _state.unsubs.length = 0;

  // Initialize settings: register the /subagent:settings command + modal and load settings
  // (load happens at registration + every session_start, handled inside registerSettingsCommand).
  initSubagentSettings(pi);

  // Global dir for the `avtc-pi-subagent` section of settings.json (model overrides).
  // globalSettingsDir (~/.pi/agent) is defined at module scope — shared by the visibility-glob
  // loader and the child-enforcement path. The model `avtc-pi-subagent` section lives in the regular
  // settings.json (NOT the avtc-pi-settings-ui schema path avtc-pi-subagent-settings.json, which holds
  // the operational presets).

  // Register fork tool guard (restricts tools in forked sessions)
  registerForkToolGuard(pi);

  const registry = new ProcessRegistry();
  const gate = new ConcurrencyGate(getSubagentConcurrency);

  // Parent PID watchdog: self-terminate if parent dies (prevents orphaned subagents)
  const parentPid = getParentPid();
  const watchdog = parentPid ? new ParentWatchdog(parentPid, (msg) => log.info(msg)) : null;
  watchdog?.start();

  // Process-exit cleanup: terminate any orphaned subagents. Registered ONCE per process
  // (idempotent) so repeated factory invocations across test files don't stack listeners and
  // trip Node's MaxListenersExceededWarning. The listener terminates the most-recent registry.
  _activeRegistry = registry;
  if (!_exitListenerRegistered) {
    _exitListenerRegistered = true;
    process.on("exit", () => _activeRegistry?.terminateAll());
  }

  /**
   * Build the tool description listing all currently-discoverable agents.
   *
   * The description is a static string captured at registerTool time. The tool
   * is registered in the factory (so it exists immediately, seeing bundled +
   * user + project agents) and re-registered in session_start AFTER
   * `pi-subagent:ready` has fired — by then other extensions have called
   * addAgentsPaths, so the refreshed description includes integration agents.
   * pi.registerTool keys tools by name in a Map, so re-registering updates
   * the description in place and calls refreshTools.
   */
  const buildDescription = (injected: AgentDiscoveryResult | undefined): string => {
    const discovery = injected ?? _cachedDiscover(process.cwd());
    const { hidden, disabled } = loadVisibilityGlobs();
    const list = formatVisibleAgentList(discovery.agents, hidden, disabled);
    // Always note that additional agents may appear at runtime (e.g. integration
    // paths, fork subagents). The note is unconditional — feature-flow or the
    // user can spawn *-fork agents dynamically, and other extensions can call
    // addAgentsPaths after tool registration.
    const runtimeNote = "Other agents may be available at runtime — use them when instructed.";
    return [
      "Delegate tasks to specialized subagents with isolated context.",
      "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
      `Available agents: ${list}.`,
      runtimeNote,
    ].join(" ");
  };

  const subagentTool: ToolDefinition<typeof SubagentParams, SubagentDetails> = {
    name: "subagent",
    label: "Subagent",
    description: buildDescription(NO_DISCOVERY_INJECTION),
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const discovery: AgentDiscoveryResult = _cachedDiscover(ctx.cwd);
      const agents = discovery.agents;

      // Load merged visibility globs ONCE per dispatch (cache HIT — no disk re-read). Used by
      // the error-response listings AND threaded into runSingleAgent (disabled = spawn-rejected,
      // hidden = unknown-agent list excludes them).
      const { hidden: hiddenGlobs, disabled: disabledGlobs } = loadVisibilityGlobs();

      const runId = randomUUID().slice(0, 8);

      // Capture parent session model for fork fallback
      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

      /** Resolve context window using the module-scoped helper with this execute's ctx. */
      const resolveContextWindowLocal = (modelString: string | undefined) =>
        resolveContextWindow(modelString, ctx.modelRegistry);

      /** Build the RunSingleAgentOptions shared by all three dispatch modes. The per-site fields
       *  (resolved model, fork session file, context window) vary; the rest (parent model, the
       *  shared prompt-transformer pipeline, and the config-driven visibility globs threaded so
       *  disabled agents are spawn-rejected and hidden agents stay out of error listings) is
       *  common, so it lives here once. */
      const buildRunOptions = (
        modelOverride: string | undefined,
        forkSessionFile: string | undefined,
        contextWindow: number | undefined,
      ): RunSingleAgentOptions => ({
        modelOverride,
        forkSessionFile,
        parentModel,
        contextWindow,
        transformPrompt: async (sp, transformCtx) => {
          let result = sp;
          for (const fn of _promptTransformers) result = await fn(result, transformCtx);
          return result;
        },
        disabledAgentGlobs: disabledGlobs,
        hiddenAgentGlobs: hiddenGlobs,
      });

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        });

      if (modeCount !== 1) {
        const available = formatVisibleAgentList(agents, hiddenGlobs, disabledGlobs);
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails("single")([]),
        };
      }

      // --- Fork session file resolution ---
      // Uses PI_SUBAGENT_FORK_MODE env var set by orchestrator.
      const resolveForkSessionFile = async (
        agentName: string,
        runId: string,
        step: number | undefined,
      ): Promise<string | undefined> => {
        // After fork-name unification (Phase 3), the -fork suffix is the single
        // source of fork-ness across all modes: every dispatch site (chain,
        // single, parallel) applies applyForkSuffix in fork mode, and new+fork
        // creates the -fork variant via duplication. So needsFork is name-based
        // only — explicit -fork agent names and fork-mode-suffixed names alike
        // end in -fork here. Base agents (no suffix) run fresh (no fork session).
        const forkSuffix = getForkAgentSuffix();
        const needsFork = agentName.endsWith(forkSuffix);

        if (!needsFork) return undefined;

        const sessionManager = ctx.sessionManager;
        if (!sessionManager) {
          throw new Error("Fork requested but sessionManager unavailable — cannot create branched session");
        }

        const parentSessionFile = sessionManager.getSessionFile();
        const leafId = sessionManager.getLeafId?.();
        if (!parentSessionFile || !leafId) {
          throw new Error("Fork requested but session file or leaf ID unavailable — cannot create branched session");
        }

        const MutableSM = sessionManager.constructor as typeof sessionManager.constructor & {
          open(filePath: string): { createBranchedSession(leaf: string): string | undefined };
        };
        const mutableSession = MutableSM.open(parentSessionFile);
        const branchedSession = mutableSession.createBranchedSession(leafId);
        if (!branchedSession) {
          throw new Error("createBranchedSession returned undefined — cannot create branched session");
        }

        // Move the branched session to subagent-sessions to avoid polluting the parent session directory.
        // Use the base name (strip -fork) so a plan-reviewer-fork agent yields plan-reviewer_fork,
        // not plan-reviewer-fork_fork (cosmetic double suffix). needsFork (the early-return guard
        // above) already proved agentName ends with the fork suffix, so this slice is always valid.
        const baseName = agentName.slice(0, -forkSuffix.length);
        const targetSessionFile = getSubagentSessionFile(ctx.cwd, runId, `${baseName}_fork`, step);
        fs.mkdirSync(path.dirname(targetSessionFile), { recursive: true });
        try {
          fs.copyFileSync(branchedSession, targetSessionFile);
          fs.unlinkSync(branchedSession);
        } catch (err) {
          log.warn(`Failed to move fork session: ${err instanceof Error ? err.message : err}`);
          return branchedSession;
        }
        return targetSessionFile;
      };

      // --- Resolve subagent settings from hook when env var absent ---
      // Settings propagation: subagent owns its own settings,
      // serialized to PI_SETTINGS_SUBAGENT env var by loadSettingsIntoMemory.
      // No host-provided getSettings hook needed.

      // --- Model resolution: 5-layer precedence ---
      // Phase 0 explicit param > Phase 1 built-in subagent-models (agent/glob)
      // > Phase 2 registered hooks (first-wins)
      // > Phase 3 built-in subagent default-model > Phase 4 fall through
      // (process-runner.ts applies modelOverride ?? agent.model ?? parentModel).
      // The pure precedence ordering lives in resolveModelLayered (directly unit-tested);
      // this closure only supplies the live config (re-read per call so session_start
      // invalidation takes effect) and the hook array.
      const resolveModelForAgent = (agentName: string, explicitModel: string | undefined): string | undefined => {
        const modelConfig = _loadSubagentModelConfig(globalSettingsDir, process.cwd());
        return resolveModelLayered(agentName, explicitModel, modelConfig, _modelResolvers);
      };

      // --- Chain mode ---
      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";
        const forkMode = process.env.PI_SUBAGENT_FORK_MODE;

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

          const chainUpdate = onUpdate
            ? (partial: AgentToolResult<SubagentDetails>) => {
                if (signal?.aborted) return;
                const currentResult = partial.details?.results[0];
                if (currentResult) {
                  const allResults = [...results, currentResult];
                  onUpdate({
                    content: partial.content,
                    details: makeDetails("chain")(allResults),
                  });
                }
              }
            : undefined;

          const chainAgentName = applyForkSuffix(step.agent, forkMode);
          const chainResolvedModel = resolveModelForAgent(chainAgentName, params.model);
          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            chainAgentName,
            taskWithContext,
            step.cwd,
            i + 1,
            signal,
            chainUpdate,
            makeDetails("chain"),
            registry,
            gate,
            runId,
            buildRunOptions(
              chainResolvedModel,
              await resolveForkSessionFile(chainAgentName, runId, i + 1),
              resolveContextWindowLocal(chainResolvedModel),
            ),
          );

          results.push(result);

          const isError = isResultError(result);
          if (isError) {
            const errorMsg = resultErrorMessage(result);
            return {
              content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${chainAgentName}): ${errorMsg}` }],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }
          previousOutput = result.output || "";
        }
        return {
          content: [{ type: "text", text: results[results.length - 1].output || "(no output)" }],
          details: makeDetails("chain")(results),
        };
      }

      // --- Shared parallel task execution ---
      const runParallelTasks = async (
        tasks: { agent: string; task: string; cwd?: string }[],
        modelOverride: string | undefined,
        resolveModelFn: typeof resolveModelForAgent,
      ): Promise<{ results: SingleResult[]; allResults: SingleResult[] }> => {
        const allResults: SingleResult[] = new Array(tasks.length);
        for (let i = 0; i < tasks.length; i++) {
          allResults[i] = createPlaceholderResult({
            agent: tasks[i].agent,
            task: tasks[i].task,
            exitCode: -1,
          });
        }

        const emitParallelUpdate = () => {
          if (signal?.aborted) return;
          if (onUpdate) {
            const running = allResults.filter((r) => r.exitCode === -1).length;
            const done = allResults.filter((r) => r.exitCode !== -1).length;
            onUpdate({
              content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
              details: makeDetails("parallel")([...allResults]),
            });
          }
        };

        const results = await mapWithConcurrencyLimit(tasks, tasks.length, async (t, index) => {
          const parallelResolvedModel = resolveModelFn(t.agent, modelOverride);
          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            t.agent,
            t.task,
            t.cwd,
            NO_STEP,
            signal,
            (partial) => {
              if (partial.details?.results[0]) {
                allResults[index] = partial.details.results[0];
                emitParallelUpdate();
              }
            },
            makeDetails("parallel"),
            registry,
            gate,
            runId,
            buildRunOptions(
              parallelResolvedModel,
              await resolveForkSessionFile(t.agent, runId, index),
              resolveContextWindowLocal(parallelResolvedModel),
            ),
          );
          allResults[index] = result;
          emitParallelUpdate();
          return result;
        });

        return { results, allResults };
      };

      // --- Parallel mode ---
      if (params.tasks && params.tasks.length > 0) {
        // Auto-duplicate tasks for new+fork mode.
        // Creates a forked copy of each forkable base agent, running both fresh and forked variants.
        let effectiveTasks = params.tasks;
        const forkMode = process.env.PI_SUBAGENT_FORK_MODE;
        if (forkMode === "new+fork") {
          const existingAgentNames = new Set(params.tasks.map((t) => t.agent));
          const forkedDuplicates = params.tasks
            .filter(
              (t) =>
                !t.agent.endsWith(getForkAgentSuffix()) &&
                !existingAgentNames.has(t.agent + getForkAgentSuffix()) &&
                isForkableAgent(t.agent),
            )
            .map((t) => ({ ...t, ...createForkedTask(t.agent, t.task, t.cwd) }));
          effectiveTasks = [...params.tasks, ...forkedDuplicates];
        }

        // In plain "fork" mode, suffix every task's agent name so it encodes fork-ness
        // (config *-fork globs route to fork-safe models). No-op in new+fork (above)
        // or when fork mode is unset. Name-only — the task/report content is untouched.
        if (forkMode === "fork") {
          effectiveTasks = effectiveTasks.map((t) => ({ ...t, agent: applyForkSuffix(t.agent, forkMode) }));
        }

        if (effectiveTasks.length > MAX_PARALLEL_TASKS)
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${effectiveTasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
              },
            ],
            details: makeDetails("parallel")([]),
          };

        const { results } = await runParallelTasks(effectiveTasks, params.model, resolveModelForAgent);

        return buildParallelSummary(results, makeDetails);
      }

      // --- Single mode ---
      if (params.agent && params.task) {
        const forkMode = process.env.PI_SUBAGENT_FORK_MODE;
        const singleAgentName = applyForkSuffix(params.agent, forkMode);
        const singleAgentTask = params.task;

        // Auto-duplicate for new+fork mode: convert single review agent
        // dispatch into a 2-task parallel dispatch (base + fork).
        if (forkMode === "new+fork" && !params.agent.endsWith(getForkAgentSuffix()) && isForkableAgent(params.agent)) {
          const forked = createForkedTask(params.agent, params.task, params.cwd);
          const parallelTasks = [
            { agent: singleAgentName, task: singleAgentTask, cwd: params.cwd },
            { agent: forked.agent, task: forked.task, cwd: forked.cwd },
          ];
          const { results } = await runParallelTasks(parallelTasks, params.model, resolveModelForAgent);

          return buildParallelSummary(results, makeDetails);
        }

        const singleResolvedModel = resolveModelForAgent(singleAgentName, params.model);

        const result = await runSingleAgent(
          ctx.cwd,
          agents,
          singleAgentName,
          singleAgentTask,
          params.cwd,
          NO_STEP,
          signal,
          onUpdate,
          makeDetails("single"),
          registry,
          gate,
          runId,
          buildRunOptions(
            singleResolvedModel,
            await resolveForkSessionFile(singleAgentName, runId, NO_STEP),
            resolveContextWindowLocal(singleResolvedModel),
          ),
        );

        const stableDetails = {
          ...makeDetails("single")([result]),
          status: isResultError(result) ? ("failed" as const) : ("completed" as const),
          agent: result.agent,
          task: result.task,
          result: result.output || "",
          filesChanged: result.filesChanged,
          testsRan: result.testsRan,
        };
        const isError = isResultError(result);
        if (isError) {
          const errorMsg = resultErrorMessage(result);
          return {
            content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
            details: stableDetails,
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: result.output || "(no output)" }],
          details: stableDetails,
        };
      }

      const available = formatVisibleAgentList(agents, hiddenGlobs, disabledGlobs);
      return {
        content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
        details: makeDetails("single")([]),
      };
    },

    renderCall(args, theme, _context) {
      return renderCallImpl(
        args as Parameters<typeof renderCallImpl>[0],
        theme as ThemeLike,
        _context as Parameters<typeof renderCallImpl>[2],
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const container = new Container();
        // Inline getLastTextContent: find last text content in result.content array
        const lastText =
          (result.content as Array<{ type: string; text?: string }> | undefined)
            ?.filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
            .reduce<string>((_, p) => p.text, "") || "(no output)";
        container.addChild(new Text(lastText, 0, 0));
        return container;
      }
      return renderResultImpl(result as Parameters<typeof renderResultImpl>[0], expanded, theme as ThemeLike);
    },
  };

  // Register at factory time (tool exists immediately; description sees
  // bundled + user + project agents).
  pi.registerTool(subagentTool);

  // Re-register in session_start so the description picks up integration
  // agents added by other extensions via the:ready API. Idempotent: only
  // re-registers when the agent list actually changed.
  const refreshToolDescription = (injected: AgentDiscoveryResult | undefined): void => {
    const next = buildDescription(injected);
    if (next === subagentTool.description) return;
    subagentTool.description = next;
    pi.registerTool(subagentTool);
  };

  // Build the API object with add* methods
  const api: PiSubagentApi = {
    addPromptTransformer(fn): void {
      _promptTransformers.push(fn);
    },
    addModelResolver(fn): void {
      _modelResolvers.push(fn);
    },
    addSkillPaths(paths: string[]): void {
      addSkillPaths(paths);
    },
    addAgentsPaths(paths: string[], extensionName: string): void {
      addAgentsPaths(paths, extensionName);
    },
  };

  // Cache API for reload survival
  _state.cachedApi = api;

  // /subagent:settings command + modal are registered by initSubagentSettings (called at the
  // top of this activate function).

  // Always defer:ready to session_start вЂ” ensures all consumers have registered listeners.
  // Clear hook arrays unconditionally (no-op on first load, clears stale hooks on reload).
  _state.unsubs.push(
    safeOn(pi, "session_start", () => {
      _promptTransformers.length = 0;
      _modelResolvers.length = 0;
      invalidateSubagentConfig();
      _resetSkillResolution();
      _resetAgentsPaths();
      // Invalidate the per-cwd discovery cache: _agentsPaths was just reset and :ready is
      // about to re-fire (re-populating integration paths), so any cached discovery is stale.
      _invalidateDiscoveryCache();
      pi.events.emit("pi-subagent:ready", api);
      // Compute discovery ONCE (after :ready emit, which synchronously populates integration
      // agent paths) and share it across the description refresh, collision detection, and
      // child enforcement — avoids 3 separate discoverAgents/disk reads. Goes through the
      // cache so dispatches within this session reuse it without re-reading disk.
      const discovery = _cachedDiscover(process.cwd());
      // Refresh the tool description now that other extensions have registered
      // their agents via the:ready API (addAgentsPaths runs synchronously in
      // the:ready listeners, so _agentsPaths is populated by the time emit
      // returns). Must run AFTER emit.
      refreshToolDescription(discovery);
      // Extension-provided name-collision hard-stop (top-level: not gated on CHILD_AGENT). Detects
      // agent names defined by ≥2 distinct extensions with no user/project override.
      // stderr is required — without it pi would exit during startup with the cause only in the
      // log file (near-silent crash). process.exit directly (NO throw before exit — the runner
      // swallows session_start throws, making the exit unreachable).
      const collisions = detectIntegrationCollisions(discovery);
      if (collisions.length > 0) {
        hardStop(formatCollisionMessage(collisions), NO_ERROR);
      }
      // Child-side tool-policy enforcement (gated on PI_SUBAGENT_CHILD_AGENT inside the
      // function — the top-level interactive session is never self-restricted). Pass this
      // module's injected loader so there is ONE config-loader seam in the process.
      enforceChildToolPolicy(pi, discovery, globalSettingsDir, _loadSubagentConfig, resolveToolPolicy);
    }),
  );

  // Clean up on session shutdown
  _state.unsubs.push(
    safeOn(pi, "session_shutdown", () => {
      watchdog?.stop();
      _state.cachedApi = null;
    }),
  );

  // Reload-safe reset: clear the one-time wiring flag so the next session (and a /reload, which
  // re-evaluates this module fresh against a new Extension but preserves globalThis) can re-wire.
  // pi accumulates session_shutdown handlers, so registering this never shadows the cleanup above.
  pi.on("session_shutdown", () => {
    g[WIRED_KEY] = false;
  });
}

export const __internal = {
  // From agents
  discoverAgents: _realDiscoverAgents,
  findNearestDotPiSubdir: _realFindNearestDotPiSubdir,
  // From fork
  createForkedTask,
  REPORT_FILE_FORK_REGEX,
  escapeXml,
  buildForkInstruction,
  // From process-runner
  getSubagentSessionFile,
  // From progress-tracking
  createDefaultProgress,
  createPlaceholderResult,
  extractToolArgsPreview,
  extractLastMessage,
  pushToolEvent,
  findToolEventByCallId,
  findToolEventByCallIdRecursive,
  getActiveNestedChild,
  mergePlaceholderIntoChildren,
  findCompactingEvent,
  extractChildrenFromResults,
  createThrottle,
  isTestCommand,
  resolveContextWindow,
  // From rendering
  renderAgentProgress,
  renderCallImpl,
  renderResultImpl,
  formatTokens,
  formatDuration,
  formatUsageStats,
  truncateTask,
  extractLastProseLines,
  sanitizeMarkdownPreview,
  isCodeFence,
  // Compact mode exports
  renderConfig,
  renderCompactAgentProgress,
  findLastToolEvent,
  extractLastMessageLine,
  stripMarkdownInline,
  truncateThemedLine,
  stripAnsi,
  stripControlChars,
  getErrorLine,
  getTermWidth,
  MAX_RECENT_TOOLS,
  COLLAPSED_TOOL_COUNT_SINGLE,
  COLLAPSED_TOOL_COUNT_STEP,
  // Error-result helpers (sanitized at the consumption boundary)
  isResultError,
  resultErrorMessage,
  parallelFailedReason,
  // From skill-resolution
  resolveSkillContent,
  readAndStripFrontmatter,
  injectSkills,
};

/**
 * Reset all module-level test hooks to their defaults.
 * Call in afterEach to prevent state leaking between tests.
 */
export function _resetAllTestHooks(): void {
  _resetGetSubagentSettings();
  _discoverAgents = _realDiscoverAgents;
  _findNearestDotPiSubdir = _realFindNearestDotPiSubdir;
  _loadSubagentModelConfig = loadSubagentModelConfig;
  _loadSubagentConfig = loadSubagentConfig;
  // Clear the real loader's own module-level config cache (_config/_configLoaded)
  // so a stale cached config from a prior test can't leak into the next.
  _resetSubagentConfig();
  _resetFs();
  _resetSpawn();
  _resetSkillResolution();
  _resetAgentsPaths();
  _resetUserAgentsDir();
  _invalidateDiscoveryCache();
  // Reset tool-enforcement + fork-guard module state (the validated-policy stash the fork
  // guard reads at first tool_call, and the fork-guard dep seam). Without these, a test that
  // drives session_start indirectly leaves _validatedPolicy stale for the next test.
  _resetToolEnforcementState();
  _resetForkGuardDeps();
  // Reset hook arrays
  _promptTransformers.length = 0;
  _modelResolvers.length = 0;
}
