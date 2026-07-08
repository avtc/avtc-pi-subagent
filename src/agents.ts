// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { log } from "./log.js";
import { compileGlob } from "./model-resolution.js";

const moduleLog = log.child("agents");

/** A registered integration-agent directory, attributed to the calling extension's name
 *  (so collision messages can name the contributor). */
export interface AgentPathEntry {
  dir: string;
  extensionName: string;
}

/** An extension-provided agent directory with the agents loaded from it. One entry per
 *  registered directory; used by collision detection to spot a name defined by multiple
 *  extensions without re-reading disk. */
export interface ExtensionAgentDir extends AgentPathEntry {
  agents: AgentConfig[];
}

let _agentsPaths: AgentPathEntry[] = [];

/** Set additional agent search directories (called from extension factory with options.agentsPaths,
 *  and via the pi-subagent:ready API by other extensions). `extensionName` attributes the
 *  directories to the calling extension's name (used in collision reporting). Deduplicates by
 *  directory. */
export function addAgentsPaths(paths: string[] | undefined, extensionName: string): void {
  // Append new paths (merge) rather than replace, so multiple extensions
  // can each register their own agent directories without overwriting.
  if (paths) {
    for (const p of paths) {
      if (!_agentsPaths.some((entry) => entry.dir === p)) _agentsPaths.push({ dir: p, extensionName });
    }
  }
}

/** @internal Test hook to reset agentsPaths state. */
export function _resetAgentsPaths(): void {
  _agentsPaths = [];
}

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  extensions?: string[];
  model?: string;
  skills?: string[];
  /**
   * When true, the agent is omitted from every model-facing agent listing the
   * tool produces: the subagent tool description AND the "Available agents"
   * error responses. The agent remains fully discovered and routable at runtime
   * (it can still be dispatched by name when a user, skill, or other agent
   * explicitly names it). Mirrors the skill `disable-model-invocation` convention.
   */
  hideFromAgentsList?: boolean;
  systemPrompt: string;
  filePath: string;
}

/** An agent is visible in model-facing listings (tool description + error responses) when it is
 *  NOT hidden by any source: neither frontmatter `hide-from-agents-list` nor a config-driven
 *  `hidden-agents` glob nor a `disabled-agents` glob (disabled implies hidden). The agent's base
 *  name is tested against both glob lists; `disabledGlobs` is folded in so a disabled agent is
 *  never announced even without a separate hidden entry. PURE (no I/O).
 *
 *  Note on base-name asymmetry: hidden-agents matches the BASE name only — a fork-suffixed
 *  name like "reviewer-fork" is never hidden by hidden-agents. disabled-agents is the exception
 *  and is handled separately at dispatch where the requested (fork-suffixed) name is also checked. */
export function isVisible(agent: AgentConfig, hiddenGlobs: string[], disabledGlobs: string[]): boolean {
  if (agent.hideFromAgentsList) return false;
  for (const g of hiddenGlobs) if (compileGlob(g).test(agent.name)) return false;
  for (const g of disabledGlobs) if (compileGlob(g).test(agent.name)) return false;
  return true;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  bundledAgents: AgentConfig[];
  projectAgentsDir: string | null;
  /** Pre-merge per-extension integration-agent data (one entry per registered directory), so
   *  collision detection can group by name across distinct extensions WITHOUT re-reading disk.
   *  Each AgentConfig carries its filePath (populated by loadAgentsFromDir). */
  extensionAgentDirs: ExtensionAgentDir[];
  /** Names of the user-tier + project-tier agents (the override tier): these silently override
   *  bundled/integration agents of the same name, so collision detection suppresses a throw
   *  when one of these names collides at a lower tier. */
  overrideNames: Set<string>;
}

