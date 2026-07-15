// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Process runner for subagent execution.
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * managing process lifecycle, stdout parsing, progress tracking,
 * throttling, inactivity/absolute timeouts, and temp file cleanup.
 */

import { spawn as _realSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type AgentConfig, isVisible } from "./agents.js";
import type { ConcurrencyGate } from "./concurrency.js";
import { buildSubagentEnv } from "./env.js";
// The parent forwards the child's frontmatter whitelist via PI_SUBAGENT_TOOLS (spawn env
// below); the child self-restricts from settings.json policy + frontmatter + PI_SUBAGENT_TOOLS_ADD.
import { buildForkInstruction, getForkAgentSuffix } from "./fork.js";
import type { ProcessRegistry } from "./lifecycle.js";
import { log } from "./log.js";
import { compileGlob } from "./model-resolution.js";
import {
  createDefaultProgress,
  createPlaceholderResult,
  createThrottle,
  extractChildrenFromResults,
  extractLastMessage,
  findCompactingEvent,
  findToolEventByCallIdRecursive,
  getActiveNestedChild,
  isTestCommand,
  mergePlaceholderIntoChildren,
  pushToolEvent,
} from "./progress-tracking.js";
import { extractToolArgsPreview, formatTokens, renderConfig, stripControlChars } from "./rendering.js";
import { getSubagentSettings } from "./settings-ui.js";
import { injectSkills } from "./skill-resolution.js";
import type { PromptTransformer, SingleResult, SubagentDetails } from "./types.js";
import { isErrorStopReason } from "./types.js";

// ── Injectable test hooks ──────────────────────────────────────────────────

let _spawn: typeof _realSpawn = _realSpawn;

/** Injectable fs — tests can override specific methods via _setFs. */
const _fsOverrides: Partial<typeof import("node:fs")> = {};
const _fsProxy = new Proxy(fs, {
  get(target, prop: string) {
    return prop in _fsOverrides
      ? (_fsOverrides as Record<string, unknown>)[prop]
      : (target as Record<string, unknown>)[prop];
  },
});

const moduleLog = log.child("process-runner");

/** @internal Test hook to override specific fs methods */
export function _setFs(overrides: Partial<typeof import("node:fs")>): void {
  Object.assign(_fsOverrides, overrides);
}
/** @internal Test hook to restore fs to real implementations */
export function _resetFs(): void {
  for (const key of Object.keys(_fsOverrides)) delete (_fsOverrides as Record<string, unknown>)[key];
}
/** @internal Test hook to override spawn */
export function _setSpawn(fn: typeof _realSpawn): void {
  _spawn = fn;
}

export function _resetSpawn(): void {
  _spawn = _realSpawn;
}

/** Send SIGTERM, then escalate to SIGKILL after 5s if the process hasn't exited. Shared by the inactivity and absolute-timeout kill paths. */
function escalateKill(proc: ReturnType<typeof _spawn>): void {
  proc.kill("SIGTERM");
  setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, 5000);
}

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Base directory for subagent session files.
 * Subagent sessions are stored here instead of alongside the parent session
 * to prevent the parent session directory from accumulating thousands of files.
 */
const SUBAGENT_SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "subagent-sessions");

/**
 * Encode a cwd into the same safe directory name pi uses for sessions.
 * Mirrors pi's session-manager: `--${cwd.replace(^[/\\]/, "").replace([/\\:]/g, "-")}--`
 */
