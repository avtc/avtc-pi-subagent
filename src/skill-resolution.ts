// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Skill resolution and injection for subagent system prompts.
 *
 * Uses pi's loadSkills() for skill discovery across project, bundled,
 * and user directories. Integration layer provides additional skillPaths
 * via addSkillPaths.
 *
 * Skills are cached by name and invalidated when skillPaths change.
 */

import * as fs from "node:fs";
import { getAgentDir, loadSkills, parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { log } from "./log.js";

const moduleLog = log.child("skill-resolution");

let _fsProxy: typeof fs = fs;
let _skillPaths: string[] = [];
let _skillCache: Map<string, Skill> | null = null;

/** Set additional skill search directories (called from extension factory with options.skillPaths).
 *  Appends new paths rather than replacing, so multiple extensions can each
 *  register their own skill directories without overwriting. */
export function addSkillPaths(paths: string[] | undefined): void {
  if (paths) {
    for (const p of paths) {
      if (!_skillPaths.includes(p)) _skillPaths.push(p);
    }
  }
  _skillCache = null; // invalidate cache when paths change
}

/** @internal Test hook to override fs proxy. */
export function _setFsProxy(fsOverride: typeof fs): void {
  _fsProxy = fsOverride;
}

/** @internal Test hook to override loadSkills. */
let _loadSkillsOverride: typeof loadSkills | null = null;

export function _setLoadSkills(fn: typeof loadSkills | null): void {
  _loadSkillsOverride = fn;
  _skillCache = null;
}

/** @internal Test hook to reset all module state. */
export function _resetSkillResolution(): void {
  _skillPaths = [];
  _skillCache = null;
  _loadSkillsOverride = null;
}

/** Read a skill file, parse and strip frontmatter, return trimmed body or undefined. */
export function readAndStripFrontmatter(filePath: string): string | undefined {
  if (!_fsProxy.existsSync(filePath)) return undefined;
  try {
    const raw = _fsProxy.readFileSync(filePath, "utf-8");
    const { body } = parseFrontmatter<Record<string, string>>(raw);
    return body.trim();
  } catch (err) {
    moduleLog.warn(`Failed to read skill file: ${filePath} — ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

/** Load all skills using pi's loadSkills() and cache them by name.
 *  NOTE: Cache is keyed by skillPaths, not cwd. The cwd parameter affects
 *  project-local .pi/skills/ discovery — first call's cwd wins. This is
 *  correct for subagent use where cwd is stable within an extension lifecycle.
 *  Cache is invalidated by addSkillPaths() or _resetSkillResolution(). */
function loadAllSkills(cwd: string): Map<string, Skill> {
  if (_skillCache) return _skillCache;

  const loader = _loadSkillsOverride ?? loadSkills;
  const agentDir = getAgentDir();

  const result = loader({
    cwd,
    agentDir,
    skillPaths: _skillPaths,
    includeDefaults: true,
  });

  _skillCache = new Map();
  for (const skill of result.skills) {
    // First occurrence wins (earlier skillPaths take priority over defaults)
    if (!_skillCache.has(skill.name)) {
      _skillCache.set(skill.name, skill);
    }
  }

  if (result.diagnostics.length > 0) {
    for (const diag of result.diagnostics) {
      moduleLog.warn(`Skill diagnostic: ${diag.message}`);
    }
  }

  return _skillCache;
}

/**
 * Resolve a skill's content by name, using pi's loadSkills() for discovery.
 * Returns the skill body (frontmatter stripped) or undefined if not found.
 */
export function resolveSkillContent(skillName: string, cwd: string | null): string | undefined {
  // Guard against path traversal — skill names must be simple identifiers
  if (!skillName?.trim() || skillName.includes("/") || skillName.includes("\\") || skillName.includes(".."))
    return undefined;

  const skills = loadAllSkills(cwd ?? process.cwd());
  const skill = skills.get(skillName);

  if (!skill) {
    moduleLog.debug(`Skill '${skillName}' not found in loaded skills`);
    return undefined;
  }

  return readAndStripFrontmatter(skill.filePath);
}

/**
 * Inject skill content into the agent's system prompt.
 * Returns the same agent object if no skills are injected, or a new object
 * with updated systemPrompt.
 * NOTE: Does NOT modify agent.tools — only systemPrompt is updated.
 * This assumption is relied upon by buildForkInstruction().
 */
export function injectSkills(agent: AgentConfig, cwd: string): AgentConfig {
  if (!agent.skills || agent.skills.length === 0) return agent;
  let skillInjection = "";
  for (const skillName of agent.skills) {
    const content = resolveSkillContent(skillName, cwd);
    if (content) {
      skillInjection += `\n\n<skill name="${skillName}">\n${content}\n</skill>`;
    } else {
      moduleLog.warn(`Skill '${skillName}' declared in agent '${agent.name}' but could not be resolved — skipping`);
    }
  }
  if (!skillInjection) return agent;
  return { ...agent, systemPrompt: agent.systemPrompt + skillInjection };
}
