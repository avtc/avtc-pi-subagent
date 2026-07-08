// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Rendering functions for subagent progress display.
 *
 * Includes formatting utilities, compact/multi-line rendering,
 * tool args preview, and renderCall/renderResult implementations.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
  COLLAPSED_TOOL_COUNT_SINGLE,
  COLLAPSED_TOOL_COUNT_STEP,
  DEFAULT_MAX_PROSE_LINES,
  extractLastProseLines,
  sanitizeMarkdownPreview,
  stripCodeBlockLines,
  ZERO_USAGE,
} from "./progress-tracking.js";
import type { AgentProgress, SingleResult, SubagentDetails, ThemeLike, ToolEvent } from "./types.js";
import { isResultError } from "./types.js";

// ── Render mode configuration ──────────────────────────────────────────────

/**
 * Render mode for collapsed (non-expanded) subagent progress.
 * - 'multi-line': original multi-line rendering (current behavior)
 * - 'compact': 3-line per agent rendering (header + last tool + last message)
 */
export const renderConfig = {
  mode: "compact" as "multi-line" | "compact",
};

// ── Formatting utilities ───────────────────────────────────────────────────

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Compute total wall-clock time across all results (earliest start to latest end). */
export function getTotalElapsedMs(results: SingleResult[]): number | undefined {
  let earliestStart = Infinity;
  let latestEnd = -Infinity;
  for (const r of results) {
    if (r.startTime != null && r.endTime != null) {
      if (r.startTime < earliestStart) earliestStart = r.startTime;
      if (r.endTime > latestEnd) latestEnd = r.endTime;
    }
  }
  if (earliestStart === Infinity) return undefined;
  return latestEnd - earliestStart;
}

/** Render aggregate usage line ("Total: ...") for chain/parallel modes. */
export function renderAggregateUsage(results: SingleResult[], theme: ThemeLike): Container {
  const c = new Container();
  const totalElapsedMs = getTotalElapsedMs(results);
  const usageStr = formatUsageStats(aggregateUsage(results), NO_MODEL, totalElapsedMs, NO_TOTAL_ELAPSED_MS);
  if (usageStr) {
    c.addChild(new Spacer(1));
    c.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
  }
  return c;
}

/** Aggregate usage stats across multiple results.
 *  Note: contextTokens is NOT aggregated — it's only meaningful per-agent.
 *  Per-agent context usage is shown in each renderAgentProgress() call. */
export const aggregateUsage = (results: SingleResult[]) => {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.turns += r.usage.turns;
  }
  return total;
};

