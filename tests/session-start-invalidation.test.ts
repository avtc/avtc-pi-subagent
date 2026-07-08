// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Prove the `session_start` handler actually calls `invalidateSubagentConfig` — the entire
 * hot-reload contract rests on that single wiring. The loader function and the invalidator
 * are each unit-tested, but no test fired the REAL `session_start` event to prove the wiring.
 * This test does: it registers the real extension against an EventEmitter-backed `pi.on`,
 * drives the REAL loader against a temp settings file, fires `session_start`, and asserts the
 * next load observes a mutated file (cache was invalidated).
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentExtension, { _resetAllTestHooks } from "../src/extension.js";
import { _resetSubagentConfig, invalidateSubagentConfig, loadSubagentModelConfig } from "../src/subagent-config.js";

describe("session_start handler invalidates the model-config cache", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    _resetAllTestHooks();
    _resetSubagentConfig();
    tempDir = mkdtempSync(join(tmpdir(), "pi-subagent-config-invalidation-"));
    // The session_start handler reads config from module-scope globalSettingsDir + process.cwd().
    // chdir into tempDir so that the project settings the test writes are the SAME project the
    // handler reads (the single-slot config cache would otherwise be populated with the repo's
    // real cwd settings during the description refresh, masking the invalidation under test).
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    _resetAllTestHooks();
    _resetSubagentConfig();
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  const writeProjectSettings = (model: string): void => {
    mkdirSync(join(tempDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tempDir, ".pi", "settings.json"),
      JSON.stringify({ "avtc-pi-subagent": { "subagent-models": { "agent-x": model } } }),
    );
  };

  /** Register the real extension with a REAL EventEmitter backing `pi.on`, so the
   *  `session_start` handler is captured and can be fired by emitting the event. */
  const registerExtensionAndReturnEmitter = (): EventEmitter => {
    const emitter = new EventEmitter();
    subagentExtension({
      on: ((event: string, handler: (...args: unknown[]) => unknown) => {
        emitter.on(event, handler);
        return () => emitter.off(event, handler);
      }) as ExtensionAPI["on"],
      events: { on: vi.fn(), emit: vi.fn() } as unknown as ExtensionAPI["events"],
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      appendEntry: vi.fn(),
      getSessionName: vi.fn(() => "config-invalidation-session"),
    } as unknown as ExtensionAPI);
    return emitter;
  };

  it("firing session_start causes the next load to re-read the (mutated) settings file", () => {
    writeProjectSettings("alpha/1");
    const emitter = registerExtensionAndReturnEmitter();

    // globalDir=null → only the project file (tempDir) is read.
    const before = loadSubagentModelConfig(null, tempDir);
    expect(before["subagent-models"]?.["agent-x"]).toBe("alpha/1");

    // Mutate the settings file. WITHOUT invalidation the cache would still return alpha/1.
    writeProjectSettings("beta/2");
    const cachedAfterMutate = loadSubagentModelConfig(null, tempDir);
    expect(cachedAfterMutate["subagent-models"]?.["agent-x"]).toBe("alpha/1"); // still cached

    // Fire session_start → the registered handler must call invalidateSubagentConfig.
    emitter.emit("session_start");

    const after = loadSubagentModelConfig(null, tempDir);
    expect(after["subagent-models"]?.["agent-x"]).toBe("beta/2"); // re-read from disk
  });

  it("invalidateSubagentConfig is idempotent and safe when the cache is already empty", () => {
    // Direct unit guard for the invalidator the handler calls: clearing an unloaded
    // cache must not throw and must leave the loader able to read fresh.
    expect(() => invalidateSubagentConfig()).not.toThrow();
    writeProjectSettings("gamma/3");
    const cfg = loadSubagentModelConfig(null, tempDir);
    expect(cfg["subagent-models"]?.["agent-x"]).toBe("gamma/3");
  });
});
