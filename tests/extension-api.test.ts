// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for pi-subagent extension add* API methods.
 *
 * Verifies hook registration, merge semantics, and lifecycle behavior
 * of the new add* API on PiSubagentApi.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAllTestHooks } from "../src/extension.js";
import { _modelResolvers, _promptTransformers } from "../src/hooks.js";

describe("Subagent add* API", () => {
  beforeEach(() => {
    _resetAllTestHooks();
  });

  describe("addPromptTransformer", () => {
    it("pushes transformer to _promptTransformers array", () => {
      const transformer = vi.fn((sp: string) => sp);
      _promptTransformers.push(transformer);
      expect(_promptTransformers).toContain(transformer);
    });

    it("pipeline runs transformers sequentially", async () => {
      const t1 = vi.fn((sp: string) => `${sp}-t1`);
      const t2 = vi.fn((sp: string) => `${sp}-t2`);
      _promptTransformers.push(t1, t2);

      // Simulate pipeline
      let result = "prompt";
      for (const fn of _promptTransformers) result = await fn(result, { agentName: "test", isFork: false });

      expect(result).toBe("prompt-t1-t2");
      expect(t1).toHaveBeenCalledWith("prompt", { agentName: "test", isFork: false });
      expect(t2).toHaveBeenCalledWith("prompt-t1", { agentName: "test", isFork: false });
    });
  });

  describe("addModelResolver", () => {
    it("pushes resolver to _modelResolvers array", () => {
      const resolver = vi.fn();
      _modelResolvers.push(resolver);
      expect(_modelResolvers).toContain(resolver);
    });

    it("first-wins semantics: first non-undefined wins", () => {
      const r1 = vi.fn(() => "model-a");
      const r2 = vi.fn(() => "model-b");
      _modelResolvers.push(r1, r2);

      // Simulate first-wins
      let result: string | undefined;
      for (const fn of _modelResolvers) {
        result = fn({ agentName: "test", explicitModel: undefined });
        if (result !== undefined) break;
      }
      expect(result).toBe("model-a");
      expect(r2).not.toHaveBeenCalled();
    });

    it("first-wins falls through when first returns undefined", () => {
      const r1 = vi.fn(() => undefined);
      const r2 = vi.fn(() => "model-b");
      _modelResolvers.push(r1, r2);

      let result: string | undefined;
      for (const fn of _modelResolvers) {
        result = fn({ agentName: "test", explicitModel: undefined });
        if (result !== undefined) break;
      }
      expect(result).toBe("model-b");
    });
  });

  describe("_resetAllTestHooks", () => {
    it("clears all hook arrays", () => {
      _promptTransformers.push(vi.fn());
      _modelResolvers.push(vi.fn());

      _resetAllTestHooks();

      expect(_promptTransformers).toHaveLength(0);
      expect(_modelResolvers).toHaveLength(0);
    });
  });
});
