// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { parseToolsAdd } from "../src/extra-tools.js";

describe("parseToolsAdd", () => {
  it("returns [] when the env value is undefined", () => {
    expect(parseToolsAdd(undefined)).toEqual([]);
  });

  it("returns [] when the env value is empty or whitespace", () => {
    expect(parseToolsAdd("")).toEqual([]);
    expect(parseToolsAdd("   ")).toEqual([]);
    expect(parseToolsAdd(" , , ")).toEqual([]);
  });

  it("splits, trims, and dedupes the comma-list (order stable)", () => {
    expect(parseToolsAdd("decision_add, decision_list ,decision_add")).toEqual(["decision_add", "decision_list"]);
  });

  it("is order-stable (first occurrence wins)", () => {
    expect(parseToolsAdd("todo_init, todo_add, todo_init, todo_list")).toEqual(["todo_init", "todo_add", "todo_list"]);
  });
});
