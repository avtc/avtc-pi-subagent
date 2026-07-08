// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Core types for pi-subagent.
 */

/** Options for the subagent extension factory. */
/** Transform agent system prompt before execution (template substitution, fork context injection). */
export type PromptTransformer = (
  systemPrompt: string,
  context: {
    agentName: string;
    task?: string;
    isFork: boolean;
  },
) => string | Promise<string>;

/** Execution mode for a single subagent run. */
export type ExecutionMode = "single" | "parallel" | "chain";

/** Theme-like object for rendering. */
export type ThemeLike = { fg: (s: string, text: string) => string; bold: (text: string) => string };

/** Usage statistics from a subagent run. */
export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** A tool event within agent progress tracking. */
export interface ToolEvent {
  tool: string;
  args: string; // truncated preview (max 4000 chars)
  toolCallId?: string; // correlates start/update/end. Undefined for synthetic events (compaction).
  status: "running" | "done" | "error";
  /** Live progress of nested subagents spawned by this tool call. */
  children?: AgentProgress[];
}

/** Live progress snapshot for a running subagent. */
export interface AgentProgress {
  agent: string;
  status: "pending" | "running" | "completed" | "failed";
  task: string;
  recentTools: ToolEvent[]; // capped at MAX_RECENT_TOOLS, oldest evicted
  toolCount: number; // total count (may exceed recentTools.length)
  lastMessage: string; // latest prose (code blocks stripped)
  lastThinking?: string; // latest thinking/reasoning content
  output?: string; // latest text output (for nested child rendering)
  model?: string; // model used by this agent (for nested child header rendering)
  usage?: Partial<UsageStats>; // usage stats for nested child header rendering
  startTime?: number; // wall-clock start (for nested child elapsed time)
  endTime?: number; // wall-clock end (for nested child elapsed time)
  contextWindow?: number; // resolved from model registry at execute() time
  error?: string; // error message for failed agents
  errorVisible?: boolean; // transient turn/LLM error visible live during a run (cleared on first new delta)
}

/** Result from a single subagent execution. */
export interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  startTime?: number;
  endTime?: number;
  /** Live progress snapshot for rendering. */
  progress: AgentProgress;
  output: string;
  filesChanged: string[];
  testsRan: boolean;
}

/** Details for the subagent tool result. */
export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  projectAgentsDir: string | null;
  results: SingleResult[];
}

/** Progress overrides for createDefaultProgress. */
export interface ProgressOverrides {
  status?: AgentProgress["status"];
  lastThinking?: string;
  model?: string;
  usage?: Partial<UsageStats>;
  startTime?: number;
  endTime?: number;
  contextWindow?: number;
  error?: string;
  errorVisible?: boolean;
}

/** Whether a subagent result represents an error (non-zero exit, or error/aborted stop reason).
 *  Lives in this leaf module so extension.ts and rendering.ts can share it without a circular
 *  import (extension imports rendering). NOTE: process-runner.ts has its OWN equivalent checks
 *  using the RPC-synthesized `finalExitCode` (not result.exitCode) — do NOT route those through
 *  this helper without first reconciling the exit-code semantics. */
export function isResultError(result: SingleResult): boolean {
  return result.exitCode !== 0 || isErrorStopReason(result.stopReason);
}

/** Whether a turn's stopReason indicates an error/abort (vs a clean end_turn/stop/max_tokens).
 *  Lives in this leaf module so extension.ts, rendering.ts, and process-runner.ts share it.
 *  NOTE: process-runner.ts's RPC exit synthesis also considers `exitCode !== 0` (the
 *  RPC-synthesized finalExitCode) separately — this helper covers the stopReason term only. */
export function isErrorStopReason(stopReason: string | undefined): boolean {
  return stopReason === "error" || stopReason === "aborted";
}

export type { AgentConfig, AgentDiscoveryResult } from "./agents.js";
