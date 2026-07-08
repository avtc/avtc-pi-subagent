// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { discoverAgents } from "../src/agents.js";
import { _resetAgentsPaths, type AgentConfig } from "../src/agents.js";
import { _resetAllTestHooks, _setDiscoverAgents } from "../src/extension.js";
import { injectEmptyModelConfig, registerSubagentExtension } from "./test-helpers.js";

/** Build a discovery with two extension dirs defining the same agent name (a collision). */
function collidingDiscovery(name: string): ReturnType<typeof vi.fn> {
  const mk = (dir: string, extensionName: string): { dir: string; extensionName: string; agents: AgentConfig[] } => ({
    dir,
    extensionName,
    agents: [{ name, description: `${name} from ${dir}`, systemPrompt: "", filePath: `${dir}/${name}.md` }],
  });
  return vi.fn().mockReturnValue({
    agents: [],
    bundledAgents: [],
    projectAgentsDir: null,
    extensionAgentDirs: [mk("/ext-a/agents", "ext-a"), mk("/ext-b/agents", "ext-b")],
    overrideNames: new Set<string>(),
  });
}

describe("collision hard-stop wiring (session_start)", () => {
  // Fail-stop spies restored in afterEach (not inline) so an assertion failure before the
  // restore cannot leak the process.exit/stderr mock across the isolate:false worker.
  let exitSpy: ReturnType<typeof vi.spyOn> | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;
  beforeEach(() => {
    _resetAllTestHooks();
    _resetAgentsPaths();
    injectEmptyModelConfig();
  });
  afterEach(() => {
    exitSpy?.mockRestore();
    stderrSpy?.mockRestore();
    exitSpy = undefined;
    stderrSpy = undefined;
    _resetAllTestHooks();
    _resetAgentsPaths();
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    delete process.env.PI_SUBAGENT_IS_FORK;
  });

  it("a collision -> writes stderr + process.exit(non-zero), no throw escapes", () => {
    _setDiscoverAgents(collidingDiscovery("shared") as unknown as typeof discoverAgents);

    const registrations: ToolDefinition[] = [];
    const { emitter } = registerSubagentExtension({ registrations, sessionName: "collision-session" });

    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("EXIT_CALLED");
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // session_start fires the collision hard-stop. process.exit is mocked to throw so we can
    // assert it was called WITHOUT actually exiting — the throw proves control reached exit
    // (a bare throw that escaped would surface a different error message).
    expect(() => emitter.emit("session_start", { reason: "startup" })).toThrow("EXIT_CALLED");
    expect(exitSpy).toHaveBeenCalledWith(1); // non-zero, fail-stop
    const stderrText = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(stderrText).toContain("Extension provided agent name collision:");
    expect(stderrText).toContain('"shared" — defined by extensions: ext-a, ext-b');
    // The message reports extension NAMES, never directory paths (no dir fallback / derivation).
    expect(stderrText).not.toContain("/ext-a/agents");
    expect(stderrText).not.toContain("/ext-b/agents");
    expect(stderrText).not.toContain("directory");
  });

  it("no collision -> no hard-stop (process.exit never called)", () => {
    // Distinct names across two extensions -> no collision.
    const mk = (
      dir: string,
      extensionName: string,
      name: string,
    ): { dir: string; extensionName: string; agents: AgentConfig[] } => ({
      dir,
      extensionName,
      agents: [{ name, description: `${name}`, systemPrompt: "", filePath: `${dir}/${name}.md` }],
    });
    _setDiscoverAgents(
      vi.fn().mockReturnValue({
        agents: [],
        bundledAgents: [],
        projectAgentsDir: null,
        extensionAgentDirs: [mk("/ext-a/agents", "ext-a", "agent-a"), mk("/ext-b/agents", "ext-b", "agent-b")],
        overrideNames: new Set<string>(),
      }),
    );

    const registrations: ToolDefinition[] = [];
    const { emitter } = registerSubagentExtension({ registrations, sessionName: "collision-session" });

    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("EXIT_MUST_NOT_BE_CALLED");
    }) as never);

    expect(() => emitter.emit("session_start", { reason: "startup" })).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
