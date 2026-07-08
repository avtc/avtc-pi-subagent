// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentConfig } from "../src/agents.js";
import { __internal } from "../src/extension.js";
import { _resetSkillResolution, _setLoadSkills, addSkillPaths, resolveSkillContent } from "../src/skill-resolution.js";

const { injectSkills } = __internal;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-inject-test-"));
  // Reset skill resolution state between tests
  _resetSkillResolution();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeAgent(skills: string[]): AgentConfig {
  return {
    name: "test-agent",
    description: "Test",
    tools: ["read", "bash"],
    skills: skills.length > 0 ? skills : undefined,
    systemPrompt: "You are a test agent.",
    filePath: "/tmp/test-agent.md",
  };
}

/** Create a mock loadSkills that returns skills from the given definitions. */
function mockLoadSkills(skills: Array<{ name: string; content: string }>) {
  return (_options: { cwd: string; agentDir: string; skillPaths: string[]; includeDefaults: boolean }) => {
    const tmpSkillDir = path.join(tmpDir, "loaded-skills");
    fs.mkdirSync(tmpSkillDir, { recursive: true });

    const loadedSkills: Skill[] = skills.map((s) => {
      const skillDir = path.join(tmpSkillDir, s.name);
      fs.mkdirSync(skillDir, { recursive: true });
      const skillFile = path.join(skillDir, "SKILL.md");
      fs.writeFileSync(skillFile, `---\nname: ${s.name}\n---\n\n${s.content}`, "utf-8");
      return {
        name: s.name,
        description: `Mock skill ${s.name}`,
        filePath: skillFile,
        baseDir: skillDir,
        sourceInfo: { path: skillDir, source: "project", scope: "project" as const, origin: "top-level" as const },
        disableModelInvocation: false,
      };
    });

    return { skills: loadedSkills, diagnostics: [] };
  };
}

describe("injectSkills", () => {
  test("returns same agent when no skills declared", () => {
    _setLoadSkills(mockLoadSkills([]));
    const agent = makeAgent([]);
    const result = injectSkills(agent, tmpDir);
    expect(result.systemPrompt).toBe("You are a test agent.");
    // Returns same object reference when nothing to inject
    expect(result).toBe(agent);
  });

  test("injects single skill into systemPrompt", () => {
    _setLoadSkills(mockLoadSkills([{ name: "my-skill", content: "# My Skill\n\nDo the thing." }]));

    const agent = makeAgent(["my-skill"]);
    const result = injectSkills(agent, tmpDir);

    expect(result.systemPrompt).toContain("You are a test agent.");
    expect(result.systemPrompt).toContain('<skill name="my-skill">');
    expect(result.systemPrompt).toContain("# My Skill");
    expect(result.systemPrompt).toContain("</skill>");
  });

  test("injects multiple skills as separate XML blocks", () => {
    _setLoadSkills(
      mockLoadSkills([
        { name: "skill-a", content: "# Skill A" },
        { name: "skill-b", content: "# Skill B" },
      ]),
    );

    const agent = makeAgent(["skill-a", "skill-b"]);
    const result = injectSkills(agent, tmpDir);

    expect(result.systemPrompt).toContain('<skill name="skill-a">');
    expect(result.systemPrompt).toContain('<skill name="skill-b">');
    expect(result.systemPrompt).toContain("# Skill A");
    expect(result.systemPrompt).toContain("# Skill B");
  });

  test("skips missing skill without breaking other injections", () => {
    _setLoadSkills(mockLoadSkills([{ name: "existing-skill", content: "# Existing" }]));

    const agent = makeAgent(["nonexistent-skill", "existing-skill"]);
    const result = injectSkills(agent, tmpDir);

    // Missing skill silently skipped
    expect(result.systemPrompt).not.toContain("nonexistent-skill");
    // Existing skill still injected
    expect(result.systemPrompt).toContain('<skill name="existing-skill">');
  });

  test("returns same agent reference when all skills are nonexistent", () => {
    _setLoadSkills(mockLoadSkills([]));

    const agent = makeAgent(["nonexistent-a", "nonexistent-b"]);
    const result = injectSkills(agent, tmpDir);

    // Same reference — no injection happened
    expect(result).toBe(agent);
    expect(result.systemPrompt).toBe(agent.systemPrompt);
  });

  test("does not mutate original agent object", () => {
    _setLoadSkills(mockLoadSkills([{ name: "my-skill", content: "# My Skill" }]));

    const agent = makeAgent(["my-skill"]);
    const originalPrompt = agent.systemPrompt;
    injectSkills(agent, tmpDir);

    // Original agent unchanged
    expect(agent.systemPrompt).toBe(originalPrompt);
  });

  test("returns same agent reference when skills contain path-traversal names", () => {
    _setLoadSkills(mockLoadSkills([]));

    const agent = makeAgent(["../etc/passwd", "../../secret", "foo/bar"]);
    const result = injectSkills(agent, tmpDir);

    // Path traversal names are rejected — same reference, no injection
    expect(result).toBe(agent);
    expect(result.systemPrompt).toBe(agent.systemPrompt);
  });

  test("strips frontmatter from injected skill content", () => {
    _setLoadSkills(mockLoadSkills([{ name: "meta-skill", content: "# Meta Skill" }]));

    const agent = makeAgent(["meta-skill"]);
    const result = injectSkills(agent, tmpDir);

    // No YAML frontmatter in injected content
    expect(result.systemPrompt).not.toContain("name: meta-skill");
    expect(result.systemPrompt).toContain("# Meta Skill");
  });
});

