// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { _resetAgentsPaths, _setUserAgentsDir, addAgentsPaths, discoverAgents } from "../src/agents.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-discovery-test-"));
  _resetAgentsPaths();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  _resetAgentsPaths();
});

/** Create an agent .md file in a directory. */
function writeAgentFile(dir: string, name: string, description: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.md`);
  fs.writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\nAgent body for ${name}.\n`,
    "utf-8",
  );
  return filePath;
}

describe("discoverAgents with agentsPaths", () => {
  test("discovers agents from agentsPaths directories", () => {
    const agentsDir = path.join(tmpDir, "integration-agents");
    writeAgentFile(agentsDir, "researcher", "Deep code analysis agent");
    writeAgentFile(agentsDir, "implementer", "TDD implementation agent");

    addAgentsPaths([agentsDir], "test-ext");

    const result = discoverAgents(tmpDir);

    const names = result.agents.map((a) => a.name);
    expect(names).toContain("researcher");
    expect(names).toContain("implementer");
  });

  test("agents from agentsPaths are discoverable", () => {
    const agentsDir = path.join(tmpDir, "integration-agents");
    writeAgentFile(agentsDir, "test-agent", "Test agent");

    addAgentsPaths([agentsDir], "test-ext");

    const result = discoverAgents(tmpDir);
    const agent = result.agents.find((a) => a.name === "test-agent");

    expect(agent).toBeDefined();
    expect(agent?.description).toBe("Test agent");
  });

  test("agentsPaths agents are overridden by project.pi/agents", () => {
    const agentsDir = path.join(tmpDir, "integration-agents");
    writeAgentFile(agentsDir, "overridden-agent", "Integration version");

    // Create a .pi/agents directory in tmpDir with same agent name
    const projectAgentsDir = path.join(tmpDir, ".pi", "agents");
    writeAgentFile(projectAgentsDir, "overridden-agent", "Project version");

    addAgentsPaths([agentsDir], "test-ext");

    const result = discoverAgents(tmpDir);

    const agent = result.agents.find((a) => a.name === "overridden-agent");
    expect(agent).toBeDefined();
    expect(agent?.description).toBe("Project version");
  });

  test("empty agentsPaths produces no integration agents", () => {
    addAgentsPaths([], "test-ext");

    // Create a .pi/agents dir so project discovery works
    const projectAgentsDir = path.join(tmpDir, ".pi", "agents");
    writeAgentFile(projectAgentsDir, "project-agent", "Project agent");

    const result = discoverAgents(tmpDir);

    const names = result.agents.map((a) => a.name);
    expect(names).toContain("project-agent");
    // Should not have any integration-sourced agents
    expect(result.agents.some((a) => a.filePath.includes("integration"))).toBe(false);
  });

  test("multiple agentsPaths directories are all searched", () => {
    const dir1 = path.join(tmpDir, "agents-1");
    const dir2 = path.join(tmpDir, "agents-2");
    writeAgentFile(dir1, "agent-from-1", "First dir");
    writeAgentFile(dir2, "agent-from-2", "Second dir");

    addAgentsPaths([dir1, dir2], "test-ext");

    const result = discoverAgents(tmpDir);

    const names = result.agents.map((a) => a.name);
    expect(names).toContain("agent-from-1");
    expect(names).toContain("agent-from-2");
  });

  test("earlier agentsPaths take priority over later ones", () => {
    const dir1 = path.join(tmpDir, "agents-1");
    const dir2 = path.join(tmpDir, "agents-2");
    writeAgentFile(dir1, "duplicate", "From first dir");
    writeAgentFile(dir2, "duplicate", "From second dir");

    addAgentsPaths([dir1, dir2], "test-ext");

    const result = discoverAgents(tmpDir);

    const agent = result.agents.find((a) => a.name === "duplicate");
    expect(agent).toBeDefined();
    expect(agent?.description).toBe("From first dir");
  });

  test("agentsPaths agents are always available", () => {
    const agentsDir = path.join(tmpDir, "integration-agents");
    writeAgentFile(agentsDir, "integration-agent", "Integration agent");

    addAgentsPaths([agentsDir], "test-ext");

    const result = discoverAgents(tmpDir);

    const names = result.agents.map((a) => a.name);
    // Integration agents are always loaded — registered via the ready API
    expect(names).toContain("integration-agent");
  });
});

describe("addAgentsPaths", () => {
  test("calling addAgentsPaths with new paths updates discovery", () => {
    const dir1 = path.join(tmpDir, "dir1");
    const dir2 = path.join(tmpDir, "dir2");
    writeAgentFile(dir1, "agent-1", "From dir1");
    writeAgentFile(dir2, "agent-2", "From dir2");

    addAgentsPaths([dir1], "test-ext");
    let result = discoverAgents(tmpDir);
    expect(result.agents.map((a) => a.name)).toContain("agent-1");

    addAgentsPaths([dir2], "test-ext");
    result = discoverAgents(tmpDir);
    expect(result.agents.map((a) => a.name)).toContain("agent-2");
  });

  test("_resetAgentsPaths clears agentsPaths state", () => {
    const agentsDir = path.join(tmpDir, "integration-agents");
    writeAgentFile(agentsDir, "temp-agent", "Temporary");

    addAgentsPaths([agentsDir], "test-ext");
    let result = discoverAgents(tmpDir);
    expect(result.agents.map((a) => a.name)).toContain("temp-agent");

    _resetAgentsPaths();
    result = discoverAgents(tmpDir);
    expect(result.agents.map((a) => a.name)).not.toContain("temp-agent");
  });
});

