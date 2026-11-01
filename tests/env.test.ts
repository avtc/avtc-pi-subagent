// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildSubagentEnv } from "../src/env.js";

describe("buildSubagentEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("takes no arguments — pure inheritance policy, no per-spawn overrides", () => {
    // The function signature has no `extra` param: it only applies the inheritance policy.
    // Per-spawn overrides (PI_SETTINGS_SUBAGENT, PI_SUBAGENT_PARENT_PID, etc.) are the
    // caller's responsibility, applied directly on the returned env object.
    expect(buildSubagentEnv.length).toBe(0);
  });

  test("inherits the FULL parent env — subagent gets the same env as the main session", () => {
    process.env.MY_ARBITRARY_VAR = "anything";
    process.env.SOME_CUSTOM_TOOL_CONFIG = "xyz";
    const env = buildSubagentEnv();
    expect(env.MY_ARBITRARY_VAR).toBe("anything");
    expect(env.SOME_CUSTOM_TOOL_CONFIG).toBe("xyz");
  });

  test("inherits Windows system vars (the fix for the WSL-shell bug)", () => {
    // The bug: the old allowlist dropped ProgramFiles, causing subagent bash to pick WSL
    // (Git Bash's hardcoded path needs ProgramFiles). Full-inherit fixes this.
    process.env.ProgramFiles = "C:\\Program Files";
    process.env["ProgramFiles(x86)"] = "C:\\Program Files (x86)";
    process.env.SystemRoot = "C:\\WINDOWS";
    process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
    const env = buildSubagentEnv();
    expect(env.ProgramFiles).toBe("C:\\Program Files");
    expect(env["ProgramFiles(x86)"]).toBe("C:\\Program Files (x86)");
    expect(env.SystemRoot).toBe("C:\\WINDOWS");
    expect(env.APPDATA).toBe("C:\\Users\\test\\AppData\\Roaming");
  });

  test("inherits standard Unix/toolchain vars", () => {
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/home/user";
    process.env.SHELL = "/bin/zsh";
    process.env.TERM = "xterm-256color";
    process.env.NODE_ENV = "test";
    process.env.PI_CUSTOM_CONFIG = "value";
    const env = buildSubagentEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.SHELL).toBe("/bin/zsh");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.NODE_ENV).toBe("test");
    expect(env.PI_CUSTOM_CONFIG).toBe("value");
  });

  test("does NOT leak secrets from parent env (subagent is a trusted child, same as main session)", () => {
    // Rationale: secrets are already in the main session's env; a subagent is a trusted
    // child running the same user's task with no exfiltration path the main session lacks.
    // pi-core and nicobailon both inherit full env (incl. secrets). We match that.
    process.env.MY_API_KEY = "sk-secret";
    const env = buildSubagentEnv();
    expect(env.MY_API_KEY).toBe("sk-secret");
  });

  test("excludes per-level/per-spawn vars — they must not cascade to nested subagents", () => {
    // Fork mode is a per-level orchestration decision; IS_FORK + TOOLS are parent->child
    // per-spawn inputs (a fork child's fresh grandchild must not inherit IS_FORK; a
    // whitelisted parent's TOOLS must not leak to a whitelistless child).
    process.env.PI_SUBAGENT_FORK_MODE = "new+fork";
    process.env.PI_SUBAGENT_IS_FORK = "1";
    process.env.PI_SUBAGENT_TOOLS = "read,bash";
    process.env.PI_CUSTOM_VAR = "should-pass";
    process.env.PI_SETTINGS_SUBAGENT = "{}";
    const env = buildSubagentEnv();
    expect(env.PI_SUBAGENT_FORK_MODE).toBeUndefined();
    expect(env.PI_SUBAGENT_IS_FORK).toBeUndefined();
    expect(env.PI_SUBAGENT_TOOLS).toBeUndefined();
    expect(env.PI_CUSTOM_VAR).toBe("should-pass");
    expect(env.PI_SETTINGS_SUBAGENT).toBe("{}");
  });

  test("PI_SUBAGENT_TOOLS_ADD + PI_SUBAGENT_CHILD_AGENT still pass through (not excluded)", () => {
    // TOOLS_ADD is a contributor contract that cascades (forced-add survives nesting);
    // CHILD_AGENT is overwritten per-spawn by process-runner but is not excluded from
    // inheritance (the overwrite handles it).
    process.env.PI_SUBAGENT_TOOLS_ADD = "todo_init";
    process.env.PI_SUBAGENT_CHILD_AGENT = "parent-agent";
    const env = buildSubagentEnv();
    expect(env.PI_SUBAGENT_TOOLS_ADD).toBe("todo_init");
    expect(env.PI_SUBAGENT_CHILD_AGENT).toBe("parent-agent");
  });

  test("the cascade exclusion set is the ONLY filter — everything else passes through", () => {
    // Set a wide variety of vars; all should pass except the excluded set.
    process.env.RANDOM_VAR_1 = "1";
    process.env.RANDOM_VAR_2 = "2";
    process.env.UPPERCASE = "3";
    process.env["Weird-Var_Name"] = "4";
    process.env.PI_SUBAGENT_FORK_MODE = "fork";
    process.env.PI_SUBAGENT_IS_FORK = "1";
    process.env.PI_SUBAGENT_TOOLS = "read";
    const env = buildSubagentEnv();
    expect(env.RANDOM_VAR_1).toBe("1");
    expect(env.RANDOM_VAR_2).toBe("2");
    expect(env.UPPERCASE).toBe("3");
    expect(env["Weird-Var_Name"]).toBe("4");
    expect(env.PI_SUBAGENT_FORK_MODE).toBeUndefined();
    expect(env.PI_SUBAGENT_IS_FORK).toBeUndefined();
    expect(env.PI_SUBAGENT_TOOLS).toBeUndefined();
  });

  test("returns a new object — mutating it does not affect process.env", () => {
    const env = buildSubagentEnv();
    env.NEW_INJECTED_VAR = "injected-by-caller";
    expect(process.env.NEW_INJECTED_VAR).toBeUndefined();
  });

  test("drops undefined-valued env entries", () => {
    process.env.UNDEF_VAR = undefined as unknown as string;
    const env = buildSubagentEnv();
    expect("UNDEF_VAR" in env).toBe(false);
  });
});
