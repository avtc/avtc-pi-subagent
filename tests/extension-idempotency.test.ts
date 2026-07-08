// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Reload-safe idempotent globalThis wiring guard for the extension entry.
 *
 * Why this matters: pi re-evaluates extension modules fresh on /reload (jiti moduleCache:false),
 * handing the entry a NEW Extension with empty handlers — but globalThis PERSISTS across the
 * reload. The entry uses a globalThis flag to avoid double-wiring when the package is both bundled
 * into the avtc-pi umbrella AND installed standalone. An un-reset flag would short-circuit
 * re-wiring after /reload, leaving the extension dead. So the flag MUST reset on session_shutdown
 * (pi accumulates session_shutdown handlers, so the reset never shadows other cleanup).
 */
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import subagentExtension, { _resetAllTestHooks, _setDiscoverAgents } from "../src/extension.js";
import { injectEmptyModelConfig, setTestSettings } from "./test-helpers.js";

const WIRED_KEY = "__avtcPiSubagentWired";
type GlobalWithWired = typeof globalThis & { [WIRED_KEY]?: boolean };

/** Discover-agents stub: a single bundled agent so buildDescription() never reads real disk. */
const discoverAgentsMock = vi.fn().mockReturnValue({
  agents: [{ name: "test-agent", filePath: "/tmp/test-agent.md", systemPrompt: "" }],
  bundledAgents: [],
  projectAgentsDir: null,
  extensionAgentDirs: [],
  overrideNames: new Set(),
});

/**
 * Lightest mock pi that lets the entry run end-to-end: an EventEmitter-backed `on` (so
 * session_shutdown handlers are CAPTURED and can be fired for the reload-safe cycle), and vi.fn
 * stubs for the rest. Returns the captured tool registrations + the `on` emitter.
 */
function makeMockPi(): { api: ExtensionAPI; emitter: EventEmitter; registrations: ToolDefinition[] } {
  const emitter = new EventEmitter();
  const registrations: ToolDefinition[] = [];
  const api = {
    on: ((event: string, handler: (...args: unknown[]) => unknown) => {
      emitter.on(event, handler);
      return () => emitter.off(event, handler);
    }) as ExtensionAPI["on"],
    events: { on: vi.fn(), emit: vi.fn() } as unknown as ExtensionAPI["events"],
    registerTool: (tool: ToolDefinition) => {
      registrations.push(tool);
    },
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),
    getSessionName: vi.fn(() => "idempotency-session"),
  } as unknown as ExtensionAPI;
  return { api, emitter, registrations };
}

describe("extension entry idempotency (reload-safe globalThis wiring guard)", () => {
  beforeEach(() => {
    delete (globalThis as GlobalWithWired)[WIRED_KEY];
    _resetAllTestHooks();
    _setDiscoverAgents(discoverAgentsMock);
    injectEmptyModelConfig();
    setTestSettings(null);
  });

  afterEach(() => {
    delete (globalThis as GlobalWithWired)[WIRED_KEY];
    _resetAllTestHooks();
  });

  test("(a) first call wires: registers the subagent tool exactly once", () => {
    const { api, registrations } = makeMockPi();
    subagentExtension(api);

    // Wiring reached registerTool: the subagent tool was captured.
    expect(registrations).toHaveLength(1);
  });

  test("(b) second call is a no-op: no additional tool registration", () => {
    const { api, registrations } = makeMockPi();
    subagentExtension(api);
    expect(registrations).toHaveLength(1);

    // A second invocation against a FRESH pi with empty handlers must short-circuit — it must
    // NOT re-register (and must NOT touch the new pi's handlers, simulating reload-safety).
    const second = makeMockPi();
    subagentExtension(second.api);

    expect(second.registrations).toHaveLength(0);
  });

  test("(c) the wiring flag is set on globalThis after the first call", () => {
    expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBeUndefined();
    const { api } = makeMockPi();
    subagentExtension(api);

    expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBe(true);
  });

  test("(d) RELOAD-SAFE cycle: firing session_shutdown resets the flag so a fresh call re-wires", () => {
    // 1) First call wires (flag set, shutdown handler captured on the emitter).
    const first = makeMockPi();
    subagentExtension(first.api);
    expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBe(true);
    expect(first.registrations).toHaveLength(1);

    // 2) Simulate pi tearing down this session: fire every session_shutdown handler the entry
    //    accumulated. The flag MUST reset to false so the next module reload can re-wire.
    first.emitter.emit("session_shutdown");
    expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBe(false);

    // 3) A fresh reload-equivalent call (new module, new empty pi) re-wires.
    const second = makeMockPi();
    subagentExtension(second.api);

    expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBe(true);
    expect(second.registrations).toHaveLength(1);
  });
});