describe("addSkillPaths cache invalidation", () => {
  test("cache is invalidated when addSkillPaths is called", () => {
    const loader1 = mockLoadSkills([{ name: "skill-a", content: "# Skill A" }]);
    const loader2 = mockLoadSkills([{ name: "skill-b", content: "# Skill B" }]);

    _setLoadSkills(loader1);
    const result1 = resolveSkillContent("skill-a", tmpDir);
    expect(result1).toContain("# Skill A");

    // Changing skillPaths invalidates cache
    addSkillPaths(["/new/path"]);
    // Also reset the mock to return different skills
    _setLoadSkills(loader2);

    const result2 = resolveSkillContent("skill-b", tmpDir);
    expect(result2).toContain("# Skill B");

    // Old skill no longer in cache
    const result3 = resolveSkillContent("skill-a", tmpDir);
    expect(result3).toBeUndefined();
  });

  test("cache is reused when addSkillPaths is not called again", () => {
    const loader = vi.fn(mockLoadSkills([{ name: "cached-skill", content: "# Cached" }]));
    _setLoadSkills(loader);

    // First call loads skills
    resolveSkillContent("cached-skill", tmpDir);
    expect(loader).toHaveBeenCalledTimes(1);

    // Second call uses cache
    resolveSkillContent("cached-skill", tmpDir);
    expect(loader).toHaveBeenCalledTimes(1); // not called again
  });
});

describe("resolveSkillContent", () => {
  test("returns undefined for empty skill name", () => {
    _setLoadSkills(mockLoadSkills([]));
    expect(resolveSkillContent("", tmpDir)).toBeUndefined();
    expect(resolveSkillContent("  ", tmpDir)).toBeUndefined();
  });

  test("returns undefined for skill names with slashes", () => {
    _setLoadSkills(mockLoadSkills([]));
    expect(resolveSkillContent("foo/bar", tmpDir)).toBeUndefined();
    expect(resolveSkillContent("foo\\bar", tmpDir)).toBeUndefined();
  });

  test("returns undefined for path traversal attempts", () => {
    _setLoadSkills(mockLoadSkills([]));
    expect(resolveSkillContent("..", tmpDir)).toBeUndefined();
    expect(resolveSkillContent("../secret", tmpDir)).toBeUndefined();
  });
});
