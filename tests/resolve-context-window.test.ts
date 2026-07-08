// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";

const { resolveContextWindow } = __internal;

type ModelRegistry = { find?: (provider: string, modelId: string) => { contextWindow?: number } | undefined };

describe("resolveContextWindow", () => {
  test("returns contextWindow for valid provider/model with registry hit", () => {
    const registry = {
      find: (_provider: string, _modelId: string) => ({ contextWindow: 200000 }),
    };
    expect(resolveContextWindow("anthropic/claude-sonnet-4-5", registry)).toBe(200000);
  });

  test("returns undefined when registry returns null", () => {
    const registry: ModelRegistry = {
      find: () => undefined,
    };
    expect(resolveContextWindow("unknown/model", registry)).toBeUndefined();
  });

  test("returns undefined when modelString is undefined", () => {
    expect(resolveContextWindow(undefined, {})).toBeUndefined();
  });

  test("returns undefined when modelString is empty string", () => {
    expect(resolveContextWindow("", {})).toBeUndefined();
  });

  test("returns undefined when modelString has no slash", () => {
    expect(resolveContextWindow("just-a-model", {})).toBeUndefined();
  });

  test("returns undefined when modelString starts with slash", () => {
    expect(resolveContextWindow("/model", {})).toBeUndefined();
  });

  test("returns undefined when registry is null", () => {
    expect(resolveContextWindow("anthropic/claude", undefined)).toBeUndefined();
  });

  test("returns undefined when registry throws", () => {
    const registry = {
      find: () => {
        throw new Error("registry broken");
      },
    };
    expect(resolveContextWindow("anthropic/claude", registry)).toBeUndefined();
  });
});
