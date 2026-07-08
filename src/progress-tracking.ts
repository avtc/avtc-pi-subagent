// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Progress tracking for subagent execution.
 *
 * Manages live progress state, tool event tracking, nested child routing,
 * and placeholder result creation.
 */

import { log } from "./log.js";
import type { AgentProgress, ProgressOverrides, SingleResult, ToolEvent, UsageStats } from "./types.js";

const moduleLog = log.child("progress-tracking");

// ── Constants ──────────────────────────────────────────────────────────────

/** Maximum tool events retained in recentTools (oldest evicted). */
export const MAX_RECENT_TOOLS = 50;

/** Max tool events shown in collapsed (non-expanded) view for single mode. */
export const COLLAPSED_TOOL_COUNT_SINGLE = 10;

/** Max tool events shown in collapsed (non-expanded) view per chain/parallel step. */
export const COLLAPSED_TOOL_COUNT_STEP = 5;

/** Zero-usage constant shared across placeholder results. */
export const ZERO_USAGE: UsageStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

// ── Code fence / prose helpers ─────────────────────────────────────────────

/** Check if a line is a code fence marker (``` with optional language identifier). */
export function isCodeFence(line: string): boolean {
  return line.trimStart().startsWith("```");
}

/** Split text into prose lines, dropping any lines inside fenced code blocks. Shared by extractLastMessageLine / extractLastMessage / extractLastProseLines. */
export function stripCodeBlockLines(text: string): string[] {
  const lines = text.split("\n");
  const proseLines: string[] = [];
  let inCodeBlock = false;
  for (const line of lines) {
    if (isCodeFence(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!inCodeBlock) proseLines.push(line);
  }
  return proseLines;
}

/** Extract last-message prose from an assistant message. */
export function extractLastMessage(msg: { content: Array<{ type: string; text?: string }> }): string {
  // (1) concatenate all text-type content parts
  const allText = msg.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");

  if (!allText.trim()) return "";

  // (2) remove lines inside fenced code blocks
  const proseLines = stripCodeBlockLines(allText);

  // (3) collect last 3 non-empty prose lines
  const nonEmpty = proseLines.filter((l) => l.trim());
  const last3 = nonEmpty.slice(-3);

  // (4) join with space, (5) truncate to 200 chars
  const result = last3.join(" ").trim();
  return result.length > 200 ? result.slice(0, 200) : result;
}

/** Default max lines for prose extraction */
export const DEFAULT_MAX_PROSE_LINES = 3;

/** Extract last N non-empty prose lines from text (code blocks stripped), joined with newlines — live-scrolling preview. */
export function extractLastProseLines(text: string, maxLines: number): string {
  const proseLines = stripCodeBlockLines(text);
  return proseLines
    .filter((l) => l.trim())
    .slice(-maxLines)
    .join("\n")
    .trim();
}

/** Close any open code fences in text to prevent broken markdown rendering. */
export function sanitizeMarkdownPreview(text: string): string {
  const lines = text.split("\n");
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i++) {
    if (isCodeFence(lines[i])) {
      inCodeBlock = !inCodeBlock;
    }
  }
  // If we're inside an unclosed code fence, add a closing fence
  return inCodeBlock ? `${text}\n\`\`\`` : text;
}

// ── Tool event management ──────────────────────────────────────────────────

/** Push a ToolEvent onto progress.recentTools with cap enforcement. */
export function pushToolEvent(progress: AgentProgress, event: ToolEvent): void {
  progress.recentTools.push(event);
  progress.toolCount++;
  if (progress.recentTools.length > MAX_RECENT_TOOLS) {
    progress.recentTools.shift();
  }
}

/** Find a ToolEvent by toolCallId in recentTools. */
export function findToolEventByCallId(progress: AgentProgress, toolCallId: string): ToolEvent | undefined {
  return progress.recentTools.find((e) => e.toolCallId === toolCallId);
}

/** Find the AgentProgress of the deepest active nested child.
 *  When a subagent tool is running, route tool events to its child
 *  so they don't pollute the parent's tool log. If the subagent has
 *  no children yet (tool_execution_update hasn't fired), creates a
 *  placeholder child to buffer events until real children arrive. */
export function getActiveNestedChild(progress: AgentProgress): AgentProgress | null {
  // Find the last running subagent tool event
  for (let i = progress.recentTools.length - 1; i >= 0; i--) {
    const te = progress.recentTools[i];
    if (!te) continue;
    if (te.tool === "subagent" && te.status === "running") {
      if (te.children?.length) {
        // Return the last running child, or recurse into its nested children
        for (let j = te.children.length - 1; j >= 0; j--) {
          const child = te.children[j];
          if (!child) continue;
          if (child.status === "running") {
            const deeper = getActiveNestedChild(child);
            return deeper || child;
          }
        }
      } else {
        // No children yet — create a placeholder to buffer tool events
        const placeholder = createDefaultProgress("(nested)", NO_TASK, {
          status: "running",
        });
        te.children = [placeholder];
        return placeholder;
      }
    }
  }
  return null;
}

/** Find a ToolEvent by toolCallId, searching recursively through nested children. */
export function findToolEventByCallIdRecursive(progress: AgentProgress, toolCallId: string): ToolEvent | undefined {
  const direct = progress.recentTools.find((e) => e.toolCallId === toolCallId);
  if (direct) return direct;
  // Search nested children's tool events
  for (const te of progress.recentTools) {
    if (te.children) {
      for (const child of te.children) {
        const found = findToolEventByCallIdRecursive(child, toolCallId);
        if (found) return found;
      }
    }
  }
  return undefined;
}

