// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Tests for the `hide-from-agents-list` frontmatter field.
 *
 * An agent with `hide-from-agents-list: true` is:
 *  - omitted from the subagent tool description's "Available agents" list,
 *  - omitted from the "Available agents" error responses (invalid mode / fallthrough),
 *  - still fully routable when called by name (execute-time discovery is unaffected).
 *
 * The runtime note "Other agents may be available at runtime — use them when
 * instructed." is always appended to the description (integration agents and
 * fork subagents can appear at runtime regardless of hidden agent count).
 */
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetAgentsPaths, type AgentConfig, addAgentsPaths } from "../src/agents.js";
import { _resetAllTestHooks, _setDiscoverAgents, _setLoadSubagentConfig } from "../src/extension.js";
import type { SubagentConfig } from "../src/subagent-config.js";
import { configWithGlobs, injectEmptyModelConfig, registerSubagentExtension } from "./test-helpers.js";

describe("hide-from-agents-list", () => {
  let tempDir: string;

  beforeEach(() => {
    _resetAllTestHooks();
    _resetAgentsPaths();
    tempDir = mkdtempSync(join(tmpdir(), "pi-subagent-hidden-"));
  });

  afterEach(() => {
    _resetAllTestHooks();
    _resetAgentsPaths();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Register the extension with an EventEmitter-backed pi and real pi.events. */
  const registerExtension = (): { registrations: ToolDefinition[]; emitter: EventEmitter } => {
    const registrations: ToolDefinition[] = [];
    const { emitter } = registerSubagentExtension({ registrations, sessionName: "hidden-session" });
    return { registrations, emitter };
  };

  /** Write an agent .md file with the given frontmatter fields into tempDir. */
  const writeAgent = (name: string, extra: Record<string, unknown> = {}): void => {
    const fm: string[] = [`name: ${name}`, `description: ${(extra.description ?? `${name} agent`) as string}`];
    for (const [k, v] of Object.entries(extra)) {
      if (k === "description") continue;
      fm.push(`${k}: ${v}`);
    }
    writeFileSync(join(tempDir, `${name}.md`), `---\n${fm.join("\n")}\n---\nbody\n`);
  };

  it("parses hide-from-agents-list: true from frontmatter into hideFromAgentsList", async () => {
    writeAgent("secret", { "hide-from-agents-list": true });
    // Use real discoverAgents (not mocked) so parsing is exercised end-to-end.
    addAgentsPaths([tempDir], "test-ext");
    const { discoverAgents } = await import("../src/agents.js");
    const discovery = discoverAgents(tempDir);
    const secret = discovery.agents.find((a) => a.name === "secret");
    expect(secret).toBeDefined();
    expect(secret?.hideFromAgentsList).toBe(true);
  });

  it("defaults to hideFromAgentsList=false when the field is absent", async () => {
    writeAgent("public");
    addAgentsPaths([tempDir], "test-ext");
    const { discoverAgents } = await import("../src/agents.js");
    const discovery = discoverAgents(tempDir);
    const pub = discovery.agents.find((a) => a.name === "public");
    expect(pub?.hideFromAgentsList).toBe(false);
  });

  it("excludes hidden agents from the tool description name list", () => {
    addAgentsPaths([tempDir], "test-ext");
    writeAgent("public-a");
    writeAgent("secret-b", { "hide-from-agents-list": true });

    const { registrations } = registerExtension();
    const desc = registrations[0].description;
    expect(desc).toContain("public-a");
    expect(desc).toContain("worker"); // bundled agent always listed
    expect(desc).not.toContain("secret-b");
  });

  it("inlines each agent's description as `name (desc)` in the announcement", () => {
    addAgentsPaths([tempDir], "test-ext");
    writeAgent("custom-worker", { description: "does custom work" });

    const { registrations } = registerExtension();
    const desc = registrations[0].description;
    // Description is inlined parenthetically right after the name.
    expect(desc).toContain("custom-worker (does custom work)");
  });

  it("truncates long descriptions at a word boundary within 60 chars", () => {
    addAgentsPaths([tempDir], "test-ext");
    const long = "Generalist code reviewer covering all aspects via todo-driven sequential iteration";
    writeAgent("wordy-agent", { description: long });

    const { registrations } = registerExtension();
    const desc = registrations[0].description;
    // The full long description must NOT appear; a truncated, ellipsized form does.
    expect(desc).not.toContain(long);
    expect(desc).toContain("wordy-agent (");
    expect(desc).toContain("…");
    const match = desc.match(/wordy-agent \(([^)]+)…\)/);
    expect(match).not.toBeNull();
    const head = match?.[1] ?? "";
    // Truncated head stays within the 60-char cap.
    expect(head.length).toBeLessThanOrEqual(60);
    // Word-boundary cut: head is a clean prefix of the source and the source's
    // next char after the head is a space (not a letter — i.e. no mid-word cut).
    expect(long.startsWith(head)).toBe(true);
    expect(long.charAt(head.length)).toBe(" ");
  });

  it("always appends the runtime note", () => {
    addAgentsPaths([tempDir], "test-ext");
    writeAgent("public-c");

    const { registrations } = registerExtension();
    expect(registrations[0].description).toContain("may be available at runtime");
  });

  describe("error responses exclude hidden agents", () => {
    // Mock discoverAgents so execute() sees a controlled agent set without spawning.
    const visibleAgent: AgentConfig = {
      name: "visible-agent",
      description: "d",
      systemPrompt: "",
      filePath: "/tmp/visible.md",
      hideFromAgentsList: false,
    };
    const hiddenAgent: AgentConfig = {
      name: "hidden-agent",
      description: "d",
      systemPrompt: "",
      filePath: "/tmp/hidden.md",
      hideFromAgentsList: true,
    };

    const setup = (): ToolDefinition => {
      _setDiscoverAgents(() => ({
        agents: [visibleAgent, hiddenAgent],
        bundledAgents: [visibleAgent],
        projectAgentsDir: null,
        extensionAgentDirs: [],
        overrideNames: new Set(),
      }));
      const { registrations } = registerExtension();
      // Trigger session_start so the description refresh runs (uses the mock).
      return registrations[0];
    };

    const ctx = { cwd: process.cwd(), hasUI: false } as unknown as ExtensionContext;

    it("error response (invalid parameters) omits hidden agents", async () => {
      injectEmptyModelConfig();
      const tool = setup();
      // modeCount===0 (no mode provided) -> the invalid-parameters listing.
      // Both listing sites (invalid-mode + final fallthrough) use visibleAgents(),
      // so this covers the shared filter applied everywhere agents are listed.
      const result = (await tool.execute("id", { tasks: [] }, undefined, undefined, ctx)) as {
        content: Array<{ type: string; text?: string }>;
      };
      const text = result.content.map((c) => c.text ?? "").join("");
      expect(text).toContain("visible-agent");
      expect(text).not.toContain("hidden-agent");
    });
  });

  it("hidden agent is still routable when called by name (execute-time discovery unaffected)", async () => {
    // The filter only affects model-facing listings, not routing. discoverAgents
    // (the source execute() uses) still returns hidden agents, so dispatch by
    // name resolves them.
    addAgentsPaths([tempDir], "test-ext");
    writeAgent("callable-secret", { "hide-from-agents-list": true });
    const { discoverAgents } = await import("../src/agents.js");
    const discovery = discoverAgents(tempDir);
    expect(discovery.agents.map((a) => a.name)).toContain("callable-secret");
  });
});

describe("hidden-agents config glob", () => {
  const debugLogger: AgentConfig = {
    name: "debug-logger",
    description: "d",
    systemPrompt: "",
    filePath: "/tmp/debug.md",
    hideFromAgentsList: false,
  };
  const worker: AgentConfig = {
    name: "worker",
    description: "d",
    systemPrompt: "",
    filePath: "/tmp/worker.md",
    hideFromAgentsList: false,
  };

  beforeEach(() => {
    _resetAllTestHooks();
    _resetAgentsPaths();
    injectEmptyModelConfig();
  });
  afterEach(() => {
    _resetAllTestHooks();
    _resetAgentsPaths();
  });

  const registerExtension = (cfg: SubagentConfig): ToolDefinition[] => {
    _setDiscoverAgents(() => ({
      agents: [debugLogger, worker],
      bundledAgents: [worker],
      projectAgentsDir: null,
      extensionAgentDirs: [],
      overrideNames: new Set(),
    }));
    _setLoadSubagentConfig(() => ({ config: cfg, errors: [] }));
    const registrations: ToolDefinition[] = [];
    registerSubagentExtension({ registrations, sessionName: "hidden-session" });
    return registrations;
  };

  it("hidden-agents glob hides matching agents from the tool description", () => {
    const [tool] = registerExtension(configWithGlobs({ hidden: ["debug-*"] }));
    expect(tool.description).not.toContain("debug-logger");
    expect(tool.description).toContain("worker");
  });

  it("hidden-agents matches base name only (asymmetry): a fork-suffixed glob hides NOTHING", () => {
    // A glob like "reviewer-fork" would only hide an agent literally named "reviewer-fork";
    // it must not hide an agent named "reviewer".
    const reviewer: AgentConfig = {
      name: "reviewer",
      description: "d",
      systemPrompt: "",
      filePath: "/tmp/r.md",
      hideFromAgentsList: false,
    };
    _setDiscoverAgents(() => ({
      agents: [reviewer, worker],
      bundledAgents: [worker],
      projectAgentsDir: null,
      extensionAgentDirs: [],
      overrideNames: new Set(),
    }));
    _setLoadSubagentConfig(() => ({ config: configWithGlobs({ hidden: ["reviewer-fork"] }), errors: [] }));
    const registrations: ToolDefinition[] = [];
    registerSubagentExtension({ registrations, sessionName: "hidden-session" });
    // "reviewer" stays visible because hidden-agents matches base names only.
    expect(registrations[0].description).toContain("reviewer");
  });
});