export function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model: string | undefined,
  elapsedMs: number | undefined,
  contextWindow: number | undefined,
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (elapsedMs !== undefined && elapsedMs >= 0) {
    parts.push(formatDuration(elapsedMs));
  }
  if (usage.contextTokens && usage.contextTokens > 0) {
    if (contextWindow) {
      parts.push(`ctx:${formatTokens(usage.contextTokens)}/${formatTokens(contextWindow)}`);
    } else {
      parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
    }
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

// ── Spinner / terminal utilities ───────────────────────────────────────────

// Braille dots spinner frames (9-frame cycle)
const SPINNER_FRAMES = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807";

/** Sentinel: no token count or total elapsed for usage stats */
/** Sentinel: no model name provided */
const NO_MODEL: string | undefined = undefined;
/** Sentinel: no total elapsed time provided */
const NO_TOTAL_ELAPSED_MS: number | undefined = undefined;
/** Default: recurse into children when finding last tool event */
const RECURSE_INTO_CHILDREN = true;
/** Default: collapse task text (not expanded) */
const TASK_COLLAPSED = false;

export function getSpinnerFrame(): string {
  const idx = Math.floor(Date.now() / 150) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[idx] || "\u2819";
}

/** Status → icon glyph. `runningIcon` is the glyph used for the "running" status (animated spinner in compact, static ▶ in full rendering). */
export function getStatusIcon(status: string, runningIcon: string): string {
  const icons: Record<string, string> = {
    pending: "○",
    running: runningIcon,
    completed: "✓",
    failed: "✗",
  };
  return icons[status] || "○";
}

/** Status → theme color name for the icon. */
export function getStatusColor(status: string): string {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "accent";
  return "dim";
}

/** Push the shared context-tokens / elapsed / failed-stopReason detail lines onto `parts`. Used by both compact and full agent renderers. */
export function pushContextParts(
  parts: string[],
  r: SingleResult,
  p: AgentProgress,
  elapsedMs: number | undefined,
  theme: ThemeLike,
): void {
  if (r.usage.contextTokens && r.usage.contextTokens > 0) {
    const ctxStr = p.contextWindow
      ? `${formatTokens(r.usage.contextTokens)}/${formatTokens(p.contextWindow)}`
      : formatTokens(r.usage.contextTokens);
    parts.push(theme.fg("dim", ctxStr));
  }
  if (elapsedMs !== undefined) parts.push(theme.fg("dim", formatDuration(elapsedMs)));
  if (p.status === "failed" && r.stopReason) parts.push(theme.fg("error", `[${r.stopReason}]`));
}

/**
 * Push the "turns + tools" and "input + output" stat parts in the shared header format.
 * Both the compact and full renderers build these identical aggregates, so they live here once.
 */
export function pushTurnsToolsAndIo(parts: string[], r: SingleResult, p: AgentProgress, theme: ThemeLike): void {
  // Turns + tools as a single part: "12⟳ 11 tools"
  const turnsTools: string[] = [];
  if (r.usage.turns) turnsTools.push(`${r.usage.turns}⟳`);
  if (p.toolCount) turnsTools.push(`${p.toolCount} tools`);
  if (turnsTools.length > 0) parts.push(theme.fg("dim", turnsTools.join(" ")));
  // Input + output as a single part: "↑141k ↓2.2k"
  const ioParts: string[] = [];
  if (r.usage.input) ioParts.push(`↑${formatTokens(r.usage.input)}`);
  if (r.usage.output) ioParts.push(`↓${formatTokens(r.usage.output)}`);
  if (ioParts.length > 0) parts.push(theme.fg("dim", ioParts.join(" ")));
}

/** Promote a nested child AgentProgress into a SingleResult for recursive rendering. Both compact and full renderers build the same wrapper. */
export function childToResult(child: AgentProgress): SingleResult {
  return {
    agent: child.agent,
    task: child.task,
    exitCode: 0,
    stderr: "",
    usage: { ...ZERO_USAGE, ...child.usage },
    model: child.model,
    stopReason: undefined,
    errorMessage: undefined,
    step: undefined,
    startTime: child.startTime,
    endTime: child.endTime,
    progress: child,
    output: child.output || "",
    filesChanged: [],
    testsRan: false,
  };
}

/** Push the shared aggregate io/turns/elapsed detail lines onto `topParts`. Used by both parallel- and chain/parallel-result top headers. */
export function pushAggregateIoParts(
  topParts: string[],
  agg: { turns?: number; input?: number; output?: number },
  totalElapsedMs: number | undefined,
  theme: ThemeLike,
): void {
  if (agg.turns) topParts.push(theme.fg("dim", `${agg.turns}⟳`));
  const topIo: string[] = [];
  if (agg.input) topIo.push(`↑${formatTokens(agg.input)}`);
  if (agg.output) topIo.push(`↓${formatTokens(agg.output)}`);
  if (topIo.length > 0) topParts.push(theme.fg("dim", topIo.join(" ")));
  if (totalElapsedMs !== undefined) topParts.push(theme.fg("dim", formatDuration(totalElapsedMs)));
}

/** Get approximate terminal width (fallback to 80 if not available). */
export function getTermWidth(): number {
  // Subtract 2 for Box(1,1) padding applied by ToolExecutionComponent's contentBox
  return ((typeof process !== "undefined" && process.stdout?.columns) || 80) - 2;
}

// ── String utilities ───────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noControlCharactersInRegex: defense-in-depth sanitization of untrusted child output
const CSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: defense-in-depth sanitization of untrusted child output
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: defense-in-depth sanitization of untrusted child output
const ESC2_RE = /\x1b./g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: defense-in-depth sanitization of untrusted child output
const C0_RE = /[\x00-\x1f\x7f]/g;

/** Strip ANSI escape sequences to get plain-text length. */
export function stripAnsi(str: string): string {
  return str.replace(CSI_RE, "");
}

/** Strip ALL terminal-control hazards from untrusted strings before surfacing to the
 *  operator terminal/logs: ANSI CSI sequences, OSC sequences (incl. OSC 8 clickable
 *  hyperlinks), 2-char ESC sequences (e.g. `ESC c` reset), and all C0 control chars + DEL
 *  (CR line-overwrite, NUL, BEL, BS, …). Defense-in-depth against display-spoofing from
 *  buggy/hostile child output. (Not a full Unicode-bidi sanitizer — visual RTL/homoglyph
 *  spoofing is out of scope for a C0 cleaner.) */
export function stripControlChars(str: string): string {
  return str.replace(CSI_RE, "").replace(OSC_RE, "").replace(ESC2_RE, "").replace(C0_RE, "");
}

/** Resolve the transient-or-terminal error text to render for an agent (shared by the compact
 *  and multi-line renderers). Returns `undefined` when no error should be shown (a running or
 *  completed agent with no live/final error). Gate: `errorVisible` (transient mid-run turn/LLM
 *  error) OR `status === "failed"` (terminal hard-failure); text from `progress.error || result.errorMessage`. */
export function getErrorLine(p: AgentProgress, r: SingleResult): string | undefined {
  if ((p.errorVisible || p.status === "failed") && (p.error || r.errorMessage)) {
    return p.error || r.errorMessage;
  }
  return undefined;
}

/**
 * Truncate a themed (ANSI-colored) string to fit within maxWidth visible cells.
 * Preserves ANSI codes — only truncates the visible content.
 * Returns the truncated string with ANSI codes intact.
 */
export function truncateThemedLine(themed: string, maxWidth: number): string {
  const visible = visibleWidth(themed);
  if (visible <= maxWidth) return themed;

  const targetWidth = maxWidth - 1; // reserve 1 for ellipsis
  let result = "";
  let vis = 0;
  let i = 0;

  while (i < themed.length && vis < targetWidth) {
    if (themed[i] === "\x1b") {
      // ANSI escape sequence — include verbatim
      const end = themed.indexOf("m", i);
      if (end !== -1) {
        result += themed.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    const char = themed[i] ?? "";
    result += char;
    vis += visibleWidth(char);
    i++;
  }

  return `${result}…`;
}

// ── Inline markdown / message extraction ───────────────────────────────────

/** Extract the last non-empty line from text (for compact message display). */
export function extractLastMessageLine(text: string): string {
  if (!text) return "";
  // Strip code blocks
  const proseLines = stripCodeBlockLines(text);
  // Get last non-empty line
  for (let i = proseLines.length - 1; i >= 0; i--) {
    const trimmed = proseLines[i]?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** Strip common inline markdown formatting for compact single-line display. */
export function stripMarkdownInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold
    .replace(/\*(.+?)\*/g, "$1") // italic
    .replace(/`(.+?)`/g, "$1") // inline code
    .replace(/\[(.+?)\]\(.+?\)/g, "$1") // links
    .replace(/^#{1,6}\s+/, "") // heading
    .replace(/^>\s?/, "") // blockquote
    .replace(/^[-*]\s/, "- ") // list item
    .trim();
}

// ── Tool event tree helpers ────────────────────────────────────────────────

/** Find the last tool event with the most recent activity (deepest nested or last in list). */
export function findLastToolEvent(tools: ToolEvent[], recurseIntoChildren: boolean): ToolEvent | undefined {
  if (tools.length === 0) return undefined;
  const tool = tools[tools.length - 1];
  if (!tool) return undefined;
  // If this tool has children, recurse into the last child to show deepest active tool
  // — but only when children are NOT rendered separately (i.e., no recursion when
  // the caller will render nested children as their own agent blocks)
  if (recurseIntoChildren && tool.children && tool.children.length > 0) {
    for (let j = tool.children.length - 1; j >= 0; j--) {
      const child = tool.children[j];
      if (child.recentTools.length > 0) {
        return findLastToolEvent(child.recentTools, RECURSE_INTO_CHILDREN);
      }
    }
  }
  return tool;
}

/** Collect nested AgentProgress children from tool events (for tree rendering). */
export function collectNestedChildren(tools: ToolEvent[]): AgentProgress[] {
  const children: AgentProgress[] = [];
  for (const tool of tools) {
    if (tool.children) {
      for (const child of tool.children) {
        children.push(child);
      }
    }
  }
  return children;
}

// ── Tool args preview ──────────────────────────────────────────────────────

/** Plain-text tool args preview for ToolEvent.args (no theme colors, no tool name prefix). */
export function extractToolArgsPreview(toolName: string, args: Record<string, unknown>): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  let result: string;
  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const lines = command.split("\n");
      const firstLine = lines[0];
      const extra = lines.length > 1 ? ` ... (+${lines.length - 1} more lines)` : "";
      result = `$ ${firstLine}${extra}`;
      break;
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = filePath;
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += `:${startLine}${endLine ? `-${endLine}` : ""}`;
      }
      result = text;
      break;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lineCount = content ? content.split("\n").length : 0;
      if (lineCount > 1) {
        result = `${filePath} (${lineCount} lines)`;
      } else if (lineCount === 1) {
        const preview = content.length > 60 ? `${content.slice(0, 57)}...` : content;
        result = `${filePath}: ${preview}`;
      } else {
        result = filePath;
      }
      break;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      result = shortenPath(rawPath);
      break;
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      result = shortenPath(rawPath);
      break;
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      result = `${pattern} in ${shortenPath(rawPath)}`;
      break;
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      result = `/${pattern}/ in ${shortenPath(rawPath)}`;
      break;
    }
    case "subagent": {
      const agent = (args.agent || "...") as string;
      result = agent;
      break;
    }
    default: {
      const preview = JSON.stringify(args);
      result = preview.slice(0, 200);
      break;
    }
  }
  // Sanitize child-controlled args before rendering in the tool log (defense-in-depth against
  // display-spoofing; the named cases interpolate child args raw, the default case is safe via
  // JSON.stringify). Match the posture of the event-field sanitization in process-runner.ts.
  const safe = stripControlChars(result);
  return safe.length > 4000 ? safe.slice(0, 4000) : safe;
}

// ── Task truncation ────────────────────────────────────────────────────────

/** Truncate task text: full in expanded, first line only in collapsed (TUI wraps to width). */
export function truncateTask(task: string, expanded: boolean): string {
  if (expanded) return task;
  const firstNewline = task.indexOf("\n");
  return firstNewline === -1 ? task : task.slice(0, firstNewline);
}

// ── Compact rendering (3-line per agent) ───────────────────────────────────

/**
 * Compact 3-line rendering for a single agent.
 * Line 1: indicator + agent name + model + turns + tools + tokens + ctx + cost + timer
 * Line 2: last tool call (started/in-progress/done), trimmed to terminal width
 * Line 3: last message line, trimmed to terminal width
 *
 * Supports nesting with tree-line prefixes (├─, │, └─).
 */
/** Default depth for agent rendering */
export const DEFAULT_DEPTH = 0;
/** Depth for compact child rendering — builds ├─/└─ tree prefixes (one level below root). */
export const CHILD_DEPTH = 1;
/** Markdown vertical padding: no empty lines above/below content. */
const MARKDOWN_NO_VERTICAL_PADDING = 0;
/** Default: agent is last child */
export const DEFAULT_IS_LAST_CHILD = true;
/** Default: no parent prefix */
export const DEFAULT_PARENT_PREFIX = "";
/** Default: suppress header is false */
export const DEFAULT_SUPPRESS_HEADER = false;
/** Suppress header in compact rendering */
export const SUPPRESS_HEADER = true;
/** Do not suppress header */
export const HEADER_VISIBLE = false;
/** Sentinel: no collapsed tool limit (show all tools) */
export const NO_COLLAPSED_TOOL_LIMIT: number | undefined = undefined;

export function renderCompactAgentProgress(
  r: SingleResult,
  theme: ThemeLike,
  depth: number,
  isLastChild: boolean,
  parentPrefix: string,
): Container {
  const container = new Container();
  const termWidth = getTermWidth();
  const p = r.progress;
  const elapsedMs = r.startTime ? (r.endTime ?? Date.now()) - r.startTime : undefined;

  // Build tree-line prefix for this depth level
  const branch = depth === 0 ? "" : isLastChild ? "└ " : "├ ";
  const childPrefix = depth === 0 ? "" : isLastChild ? "  " : "│ ";
  const prefix = parentPrefix + branch;
  const fullChildPrefix = parentPrefix + childPrefix;
  const _prefixWidth = visibleWidth(prefix);

  // Sub-line tree prefixes: tool gets ├, nested children get continuation, message gets └
  const hasTool = findLastToolEvent(p.recentTools, RECURSE_INTO_CHILDREN) !== undefined || p.status === "running";
  const messageText = r.output || p.lastThinking || p.lastMessage || "";
  const lastMsgLine = extractLastMessageLine(messageText);
  const hasMessage = !!lastMsgLine;
  const nestedChildren = collectNestedChildren(p.recentTools);
  const hasNested = nestedChildren.length > 0;
  // Tool: ├ if there are more lines after it (nested or message)
  const toolBranch = hasTool ? (hasNested || hasMessage ? "├ " : "└ ") : "";
  // Nested children: continuation prefix │  or spaces
  // Message: └ (always terminal)
  const msgBranch = hasMessage ? "└ " : "";
  const toolPrefix = `${fullChildPrefix}${toolBranch}`;
  const nestedPrefix = hasNested ? `${fullChildPrefix}${hasMessage ? "│ " : "  "}` : "";
  const msgPrefix = `${fullChildPrefix}${msgBranch}`;

  // === LINE 1: Header ===
  const icon = getStatusIcon(p.status, getSpinnerFrame());
  const iconColor = getStatusColor(p.status);

  const parts: string[] = [];
  parts.push(`${theme.fg(iconColor, icon)} ${theme.fg("toolTitle", theme.bold(p.agent))}`);
  // Reserve spot for task — will be truncated to fit
  const TASK_PLACEHOLDER = "\x00TASK\x00";
  const taskIdx = r.task ? parts.length : -1;
  if (r.task) parts.push(TASK_PLACEHOLDER);
  if (r.model) parts.push(theme.fg("dim", r.model));
  pushTurnsToolsAndIo(parts, r, p, theme);
  if (r.usage.cacheRead) parts.push(theme.fg("dim", `R${formatTokens(r.usage.cacheRead)}`));
  if (r.usage.cost) parts.push(theme.fg("dim", `$${r.usage.cost.toFixed(4)}`));
  pushContextParts(parts, r, p, elapsedMs, theme);

  // Truncate task to fit: iteratively shrink until the full header line fits termWidth
  if (taskIdx >= 0) {
    const _prefixW = visibleWidth(prefix);
    const buildAndMeasure = (taskStr: string) => {
      const tempParts = [...parts];
      tempParts[taskIdx] = theme.fg("dim", taskStr);
      return visibleWidth(prefix + tempParts.join(" · "));
    };
    let taskText = truncateTask(r.task, TASK_COLLAPSED);
    // Remove task if even the shortest version doesn't fit
    if (buildAndMeasure("") > termWidth) {
      parts.splice(taskIdx, 1);
    } else {
      // Shrink task until the full line fits
      while (buildAndMeasure(taskText) > termWidth && taskText.length > 1) {
        taskText = taskText.slice(0, -1);
      }
      // Add ellipsis if we truncated (and it still fits)
      if (taskText.length < truncateTask(r.task, TASK_COLLAPSED).length) {
        const withEllipsis = `${taskText.slice(0, -1)}…`;
        if (buildAndMeasure(withEllipsis) <= termWidth) {
          taskText = withEllipsis;
        }
      }
      parts[taskIdx] = theme.fg("dim", taskText);
    }
  }

  // Join parts with " · " separator, build the full line
  // Safety: iteratively remove last part if header exceeds termWidth
  let headerContent = parts.join(" · ");
  while (visibleWidth(prefix + headerContent) > termWidth && parts.length > 1) {
    parts.pop();
    headerContent = parts.join(" · ");
  }
  const headerLine = `${prefix}${headerContent}`;
  container.addChild(new Text(headerLine, 0, 0));

  // === LINE 2: Last tool call ===
  // When nested children are rendered separately (LINE 3), don't recurse into them
  const lastTool = findLastToolEvent(p.recentTools, !hasNested);
  if (lastTool) {
    // All tool calls use → prefix; color differentiates status (matching multi-line tool log style)
    const statusPrefix = "→ ";
    const toolColor = lastTool.status === "running" ? "accent" : lastTool.status === "error" ? "error" : "dim";
    const toolLine = `${toolPrefix}${theme.fg(toolColor, `${statusPrefix}${lastTool.tool}: ${lastTool.args}`)}`;
    container.addChild(new Text(truncateThemedLine(toolLine, termWidth), 0, 0));
  }

  // === LINE 3: Nested children (between tool and message) ===
  for (let i = 0; i < nestedChildren.length; i++) {
    const child = nestedChildren[i];
    const childIsLast = i === nestedChildren.length - 1;
    const childResult = childToResult(child);
    const childContainer = renderCompactAgentProgress(childResult, theme, depth + 1, childIsLast, nestedPrefix);
    container.addChild(childContainer);
  }

  // === LINE 4: Last message (after nested children) ===
  if (lastMsgLine) {
    const plainMsg = stripMarkdownInline(lastMsgLine);
    container.addChild(new Text(truncateThemedLine(`${msgPrefix}${theme.fg("muted", plainMsg)}`, termWidth), 0, 0));
  }

  // Error line (shown on transient turn/LLM error OR final failure)
  const errLine = getErrorLine(p, r);
  if (errLine) {
    container.addChild(new Text(`${fullChildPrefix}${theme.fg("error", `Error: ${errLine}`)}`, 0, 0));
  }

  return container;
}

// ── Multi-line rendering ───────────────────────────────────────────────────

export function renderAgentProgress(
  r: SingleResult,
  theme: ThemeLike,
  expanded: boolean,
  depth: number,
  suppressHeader: boolean,
  collapsedToolLimit: number | undefined,
): Container {
  // Compact mode: delegate to 3-line renderer when not expanded
  if (renderConfig.mode === "compact" && !expanded) {
    return renderCompactAgentProgress(r, theme, depth, DEFAULT_IS_LAST_CHILD, DEFAULT_PARENT_PREFIX);
  }

  const container = new Container();
  const indent = "  ".repeat(depth);
  const p = r.progress;
  const elapsedMs = r.startTime ? (r.endTime ?? Date.now()) - r.startTime : undefined;

  // Header line — same style as compact: icon · agent · model · stats
  // Use static ▶ for running (no animated spinner in full rendering — causes scroll issues)
  if (!suppressHeader) {
    const icon = getStatusIcon(p.status, "▶");
    const iconColor = getStatusColor(p.status);
    const parts: string[] = [];
    parts.push(`${theme.fg(iconColor, icon)} ${theme.fg("toolTitle", theme.bold(p.agent))}`);
    if (r.model) parts.push(theme.fg("dim", r.model));
    // Freeze live stats while an agent is running in expanded view. turns/tools/io/ctx/elapsed
    // all mutate the header every event/second; a tall expanded block sits above the viewport,
    // and any above-viewport line change makes pi-tui do a full-screen clear that wipes
    // scrollback and resets scroll. Rendering these only at completion keeps the header
    // byte-stable during the run. The tool log and output still grow at the tail, which
    // pi-tui renders without a clear — so single-subagent expanded view stops resetting scroll.
    const freezeLiveStats = expanded && p.status === "running";
    if (!freezeLiveStats) {
      pushTurnsToolsAndIo(parts, r, p, theme);
      pushContextParts(parts, r, p, elapsedMs, theme);
    }
    container.addChild(new Text(`${indent}${parts.join(" · ")}`, 0, 0));
  }

  // Task line — full text, not truncated
  if (!suppressHeader && p.task) {
    container.addChild(new Text(`${indent}${theme.fg("dim", p.task)}`, 0, 0));
  }

  // Error message line (shown on transient turn/LLM error OR final failure, even with suppressHeader)
  const errLine = getErrorLine(p, r);
  if (errLine) {
    container.addChild(new Text(`${indent}${theme.fg("error", `Error: ${errLine}`)}`, 0, 0));
  }

  // Tool log
  const effectiveLimit = expanded
    ? undefined
    : (collapsedToolLimit ?? (depth >= 1 ? COLLAPSED_TOOL_COUNT_STEP : COLLAPSED_TOOL_COUNT_SINGLE));
  const toolsToShow = effectiveLimit ? p.recentTools.slice(-effectiveLimit) : p.recentTools;
  const skipped = effectiveLimit ? p.toolCount - toolsToShow.length : 0;
  if (skipped > 0) {
    container.addChild(new Text(`${indent}${theme.fg("muted", `... ${skipped} earlier tools`)}`, 0, 0));
  }
  for (const event of toolsToShow) {
    const toolColor = event.status === "running" ? "accent" : event.status === "error" ? "error" : "dim";
    const displayText = `${event.tool}: ${event.args}`;
    container.addChild(new Text(`${indent}${theme.fg(toolColor, `→ ${displayText}`)}`, 0, 0));

    // Nested children rendered after their tool call
    if (event.children) {
      for (const child of event.children) {
        const childResult = childToResult(child);
        const childContainer = renderAgentProgress(
          childResult,
          theme,
          expanded,
          depth + 1,
          HEADER_VISIBLE,
          NO_COLLAPSED_TOOL_LIMIT,
        );
        container.addChild(childContainer);
        container.addChild(new Spacer(1));
      }
    }
  }

  // Preview: last few lines as markdown — collapsed only
  if (!expanded) {
    const hasOutput = !!r.output;
    const rawText = r.output || p.lastMessage || p.lastThinking || "";
    if (rawText) {
      let preview = sanitizeMarkdownPreview(extractLastProseLines(rawText, DEFAULT_MAX_PROSE_LINES));
      if (!hasOutput) {
        preview = preview
          .split("\n")
          .map((line) => `*${line}*`)
          .join("\n");
      }
      if (preview) {
        const mdTheme = getMarkdownTheme();
        container.addChild(new Markdown(preview, indent.length, MARKDOWN_NO_VERTICAL_PADDING, mdTheme));
      }
    }
  }

  // Expanded: full output as Markdown; thinking/message shown italic to differentiate
  if (expanded) {
    const hasOutput = !!r.output;
    const expandedText = r.output || p.lastMessage || p.lastThinking;
    if (expandedText) {
      let text = sanitizeMarkdownPreview(expandedText.trim());
      if (!hasOutput) {
        // Italic-wrap non-output content (matching collapsed-mode preview styling)
        text = text
          .split("\n")
          .map((line) => `*${line}*`)
          .join("\n");
      }
      const mdTheme = getMarkdownTheme();
      container.addChild(new Markdown(text, indent.length, MARKDOWN_NO_VERTICAL_PADDING, mdTheme));
    }
  }

  return container;
}

/** Prepend a prefix string to every Text line in a Container tree. */
export function _prependToLines(container: Container, prefix: string): void {
  for (const child of container.children) {
    if (child instanceof Text) {
      // biome-ignore lint/suspicious/noExplicitAny: Text.text is internal, not exposed in public type
      (child as any).text = prefix + (child as any).text;
    } else if (child instanceof Container) {
      _prependToLines(child, prefix);
    }
  }
}

// ── Classify results ───────────────────────────────────────────────────────

/** Classify results as running, completed, or failed.
 *  Uses progress.status primarily, falls back to exitCode for backward compat (tests). */
export function classifyResults(results: SingleResult[]) {
  let running = 0;
  let successCount = 0;
  let failCount = 0;
  for (const r of results) {
    const s = r.progress.status;
    if (s === "failed" || r.exitCode > 0) {
      failCount++;
    } else if (s === "completed") {
      successCount++;
    } else if (r.exitCode === -1) {
      // Legacy: exitCode=-1 used in tests to indicate running
      running++;
    } else if (s === "running" || s === "pending") {
      running++;
    } else {
      // Default exitCode=0 with non-terminal status — treat as running
      running++;
    }
  }
  return { running, successCount, failCount, isRunning: running > 0 };
}

// ── renderCall / renderResult implementations ──────────────────────────────

/** Standalone renderCall implementation. */
export function renderCallImpl(
  args: {
    chain?: Array<{ agent: string; task: string }>;
    tasks?: Array<{ agent: string; task: string }>;
    agent?: string;
    task?: string;
  },
  theme: ThemeLike,
  _context: { expanded?: boolean; lastComponent?: Container | Text | null },
) {
  if (args.chain && args.chain.length > 0) {
    return new Text(
      theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length} steps)`),
      0,
      0,
    );
  }
  if (args.tasks && args.tasks.length > 0) {
    return new Text(
      theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`),
      0,
      0,
    );
  }
  // Single mode — task is rendered per-subagent in renderResult, not here
  const agentName = args.agent || "...";
  return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName), 0, 0);
}

