# Configuration

Configuration lives in a `avtc-pi-subagent` section of `settings.json`, merged from two files. Model overrides and tool policies both merge global with project, but each key type merges its own way (see the section that documents it):

| Scope | Path |
|---|---|
| Global | `~/.pi/agent/settings.json` |
| Project | `<project>/.pi/settings.json` |

Edits take effect on the next session start (`/reload` re-reads them).

## Tool policy

Control which tools each subagent can use with the `subagent-tools` key. Keys are agent-name patterns (literals or globs); each maps to a tool policy with three operations:

| Operation | Meaning |
|---|---|
| `add` | Add tools to the agent's set (augments its frontmatter `tools` whitelist and any forced additions). |
| `block` | Remove tools from the agent's set. Highest precedence — blocks even forced additions. |
| `only` | Replace the agent's whole tool set with exactly this list. Terminal and absolute: ignores the frontmatter whitelist, forced additions, and every other matching pattern. |

```json
{
  "avtc-pi-subagent": {
    "subagent-tools": {
      "*": { "block": ["bash"] },
      "worker": { "add": ["todo_*"] },
      "reviewer-*": { "only": ["read", "grep"] }
    }
  }
}
```

Every entry — including `*` — can carry any combination of `add` / `block` / `only`. Putting `add` or `block` alongside `only` in the **same** entry is a contradiction: the whole tool policy for that agent is dropped for the session (it falls back to its base tools) and the error is reported.

### Patterns and tokens

- **Agent-name globs** — keys like `reviewer-*` match the agent's **base** name (the name without a `-fork` suffix). A more specific glob wins: `senior-reviewer` beats `*-reviewer`; `reviewer` beats `*`. Equal specificity falls back to declaration order. (Unlike `subagent-models` keys — which match the fork-suffixed name — a `*-fork` tool-policy key matches no agent, since a forked agent still reports its base name here.)
- **Tool-name globs** — every `add` / `block` / `only` value accepts globs too, e.g. `"todo_*"` or `"mcp__*__*"`. In fresh sessions a glob expands to the concrete tool names known to that session; in forked sessions it is matched at call time against the actual tool name.
- **`$all`** — a special token meaning "every tool the session knows". `$all` in `block` removes all tools; `$all` in `only` whitelists all tools; `$all` in `add` adds all tools to the set.

### How matching patterns combine

When several patterns match the same agent, they combine **accumulatively** from least to most specific, with the most specific match winning any conflict for a given tool:

- `add` augments the running set; `block` removes from it.
- A more-specific `add` cancels a less-specific `block` (and vice-versa) for that tool.
- `only` is absolute: if **any** matching pattern for the agent has `only`, that becomes the entire set (taken from the most-specific `only` entry). Combining `only` at one specificity with `add`/`block` at another is an error.

Example — a global block that one agent overrides:

```json
{
  "avtc-pi-subagent": {
    "subagent-tools": {
      "*": { "block": ["bash"] },
      "worker": { "add": ["bash"] }
    }
  }
}
```

`worker` gets `bash` back; every other agent keeps it blocked.

### Global and project merge

Tool policies merge across the two files **per agent-glob key**: `add` lists union (deduped), `block` lists union (deduped), and `only` is project-replaces-global. So when both files define the same key, they combine into one entry before the accumulative walk runs:

```jsonc
// ~/.pi/agent/settings.json (global)
{ "avtc-pi-subagent": { "subagent-tools": { "worker": { "add": ["bash"] } } } }

// <project>/.pi/settings.json (project)
{ "avtc-pi-subagent": { "subagent-tools": { "worker": { "block": ["git"] } } } }
```

The merged `worker` entry is `{ add: ["bash"], block: ["git"] }`. Patterns defined in only one file apply as-is. Named tool sets (`tool-sets`) merge name by name — project replaces global for the same set name.

### Named tool sets

Reuse a bundle of tools across several patterns with `tool-sets`. Define the set once, then reference it as `"$name"` inside any `add` / `block` / `only` list:

```json
{
  "avtc-pi-subagent": {
    "tool-sets": {
      "readonly": ["read", "grep", "ls"]
    },
    "subagent-tools": {
      "reviewer-*": { "only": ["$readonly"] },
      "researcher-*": { "only": ["$readonly", "web_search"] }
    }
  }
}
```

The `$name` reference expands to the set's members at load time. Set entries must be literal tool names or globs (not further `$name` references). `$all` is reserved and may appear only in `add` / `block` / `only` lists, never as a tool-set name.

### Nesting

A `*` policy applies at **every** nesting depth: each subagent is a fresh process that reads the merged config independently, so a global block is a floor the whole subtree inherits. A specific agent pattern (e.g. `worker`) applies only to that agent's own process — it does not cascade to the agents `worker` itself spawns. Forced additions (`PI_SUBAGENT_TOOLS_ADD`) cascade down, but a global `*` block is re-read at every level and still vetoes them there.

### Validation

