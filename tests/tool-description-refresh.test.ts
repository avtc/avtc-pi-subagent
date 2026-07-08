// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Prove the subagent tool description is refreshed in `session_start` to include
 * integration agents registered by OTHER extensions via the `pi-subagent:ready`
 * API (addAgentsPaths).
 *
 * Why this matters: `ToolDefinition.description` is a static string captured at
 * registerTool() time. The factory runs BEFORE session_start, so at factory time
 * `_agentsPaths` is empty and integration agents are invisible. The extension
 * re-registers the tool in session_start (after emitting `:ready`) so the
 * description the LLM sees includes agents other extensions contributed.
 *
 * See extension.ts: `buildDescription()`, `refreshToolDescription()`, and the
 * session_start handler that calls it after `pi.events.emit("pi-subagent:ready")`.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAgentsPaths, addAgentsPaths } from "../src/agents.js";
import subagentExtension, { _resetAllTestHooks } from "../src/extension.js";

describe("tool description refreshed in session_start includes integration agents", () => {
  let tempDir: string;

  beforeEach(() => {
    _resetAllTestHooks();
    _resetAgentsPaths();
    tempDir = mkdtempSync(join(tmpdir(), "pi-subagent-desc-"));
  });

  afterEach(() => {
    _resetAllTestHooks();
    _resetAgentsPaths();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Register the real extension against an EventEmitter-backed `pi.on` (so the
   * session_start handler is captured and can be fired) and a REAL `pi.events`
   * (so `pi-subagent:ready` listeners actually run when emit is called). Every
   * registerTool() call is recorded so the description can be inspected at each
   * registration point.
   *
   * `onReady` is invoked from a `:ready` listener — it simulates another
   * extension calling addAgentsPaths([...]) to contribute an agent directory.
   */
  const registerExtension = (onReady: () => void): { registrations: ToolDefinition[]; emitter: EventEmitter } => {
    const emitter = new EventEmitter();
    const events = new EventEmitter();
    const registrations: ToolDefinition[] = [];

    // Simulate another extension subscribing to :ready in its own factory.
    events.on("pi-subagent:ready", () => onReady());

    subagentExtension({
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
      getSessionName: vi.fn(() => "desc-refresh-session"),
    } as unknown as ExtensionAPI);

    return { registrations, emitter };
  };

  const writeIntegrationAgent = (name: string): void => {
    writeFileSync(join(tempDir, `${name}.md`), `---\nname: ${name}\ndescription: Integration test agent\n---\nbody\n`);
  };

  it("factory-time description lacks the integration agent; session_start refresh adds it", () => {
    writeIntegrationAgent("integration-scout");
    const { registrations, emitter } = registerExtension(() => {
      // Another extension contributes the agent dir when :ready fires.
      addAgentsPaths([tempDir], "test-ext");
    });

    // Factory registered the tool exactly once, before any :ready listener ran.
    expect(registrations).toHaveLength(1);
    const factoryDesc = registrations[0].description;
    expect(factoryDesc).toContain("worker"); // bundled agent always present
    expect(factoryDesc).not.toContain("integration-scout"); // not yet registered

    // Fire session_start: handler resets paths, emits :ready (other extension
    // calls addAgentsPaths synchronously), then refreshes the description.
    emitter.emit("session_start");

    // A second registration happened with the refreshed description.
    expect(registrations).toHaveLength(2);
    const refreshedDesc = registrations[1].description;
    expect(refreshedDesc).toContain("worker");
    expect(refreshedDesc).toContain("integration-scout"); // now present
  });

  it("does not re-register when the agent list is unchanged (idempotent)", () => {
    // No integration agent contributed by the ready listener.
    const { registrations, emitter } = registerExtension(() => {
      /* no-op: nothing contributed */
    });

    expect(registrations).toHaveLength(1);
    const before = registrations[0].description;

    emitter.emit("session_start");

    // Description identical → refreshToolDescription skips re-registration.
    expect(registrations).toHaveLength(1);
    expect(registrations[0].description).toBe(before);
  });

  it("an agent added AFTER session_start returns is not picked up until the next session_start", () => {
    const { registrations, emitter } = registerExtension(() => {
      addAgentsPaths([tempDir], "test-ext");
    });

    // First session_start: tempDir is empty → description has only bundled agents.
    emitter.emit("session_start");
    const lastAfterFirst = registrations[registrations.length - 1].description;
    expect(lastAfterFirst).toContain("worker");
    expect(lastAfterFirst).not.toContain("late-agent");

    // Now add an agent file AFTER session_start has returned.
    writeIntegrationAgent("late-agent");

    // No refresh in between: the stale description is still the last one.
    expect(registrations[registrations.length - 1].description).not.toContain("late-agent");

    // Next session_start re-discovers → picks up the late agent.
    emitter.emit("session_start");
    const lastAfterSecond = registrations[registrations.length - 1].description;
    expect(lastAfterSecond).toContain("late-agent");
  });
});
