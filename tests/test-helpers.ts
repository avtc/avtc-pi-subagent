// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** Shared test helpers for subagent extension tests. */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import subagentExtension, { _setLoadSubagentModelConfig } from "../src/extension.js";
import { SUBAGENT_SCHEMA, type SubagentSettings } from "../src/schema.js";
import { _setGetSubagentSettings } from "../src/settings-ui.js";
import type { ModelOverride, SubagentConfig, SubagentModelConfig } from "../src/subagent-config.js";
import type { ThemeLike } from "../src/types.js";

/** Process exited successfully */
export const EXIT_CODE_SUCCESS = 0;

/** Process exited with error */
export const EXIT_CODE_FAILURE = 1;

/** A fake ChildProcess backed by EventEmitters for stdout/stderr. The spawn mock returns one;
 *  tests drive it by emitting "data" on proc.stdout / "close" on proc. */
export function createFakeProcess(): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  proc.stdout = new EventEmitter() as ChildProcess["stdout"];
  proc.stderr = new EventEmitter() as ChildProcess["stderr"];
  proc.kill = vi.fn(() => {
    (proc as unknown as { killed: boolean }).killed = true;
    return true;
  });
  (proc as unknown as { killed: boolean }).killed = false;
  return proc;
}

/** A fake ChildProcess WITH a mock stdin (write/end as vi.fn). RPC tests write prompt/shutdown
 *  commands to stdin and assert on them; json-mode tests never touch stdin. The stdin is an
 *  EventEmitter so production code can attach a safety 'error' listener (a real Writable/
 *  Socket exposes both .on() and .write()/.end()). */
export function createFakeProcessWithStdin(): ChildProcess {
  const proc = createFakeProcess();
  const stdin = new EventEmitter() as unknown as { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdin.write = vi.fn(() => true);
  stdin.end = vi.fn();
  (proc as unknown as { stdin: unknown }).stdin = stdin;
  return proc;
}

/** Derive the schema defaults statically (no handle needed) — used to seed the settings mock. */
function subagentSettingsDefaults(): SubagentSettings {
  const d: Record<string, unknown> = {};
  for (const s of SUBAGENT_SCHEMA.settings) d[s.id] = s.defaultValue;
  return d as unknown as SubagentSettings;
}

/**
 * Mock the settings read (DI/test-double for the settings source): getSubagentSettings returns a
 * mutable holder seeded with schema defaults (+ a shorter subagent timeout than the 3h schema
 * default — tests must not wait hours — plus any overrides). The holder is returned so a test can
 * mutate it mid-test (e.g. `const s = setTestSettings(null); s.subagentConcurrency = 1;`). Cleared in
 * afterEach via _resetAllTestHooks. This keeps subagent tests isolated from settings-ui (no real
 * handle, no env var, no session_start).
 */
export function setTestSettings(overrides: Partial<SubagentSettings> | null): SubagentSettings {
  const settings: SubagentSettings = {
    ...subagentSettingsDefaults(),
    subagentTimeoutMs: 600_000,
    ...(overrides ?? {}),
  };
  _setGetSubagentSettings(() => settings);
  return settings;
}

/** Empty subagent model config — used to isolate tests from the developer's real
 *  ~/.pi/agent/settings.json `subagent` section (so Phase 1/3 resolution is deterministic). */
const EMPTY_MODEL_CONFIG: SubagentModelConfig = { "subagent-models": {}, "default-model": null };

/** Build a SubagentModelConfig from a subagent-models map (+ optional default-model).
 *  Shared by the resolution/phase/integration tests so the config shape stays
 *  consistent and the factories aren't duplicated across files. */
export function makeSubagentConfig(
  models: Record<string, ModelOverride>,
  defaultModel: string | null,
): SubagentModelConfig {
  return { "subagent-models": models, "default-model": defaultModel };
}

/** No default model override */
export const NO_DEFAULT_MODEL: string | null = null;

/** Inject an empty subagent model-config loader so tests are isolated from the
 *  developer's real global/project settings.json. Call in beforeEach(); the loader
 *  is restored by _resetAllTestHooks() in afterEach().
 *
 *  REQUIRED for any test that drives the subagent tool (registerTool()/tool.execute),
 *  which reaches the resolveModelForAgent closure: without this, Phase 1/3 resolution
 *  reads the developer's real ~/.pi/agent/settings.json `subagent` section and the
 *  resolved model is appended to the spawn `--model` arg (process-runner.ts), making
 *  the test machine-dependent. The 3 dispatch test files all call this in beforeEach. */
export function injectEmptyModelConfig(): void {
  _setLoadSubagentModelConfig(() => EMPTY_MODEL_CONFIG);
}

/** Minimal mock theme — strips formatting so plain-text matching works. */
export const mockTheme: ThemeLike = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

/** Helper to collect all text content from a Container tree. */
export function collectText(container: { children: Array<{ text?: string; children?: unknown[] }> }): string[] {
  const texts: string[] = [];
  for (const child of container.children) {
    if ("text" in child && typeof child.text === "string") {
      texts.push(child.text);
    }
    if ("children" in child && Array.isArray(child.children)) {
      texts.push(...collectText(child as { children: Array<{ text?: string; children?: unknown[] }> }));
    }
  }
  return texts;
}

/** Zero-usage object for SingleResult usage fields. */
export const ZERO_USAGE = {
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
} as const;

/** Build a SubagentConfig with visibility globs. Uses an OPTIONS object so the hidden/disabled
 *  globs cannot be transposed (each glob is named, so position is irrelevant). Omitted globs are absent. */
export function configWithGlobs(opts: { hidden?: string[]; disabled?: string[] }): SubagentConfig {
  const cfg: SubagentConfig = { "subagent-models": {}, "default-model": null };
  if (opts.hidden) cfg["hidden-agents"] = opts.hidden;
  if (opts.disabled) cfg["disabled-agents"] = opts.disabled;
  return cfg;
}

/** Resolve once a spawn mock has been called, replacing hand-rolled 2s polling loops. Event-driven:
 *  the mock resolves a promise on its first call, so the wait is deterministic (no busy-poll, no
 *  fixed worst-case delay). Throws (rejects) if spawn is not called within `timeoutMs`. */
export function spawnCalledPromise(timeoutMs: number): { promise: Promise<void>; mark: () => void } {
  let mark: () => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("spawn was never called within the timeout")), timeoutMs);
    mark = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, mark };
}