Structural errors are detected at load and reported (then the policy falls back to the agent's base tools for that session): unknown keys, non-array values, undefined `$name` references, `only` combined with `add`/`block` in one entry, and `$`-prefixed tool-set names. Malformed JSON is also reported.

## Hiding and disabling agents

Two agent-level controls (agent-name globs) live in the same `avtc-pi-subagent` section:

| Key | Effect |
|---|---|
| `hidden-agents` | Matching agents are hidden from the "Available agents" list and error messages, but stay callable by name. |
| `disabled-agents` | Matching agents are hidden **and** cannot be spawned — dispatch returns an "Agent is disabled by policy" error. |

```json
{
  "avtc-pi-subagent": {
    "hidden-agents": ["debug-*"],
    "disabled-agents": ["experimental-*"]
  }
}
```

Both combine with the agent frontmatter `hide-from-agents-list: true` (an agent is hidden if any applies). `hidden-agents` matches the agent's base name; `disabled-agents` matches both the requested name (e.g. `reviewer-fork`) and the resolved base name (`reviewer`), so a fork variant can be disabled on its own.

### Global and project merge

`hidden-agents` and `disabled-agents` union-dedupe across the two files: an agent is hidden or disabled if it matches any glob from either level.

## Agent discovery and collisions

Agent definitions are discovered from four sources, in this priority order (later sources override earlier ones for the same name):

1. **Bundled** — agents shipped with avtc-pi-subagent.
2. **Extension-provided** — agents contributed by other extensions via the `pi-subagent:ready` event.
3. **User** — `~/.pi/agent/agents/`.
4. **Project** — `<project>/.pi/agents/`.

A user or project agent overrides an extension-provided one of the same name. If **two extensions** define the same agent name and no user/project agent overrides it, avtc-pi-subagent hard-stops at session start, printing which name collides and which extensions define it:

```
Extension provided agent name collision:
  "shared" — defined by extensions: avtc-pi-feature-flow, avtc-pi-todo
Define a user or project agent with these names to override and resolve.
```

Define a user or project agent with that name to override the conflict and resolve it.

## Model overrides

```json
{
  "avtc-pi-subagent": {
    "default-model": "providerA/modelA",
    "subagent-models": {
      "worker": "providerB/modelB",
      "reviewer-*": ["providerA/modelA", "providerB/modelB"],
      "reviewer-*-fork": "providerA/modelA"
    }
  }
}
```

Some models in fork mode behave like they are in main session, so exclude them from "-fork" overrides.
More specific glob wins `reviewer-*-fork` beats `reviewer-*`.

- A single string is used as-is.
- A `string[]` is rotated round-robin per spawn.

### Global and project merge

`subagent-models` merges per key: project overrides global for a matching key. When both files specify an array for the same key, the project array replaces the global array (no concatenation). `default-model` uses present-wins: project wins if defined, otherwise global.

## Settings UI

Edit these via `/subagent:settings` (stored in `avtc-pi-subagent-settings.json`):

| Setting | Default | Meaning |
|---|---|---|
| Subagent timeout | 3h | Max wall-clock time per subagent. `Infinite` = no limit. |
| Inactivity timeout | 10m | Max time with no output before a subagent is killed. `Infinite` = no limit. |
| Concurrency | 6 | Max parallel subagents. `Infinite` = no limit. |
| Max nesting depth | 3 | Max depth of nested subagent calls. |
| Spawn mode | RPC | How subagent child processes run: `JSON` (single-shot) or `RPC` (long-lived; keeps a subagent going through compaction on long tasks). See [Spawn mode](../README.md#spawn-mode). |

## Environment variables

These variables communicate the spawn context to each subagent child process. The parent sets most of them at spawn time; `PI_SUBAGENT_FORK_MODE` is set by the user, and `PI_SUBAGENT_TOOLS_ADD` is written by contributor extensions. See the "Who sets it" column:

| Variable | Who sets it | Meaning |
|---|---|---|
| `PI_SUBAGENT_TOOLS_ADD` | **Contributors** (append tool names) | Tools to force-add to every subagent. Contributors append their tool names (append-with-dedup). Commutative across contributors: load order does not change the resulting set. |
| `PI_SUBAGENT_TOOLS` | Parent at spawn | The child's frontmatter `tools` whitelist. Unset when the agent has no `tools` frontmatter (whitelistless — the child starts from all tools). |
| `PI_SUBAGENT_IS_FORK` | Parent at spawn | Set to `1` for forked children. |
| `PI_SUBAGENT_FORK_MODE` | User | Fork mode: `fork`, `new+fork`, or unset (fresh). See [Fork mode](../README.md#fork-mode). |
| `PI_SUBAGENT_CHILD_AGENT` | Parent at spawn | The child's agent name. |

`PI_SUBAGENT_TOOLS`, `PI_SUBAGENT_IS_FORK`, and `PI_SUBAGENT_FORK_MODE` are per-level inputs: they are stripped before a child spawns its own grandchildren, so a forked child's fresh grandchild does not inherit the fork marker or fork mode, and a whitelisted parent's whitelistless child does not inherit a stale whitelist.