describe("priority reorder: bundled < integration < user < project", () => {
  let userDir: string;

  beforeEach(() => {
    // Point the user agents dir at a tmp subdir so we control user-tier agents in isolation
    // (os.homedir is not spyable under ESM).
    userDir = path.join(tmpDir, "user-agents");
    _setUserAgentsDir(() => userDir);
  });
  afterEach(() => {
    _setUserAgentsDir(null);
  });

  test("user agent overrides an integration agent with the same name", () => {
    const integrationDir = path.join(tmpDir, "integration-agents");
    writeAgentFile(integrationDir, "shared", "Integration version");
    writeAgentFile(userDir, "shared", "User version");

    addAgentsPaths([integrationDir], "test-ext");

    const result = discoverAgents(tmpDir);
    const agent = result.agents.find((a) => a.name === "shared");
    expect(agent?.description).toBe("User version"); // user beats integration
  });

  test("project agent still wins over user and integration", () => {
    const integrationDir = path.join(tmpDir, "integration-agents");
    writeAgentFile(integrationDir, "shared", "Integration version");
    writeAgentFile(userDir, "shared", "User version");
    const projectDir = path.join(tmpDir, ".pi", "agents");
    writeAgentFile(projectDir, "shared", "Project version");

    addAgentsPaths([integrationDir], "test-ext");

    const result = discoverAgents(tmpDir);
    const agent = result.agents.find((a) => a.name === "shared");
    expect(agent?.description).toBe("Project version");
  });
});

describe("discoverAgents exposes pre-merge per-extension data", () => {
  test("extensionAgentDirs has one entry per integration dir, each with agents + filePath", () => {
    const dir1 = path.join(tmpDir, "integration-1");
    const dir2 = path.join(tmpDir, "integration-2");
    writeAgentFile(dir1, "agent-a", "From dir1");
    writeAgentFile(dir2, "agent-b", "From dir2");

    addAgentsPaths([dir1, dir2], "test-ext");

    const result = discoverAgents(tmpDir);
    expect(result.extensionAgentDirs).toHaveLength(2);
    const dirs = result.extensionAgentDirs.map((s) => s.dir);
    expect(dirs).toContain(dir1);
    expect(dirs).toContain(dir2);

    const dir1Entry = result.extensionAgentDirs.find((s) => s.dir === dir1);
    expect(dir1Entry).toBeDefined();
    if (!dir1Entry) return;
    expect(dir1Entry.agents.map((a) => a.name)).toContain("agent-a");
    expect(dir1Entry.agents[0].filePath).toContain("agent-a.md");
  });

  test("extensionAgentDirs carries the extensionName (calling extension name)", () => {
    const dir = path.join(tmpDir, "integration-agents");
    writeAgentFile(dir, "agent-x", "From ext");

    addAgentsPaths([dir], "my-extension");

    const result = discoverAgents(tmpDir);
    expect(result.extensionAgentDirs).toHaveLength(1);
    expect(result.extensionAgentDirs[0].extensionName).toBe("my-extension");
  });

  test("overrideNames contains user + project agent names", () => {
    const userAgentsDir = path.join(tmpDir, "user-agents");
    _setUserAgentsDir(() => userAgentsDir);
    try {
      writeAgentFile(userAgentsDir, "user-agent", "User agent");
      const projectDir = path.join(tmpDir, ".pi", "agents");
      writeAgentFile(projectDir, "project-agent", "Project agent");
      const integrationDir = path.join(tmpDir, "integration-agents");
      writeAgentFile(integrationDir, "integration-agent", "Integration agent");
      addAgentsPaths([integrationDir], "test-ext");

      const result = discoverAgents(tmpDir);
      expect(result.overrideNames.has("user-agent")).toBe(true);
      expect(result.overrideNames.has("project-agent")).toBe(true);
      // Integration agents are NOT override-tier.
      expect(result.overrideNames.has("integration-agent")).toBe(false);
    } finally {
      _setUserAgentsDir(null);
    }
  });
});

describe("addAgentsPaths(paths, extensionName) — required attribution", () => {
  test("addAgentsPaths([dir], 'my-ext') forwards extensionName to extensionAgentDirs", () => {
    const dir = path.join(tmpDir, "integration-agents");
    writeAgentFile(dir, "attr-agent", "Attributed");

    addAgentsPaths([dir], "my-ext");

    const result = discoverAgents(tmpDir);
    expect(result.extensionAgentDirs[0]).toMatchObject({ dir, extensionName: "my-ext" });
  });

  test("dedup by dir: adding the same dir twice with different extensionNames keeps first", () => {
    const dir = path.join(tmpDir, "integration-agents");
    writeAgentFile(dir, "dup-agent", "Dup");

    addAgentsPaths([dir], "first-ext");
    addAgentsPaths([dir], "second-ext");

    const result = discoverAgents(tmpDir);
    expect(result.extensionAgentDirs).toHaveLength(1);
    expect(result.extensionAgentDirs[0].extensionName).toBe("first-ext");
  });
});
