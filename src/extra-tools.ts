// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * `PI_SUBAGENT_TOOLS_ADD` support: a comma-list env var that contributors
 * (e.g. avtc-pi-user-decisions, avtc-pi-todo) append-with-dedup to force-enable
 * specific tools in subagents. Read by the CHILD process (which resolves its own
 * effective tool set from settings.json policy + frontmatter + TOOLS_ADD), not the parent.
 *
 * The parent does not resolve the child's tools — it forwards the frontmatter
 * whitelist as `PI_SUBAGENT_TOOLS` (deleted when the agent has no whitelist) and the
 * child applies its own `add`/`block`/`only` policy to that base. TOOLS_ADD is a
 * forced-add that contributors cascade via the inherited env.
 */

/** Parse a comma-list (e.g. PI_SUBAGENT_TOOLS_ADD) into a deduped, order-stable tool-name array. */
export function parseToolsAdd(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name.length > 0 && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