/** Standalone renderResult implementation. */
export function renderResultImpl(
  result: { details?: SubagentDetails; content?: Array<{ type: string; text?: string }> },
  expanded: boolean,
  theme: ThemeLike,
): Container {
  const details = result.details as SubagentDetails | undefined;
  // Note: returns Container with "(no output)" text here rather than delegating to renderAgentProgress with a
  // failed progress, because missing details means the subagent never started (e.g. invalid params),
  // not that it ran and failed. This keeps the "failed" visual reserved for actual execution failures.
  if (!details || details.results.length === 0) {
    const c = new Container();
    // Inline getLastTextContent: find last text content in result.content array
    const lastText =
      result.content
        ?.filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
        .reduce<string>((_, p) => p.text, "") || "(no output)";
    c.addChild(new Text(lastText, 0, 0));
    return c;
  }

  const isCompact = renderConfig.mode === "compact" && !expanded;
  const container = new Container();

  if (details.mode === "single" && details.results.length === 1) {
    const r = details.results[0];
    container.addChild(renderAgentProgress(r, theme, expanded, DEFAULT_DEPTH, HEADER_VISIBLE, NO_COLLAPSED_TOOL_LIMIT));
  } else if (isCompact) {
    // Compact multi-agent rendering (parallel or chain)
    renderCompactMultiAgent(container, details, theme);
  } else if (details.mode === "chain") {
    // Chain mode: skip per-step task preview — tasks contain {previous} placeholders
    // that would be confusing to display. Step headers already show agent + step number.
    for (let i = 0; i < details.results.length; i++) {
      const r = details.results[i];
      const isFailed = isResultError(r);
      const rIcon = isFailed ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const stepHeader = new Text(
        `${theme.fg("muted", `─── Step ${r.step ?? i + 1}: `) + theme.fg("accent", r.agent)}${r.model ? theme.fg("dim", ` (${r.model})`) : ""} ${rIcon}`,
        0,
        0,
      );
      container.addChild(new Spacer(1));
      container.addChild(stepHeader);
      container.addChild(
        renderAgentProgress(r, theme, expanded, DEFAULT_DEPTH, SUPPRESS_HEADER, COLLAPSED_TOOL_COUNT_STEP),
      ); // suppressHeader=true
    }
    // Aggregate usage
    container.addChild(renderAggregateUsage(details.results, theme));
  } else {
    // Parallel mode (multi-line)
    const { successCount, failCount, isRunning } = classifyResults(details.results);
    const topIcon = isRunning
      ? theme.fg("accent", "▶") // static icon — no spinner in expanded view
      : failCount > 0
        ? theme.fg("warning", "◐")
        : theme.fg("success", "✓");
    const agg = aggregateUsage(details.results);
    const totalElapsedMs = getTotalElapsedMs(details.results);
    const topParts: string[] = [`${topIcon} ${theme.fg("toolTitle", theme.bold("parallel"))}`];
    topParts.push(theme.fg("accent", `${successCount}/${details.results.length}`));
    // Freeze aggregate io/elapsed while running in expanded view (same rationale as the
    // per-agent header in renderAgentProgress).
    if (!(expanded && isRunning)) {
      pushAggregateIoParts(topParts, agg, totalElapsedMs, theme);
    }
    container.addChild(new Text(topParts.join(" · "), 0, 0));

    for (let i = 0; i < details.results.length; i++) {
      if (i > 0) container.addChild(new Spacer(1));
      container.addChild(
        renderAgentProgress(
          details.results[i],
          theme,
          expanded,
          DEFAULT_DEPTH,
          HEADER_VISIBLE,
          COLLAPSED_TOOL_COUNT_STEP,
        ),
      );
    }
  }

  if (!expanded) {
    const hasExpandableContent = details.results.some((r) => r.progress.toolCount > 0 || r.output.length > 0);
    if (hasExpandableContent) {
      container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
    }
  }

  return container;
}

