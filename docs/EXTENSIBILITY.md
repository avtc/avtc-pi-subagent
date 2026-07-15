# Extensibility

Other extensions integrate with avtc-pi-subagent by subscribing to the `pi-subagent:ready` event and registering hooks. The event fires on session start with an API object.

## Hooks

| Hook | Signature | Purpose |
|---|---|---|
| `addModelResolver` | `(ctx: { agentName, explicitModel }) => string \| undefined` | Resolve a model for a subagent at dispatch time. Return `undefined` to defer to the built-in resolution. |
| `addPromptTransformer` | `(systemPrompt, ctx: { agentName, task?, isFork }) => string \| Promise<string>` | Rewrite an agent's system prompt before dispatch (e.g. template substitution). |
| `addSkillPaths` | `(paths: string[]) => void` | Register extra skill directories for subagents to load. |
| `addAgentsPaths` | `(paths: string[], extensionName: string) => void` | Register extra agent directories. `extensionName` is the calling extension's name, used to attribute agents in collision messages (when two extensions define the same agent name). |

## Integration pattern

Subscribe on `pi-subagent:ready` and register only the hooks you need. A reload-safe helper ships as the canonical `subscribe-to-subagent` snippet — vendor it verbatim into your extension (`src/snippets/vendored/`) and pass `null` for hooks you don't use:

```ts
import { subscribeToSubagent } from "./snippets/vendored/subscribe-to-subagent.js";

subscribeToSubagent(
  pi,
  /* addPromptTransformer */ (systemPrompt, ctx) => substituteMyTemplates(systemPrompt, ctx),
  /* addModelResolver */ (ctx) => resolveStageModel(ctx.agentName),
  /* addSkillPaths */ [path.resolve(__dirname, "skills")],
  /* addAgentsPaths */ [path.resolve(__dirname, "agents")],
  /* extensionName */ "my-extension",
);
```

The helper cleans its listeners on `session_shutdown` (which fires before reload), so registration survives `/reload`.

## Reference implementation

[avtc-pi-featyard](https://github.com/avtc/avtc-pi-featyard) integrates via the remaining four hooks: it substitutes prompt templates, resolves stage models, and registers its `skills/` and `agents/` directories. Its `extensions/subagent-integration.ts` is a working example of the pattern above.
