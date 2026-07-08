// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Extension-provided agent name-collision detection.
 *
 * PURE: takes a discovery result and returns the list of agent-name collisions between
 * extensions. Never touches process.* (stderr/exit are the session_start caller's concern —
 * this function only DETECTS). Consumes the pre-merge per-extension data exposed by
 * discoverAgents (extensionAgentDirs + overrideNames), so it does NOT re-read disk and sees
 * both contenders (the post-merge `agents` list lost the loser to last-wins Map overwrite).
 *
 * A collision is: an agent name defined by ≥2 DISTINCT extensions, where no user-tier or
 * project-tier agent overrides it. Two directories from the SAME extension are NOT a collision
 * (an extension duplicating a name within its own dirs is an intra-extension issue, silently
 * last-wins like the bundled/user/project tiers). When a user or project agent shares the name,
 * the collision is SUPPRESSED (that agent intentionally overrides the colliding extensions).
 */

import type { AgentDiscoveryResult } from "./agents.js";

/** A single collision: an agent name and the distinct extensions that define it. */
export interface Collision {
  agentName: string;
  extensions: string[];
}

/**
 * Detect agent-name collisions between distinct extensions.
 *
 * @param discovery The discovery result (uses extensionAgentDirs + overrideNames only).
 * @returns Collisions (empty if none). PURE — no side effects.
 */
export function detectIntegrationCollisions(discovery: AgentDiscoveryResult): Collision[] {
  const overrideNames = discovery.overrideNames;

  // Group agent names by the DISTINCT EXTENSIONS that define them. (Two dirs from the same
  // extension are not a cross-extension collision — they collapse to one extension.)
  const extensionsByName = new Map<string, Set<string>>();
  for (const entry of discovery.extensionAgentDirs) {
    for (const agent of entry.agents) {
      let exts = extensionsByName.get(agent.name);
      if (!exts) {
        exts = new Set<string>();
        extensionsByName.set(agent.name, exts);
      }
      exts.add(entry.extensionName);
    }
  }

  const collisions: Collision[] = [];
  for (const [agentName, extensions] of extensionsByName) {
    // Only a name defined by ≥2 distinct extensions is a collision.
    if (extensions.size < 2) continue;
    // Suppressed when a user/project agent overrides it (override tier).
    if (overrideNames.has(agentName)) continue;

    collisions.push({ agentName, extensions: Array.from(extensions) });
  }
  return collisions;
}

/** Format collisions into a single human-readable message for the hard-stop report. Foregrounds
 *  the colliding agent name AND the extensions that define it. PURE (string building only). */
export function formatCollisionMessage(collisions: Collision[]): string {
  const lines: string[] = ["Extension provided agent name collision:"];
  for (const c of collisions) {
    lines.push(`  "${c.agentName}" — defined by extensions: ${c.extensions.join(", ")}`);
  }
  lines.push("Define a user or project agent with these names to override and resolve.");
  return lines.join("\n");
}