/** Compact multi-agent rendering for parallel/chain modes.
 *  Renders a top header with aggregate stats, then tree-prefixed child agents. */
export function renderCompactMultiAgent(container: Container, details: SubagentDetails, theme: ThemeLike): void {
  const results = details.results;
  const termWidth = getTermWidth();
  const isChain = details.mode === "chain";

  // Aggregate stats
  const totalElapsedMs = getTotalElapsedMs(results);
  const agg = aggregateUsage(results);
  const { successCount, failCount, isRunning } = classifyResults(results);

  // Top header line: icon+mode as one part, then stats
  const topIcon = isRunning
    ? theme.fg("accent", getSpinnerFrame())
    : failCount > 0
      ? theme.fg("warning", "◐")
      : theme.fg("success", "✓");
  const modeLabel = isChain ? "chain" : "parallel";
  const topParts: string[] = [`${topIcon} ${theme.fg("toolTitle", theme.bold(modeLabel))}`];
  topParts.push(theme.fg("accent", `${successCount}/${results.length}`));
  pushAggregateIoParts(topParts, agg, totalElapsedMs, theme);
  const topHeader = topParts.join(" · ");
  container.addChild(new Text(truncateThemedLine(topHeader, termWidth), 0, 0));

  // Child agents with tree prefixes
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const isLast = i === results.length - 1;
    // Pass depth=1 so compact renderer builds ├─/└─ tree prefixes
    const childContainer = renderCompactAgentProgress(r, theme, CHILD_DEPTH, isLast, DEFAULT_PARENT_PREFIX);
    container.addChild(childContainer);
  }
}
