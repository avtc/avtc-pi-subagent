// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetGlobCache,
  _resetRotationCounters,
  type ModelResolverHook,
  resolveModelLayered,
} from "../src/model-resolution.js";
import type { SubagentModelConfig } from "../src/subagent-config.js";
import { makeSubagentConfig } from "./test-helpers.js";

/**
 * Lock the 5-phase layered precedence against the REAL
 * `resolveModelLayered` function (the pure precedence core the
 * `resolveModelForAgent` closure delegates to). This is NOT a hand-written
 * simulation — reordering the phases in the implementation WILL fail these tests.
 *
 *  Phase 0: explicit `--model` param (highest)
 *  Phase 1: built-in subagent-models match (agent/glob specificity)
 *  Phase 2: registered hooks (first-wins)
 *  Phase 3: built-in subagent default-model
 *  Phase 4: fall through → agent.model ?? parentModel (handled in process-runner.ts)
 */

type Hook = ModelResolverHook;

const cfg = makeSubagentConfig;

const resolve = (agentName: string, explicitModel: string | undefined, config: SubagentModelConfig, hooks: Hook[]) =>
  resolveModelLayered(agentName, explicitModel, config, hooks);

describe("resolveModelLayered precedence", () => {
  beforeEach(() => {
    _resetRotationCounters();
    _resetGlobCache();
  });

  it("Phase 0 explicitModel beats Phase 1 config", () => {
    const c = cfg({ "*": "config/x" }, null);
    expect(resolve("a", "explicit/y", c, [() => undefined])).toBe("explicit/y");
  });

  it("Phase 1 config beats Phase 2 hook", () => {
    const c = cfg({ "*": "config/x" }, null);
    expect(resolve("a", undefined, c, [() => "hook/z"])).toBe("config/x");
  });

  it("Phase 2 hook beats Phase 3 default-model", () => {
    const c = cfg({}, "default/d");
    expect(resolve("a", undefined, c, [() => "hook/z"])).toBe("hook/z");
  });

  it("Phase 2 first-wins among multiple hooks", () => {
    const c = cfg({}, "default/d");
    expect(resolve("a", undefined, c, [() => "first", () => "second"])).toBe("first");
  });

  it("Phase 2 falls through when a hook returns undefined", () => {
    const c = cfg({}, "default/d");
    expect(resolve("a", undefined, c, [() => undefined, () => "second"])).toBe("second");
  });

  it("Phase 3 default-model beats Phase 4 fallthrough", () => {
    const c = cfg({}, "default/d");
    expect(resolve("a", undefined, c, [() => undefined])).toBe("default/d");
  });

  it("Phase 4 returns undefined when nothing configured and no hooks match", () => {
    const c = cfg({}, null);
    expect(resolve("a", undefined, c, [() => undefined])).toBeUndefined();
  });

  it("passes the resolver context { agentName, explicitModel } to each hook", () => {
    const c = cfg({}, null);
    const seen: Array<{ agentName: string; explicitModel: string | undefined }> = [];
    resolve("plan-reviewer", undefined, c, [
      (ctx) => {
        seen.push(ctx);
        return undefined;
      },
    ]);
    expect(seen).toEqual([{ agentName: "plan-reviewer", explicitModel: undefined }]);
  });
});
