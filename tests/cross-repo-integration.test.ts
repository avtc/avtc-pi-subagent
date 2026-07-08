import type { EventEmitter } from "node:events";
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentExtension, {
  _modelResolvers,
  _resetAllTestHooks,
  _setDiscoverAgents,
  _setLoadSubagentModelConfig,
  _setSpawn,
} from "../src/extension.js";
import { applyForkSuffix } from "../src/fork.js";
import {
  _resetGlobCache,
  _resetRotationCounters,
  resolveModelLayered,
  resolveSubagentModel,
} from "../src/model-resolution.js";
import type { SubagentModelConfig } from "../src/subagent-config.js";
import {
  createFakeProcess,
  EXIT_CODE_SUCCESS,
  MockSessionManager,
  makeSubagentConfig,
  NO_DEFAULT_MODEL,
  setTestSettings,
} from "./test-helpers.js";

/**
 * Cross-repo integration smoke check.
 *
 * Composes the REAL exported modules across their join points — `fork.ts`
 * (fork-name suffixing) and `model-resolution.ts` (Phase 1 config + Phase 2
 * hooks + Phase 3 default + Phase 4 fallthrough) — and proves:
 *
 *  - STANDALONE: a `subagent-models` glob pin routes to the right model with no
 *  hook registered.
 *  - FORK-MODE: plain `fork` mode suffixes the agent name with `-fork` BEFORE
 *  resolution, and that suffixed name matches a `*-fork` glob key by
 *  specificity.
 *
 * The dispatch section additionally drives the REAL dispatch harness
 * (`_setSpawn` seam + `tool.execute`) with an injected config to prove the
 * resolved model lands on the spawn argv as `--model <resolved>` — closing the
 * full chain (`resolveModelForAgent` closure → `process-runner.ts`
 * `args.push("--model", effectiveModel)` → `_spawn` argv). It does NOT spawn a
 * real child pi process (spawn is mocked); the mocked-spawn argv assertion is
 * the integration point.
 */

const cfg = makeSubagentConfig;

/** No explicit model override */
const NO_EXPLICIT_MODEL: string | null = null;

describe("cross-repo integration smoke check", () => {
  describe("STANDALONE: subagent-models glob pin routes with no hook registered", () => {
    it("routes a glob-pinned agent to its model with no hooks registered", () => {
      // No hook registered (empty array).
      const c = cfg({ "plan-reviewer": "test-provider/model-b", "*": "fallback/x" }, "default/d");
      expect(resolveModelLayered("plan-reviewer", undefined, c, [])).toBe("test-provider/model-b");
      // And a non-exact agent still matches the bare glob.
      expect(resolveModelLayered("some-other-agent", undefined, c, [])).toBe("fallback/x");
    });

    it("with no config AND no hooks, falls all the way through to Phase 4 (undefined)", () => {
      expect(resolveModelLayered("any-agent", undefined, cfg({}, null), [])).toBeUndefined();
    });
  });

  describe("FORK-MODE (Phase 3 unification): -fork name reaches resolver, *-fork glob matches", () => {
    it("plain fork mode suffixes the name and the *-fork glob wins by specificity", () => {
      // Step 1 (fork.ts): plain fork mode appends -fork before resolution.
      const suffixed = applyForkSuffix("plan-reviewer", "fork");
      expect(suffixed).toBe("plan-reviewer-fork");
      // Step 2 (model-resolution.ts): the suffixed name matches the *-fork glob,
      // which beats the bare * on specificity — so a fork-unsafe model (here the
      // Qwen-style "fork-unsafe/x") listed only under * is NOT selected.
      const c = cfg({ "*": ["fork-unsafe/x", "safe/y"], "*-fork": ["safe/y"] }, "default/d");
      expect(resolveSubagentModel(suffixed, c)).toBe("safe/y");
      // And confirm the bare (non-fork) name still selects the non-fork list.
      expect(resolveSubagentModel("plan-reviewer", c)).toBe("fork-unsafe/x");
    });

    it("idempotent: an already-forked name is not double-suffixed, then still matches *-fork", () => {
      const once = applyForkSuffix("reviewer-quality", "fork");
      const twice = applyForkSuffix(once, "fork");
      expect(once).toBe("reviewer-quality-fork");
      expect(twice).toBe("reviewer-quality-fork"); // no -fork-fork
      const c = cfg({ "*-fork": "safe/y" }, "default/d");
      expect(resolveSubagentModel(twice, c)).toBe("safe/y");
    });

    it("new+fork mode does NOT re-suffix (duplication handles the fork variant), so the base name resolves normally", () => {
      // In new+fork mode, applyForkSuffix is a no-op on the dispatched base name;
      // the -fork duplicate is created by a different path. The base name must
      // therefore resolve against the non-fork list.
      expect(applyForkSuffix("plan-reviewer", "new+fork")).toBe("plan-reviewer");
      const c = cfg({ "plan-reviewer": "base/x", "plan-reviewer-fork": "fork-safe/y" }, "default/d");
      expect(resolveSubagentModel("plan-reviewer", c)).toBe("base/x");
    });
  });
});