/** Options for registerSubagentExtension — all optional so each test supplies only what it needs. */
export interface RegisterExtensionOptions {
  /** Captures every ToolDefinition passed to registerTool (default: an array the helper returns). */
  registrations?: ToolDefinition[];
  /** Called from a `pi-subagent:ready` listener (simulates another extension calling addAgentsPaths). */
  onReady?: () => void;
  /** Extra ExtensionAPI fields (e.g. getAllTools/setActiveTools for child-enforcement tests). */
  extra?: Record<string, unknown>;
  /** getSessionName return value (default: "test-session"). */
  sessionName?: string;
}

/** Register the real subagent extension against an EventEmitter-backed mock pi and return the
 *  handles tests need to drive it (the session_start/click emitter, the events bus, and the
 *  captured tool registrations). Deduplicates the copy-pasted harness across 5 test files.
 *  `onReady` runs from a `pi-subagent:ready` listener so it fires when the handler emits. */
export function registerSubagentExtension(opts: RegisterExtensionOptions): {
  emitter: EventEmitter;
  events: EventEmitter;
  registrations: ToolDefinition[];
} {
  const registrations = opts.registrations ?? [];
  const emitter = new EventEmitter();
  const events = new EventEmitter();
  if (opts.onReady) events.on("pi-subagent:ready", () => opts.onReady?.());
  const api = {
    on: ((event: string, handler: (...args: unknown[]) => unknown) => {
      emitter.on(event, handler);
      return () => emitter.off(event, handler);
    }) as ExtensionAPI["on"],
    events: {
      on: ((channel: string, handler: (data: unknown) => void) => {
        events.on(channel, handler);
        return () => events.off(channel, handler);
      }) as ExtensionAPI["events"]["on"],
      emit: ((channel: string, data: unknown) => events.emit(channel, data)) as ExtensionAPI["events"]["emit"],
    },
    registerTool: (tool: ToolDefinition) => {
      registrations.push(tool);
    },
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),
    getSessionName: vi.fn(() => opts.sessionName ?? "test-session"),
    ...(opts.extra ?? {}),
  } as unknown as ExtensionAPI;
  subagentExtension(api);
  return { emitter, events, registrations };
}

/** A class-based session-manager mock for fork-mode dispatch tests. Fork-mode dispatch reaches
 *  `sessionManager.constructor.open` to create a branched session; a class instance gives the
 *  mock a real `.constructor.open`. Shared by spawn-env-forwarding + cross-repo-integration. */
export class MockSessionManager {
  static open(_filePath: string): { createBranchedSession: (leaf: string) => string | undefined } {
    return { createBranchedSession: (_leaf: string) => "/test/branched-session.jsonl" };
  }

  getSessionFile(): string {
    return "/test/session.jsonl";
  }

  getLeafId(): string {
    return "leaf-123";
  }
}