function encodeSessionFolder(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Compute a session file path for a subagent run.
 * Stored under ~/.pi/agent/subagent-sessions/{projectFolder}/{runId}_{uuid}.jsonl
 */
export function getSubagentSessionFile(
  cwd: string,
  runId: string,
  agentName: string,
  step: number | undefined,
): string {
  const projectFolder = encodeSessionFolder(cwd);
  const safeAgent = agentName.replace(/[^\w.-]+/g, "_");
  const stepSuffix = step !== undefined ? `_${step}` : "";
  const uniqueId = randomUUID().slice(0, 8);
  const fileName = `${runId}_${safeAgent}${stepSuffix}_${uniqueId}.jsonl`;
  const subagentDir = path.join(SUBAGENT_SESSIONS_DIR, projectFolder);
  _fsProxy.mkdirSync(subagentDir, { recursive: true });
  return path.join(subagentDir, fileName);
}

// ── Utility functions ──────────────────────────────────────────────────────

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

export function writePromptToTempFile(tmpDir: string, agentName: string, prompt: string): { filePath: string } {
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  _fsProxy.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { filePath };
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && _fsProxy.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** Content part inside an assistant message on the subagent stdout stream. */
interface TextContentPart {
  type: "text";
  text: string;
}
interface ThinkingContentPart {
  type: "thinking";
  redacted?: boolean;
  thinking?: string;
}
type MessageContentPart = TextContentPart | ThinkingContentPart;

/** Parsed event from the subagent stdout stream (untrusted JSON, validated by usage). */
interface SubagentStreamEvent {
  type?: string;
  message?: {
    role?: string;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: { total?: number };
    };
    content?: MessageContentPart[];
  };
  assistantMessageEvent?: unknown;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: { details?: { results?: unknown }; tokensBefore?: number };
  partialResult?: { details?: { results?: unknown }; tokensBefore?: number };
  isError?: boolean;
  errorMessage?: string;
  reason?: string;
  willRetry?: boolean;
  aborted?: boolean;
  // RPC-only line types (rpc-mode.js): `response` (prompt/command preflight acks),
  // `extension_ui_request` (generic-UI bridge), `extension_error` (child extension handler
  // failure). Optional because they're absent on every other event type.
  success?: boolean; // response
  command?: string; // response
  error?: unknown; // response (string) | extension_error (string|object)
  extensionPath?: string; // extension_error
  id?: string; // response | extension_ui_request
  method?: string; // extension_ui_request (select/confirm/input/notify)
}

// ── runSingleAgent ─────────────────────────────────────────────────────────

export interface RunSingleAgentOptions {
  /** Model override from caller (takes priority over agent frontmatter and parent model). */
  modelOverride?: string;
  /** Fork session file path (set when fork mode is used). */
  forkSessionFile?: string;
  /** Parent session model (for fork fallback). */
  parentModel?: string;
  /** Context window resolved from model registry. */
  contextWindow?: number;
  /** Transform prompt hook — async pipeline. */
  transformPrompt?: PromptTransformer;
  /** Agent-name globs from `disabled-agents` config: matching the requested OR resolved base
   *  name rejects the spawn with a policy placeholder (the agent is hidden AND spawn-blocked). */
  disabledAgentGlobs?: string[];
  /** Agent-name globs from `hidden-agents` config: used only to keep hidden names out of the
   *  unknown-agent available list (hidden agents stay callable — they are NOT spawn-rejected). */
  hiddenAgentGlobs?: string[];
}

/** No step number — used for parallel/single dispatch where steps aren't tracked. */
export const NO_STEP: number | undefined = undefined;

/** Build a failed placeholder result (exit 1, errorMessage set) for a spawn that must not
 *  proceed — unknown/disabled agent, depth budget exhausted, etc. Centralizes the repeated
 *  createPlaceholderResult + errorMessage + return shape shared by the pre-spawn guards. */
function failedPlaceholder(agentName: string, task: string, step: number | undefined, errorMsg: string): SingleResult {
  const now = Date.now();
  const result = createPlaceholderResult({
    agent: agentName,
    task,
    exitCode: 1,
    stderr: errorMsg,
    step,
    startTime: now,
    endTime: now,
    progressOverrides: { status: "failed", error: errorMsg },
  });
  result.errorMessage = errorMsg;
  return result;
}

export async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  registry: ProcessRegistry,
  gate: ConcurrencyGate,
  runId: string,
  options: RunSingleAgentOptions,
): Promise<SingleResult> {
  const {
    modelOverride,
    forkSessionFile,
    parentModel,
    contextWindow,
    transformPrompt,
    disabledAgentGlobs,
    hiddenAgentGlobs,
  } = options;

  const FORK_AGENT_SUFFIX = getForkAgentSuffix();
  let resolvedAgent = agents.find((a) => a.name === agentName);
  let resolvedBaseName: string | undefined;

  // Fallback: strip -fork suffix if agent not found directly
  if (!resolvedAgent && agentName.endsWith(FORK_AGENT_SUFFIX)) {
    resolvedBaseName = agentName.slice(0, -FORK_AGENT_SUFFIX.length);
    resolvedAgent = agents.find((a) => a.name === resolvedBaseName);
  }

  if (!resolvedAgent) {
    // Filter the available-agent list so hidden/disabled names are not leaked in the error
    // response (a hidden agent is still callable, but advertising it defeats the hiding).
    const visible = agents.filter((a) => isVisible(a, hiddenAgentGlobs ?? [], disabledAgentGlobs ?? []));
    const available = visible.map((a) => `"${a.name}"`).join(", ") || "none";
    return failedPlaceholder(agentName, task, step, `Unknown agent: "${agentName}". Available agents: ${available}.`);
  }

  // Disabled-by-policy guard: disabled-agents matches BOTH the requested name (e.g.
  // "reviewer-fork") AND the resolved base name ("reviewer") — the one config key that can
  // express fork-variant-specific disabling. A match rejects the spawn with a placeholder
  // (the agent is hidden from announcements AND cannot be dispatched).
  const disabledGlobs = disabledAgentGlobs ?? [];
  if (disabledGlobs.length > 0) {
    const names = resolvedBaseName ? [agentName, resolvedBaseName] : [agentName];
    const isDisabled = names.some((nm) => disabledGlobs.some((g) => compileGlob(g).test(nm)));
    if (isDisabled) {
      return failedPlaceholder(agentName, task, step, `Agent "${agentName}" is disabled by policy.`);
    }
  }

  // Depth guard: block spawning if budget exhausted
  const settings = getSubagentSettings();
  if (settings.maxSubagentDepth <= 0) {
    return failedPlaceholder(
      agentName,
      task,
      step,
      "Max subagent depth reached. You cannot delegate to another subagent — this is the deepest allowed level. Complete the task yourself instead of delegating.",
    );
  }

  // Spawn mode selection: 'json' = single-shot (default, current behavior);
  // 'rpc' = long-lived child for compaction continuation (RPC path below).
  const spawnMode = settings.spawnMode;

  // Shallow-copy and inject skills. injectSkills creates a new object,
  // preventing mutation of the shared discovery cache.
  const agent = injectSkills(resolvedAgent, cwd || defaultCwd);
  // Compute isFork once — used for template substitution and flag gating.
  const isFork = !!forkSessionFile;

  // Apply transformPrompt hook (replaces substituteAgentTemplates)
  let agentWithTemplates = agent;
  if (transformPrompt) {
    const transformedPrompt = await transformPrompt(agent.systemPrompt, {
      agentName,
      task,
      isFork,
    });
    agentWithTemplates = { ...agent, systemPrompt: transformedPrompt };
  }

  // 'json' = pi's json appMode (single-shot runPrintMode). 'rpc' = long-lived child.
  const args: string[] = spawnMode === "rpc" ? ["--mode", "rpc"] : ["--mode", "json", "-p"];
  // Priority: override > agent frontmatter > parent session model
  const effectiveModel = modelOverride ?? agent.model ?? parentModel;
  if (effectiveModel) args.push("--model", effectiveModel);
  // Always pass --session so subagent sessions land in ~/.pi/agent/subagent-sessions/
  // instead of the parent session directory (prevents OOM from /resume).
  // Fork sessions use the branched session file; regular sessions get a dedicated path.
  const sessionFile = forkSessionFile ?? getSubagentSessionFile(defaultCwd, runId, agentName, step);
  args.push("--session", sessionFile);

  // Fork mode: skip --extension to match parent session's system prompt for LLM cache
  // reuse. Fresh mode: the parent forwards the frontmatter whitelist via PI_SUBAGENT_TOOLS
  // (below, in the spawn env) and the child self-restricts from settings.json policy +
  // frontmatter + PI_SUBAGENT_TOOLS_ADD. agent.tools are literals (no globs), so the
  // parent never expands anything.
  if (!isFork) {
    if (agent.extensions) {
      for (const ext of agent.extensions) {
        args.push("--extension", path.resolve(path.dirname(agent.filePath), ext));
      }
    }
  }

  let tmpDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult = createPlaceholderResult({
    agent: agentName,
    task,
    model: effectiveModel,
    step,
  });

  if (contextWindow) {
    currentResult.progress.contextWindow = contextWindow;
  }
  const filesChangedSet = new Set<string>();

  // Throttle emitUpdate via factory — flush called at finalization
  let emitFinished = false;
  const { throttled: throttledEmitUpdate, flush: flushThrottle } = createThrottle(() => {
    if (emitFinished) return;
    currentResult.endTime = Date.now();
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: currentResult.output || "(running...)" }],
        details: makeDetails([currentResult]),
      });
    }
  }, 150);
  const emitUpdate = throttledEmitUpdate;

  // Spinner timer: keep the braille spinner animating during idle periods
  // when no events arrive from the subagent process.
  // Skip in multi-line mode — no animated spinner there (static ▶ icon).
  const spinnerInterval = setInterval(() => {
    if (currentResult.progress?.status === "running" && renderConfig.mode !== "multi-line") {
      emitUpdate();
    }
  }, 150);

  if (gate.active >= gate.limit) {
    moduleLog.debug(`Subagent queued — ${gate.active}/${gate.limit} slots in use`);
  }
  const admission = await gate.acquire();
  try {
    tmpDir = _fsProxy.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    // rpcMessage: the stdin `prompt` command's message for RPC. Declared at this outer
    // scope because forkInstruction is const-scoped to the if(isFork) block and is not
    // visible inside the Promise where RPC writes it to stdin.
    let rpcMessage: string | undefined;
    if (isFork) {
      // FORK MODE: Cache-optimized path
      const forkInstruction = buildForkInstruction(agentWithTemplates, task);
      rpcMessage = forkInstruction;
      // Pass fork instruction as positional arg (pi core collects into messages[]).
      // NOT using @file syntax — file-processor wraps @file content in <file> tags.
      // Agent prompts are small (<5KB), well within OS command-line limits (~32K on Windows).
      if (spawnMode !== "rpc") args.push(forkInstruction); // RPC delivers the payload via stdin, not a positional arg
    } else {
      // FRESH MODE: Current behavior unchanged
      if (agentWithTemplates.systemPrompt.trim()) {
        const tmp = writePromptToTempFile(tmpDir, agent.name, agentWithTemplates.systemPrompt);
        tmpPromptPath = tmp.filePath;
        args.push("--append-system-prompt", tmpPromptPath); // BOTH modes — an arg, not the payload
      }
      rpcMessage = `Task: ${task}`;
      if (spawnMode !== "rpc") args.push(`Task: ${task}`); // RPC delivers the payload via stdin, not a positional arg
    }

    const resolvedCwd = path.resolve(cwd ?? defaultCwd);
    let cwdError: string | undefined;
    try {
      const stat = _fsProxy.statSync(resolvedCwd);
      if (!stat.isDirectory()) cwdError = `Subagent cwd is not a directory: ${resolvedCwd}`;
    } catch {
      cwdError = `Subagent cwd does not exist: ${resolvedCwd}`;
    }
    if (cwdError) {
      currentResult.exitCode = 1;
      currentResult.stderr = cwdError;
      currentResult.errorMessage = cwdError;
      currentResult.endTime = Date.now();
      currentResult.progress = createDefaultProgress(agentName, task, {
        status: "failed",
        error: cwdError,
      });
      return currentResult;
    }

    let wasAborted = false;
    // RPC resume bound + exhaustion flag. Declared at function scope so the post-spawn exit/
    // status synthesis can read them (the spawn Promise mutates them). `boundExhausted` is set
    // when MAX_RESUMES is reached but the child still can't make progress — the task genuinely
    // didn't complete, so synthesis marks it failed instead of misreporting "completed".
    const MAX_RESUMES = 3;
    // Single source for the bound-exhaustion message (used by the stderr diagnostic AND the
    // surfaced errorMessage). Keeps the wording in sync across both surfaces.
    const BOUND_EXHAUSTED_MESSAGE = `Subagent stopped after ${MAX_RESUMES} compaction-resume attempts without progress`;
    let boundExhausted = false;

    const exitCode = await new Promise<number>((resolve) => {
      // buildSubagentEnv returns the full inherited env (minus EXCLUDED_FROM_CASCADE).
      // Per-spawn overrides are applied directly here: buildSubagentEnv is a pure
      // inheritance policy and takes no overrides.
      const subagentEnv = buildSubagentEnv();
      // UI bridge: ROOT_SOCKET + AUTH_TOKEN are already inherited via full-env;
      // only the per-agent CHILD_AGENT must be set explicitly.
      if (agent.name) subagentEnv.PI_SUBAGENT_CHILD_AGENT = agent.name;
      // Forward the frontmatter whitelist so the child can self-restrict from it. The parent
      // does NOT resolve the child's tools — it forwards INPUTS only. agent.tools are literal
      // tool names. A whitelistless agent (no/empty frontmatter) MUST NOT inherit a stale
      // TOOLS value: delete it so a whitelisted parent's value never leaks to a whitelistless
      // child (both IS_FORK and TOOLS are excluded from the cascade-exclusion policy).
      if (agent.tools && agent.tools.length > 0) {
        subagentEnv.PI_SUBAGENT_TOOLS = agent.tools.join(",");
      } else {
        delete subagentEnv.PI_SUBAGENT_TOOLS;
      }
      // Mark fork children so the child's enforcement path branches fresh/fork (guard vs
      // setActiveTools). Deleted for fresh children so a forked parent's IS_FORK never leaks
      // to a fresh grandchild.
      if (isFork) {
        subagentEnv.PI_SUBAGENT_IS_FORK = "1";
      } else {
        delete subagentEnv.PI_SUBAGENT_IS_FORK;
      }
      // Serialize settings for subagent propagation with a depth-decremented budget
      // (null = Infinite, serializes naturally). The decrement is parent-side: the
      // child only checks maxSubagentDepth <= 0.
      const childSettings = { ...settings, maxSubagentDepth: settings.maxSubagentDepth - 1 };
      subagentEnv.PI_SETTINGS_SUBAGENT = JSON.stringify(childSettings);
      subagentEnv.PI_SUBAGENT_PARENT_PID = String(process.pid);
      const invocation = getPiInvocation(args);
      // RPC needs stdin as a pipe (the parent writes prompt/shutdown commands to it);
      // json never uses stdin ('ignore'). Only stdin[0] differs — stdout/stderr always pipe.
      // NOTE: the conditional stdin element widens the array so spawn resolves to its generic
      // SpawnOptions overload (plain ChildProcess, streams typed Readable|Writable|null) rather
      // than a fixed-tuple overload. So stdout/stderr are captured below as non-null locals with
      // a throw-on-null invariant (positions 1-2 are always 'pipe'), and proc.stdin writes are
      // guarded inline (stdin is null in json mode).
      const proc = _spawn(invocation.command, invocation.args, {
        cwd: resolvedCwd,
        shell: false,
        stdio: [spawnMode === "rpc" ? "pipe" : "ignore", "pipe", "pipe"],
        env: subagentEnv,
      });
      registry.register(proc);
      let buffer = "";
      let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
      let absoluteTimer: ReturnType<typeof setTimeout> | null = null;
      let exitResolved = false;
      const inactivityMs = settings.inactivityTimeoutMs;
      // Nested subagent depth tracking for absolute timeout pause/resume
      let nestedDepth = 0;
      let absolutePauseStart: number | null = null;
      let absoluteRemainingMs: number | null = null;
      // Track last event type and time for inactivity-kill diagnostics
      let lastEventType: string | null = null;
      let lastEventTime = Date.now();
      // RPC done-detection state. Declared incrementally (each `let` is assigned before
      // first read) because biome's useConst/noUnusedVariables reject forward-declared-but-
      // unused `let`s. Each flag holds the settle timer open across its in-flight window:
      //   promptInFlight — initial/resume prompt sent but its agent_start not yet seen
      //   activeRun — an agent turn is running (agent_start..agent_end)
      //   compactionInFlight — a compaction is mid-flight (compaction_start..compaction_end)
      //   retryInFlight — provider is in a retry backoff (auto_retry_start..auto_retry_end)
      //   abortedManualCompaction — a cancelled MANUAL compaction suppressed the turn's
      //                             agent_end; settle sends a bounded resume instead of closing
      let activeRun = false;
      let promptInFlight = false;
      let compactionInFlight = false;
      let retryInFlight = false;
      let abortedManualCompaction = false;
      let resumeCount = 0;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      let resetSettleTimer = () => {};
      const SETTLE_MS = 2_000;
      const RESUME_MESSAGE = "Continue your task from where you left off.";
      let isStdinOpen = true;
      // RPC done-detection settle timer (no-op for json). Assigned up here (before the
      // initial-prompt write) so that very first resetSettleTimer call arms a REAL timer
      // promptInFlight then holds it open across the startup gap until agent_start.
      const onSettle = () => {
        if (activeRun || compactionInFlight || retryInFlight || promptInFlight) return; // still in flight
        // Cancelled MANUAL compaction stall: the aborted run's agent_end was suppressed, so the
        // parent sends a bounded resume instead of concluding. Auto aborts (threshold/overflow)
        // run in-loop and emit a real agent_end — they don't stall, so they're excluded.
        if (abortedManualCompaction) {
          if (resumeCount >= MAX_RESUMES) {
            // Bound exhausted: the child still can't make progress after MAX_RESUMES resume
            // attempts. Mark failed (don't misreport "completed") and surface a diagnostic.
            boundExhausted = true;
            currentResult.stderr += `[rpc] ${BOUND_EXHAUSTED_MESSAGE}.\n`;
            abortedManualCompaction = false;
            // fall through to graceful shutdown
          } else {
            resumeCount += 1;
            abortedManualCompaction = false;
            promptInFlight = true;
            currentResult.stderr += `[rpc] Manual compaction cancelled; resuming (attempt ${resumeCount}/${MAX_RESUMES}).\n`;
            if (isStdinOpen) {
              // streamingBehavior:"followUp" — a featyard compaction extension may
              // already have resumed the child (in-process, ~500ms) before this settle timer
              // fires (~2000ms), leaving the session streaming. Without streamingBehavior the
              // RPC prompt throws "Agent is already processing". followUp queues harmlessly
              // when streaming and starts a normal turn when idle (the common case).
              proc.stdin?.write(
                `${JSON.stringify({ type: "prompt", message: RESUME_MESSAGE, id: `resume-${resumeCount}`, streamingBehavior: "followUp" })}\n`,
              );
            }
            resetSettleTimer(); // re-arm for the resume turn
            return;
          }
        }
        isStdinOpen = false;
        proc.stdin?.end(); // graceful shutdown: child drains + process.exit(0)
      };
      resetSettleTimer = () => {
        if (spawnMode !== "rpc") return;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => onSettle(), SETTLE_MS);
      };

      // RPC: deliver the initial prompt as a stdin JSONL command (pi's rpc mode reads
      // `prompt` commands from stdin). json receives its payload as a positional arg,
      // so it never writes to stdin. rpcMessage is the outer-scope let from the
      // isFork/else block (forkInstruction is const-scoped to if(isFork) and not visible here).
      if (spawnMode === "rpc" && rpcMessage !== undefined) {
        // streamingBehavior:"followUp" for the same race the resume prompt guards against:
        // a fresh session is idle at startup (so this starts the turn directly), but a forked
        // session resuming an in-progress conversation could already be streaming.
        proc.stdin?.write(
          `${JSON.stringify({ type: "prompt", message: rpcMessage, id: "1", streamingBehavior: "followUp" })}\n`,
        );
        // Arm the settle timer + mark a prompt in flight (guards the startup gap until
        // agent_start). promptInFlight keeps onSettle from closing stdin prematurely.
        promptInFlight = true;
        resetSettleTimer();
      }

      const resolveOnce = (code: number) => {
        if (exitResolved) return;
        exitResolved = true;
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (absoluteTimer) clearTimeout(absoluteTimer);
        if (settleTimer) clearTimeout(settleTimer); // stale-timer safety: no settle after resolution (EPIPE)
        resolve(code);
      };

      let resetInactivityTimer = () => {};

      const dispatchLine = (line: string) => {
        if (!line.trim()) return;
        let event: SubagentStreamEvent;
        try {
          event = JSON.parse(line) as SubagentStreamEvent;
        } catch (_err) {
          moduleLog.debug(`Ignoring non-JSON line from subagent stdout: ${line.slice(0, 120)}`);
          return;
        }
        // RPC-only ack lines (not agent activity). Drop them before the diagnostics update
        // below so they don't pollute lastEventType/lastEventTime (and can't match a handler).
        // `response` is the prompt-command preflight ack: success:true is benign (the child
        // accepted the prompt and will start the run); success:false means the preflight
        // failed (e.g. model/session load error) — fail-fast instead of hanging for the
        // full inactivity timeout.
        if (event.type === "response") {
          if (spawnMode === "rpc" && event.command === "prompt" && event.success === false) {
            // event.error is child-controlled — strip ANSI/control sequences before surfacing.
            const rawErr = typeof event.error === "string" ? event.error : "";
            currentResult.stopReason = "error";
            currentResult.errorMessage =
              rawErr.trim().length > 0 ? stripControlChars(rawErr).trim() : "Prompt preflight failed";
            isStdinOpen = false;
            proc.stdin?.end(); // conclude immediately (don't wait for the inactivity timer)
          }
          return;
        }
        // RPC's NATIVE generic-UI bridge: a child extension calling select/confirm/input/editor
        // emits {type:"extension_ui_request", id, method,...} and BLOCKS on a Promise until the
        // parent answers via stdin. The socket ui-bridge (ask_user_question) does NOT use this
        // path (it forwards tool payloads), so these shouldn't fire in practice — but if one
        // does, auto-respond cancelled:true so the child resolves to its defaultValue (== user
        // pressed Esc) instead of hanging forever. Fire-and-forget methods (notify/setStatus/…)
        // have no pending Promise and simply ignore the response. Note: this is point-to-point
        // per parent<->child pair and does NOT relay across nesting levels (the socket bridge,
        // which cascades PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET to the root, handles nesting).
        if (event.type === "extension_ui_request") {
          const method = stripControlChars(String(event.method ?? "?"));
          if (event.id) {
            if (isStdinOpen) {
              proc.stdin?.write(
                `${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`,
              );
            }
            currentResult.stderr += `[extension_ui_request] auto-cancelled (generic UI method "${method}" not bridged in subagent)\n`;
          } else {
            // No id: a fire-and-forget method (notify/setStatus/…) with no pending Promise
            // nothing to cancel, so don't claim "auto-cancelled".
            currentResult.stderr += `[extension_ui_request] ignored, no id (fire-and-forget UI method "${method}")\n`;
          }
          return;
        }
        // RPC emits `extension_error` (rpc-mode.js onError hook) when any child extension
        // handler throws. Surface the failure (don't silently lose it) but drop it before the
        // diagnostics update so it doesn't pollute lastEventType/lastEventTime either.
        if (event.type === "extension_error") {
          // event.error/extensionPath are child-controlled — strip ANSI/control sequences.
          // event.error can be a non-serializable object (a thrown Error with circular refs),
          // so guard JSON.stringify and fall back to String.
          let rawErr: string;
          if (typeof event.error === "string") {
            rawErr = event.error;
          } else {
            try {
              rawErr = JSON.stringify(event.error ?? "");
            } catch {
              rawErr = String(event.error ?? "");
            }
          }
          const extErr = stripControlChars(rawErr);
          const extPath = event.extensionPath ? stripControlChars(String(event.extensionPath)) : "";
          currentResult.stderr += `[extension_error${extPath ? ` @ ${extPath}` : ""}] ${extErr}\n`;
          return;
        }
        // Track last event for inactivity-kill diagnostics
        lastEventType = event.type ?? "unknown";
        lastEventTime = Date.now();

        // RPC done-detection: track active turns so the settle timer only concludes when idle.
        // agent_start clears the startup/resume promptInFlight guard; agent_end re-arms settle.
        if (spawnMode === "rpc") {
          if (event.type === "agent_start") {
            activeRun = true;
            promptInFlight = false;
            // A new turn started — the cancelled-manual-compaction stall is resolved. An
            // in-process extension (e.g. featyard's compaction handler) may have resumed
            // the child already (this agent_start), so the settle timer must NOT later send
            // a redundant resume. This new turn has a normal lifecycle (emits agent_end),
            // unlike the aborted run whose agent_end was suppressed. The flag was already
            // false for the process-runner's OWN resume (cleared in onSettle before sending).
            abortedManualCompaction = false;
            resetSettleTimer();
          } else if (event.type === "agent_end") {
            activeRun = false;
            resetSettleTimer();
          }
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message;

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model;
            // Sync model and usage into progress for nested child rendering
            if (currentResult.progress) {
              currentResult.progress.model = currentResult.model;
              currentResult.progress.usage = { ...currentResult.usage };
            }
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = stripControlChars(String(msg.errorMessage));
            // Transient error rendering: surface a turn/LLM error live during the run.
            // The !compactionInFlight guard avoids false-positiving a red error from an aborted
            // compaction's message_end (invariant #9). Cleared on the first new thinking/text delta.
            if (
              currentResult.progress &&
              !compactionInFlight &&
              (msg.errorMessage || isErrorStopReason(msg.stopReason))
            ) {
              currentResult.progress.errorVisible = true;
              // Also mirror the error text onto progress.error so NESTED children (whose
              // AgentProgress propagates via tool.children, but whose SingleResult.errorMessage
              // does not) can render it — the recursive render gate is `p.error || r.errorMessage`.
              currentResult.progress.error = currentResult.errorMessage ?? "Turn error";
            }

            // Extract output, thinking, and lastMessage for progress tracking
            if (currentResult.progress) {
              const content = msg.content ?? [];
              currentResult.progress.lastMessage = extractLastMessage({ ...msg, content });
              // Extract thinking content
              const thinkingPart = content.find((p): p is ThinkingContentPart => p.type === "thinking" && !p.redacted);
              if (thinkingPart && "thinking" in thinkingPart && typeof thinkingPart.thinking === "string") {
                currentResult.progress.lastThinking = thinkingPart.thinking;
              }
              // Extract output — only update if text content found and non-empty
              for (const part of content) {
                if (part.type === "text" && "text" in part && part.text?.trim()) {
                  currentResult.output = part.text;
                  currentResult.progress.output = part.text;
                  break;
                }
              }
            }
            emitUpdate();
            resetInactivityTimer();
            resetSettleTimer();
          }
        }

        // --- Event handlers for live progress tracking ---

        // message_update: streaming deltas for thinking and text (live progress)
        if (event.type === "message_update" && event.assistantMessageEvent && currentResult.progress) {
          const ame = event.assistantMessageEvent as { type?: string; delta?: string };
          // Streaming deltas represent active model generation and ARE output, so they
          // reset the inactivity timer. Without this, a model generating a single long
          // message (e.g. thinking-heavy models streaming reasoning for longer than the
          // inactivity timeout) gets killed mid-generation despite actively streaming.
          if (ame.type === "thinking_delta" || ame.type === "text_delta") {
            resetInactivityTimer();
            resetSettleTimer();
            // First delta of the next turn hides a transient turn/LLM error (recovered).
            if (currentResult.progress.errorVisible) {
              currentResult.progress.errorVisible = false;
              currentResult.progress.error = undefined; // clear the mirrored transient text too
            }
            // Transition from pending → running on first delta (agent has started working)
            if (currentResult.progress.status === "pending") {
              currentResult.progress.status = "running";
            }
          }
          if (ame.type === "thinking_delta") {
            if (!currentResult.progress.lastThinking) currentResult.progress.lastThinking = "";
            currentResult.progress.lastThinking += ame.delta ?? "";
            currentResult.progress.output = currentResult.output;
            emitUpdate();
          }
          if (ame.type === "text_delta") {
            if (!currentResult.output) currentResult.output = "";
            currentResult.output += ame.delta ?? "";
            currentResult.progress.output = currentResult.output;
            emitUpdate();
          }
        }

        // tool_execution_start: push ToolEvent, track filesChanged/testsRan
        if (event.type === "tool_execution_start") {
          if (inactivityTimer) clearTimeout(inactivityTimer);
          inactivityTimer = null;

          // Pause absolute timeout when nested subagent starts
          if (event.toolName === "subagent") {
            if (nestedDepth === 0) pauseAbsoluteTimer();
            nestedDepth++;
          }

          // Route tool event to active nested child if one exists
          const targetProgress = getActiveNestedChild(currentResult.progress) || currentResult.progress;
          const toolName = event.toolName ?? "unknown";
          const argsPreview = extractToolArgsPreview(toolName, event.args || {});
          pushToolEvent(targetProgress, {
            tool: toolName,
            args: argsPreview,
            toolCallId: event.toolCallId,
            status: "running",
          });
          // Update status to "running" on first tool call
          if (targetProgress.status === "pending") {
            targetProgress.status = "running";
          }
          // Track filesChanged
          if (toolName === "write" || toolName === "edit") {
            const filePath = event.args?.path || event.args?.file_path;
            if (typeof filePath === "string") filesChangedSet.add(filePath);
          }
          // Track testsRan
          if (toolName === "bash" && typeof event.args?.command === "string") {
            if (isTestCommand(event.args.command)) currentResult.testsRan = true;
          }
          emitUpdate();
        }

        // tool_execution_update: populate nested children for subagent tools
        if (event.type === "tool_execution_update" && event.toolName === "subagent") {
          const toolEvent = findToolEventByCallIdRecursive(currentResult.progress, event.toolCallId ?? "");
          if (toolEvent) {
            const children = extractChildrenFromResults(
              (event.partialResult?.details?.results ?? []) as Parameters<typeof extractChildrenFromResults>[0],
            );
            if (children.length > 0) {
              // Merge placeholder buffered events into real children
              mergePlaceholderIntoChildren(toolEvent, children);
              toolEvent.children = children;
            }
          }
          emitUpdate();
        }

        // tool_execution_end: mark done/error, capture final children
        if (event.type === "tool_execution_end") {
          // Resume absolute timeout when nested subagent ends
          if (event.toolName === "subagent") {
            nestedDepth = Math.max(0, nestedDepth - 1);
            if (nestedDepth === 0) resumeAbsoluteTimer();
          }
          resetInactivityTimer();
          resetSettleTimer();
          if (event.toolCallId) {
            const toolEvent = findToolEventByCallIdRecursive(currentResult.progress, event.toolCallId ?? "");
            if (toolEvent) {
              toolEvent.status = event.isError ? "error" : "done";
              if (event.toolName === "subagent") {
                const children = extractChildrenFromResults(
                  (event.result?.details?.results ?? []) as Parameters<typeof extractChildrenFromResults>[0],
                );
                if (children.length > 0) {
                  mergePlaceholderIntoChildren(toolEvent, children);
                  toolEvent.children = children;
                }
              }
            }
          }
          emitUpdate();
        }

        // compaction_start: push synthetic ToolEvent
        if (event.type === "compaction_start") {
          compactionInFlight = true; // shared (both modes) — guards settle (RPC) + errorVisible
          // Compaction is an internal summarization model-call that emits NO output events
          // while it runs. A reset-only timer (the old behavior) re-armed a fresh window and
          // then SIGKILLed mid-compaction if it outlasted inactivityMs (default 600s — manual
          // compactions on large contexts exceed this). SUSPEND the timer instead (mirrors
          // auto_retry_start); compaction_end restores it. The ABSOLUTE timeout keeps running
          // as the backstop — a compaction that outlasts the wall-clock budget
          // still dies.
          if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
          }
          pushToolEvent(currentResult.progress, {
            tool: "compacting",
            args: stripControlChars(String(event.reason ?? "unknown")),
            status: "running",
          });
          resetSettleTimer();
          emitUpdate();
        }

        // compaction_end: mark compaction done/error
        if (event.type === "compaction_end") {
          compactionInFlight = false; // shared (both modes)
          const compactEvent = findCompactingEvent(currentResult.progress);
          if (compactEvent) {
            if (event.aborted) {
              compactEvent.status = "error";
              compactEvent.args = `${compactEvent.args}: aborted${event.willRetry ? " (retrying\u2026)" : ""}`;
            } else if (event.errorMessage) {
              compactEvent.status = "error";
              compactEvent.args = `${compactEvent.args}: ${stripControlChars(String(event.errorMessage))}`;
            } else {
              compactEvent.status = "done";
              const tokensBefore = event.result?.tokensBefore;
              if (typeof tokensBefore === "number") {
                compactEvent.args = `${compactEvent.args}: ${formatTokens(tokensBefore)} compacted`;
              }
            }
          }
          // RPC: a cancelled MANUAL compaction is the suppressed-agent_end stall. The manual
          // compact path disconnects the session's event handler BEFORE aborting the run, so
          // the aborted run's agent_end is emitted internally but never reaches stdout — the
          // parent would hang on activeRun forever. Treat this compaction_end as the de-facto
          // run-end (clear activeRun/promptInFlight) and flag it so the settle timer resumes
          // the child instead of concluding. Auto aborts (threshold/overflow) run
          // in-loop between turns and emit a real agent_end — excluded so they don't fake a stall.
          if (spawnMode === "rpc" && event.aborted && event.reason === "manual") {
            abortedManualCompaction = true;
            activeRun = false;
            promptInFlight = false;
          }
          resetInactivityTimer();
          resetSettleTimer();
          emitUpdate();
        }

        // Provider auto-retry backoff (both modes). During backoff the child produces no
        // output, so a naive inactivity timer would SIGKILL mid-retry (harmless at defaults,
        // bites with short inactivity + high retries). Suspend the inactivity timer on
        // auto_retry_start and restore it on auto_retry_end. The ABSOLUTE timeout is NOT
        // suspended — a retry that outlasts the wall-clock budget still kills.
        // RPC also tracks retryInFlight so the settle timer doesn't conclude mid-backoff.
        if (event.type === "auto_retry_start") {
          if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
          }
          if (spawnMode === "rpc") {
            retryInFlight = true;
            resetSettleTimer();
          }
          return;
        }
        if (event.type === "auto_retry_end") {
          resetInactivityTimer();
          if (spawnMode === "rpc") {
            retryInFlight = false;
            resetSettleTimer();
          }
          return;
        }
      };

      // Stream-line safety net. dispatchLine's body (JSON.parse aside) runs the entire event
      // dispatch — agent/tool/message/compaction handlers plus progress aggregation
      // (getActiveNestedChild / mergePlaceholderIntoChildren / extractChildrenFromResults). An
      // uncaught throw inside a `stdout.on("data")` callback would escape to Node's event loop
      // as an uncaughtException and terminate the subagent process with a bare non-zero exit and
      // no errorMessage — the silent-failure mode behind the level-1 parallel-crash incident.
      // Catch here so a single malformed/unexpected child event is logged (avtc-pi logger) and
      // dropped instead of crashing the parent subagent, then re-arm the inactivity timer so the
      // recovered parent isn't left to time out from the lost activity signal.
      const processLine = (line: string) => {
        try {
          dispatchLine(line);
        } catch (err) {
          moduleLog.error(
            `Uncaught error processing subagent stream line — recovered, line dropped: ${line.slice(0, 120)}`,
            err,
          );
          // The dropped line may have been an activity-bearing event that would have reset the
          // inactivity timer. Re-arm defensively so a recovered error can't masquerade as a
          // genuine inactivity timeout downstream.
          resetInactivityTimer();
        }
      };

      resetInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (inactivityMs === null) return; // Infinite — skip timer
        inactivityTimer = setTimeout(() => {
          if (exitResolved) return;
          const seconds = Math.round(inactivityMs / 1000);
          const elapsed = ((currentResult.endTime ?? Date.now()) - (currentResult.startTime ?? Date.now())) / 1000;
          const idleSince = (Date.now() - lastEventTime) / 1000;
          const diag = [
            `agent=${agentName}`,
            `stopReason=${currentResult.stopReason ?? "none"}`,
            `turns=${currentResult.usage.turns}`,
            `lastEvent=${lastEventType}`,
            `idleSince=${Math.round(idleSince)}s`,
            `totalElapsed=${Math.round(elapsed)}s`,
          ].join(", ");
          moduleLog.info(`Subagent killed after ${seconds}s of inactivity: ${diag}`);
          moduleLog.debug(
            `Inactivity kill context: model=${currentResult.model ?? "unknown"}, output=${(currentResult.output ?? "").slice(0, 200)}`,
          );
          currentResult.errorMessage = `Subagent killed after ${seconds}s of inactivity`;
          if (buffer.trim()) processLine(buffer);
          escalateKill(proc);
          resolveOnce(1);
        }, inactivityMs);
      };

      resetInactivityTimer();

      // Absolute timeout — kills regardless of activity (paused during nested subagent work)
      const absoluteTimeoutMs = settings.subagentTimeoutMs;

      /** Fire the absolute timeout kill sequence. */
      const fireAbsoluteTimeout = (ms: number) => {
        if (exitResolved) return;
        const seconds = Math.round(ms / 1000);
        const diag = [
          `agent=${agentName}`,
          `stopReason=${currentResult.stopReason ?? "none"}`,
          `turns=${currentResult.usage.turns}`,
          `lastEvent=${lastEventType}`,
        ].join(", ");
        moduleLog.info(`Subagent killed after ${seconds}s absolute timeout: ${diag}`);
        currentResult.errorMessage = `Subagent timed out after ${seconds}s`;
        if (buffer.trim()) processLine(buffer);
        escalateKill(proc);
        resolveOnce(1);
      };

      /** Start or restart the absolute timeout timer with the given delay. */
      const startAbsoluteTimer = (ms: number) => {
        if (absoluteTimer) clearTimeout(absoluteTimer);
        absoluteTimer = setTimeout(() => fireAbsoluteTimeout(ms), ms);
      };

      /** Pause the absolute timeout (call when nested subagent starts). */
      const pauseAbsoluteTimer = () => {
        if (absoluteTimer !== null) {
          clearTimeout(absoluteTimer);
          absoluteTimer = null;
          absolutePauseStart = Date.now();
        }
      };

      /** Resume the absolute timeout with remaining time (call when nested subagent ends). */
      const resumeAbsoluteTimer = () => {
        if (absolutePauseStart !== null && absoluteRemainingMs !== null) {
          const pausedFor = Date.now() - absolutePauseStart;
          absoluteRemainingMs = Math.max(0, absoluteRemainingMs - pausedFor);
          absolutePauseStart = null;
          if (absoluteRemainingMs > 0) {
            startAbsoluteTimer(absoluteRemainingMs);
          } else {
            // Budget exhausted while paused — fire immediately
            if (absoluteTimeoutMs !== null) fireAbsoluteTimeout(absoluteTimeoutMs);
          }
        }
      };

      if (absoluteTimeoutMs !== null) {
        absoluteRemainingMs = absoluteTimeoutMs;
        startAbsoluteTimer(absoluteTimeoutMs);
      }

      const { stdout, stderr } = proc;
      if (!stdout || !stderr) {
        throw new Error("subagent stdout/stderr must be piped");
      }
      stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });

      // Safety net: a stdin write that lands after end() (write-after-end race, e.g. a late
      // extension_ui_request/resume line dispatched during the drain window) or after the
      // child closed its read end (EPIPE) emits an 'error' on the stream with no listener →
      // uncaughtException → silent non-zero exit. Per-write isStdinOpen guards cover the known
      // paths; this listener catches any residual/EPIPE case for the whole class.
      proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
        moduleLog.warn(`Subagent stdin stream error (suppressed): ${err.message}`);
      });

      proc.on("close", (code) => {
        if (exitResolved) return;
        if (inactivityTimer) clearTimeout(inactivityTimer);
        // 'close' fires after all stdio streams are drained, so any remaining
        // stdout data has already been processed by the 'data' handler above.
        if (buffer.trim()) processLine(buffer);
        resolveOnce(code ?? 0);
      });

      proc.on("error", (err: Error) => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        // Spawn failure (e.g. ENOENT — pi binary not found): surface a descriptive message so the
        // result isn't a silent exit:1/failed with no error text.
        currentResult.errorMessage = `Failed to start subagent process: ${err.message}`;
        resolveOnce(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          escalateKill(proc);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    // RPC children always exit 0 on graceful stdin-close, so synthesize the exit code from
    // the final stopReason. The hard-kill paths (inactivity/absolute timeout) call resolveOnce(1)
    // + set errorMessage but never set stopReason, so a non-zero raw exitCode must ALSO count as
    // failure (the grep-hang scenario). `boundExhausted` (resume bound reached without progress)
    // is likewise a genuine non-completion. json (and others) keep the raw process exit code.
    // Both the exitCode assignment and the status derivation below key off finalExitCode so RPC's
    // synthesized code drives status too (exitCode is const — use a derived value, not reassign).
    const finalExitCode =
      spawnMode === "rpc"
        ? isErrorStopReason(currentResult.stopReason) || exitCode !== 0 || boundExhausted
          ? 1
          : 0
        : exitCode;
    if (boundExhausted) {
      currentResult.errorMessage = BOUND_EXHAUSTED_MESSAGE;
    }
    currentResult.exitCode = finalExitCode;
    currentResult.endTime = Date.now();

    // Finalize progress status
    if (currentResult.progress) {
      if (finalExitCode === 0 && !isErrorStopReason(currentResult.stopReason)) {
        currentResult.progress.status = "completed";
      } else if (finalExitCode > 0 || isErrorStopReason(currentResult.stopReason)) {
        currentResult.progress.status = "failed";
      }
      // A hard-kill (inactivity/absolute timeout) or terminal error overwrites any STALE
      // transient error text that was mirrored onto progress.error for nested-child rendering.
      // Without this, the render gate `p.error || r.errorMessage` would show the stale transient
      // text instead of the kill reason / final error (which set currentResult.errorMessage late).
      // Guarded on status==="failed" so a recovered-then-completed run doesn't keep stale text
      // (errorMessage is never cleared on recovery, but completed runs don't render the error).
      if (currentResult.errorMessage && currentResult.progress.status === "failed") {
        currentResult.progress.error = currentResult.errorMessage;
      }
      currentResult.progress.endTime = currentResult.endTime;
    }
    // Convert filesChangedSet to array
    currentResult.filesChanged = Array.from(filesChangedSet);
    // Flush throttle and prevent any pending timers from firing after finalization
    flushThrottle();
    emitFinished = true;

    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    clearInterval(spinnerInterval);
    admission.release();
    if (tmpPromptPath)
      try {
        _fsProxy.unlinkSync(tmpPromptPath);
      } catch (err) {
        moduleLog.debug(
          `Failed to clean up temp prompt file: ${tmpPromptPath} — ${err instanceof Error ? err.message : err}`,
        );
      }
    if (tmpDir)
      try {
        _fsProxy.rmSync(tmpDir, { recursive: true, force: true });
      } catch (err) {
        moduleLog.debug(`Failed to clean up temp directory: ${tmpDir} — ${err instanceof Error ? err.message : err}`);
      }
  }
}