// --- Dispatch-level harness for scenario 4 (real spawn-argv assertion) ---

const spawnMock = vi.fn();
const discoverAgentsMock = vi.fn();

function registerTool(): { tool: ToolDefinition; ctx: ExtensionCommandContext } {
  let tool: ToolDefinition | undefined;
  subagentExtension({
    registerTool: (t: ToolDefinition) => {
      tool = t;
    },
    on: vi.fn(),
    events: { on: vi.fn() },
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),
    getSessionName: vi.fn(() => "test-session"),
  } as unknown as ExtensionAPI);
  return {
    tool: tool as NonNullable<typeof tool>,
    ctx: {
      cwd: process.cwd(),
      hasUI: false,
      // Fork-mode dispatch reaches sessionManager.constructor.open (the static
      // `MutableSM.open`) to create a branched session (extension.ts resolveForkSessionFile).
      // A class-based mock gives the instance a real `.constructor` with an `open`
      // static, so fork mode works end-to-end; non-fork tests only call the
      // instance methods and are unaffected.
      sessionManager: new MockSessionManager(),
    } as unknown as ExtensionCommandContext,
  };
}

const AGENTS = {
  agents: [
    {
      name: "worker",
      filePath: "/tmp/worker.md",
      systemPrompt: "system prompt",
      tools: ["read", "bash", "write", "edit", "grep", "find", "ls", "subagent"],
    },
  ],
  bundledAgents: [],
  projectAgentsDir: null,
  extensionAgentDirs: [],
  overrideNames: new Set(),
};

