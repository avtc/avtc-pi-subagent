// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/agents.js";
import { isVisible } from "../src/agents.js";

const mk = (name: string, hide: boolean): AgentConfig => ({
  name,
  description: "d",
  systemPrompt: "",
  filePath: `/tmp/${name}.md`,
  hideFromAgentsList: hide,
});

describe("isVisible", () => {
  it("visible when no frontmatter hide and no matching globs", () => {
    expect(isVisible(mk("worker", false), [], [])).toBe(true);
  });

  it("hidden when frontmatter hide-from-agents-list is true (OR with globs)", () => {
    expect(isVisible(mk("secret", true), [], [])).toBe(false);
  });

  it("hidden when base name matches a hidden glob (literal)", () => {
    expect(isVisible(mk("secret", false), ["secret"], [])).toBe(false);
  });

  it("hidden when base name matches a hidden glob (pattern)", () => {
    expect(isVisible(mk("debug-logger", false), ["debug-*"], [])).toBe(false);
  });

  it("hidden when base name matches a disabled glob (disabled implies hidden)", () => {
    expect(isVisible(mk("experimental-x", false), [], ["experimental-*"])).toBe(false);
  });

  it("visible when a hidden glob does NOT match the base name", () => {
    expect(isVisible(mk("worker", false), ["debug-*"], [])).toBe(true);
  });

  it("combines hidden and disabled globs (either hides)", () => {
    expect(isVisible(mk("a-1", false), ["a-*"], [])).toBe(false);
    expect(isVisible(mk("b-1", false), [], ["b-*"])).toBe(false);
    expect(isVisible(mk("c-1", false), ["a-*"], ["b-*"])).toBe(true);
  });
});
