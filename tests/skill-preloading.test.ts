// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadAgentsFromDir } from "../src/agents.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-skill-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAgent(name: string, content: string) {
  fs.writeFileSync(path.join(tmpDir, `${name}.md`), content, "utf-8");
}

describe("skill preloading in agent discovery", () => {
  test("parses skills field from agent frontmatter", () => {
    writeAgent(
      "test-agent",
      `---
name: test-agent
description: "Test agent"
tools: read, bash
skills: design-review, other-skill
---

You are a test agent.`,
    );

    const agents = loadAgentsFromDir(tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("test-agent");
    expect(agents[0].skills).toEqual(["design-review", "other-skill"]);
  });

  test("handles agent without skills field", () => {
    writeAgent(
      "no-skills-agent",
      `---
name: no-skills-agent
description: "No skills"
tools: read
---

You are an agent without skills.`,
    );

    const agents = loadAgentsFromDir(tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].skills).toBeUndefined();
  });

  test("accepts 'skill' (singular) frontmatter field", () => {
    writeAgent(
      "single-skill-agent",
      `---
name: single-skill-agent
description: "Single skill"
tools: read
skill: design-review
---

You are an agent.`,
    );

    const agents = loadAgentsFromDir(tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].skills).toEqual(["design-review"]);
  });

  test("handles empty skills value", () => {
    writeAgent(
      "empty-skills",
      `---
name: empty-skills
description: "Empty skills"
tools: read
skills: ""
---

You are an agent.`,
    );

    const agents = loadAgentsFromDir(tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].skills).toBeUndefined();
  });

  test("handles whitespace-only skills value", () => {
    writeAgent(
      "ws-skills",
      `---
name: ws-skills
description: "Whitespace skills"
tools: read
skills: "   "
---

You are an agent.`,
    );

    const agents = loadAgentsFromDir(tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].skills).toBeUndefined();
  });

  test("trims whitespace-padded skill names", () => {
    writeAgent(
      "padded-skills",
      `---
name: padded-skills
description: "Padded skills"
tools: read
skills: " design-review , other-skill "
---

You are an agent.`,
    );

    const agents = loadAgentsFromDir(tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].skills).toEqual(["design-review", "other-skill"]);
  });

  test("'skill' field takes precedence over 'skills' when both present", () => {
    writeAgent(
      "dual-field",
      `---
name: dual-field
description: "Both fields"
tools: read
skill: from-skill-field
skills: from-skills-field
---

You are an agent.`,
    );

    const agents = loadAgentsFromDir(tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].skills).toEqual(["from-skill-field"]);
  });
});