async function dispatchAndCaptureModel(
  injectedConfig: SubagentModelConfig,
  explicitModel: string | null,
): Promise<string | undefined> {
  const proc = createFakeProcess();
  spawnMock.mockReturnValue(proc);
  discoverAgentsMock.mockReturnValue(AGENTS);
  _setSpawn(spawnMock);
  _setDiscoverAgents(discoverAgentsMock);
  _setLoadSubagentModelConfig(() => injectedConfig);
  setTestSettings(null);
  const { tool, ctx } = registerTool();

  const resultPromise = tool.execute(
    "call-1",
    { agent: "worker", task: "test task", ...(explicitModel ? { model: explicitModel } : {}) },
    undefined,
    vi.fn(),
    ctx,
  );
  // Wait for spawn to fire.
  const start = Date.now();
  while (spawnMock.mock.calls.length === 0 && Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 1));
  }
  if (spawnMock.mock.calls.length === 0) {
    throw new Error("spawn was never called within 2s — dispatch did not reach runSingleAgent");
  }

  // Close the process so the dispatch resolves.
  (proc.stdout as EventEmitter).emit(
    "data",
    Buffer.from(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`,
    ),
  );
  proc.emit("close", EXIT_CODE_SUCCESS);
  await resultPromise;

  // spawn(command, args, options) — args is the second positional arg.
  const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
  const idx = args?.indexOf("--model");
  return idx !== undefined && idx >= 0 ? args?.[idx + 1] : undefined;
}

/**
 * Variant of dispatchAndCaptureModel for PARALLEL / CHAIN dispatch: accepts raw
 * params (so the caller can pass `tasks` or `chain`), spawns one process per item,
 * closes them all, and returns the `--model` argv captured from EVERY spawn call
 * (in spawn order). Used to verify parallel/chain suffixing routes each item's
 * model independently through the real closure.
 */
async function dispatchParamsAndCaptureModels(
  injectedConfig: SubagentModelConfig,
  params: Record<string, unknown>,
): Promise<Array<string | undefined>> {
  const procs: ReturnType<typeof createFakeProcess>[] = [];
  spawnMock.mockImplementation(() => {
    const p = createFakeProcess();
    procs.push(p);
    return p;
  });
  discoverAgentsMock.mockReturnValue(AGENTS);
  _setSpawn(spawnMock);
  _setDiscoverAgents(discoverAgentsMock);
  _setLoadSubagentModelConfig(() => injectedConfig);
  setTestSettings(null);
  const { tool, ctx } = registerTool();

  const resultPromise = tool.execute("call-1", params, undefined, vi.fn(), ctx);
  const expectedCount =
    (params.tasks as Array<{ agent: string }> | undefined)?.length ??
    (params.chain as Array<{ agent: string }> | undefined)?.length ??
    0;
  // Close each spawned process as it appears. PARALLEL fires all spawns up-front;
  // CHAIN spawns sequentially (step N+1 only spawns after step N closes + emits
  // its {previous} output), so we poll-and-close new spawns until the expected
  // count has spawned and been closed.
  const start = Date.now();
  while (procs.length < expectedCount || (expectedCount === 0 && spawnMock.mock.calls.length === 0)) {
    // Close any spawned-but-not-yet-closed process so chain can advance.
    for (const p of procs) {
      if (!(p as unknown as { _closed?: boolean })._closed) {
        (p.stdout as EventEmitter).emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`,
          ),
        );
        p.emit("close", EXIT_CODE_SUCCESS);
        (p as unknown as { _closed?: boolean })._closed = true;
      }
    }
    if (procs.length >= expectedCount && expectedCount > 0) break;
    if (Date.now() - start > 2000) {
      throw new Error(
        `expected ${expectedCount} spawns within 2s, got ${spawnMock.mock.calls.length} — dispatch did not reach all runSingleAgent calls`,
      );
    }
    await new Promise((r) => setTimeout(r, 1));
  }
  // Final close sweep (in case the last spawn landed after the loop check).
  for (const p of procs) {
    if (!(p as unknown as { _closed?: boolean })._closed) {
      (p.stdout as EventEmitter).emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`,
        ),
      );
      p.emit("close", EXIT_CODE_SUCCESS);
      (p as unknown as { _closed?: boolean })._closed = true;
    }
  }
  await resultPromise;

  // Collect --model from every spawn call (spawn order = item order).
  return spawnMock.mock.calls.map((call) => {
    const args = call?.[1] as string[] | undefined;
    const idx = args?.indexOf("--model");
    return idx !== undefined && idx >= 0 ? args?.[idx + 1] : undefined;
  });
}

/**
 * Scenario 4 — END-TO-END dispatch: the resolved model lands on the spawn argv.
 * Drives the REAL `resolveModelForAgent` closure (inside the extension's
 * session_start) → `process-runner.ts` `args.push("--model", effectiveModel)` →
 * `_spawn` argv, with an injected config (no disk read) and spawn mocked.
 */
describe("END-TO-END dispatch: resolved model lands on spawn --model argv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    // Isolation symmetry with the model-resolution unit tests: Scenario 4 exercises
    // the real resolveSubagentModel/resolveModelLayered against glob configs ("*",
    // "*-fork"), which populate the module-global _globCache and (for arrays) the
    // globalThis rotation counter. Reset both so each test starts from a clean
    // matching/rotation state (isolate:false shares the module instance).
    _resetRotationCounters();
    _resetGlobCache();
  });
  afterEach(() => {
    _resetAllTestHooks();
    delete process.env.PI_SETTINGS_SUBAGENT;
    delete process.env.PI_SUBAGENT_FORK_MODE;
    _resetRotationCounters();
    _resetGlobCache();
    vi.restoreAllMocks();
  });

  it("standalone glob pin (no hooks) → spawn argv carries the pinned --model", async () => {
    // Config pins 'worker' to a specific model; no hooks (no host hook registered).
    const c = cfg({ worker: "test-provider/model-b" }, NO_DEFAULT_MODEL);
    expect(await dispatchAndCaptureModel(c, NO_EXPLICIT_MODEL)).toBe("test-provider/model-b");
  });

  it("no config + no hooks → spawn argv has NO --model (falls through to frontmatter/parent, handled by pi core)", async () => {
    // Nothing configured: effectiveModel = undefined → no --model arg pushed.
    const c = cfg({}, NO_DEFAULT_MODEL);
    expect(await dispatchAndCaptureModel(c, NO_EXPLICIT_MODEL)).toBeUndefined();
  });

  it("Phase 0: explicit --model param beats a Phase 1 pin → spawn argv carries the explicit model", async () => {
    // Config pins 'worker' to glm-5, but the caller passes an explicit model param,
    // which short-circuits at Phase 0 (highest priority).
    const c = cfg({ worker: "test-provider/model-b" }, NO_DEFAULT_MODEL);
    expect(await dispatchAndCaptureModel(c, "explicit/x")).toBe("explicit/x");
  });

  it("Phase 3: default-model applies when no pin and no hooks → spawn argv carries the default", async () => {
    // No pin for 'worker', no hooks → Phase 3 default-model is the effective model.
    const c = cfg({ "other-agent": "a/1" }, "default/d");
    expect(await dispatchAndCaptureModel(c, NO_EXPLICIT_MODEL)).toBe("default/d");
  });

  it("fork mode: -fork name reaches the real closure and *-fork glob wins by specificity → spawn argv carries the *-fork model", async () => {
    // Plain fork mode (PI_SUBAGENT_FORK_MODE=fork) suffixes 'worker' → 'worker-fork'
    // at task-build time (extension.ts:646), BEFORE resolveModelForAgent. The
    // suffixed name then reaches the real closure. Both '*' and '*-fork' match
    // 'worker-fork'; '*-fork' must win by specificity (5 literal chars vs 0) per
    //  (fork-name unification). This is the full suffix→resolve→argv
    // chain, end-to-end through the real closure — not a fork.ts unit test.
    process.env.PI_SUBAGENT_FORK_MODE = "fork";
    const c = cfg({ "*": "generic/x", "*-fork": "fork/y" }, NO_DEFAULT_MODEL);
    expect(await dispatchAndCaptureModel(c, NO_EXPLICIT_MODEL)).toBe("fork/y");
  });

  it("Phase 2: registered addModelResolver hook model lands on spawn argv (when no Phase 1 pin)", async () => {
    // No config pin for 'worker' (Phase 1 misses) and no default-model (Phase 3
    // would be undefined) → Phase 2 hook must fire and its returned model must
    // reach the spawn argv, guarding the addModelResolver → _modelResolvers
    // → closure → argv chain end-to-end.
    const hookModel = "hook/stage-model";
    _modelResolvers.push(() => hookModel);
    const c = cfg({ "other-agent": "a/1" }, NO_DEFAULT_MODEL); // no pin, no default
    expect(await dispatchAndCaptureModel(c, NO_EXPLICIT_MODEL)).toBe(hookModel);
  });

  it("PARALLEL fork mode suffixes every task → each *-fork glob match reaches its spawn argv", async () => {
    // Parallel dispatch (params.tasks) with plain fork mode: every task's agent is
    // suffixed 'worker'→'worker-fork' at task-build time (extension.ts parallel
    // suffix site) BEFORE resolveModelForAgent. Each spawn must carry the *-fork
    // model (specificity win over '*'), proving the parallel suffix site works.
    process.env.PI_SUBAGENT_FORK_MODE = "fork";
    const c = cfg({ "*": "generic/x", "*-fork": "fork/y" }, NO_DEFAULT_MODEL);
    const models = await dispatchParamsAndCaptureModels(c, {
      tasks: [
        { agent: "worker", task: "t1" },
        { agent: "worker", task: "t2" },
      ],
    });
    expect(models).toEqual(["fork/y", "fork/y"]);
  });

  it("CHAIN fork mode suffixes each step before resolveModelForAgent (load-bearing suffix site) → *-fork glob reaches argv", async () => {
    // Chain dispatch (params.chain): the chain suffix site (extension.ts chain
    // branch) MUST apply applyForkSuffix BEFORE resolveModelForAgent(step.agent)
    // (known-issue #17: suffixing only at the fork-session site would leave the
    // resolver seeing the bare name and the *-fork glob would silently miss). This
    // test pins that load-bearing ordering end-to-end.
    process.env.PI_SUBAGENT_FORK_MODE = "fork";
    const c = cfg({ "*": "generic/x", "*-fork": "chain-fork/m" }, NO_DEFAULT_MODEL);
    const models = await dispatchParamsAndCaptureModels(c, {
      chain: [
        { agent: "worker", task: "step1" },
        { agent: "worker", task: "step2" },
      ],
    });
    expect(models).toEqual(["chain-fork/m", "chain-fork/m"]);
  });
});

/**
 * Regression: new+fork duplication must fire from the DISPATCHING process's own
 * `process.env.PI_SUBAGENT_FORK_MODE`, NOT from a host `addExtraEnvSerializer`
 * (that hook was removed — fork mode is now set on process.env by the host's
 * env-sync). With the env var set and NO serializer registered, a single
 * forkable review-agent dispatch must spawn BOTH the base (fresh) and the
 * `-fork` (branched-session) variants in parallel.
 */
describe("new+fork duplication driven by process.env (no serializer)", () => {
  const REVIEW_AGENTS = {
    agents: [
      {
        name: "plan-reviewer",
        filePath: "/tmp/plan-reviewer.md",
        systemPrompt: "system prompt",
        tools: ["read", "bash", "write", "edit", "grep", "find", "ls", "subagent"],
      },
    ],
    bundledAgents: [],
    projectAgentsDir: null,
    extensionAgentDirs: [],
    overrideNames: new Set(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    _resetRotationCounters();
    _resetGlobCache();
  });
  afterEach(() => {
    _resetAllTestHooks();
    delete process.env.PI_SETTINGS_SUBAGENT;
    delete process.env.PI_SUBAGENT_FORK_MODE;
    _resetRotationCounters();
    _resetGlobCache();
    vi.restoreAllMocks();
  });

  it("single review-agent dispatch with new+fork env var spawns base + -fork (no serializer registered)", async () => {
    // CRITICAL: no addExtraEnvSerializer is registered — fork mode comes purely
    // from process.env.PI_SUBAGENT_FORK_MODE (the regression condition).
    process.env.PI_SUBAGENT_FORK_MODE = "new+fork";
    const procs: ReturnType<typeof createFakeProcess>[] = [];
    spawnMock.mockImplementation(() => {
      const p = createFakeProcess();
      procs.push(p);
      return p;
    });
    discoverAgentsMock.mockReturnValue(REVIEW_AGENTS);
    _setSpawn(spawnMock);
    _setDiscoverAgents(discoverAgentsMock);
    _setLoadSubagentModelConfig(() => cfg({}, NO_DEFAULT_MODEL));
    setTestSettings(null);
    const { tool, ctx } = registerTool();

    const resultPromise = tool.execute(
      "call-1",
      { agent: "plan-reviewer", task: "Review the plan." },
      undefined,
      vi.fn(),
      ctx,
    );

    // Wait for the two parallel spawns (base + -fork duplicate) to fire.
    const start = Date.now();
    while (procs.length < 2 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 1));
    }

    // Close every spawned process so the parallel dispatch resolves.
    for (const p of procs) {
      (p.stdout as EventEmitter).emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`,
        ),
      );
      p.emit("close", EXIT_CODE_SUCCESS);
    }
    await resultPromise;

    // Exactly two spawns: the base plan-reviewer and its plan-reviewer-fork duplicate.
    expect(spawnMock.mock.calls).toHaveLength(2);
  });
});