/** Merge placeholder child's buffered tool events into real children.
 *  When tool_execution_update hasn't fired yet, getActiveNestedChild creates
 *  a placeholder to buffer tool events. This merges those events into the
 *  first real child when it arrives. */
export function mergePlaceholderIntoChildren(toolEvent: ToolEvent, realChildren: AgentProgress[]): void {
  if (!toolEvent.children) return;
  for (const ph of toolEvent.children) {
    if (ph.agent === "(nested)" && ph.recentTools.length > 0) {
      // Merge buffered events into the first real child
      const target = realChildren[0];
      if (target) {
        target.recentTools = [...ph.recentTools, ...target.recentTools];
        target.toolCount += ph.toolCount;
      }
    }
  }
}

/** Find a running compaction event in recentTools. */
export function findCompactingEvent(progress: AgentProgress): ToolEvent | undefined {
  return progress.recentTools.find((e) => e.tool === "compacting" && e.status === "running");
}

/** Extract AgentProgress[] from an array of results (for nested children). */
export function extractChildrenFromResults(
  results: Array<{ progress?: AgentProgress }> | undefined | null,
): AgentProgress[] {
  if (!results) return [];
  return results.map((r) => r.progress).filter(Boolean) as AgentProgress[];
}

// ── Context window resolution ──────────────────────────────────────────────

/** Resolve context window from model registry. */
export function resolveContextWindow(
  modelString: string | undefined,
  modelRegistry: { find?: (provider: string, modelId: string) => { contextWindow?: number } | undefined } | undefined,
): number | undefined {
  if (!modelString) return undefined;
  try {
    const slashIdx = modelString.indexOf("/");
    if (slashIdx > 0) {
      const provider = modelString.slice(0, slashIdx);
      const modelId = modelString.slice(slashIdx + 1);
      const model = modelRegistry?.find?.(provider, modelId);
      return model?.contextWindow;
    }
  } catch (err) {
    moduleLog.debug(`resolveContextWindow failed for ${modelString}: ${err instanceof Error ? err.message : err}`);
  }
  return undefined;
}

// ── Progress / result factories ────────────────────────────────────────────

/** Empty task label — used for nested placeholders that buffer tool events (no own task text). */
const NO_TASK = "";

/** Create a default AgentProgress for initialization. */
export function createDefaultProgress(agent: string, task: string, overrides: ProgressOverrides): AgentProgress {
  return {
    agent,
    status: overrides?.status ?? "pending",
    task,
    recentTools: [],
    toolCount: 0,
    lastMessage: "",
    lastThinking: overrides?.lastThinking,
    model: overrides?.model,
    usage: overrides?.usage,
    startTime: overrides?.startTime,
    endTime: overrides?.endTime,
    contextWindow: overrides?.contextWindow,
    error: overrides?.error,
  };
}

/**
 * Factory for placeholder SingleResult objects.
 * Used by: unknown-agent early return, single-mode init, parallel-mode placeholders.
 */
export function createPlaceholderResult(opts: {
  agent: string;
  task: string;
  exitCode?: number;
  stderr?: string;
  model?: string;
  step?: number;
  startTime?: number;
  endTime?: number;
  progressOverrides?: ProgressOverrides;
}): SingleResult {
  const resolvedStartTime = opts.startTime ?? Date.now();
  return {
    agent: opts.agent,
    task: opts.task,
    exitCode: opts.exitCode ?? 0,
    stderr: opts.stderr ?? "",
    usage: { ...ZERO_USAGE },
    model: opts.model,
    step: opts.step,
    startTime: resolvedStartTime,
    endTime: opts.endTime,
    progress: createDefaultProgress(opts.agent, opts.task, {
      ...opts.progressOverrides,
      model: opts.model,
      startTime: resolvedStartTime,
      endTime: opts.endTime,
    }),
    output: "",
    filesChanged: [],
    testsRan: false,
  };
}

// ── Throttle utility ───────────────────────────────────────────────────────

/**
 * Create a throttled wrapper around a callback.
 * Ensures the callback is called at most once per `intervalMs`.
 * If called again during the throttle window, the last call is pending and fires after the window.
 */
export function createThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number,
): { throttled: (...args: A) => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let lastArgs: A | null = null;
  const throttled = (...args: A) => {
    lastArgs = args;
    if (timer) {
      pending = true;
      return;
    }
    fn(...args);
    timer = setTimeout(() => {
      timer = null;
      if (pending && lastArgs) {
        pending = false;
        fn(...lastArgs);
      }
    }, intervalMs);
  };
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending && lastArgs) {
      pending = false;
      fn(...lastArgs);
    }
  };
  return { throttled, flush };
}

// ── Test command detection ─────────────────────────────────────────────────

/** Check if a command string looks like a test command. */
export function isTestCommand(cmd: string): boolean {
  return (
    /\bvitest\b/.test(cmd) ||
    /\bpytest\b/.test(cmd) ||
    /\bnpm\s+test\b/.test(cmd) ||
    /\bpnpm\s+test\b/.test(cmd) ||
    /\byarn\s+test\b/.test(cmd)
  );
}