export function loadAgentsFromDir(dir: string): AgentConfig[] {
  const agents: AgentConfig[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Covers ENOENT (missing dir) and any other read failure — no separate existsSync probe
    // needed (a pre-check would race and double the stat calls).
    moduleLog.warn(`Failed to read agents directory: ${dir} — ${err instanceof Error ? err.message : err}`);
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      moduleLog.warn(`Failed to read agent file: ${filePath} — ${err instanceof Error ? err.message : err}`);
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }

    const tools = frontmatter.tools
      ?.split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);
    const extensions = frontmatter.extensions
      ?.split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);
    const skillStr = frontmatter.skill || frontmatter.skills;
    const skills = skillStr
      ?.split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      extensions: extensions && extensions.length > 0 ? extensions : undefined,
      model: frontmatter.model,
      skills: skills && skills.length > 0 ? skills : undefined,
      // YAML parses `true` to boolean; match the skills disable-model-invocation convention.
      // (frontmatter is typed loosely as Record<string,string> here for the existing string
      // fields; cast through unknown to read the boolean flag accurately.)
      hideFromAgentsList: (frontmatter as Record<string, unknown>)["hide-from-agents-list"] === true,
      systemPrompt: body,
      filePath,
    });
  }

  return agents;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch (err) {
    moduleLog.debug(`stat failed for ${p}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Walk up from cwd looking for .pi/<subpath> directory.
 * Shared by agent discovery and skill resolution.
 */
export function findNearestDotPiSubdir(cwd: string, subpath: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", subpath);
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  return findNearestDotPiSubdir(cwd, "agents");
}

/** The user-tier agents directory. Injectable so tests can control the user tier in isolation
 *  (os.homedir is not spyable under ESM). */
const defaultUserAgentsDir = (): string => path.join(os.homedir(), ".pi", "agent", "agents");
let _userAgentsDir: () => string = defaultUserAgentsDir;

/** @internal Test seam: override the user agents directory computation. */
export function _setUserAgentsDir(fn: (() => string) | null): void {
  _userAgentsDir = fn ?? defaultUserAgentsDir;
}

/** @internal Test seam: reset the user agents directory to its default (home-dir) computation. */
export function _resetUserAgentsDir(): void {
  _userAgentsDir = defaultUserAgentsDir;
}

export function discoverAgents(cwd: string): AgentDiscoveryResult {
  const userDir = _userAgentsDir();
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const thisFile = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(thisFile), "..", "..");
  const bundledAgentsDir = path.join(packageRoot, "agents");

  const userAgents = loadAgentsFromDir(userDir);
  const projectAgents = projectAgentsDir ? loadAgentsFromDir(projectAgentsDir) : [];
  const bundledAgents = loadAgentsFromDir(bundledAgentsDir);

  // Integration agents (registered via the ready API) always load. Build pre-merge per-extension
  // data (one entry per registered directory) so collision detection can group by name across
  // distinct extensions without re-reading disk. loadAgentsFromDir populates each agent's filePath.
  const extensionAgentDirs: ExtensionAgentDir[] = _agentsPaths.map((entry) => ({
    dir: entry.dir,
    extensionName: entry.extensionName,
    agents: loadAgentsFromDir(entry.dir),
  }));
  // Reverse so earlier paths take priority (later entries overwrite in the Map below).
  const integrationAgents = [...extensionAgentDirs].reverse().flatMap((s) => s.agents);

  // Priority (lowest to highest): bundled < integration < user < project. Integration agents are
  // extension-shipped (like bundled), so a user's personal agent overrides them. Later Map writes
  // overwrite earlier ones.
  const agentMap = new Map<string, AgentConfig>();
  for (const agent of bundledAgents) agentMap.set(agent.name, agent);
  for (const agent of integrationAgents) agentMap.set(agent.name, agent);
  for (const agent of userAgents) agentMap.set(agent.name, agent);
  for (const agent of projectAgents) agentMap.set(agent.name, agent);

  const overrideNames = new Set<string>([...userAgents, ...projectAgents].map((a) => a.name));

  return { agents: Array.from(agentMap.values()), bundledAgents, projectAgentsDir, extensionAgentDirs, overrideNames };
}
