// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, AgentDiscoveryResult } from "../src/agents.js";
import { detectIntegrationCollisions, formatCollisionMessage } from "../src/collision-detection.js";

function agent(name: string, dir: string): AgentConfig {
  return {
    name,
    description: `${name} from ${dir}`,
    systemPrompt: "",
    filePath: `${dir}/${name}.md`,
  };
}

/** Build a discovery result with extension-provided agent dirs (the fields collision detection consumes). */
function discovery(
  extensionAgentDirs: Array<{ dir: string; extensionName: string; agents: AgentConfig[] }>,
  overrideNames: Set<string>,
): AgentDiscoveryResult {
  return {
    // agents/bundledAgents/projectAgentsDir aren't read by the detector — keep minimal.
    agents: [],
    bundledAgents: [],
    projectAgentsDir: null,
    extensionAgentDirs,
    overrideNames,
  };
}

describe("detectIntegrationCollisions", () => {
  it("detects a name defined by two distinct extensions (no override)", () => {
    const result = discovery(
      [
        { dir: "/ext-a/agents", extensionName: "ext-a", agents: [agent("shared", "/ext-a/agents")] },
        { dir: "/ext-b/agents", extensionName: "ext-b", agents: [agent("shared", "/ext-b/agents")] },
      ],
      new Set(),
    );

    const collisions = detectIntegrationCollisions(result);

    expect(collisions).toHaveLength(1);
    expect(collisions[0].agentName).toBe("shared");
    expect(collisions[0].extensions.sort()).toEqual(["ext-a", "ext-b"]);
  });

  it("a USER agent overriding the name suppresses the collision (override tier)", () => {
    const result = discovery(
      [
        { dir: "/ext-a/agents", extensionName: "ext-a", agents: [agent("shared", "/ext-a/agents")] },
        { dir: "/ext-b/agents", extensionName: "ext-b", agents: [agent("shared", "/ext-b/agents")] },
      ],
      new Set(["shared"]), // user agent named "shared" exists
    );

    const collisions = detectIntegrationCollisions(result);
    expect(collisions).toHaveLength(0);
  });

  it("a PROJECT agent overriding the name also suppresses the collision", () => {
    const result = discovery(
      [
        { dir: "/ext-a/agents", extensionName: "ext-a", agents: [agent("shared", "/ext-a/agents")] },
        { dir: "/ext-b/agents", extensionName: "ext-b", agents: [agent("shared", "/ext-b/agents")] },
      ],
      new Set(["shared"]), // overrideNames holds BOTH user and project names
    );

    expect(detectIntegrationCollisions(result)).toHaveLength(0);
  });

  it("two dirs from the SAME extension are NOT a collision (intra-extension dupe silently last-wins)", () => {
    // One extension registers two dirs that both define "shared" — that's an intra-extension
    // issue, not a cross-extension collision. Collapses to one extension.
    const result = discovery(
      [
        { dir: "/ext-a/agents-a", extensionName: "ext-a", agents: [agent("shared", "/ext-a/agents-a")] },
        { dir: "/ext-a/agents-b", extensionName: "ext-a", agents: [agent("shared", "/ext-a/agents-b")] },
      ],
      new Set(),
    );

    expect(detectIntegrationCollisions(result)).toHaveLength(0);
  });

  it("same-directory duplicates are NOT a collision (last-wins within a dir is out of scope)", () => {
    const result = discovery(
      [
        {
          dir: "/ext-a/agents",
          extensionName: "ext-a",
          agents: [agent("dup", "/ext-a/agents"), agent("dup", "/ext-a/agents")],
        },
      ],
      new Set(),
    );

    expect(detectIntegrationCollisions(result)).toHaveLength(0);
  });

  it("no duplicates -> no collision, no false positives", () => {
    const result = discovery(
      [
        { dir: "/ext-a/agents", extensionName: "ext-a", agents: [agent("agent-a", "/ext-a/agents")] },
        { dir: "/ext-b/agents", extensionName: "ext-b", agents: [agent("agent-b", "/ext-b/agents")] },
      ],
      new Set(),
    );

    expect(detectIntegrationCollisions(result)).toHaveLength(0);
  });

  it("reports multiple distinct collisions", () => {
    const result = discovery(
      [
        {
          dir: "/ext-a/agents",
          extensionName: "ext-a",
          agents: [agent("shared1", "/ext-a/agents"), agent("shared2", "/ext-a/agents")],
        },
        {
          dir: "/ext-b/agents",
          extensionName: "ext-b",
          agents: [agent("shared1", "/ext-b/agents"), agent("shared2", "/ext-b/agents")],
        },
      ],
      new Set(),
    );

    const collisions = detectIntegrationCollisions(result);
    expect(collisions).toHaveLength(2);
    expect(collisions.map((c) => c.agentName).sort()).toEqual(["shared1", "shared2"]);
  });

  it("an unrelated override name does not suppress a collision it doesn't cover", () => {
    const result = discovery(
      [
        { dir: "/ext-a/agents", extensionName: "ext-a", agents: [agent("shared", "/ext-a/agents")] },
        { dir: "/ext-b/agents", extensionName: "ext-b", agents: [agent("shared", "/ext-b/agents")] },
      ],
      new Set(["unrelated"]), // override exists for a DIFFERENT name
    );

    expect(detectIntegrationCollisions(result)).toHaveLength(1);
  });

  it("is PURE — no process.* side effects (returns collisions, never exits)", () => {
    const result = discovery(
      [
        { dir: "/ext-a/agents", extensionName: "ext-a", agents: [agent("shared", "/ext-a/agents")] },
        { dir: "/ext-b/agents", extensionName: "ext-b", agents: [agent("shared", "/ext-b/agents")] },
      ],
      new Set(),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const collisions = detectIntegrationCollisions(result);
    expect(collisions.length).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

describe("formatCollisionMessage", () => {
  it("reports the colliding agent name AND the extensions that define it, with a resolution hint", () => {
    const collisions = [{ agentName: "shared", extensions: ["avtc-pi-feature-flow", "avtc-pi-todo"] }];
    const msg = formatCollisionMessage(collisions);
    expect(msg).toContain("Extension provided agent name collision:");
    expect(msg).toContain('"shared" — defined by extensions: avtc-pi-feature-flow, avtc-pi-todo');
    expect(msg).toContain("Define a user or project agent with these names to override and resolve.");
  });

  it("lists one line per colliding name when multiple collide", () => {
    const collisions = [
      { agentName: "shared", extensions: ["ext-a", "ext-b"] },
      { agentName: "reviewer", extensions: ["ext-a", "ext-c"] },
    ];
    const msg = formatCollisionMessage(collisions);
    expect(msg).toContain('"shared" — defined by extensions: ext-a, ext-b');
    expect(msg).toContain('"reviewer" — defined by extensions: ext-a, ext-c');
  });
});
