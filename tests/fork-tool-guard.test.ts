// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForkGuardDeps, _setGetValidatedPolicy, type ForkGuardPi, registerForkToolGuard } from "../src/fork.js";
import { _resetToolEnforcementState, _setValidatedPolicy, type ValidatedPolicy } from "../src/tool-enforcement.js";
import { registerSubagentExtension } from "./test-helpers.js";

type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallEventResult | undefined;

/** Build a fake pi that captures the registered tool_call handler. Throws if no handler was
 *  registered (a test precondition — the guard only registers a handler for fork children). */
function captureHandler(): { pi: ForkGuardPi; getHandler: () => ToolCallHandler } {
  let handler: ToolCallHandler | undefined;
  const pi: ForkGuardPi = {
    on: vi.fn((_event: "tool_call", h: ToolCallHandler) => {
      handler = h;
    }),
  };
  return {
    pi,
    getHandler: (): ToolCallHandler => {
      if (!handler) throw new Error("no tool_call handler registered");
      return handler;
    },
  };
}

const ALL_TOOLS = ["read", "write", "bash", "subagent", "todo_init", "todo_add", "git"];

/** Set IS_FORK + CHILD_AGENT so the guard activates. */
function asForkChild(): void {
  process.env.PI_SUBAGENT_IS_FORK = "1";
  process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
}

/** Stage the stash with a valid policy (addblock). */
function stageAddBlock(add: string[], block: string[], degraded: boolean): void {
  _setValidatedPolicy({ policy: { mode: "addblock", add, block }, degraded } as ValidatedPolicy);
}

/** Stage the stash with an only-mode policy. */
function stageOnly(set: string[], degraded: boolean): void {
  _setValidatedPolicy({ policy: { mode: "only", set }, degraded } as ValidatedPolicy);
}

describe("fork tool guard", () => {
  beforeEach(() => {
    _resetForkGuardDeps();
    _resetToolEnforcementState();
  });
  afterEach(() => {
    _resetForkGuardDeps();
    _resetToolEnforcementState();
    delete process.env.PI_SUBAGENT_IS_FORK;
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    delete process.env.PI_SUBAGENT_TOOLS;
    delete process.env.PI_SUBAGENT_TOOLS_ADD;
  });

  describe("activation gate (short-circuits unless IS_FORK=1)", () => {
    it("does NOT register a handler when IS_FORK is unset (top-level session)", () => {
      delete process.env.PI_SUBAGENT_IS_FORK;
      delete process.env.PI_SUBAGENT_CHILD_AGENT;
      // A *:{block:[bash]} policy present — would block bash if the gate were absent.
      stageAddBlock([], ["bash"], false);
      const { pi } = captureHandler();
      registerForkToolGuard(pi);
      expect(pi.on).not.toHaveBeenCalled();
    });

    it("does NOT register a handler for a fresh child (IS_FORK unset)", () => {
      process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
      delete process.env.PI_SUBAGENT_IS_FORK;
      stageAddBlock([], ["bash"], false);
      const { pi } = captureHandler();
      registerForkToolGuard(pi);
      expect(pi.on).not.toHaveBeenCalled();
    });

    it("registers a handler when IS_FORK=1", () => {
      asForkChild();
      stageAddBlock([], ["bash"], false);
      const { pi } = captureHandler();
      registerForkToolGuard(pi);
      expect(pi.on).toHaveBeenCalledTimes(1);
    });
  });

  describe("blocks non-effective, allows effective", () => {
    it("blocks a tool not in the effective set, allows one in it", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read"; // whitelisted base
      stageAddBlock([], [], false); // base-only effective = {read}
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      expect(handler({ toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined(); // allowed
      const blocked = handler({ toolName: "subagent" } as ToolCallEvent, {} as ExtensionContext) as {
        block: boolean;
        reason: string;
      };
      expect(blocked.block).toBe(true);
      expect(blocked.reason).toContain("subagent"); // names the blocked tool
      expect(blocked.reason).toContain("restricted"); // explains why
    });
  });

  describe("TOOLS_ADD unioned into base (forced tools survive the guard)", () => {
    it("allows a forced tool from TOOLS_ADD even though not in TOOLS", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read";
      process.env.PI_SUBAGENT_TOOLS_ADD = "todo_init";
      stageAddBlock([], [], false); // base = {read, todo_init}
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      expect(handler({ toolName: "todo_init" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      expect(handler({ toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      const blocked = handler({ toolName: "bash" } as ToolCallEvent, {} as ExtensionContext) as { block: boolean };
      expect(blocked.block).toBe(true);
    });
  });

  describe("fork: no-config/whitelistless fork child (base-only), allow-all, no getAllTools", () => {
    it("whitelistless + no policy -> allow-all WITHOUT calling getAllTools", () => {
      asForkChild();
      // Whitelistless: TOOLS unset -> base = {kind:"all"} -> allow-all predicate.
      // No policy match -> addblock {add:[],block:[]} composes to base-only (allow-all).
      stageAddBlock([], [], false);
      // ForkGuardPi declares ONLY `on` — there is no getAllTools on this object. If the guard
      // reached for getAllTools it would throw (cannot read). We assert every tool is allowed
      // (the allow-all default), proving no enumeration happened.
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      for (const name of ALL_TOOLS) {
        expect(handler({ toolName: name } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      }
    });

    it("whitelistless + explicit block still blocks", () => {
      asForkChild();
      stageAddBlock([], ["bash"], false); // base(all) - block(bash)
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      expect(handler({ toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      const blocked = handler({ toolName: "bash" } as ToolCallEvent, {} as ExtensionContext) as { block: boolean };
      expect(blocked.block).toBe(true);
    });

    it("degraded stash -> base-only, no throw/exit", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read";
      stageAddBlock([], ["bash"], true); // degraded -> policy ignored, base-only = {read}
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      expect(handler({ toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      const blocked = handler({ toolName: "bash" } as ToolCallEvent, {} as ExtensionContext) as { block: boolean };
      expect(blocked.block).toBe(true);
    });

    it("null stash (validation never ran) -> base-only", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read";
      _setValidatedPolicy(null);
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      expect(handler({ toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      const blocked = handler({ toolName: "bash" } as ToolCallEvent, {} as ExtensionContext) as { block: boolean };
      expect(blocked.block).toBe(true);
    });
  });

  describe("not re-thrown by the guard (degraded -> base-only)", () => {
    it("degraded stash with null policy -> composes base-only, neither throws nor exits", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read,write";
      //  contradiction at session_start -> degraded:true, policy:null.
      _setValidatedPolicy({ policy: null, degraded: true });
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("EXIT_MUST_NOT_BE_CALLED");
      }) as never);
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      expect(handler({ toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      expect(handler({ toolName: "write" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      const blocked = handler({ toolName: "bash" } as ToolCallEvent, {} as ExtensionContext) as { block: boolean };
      expect(blocked.block).toBe(true);
      expect(exitSpy).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    });
  });

  describe("token matching (patterns matched at call time, NO getAllTools)", () => {
    it("block glob blocks matching tools (todo_* blocks todo_init)", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read,todo_init,todo_add"; // base includes todo_*
      stageAddBlock([], ["todo_*"], false); // block removes todo_*
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      expect(handler({ toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      const blocked = handler({ toolName: "todo_init" } as ToolCallEvent, {} as ExtensionContext) as {
        block: boolean;
        reason: string;
      };
      expect(blocked.block).toBe(true);
      expect(blocked.reason).toContain("todo_init"); // names the blocked tool
      expect(blocked.reason).toContain("restricted");
    });

    it("only-mode allows only the only-set", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read,write,bash";
      stageOnly(["read"], false); // only-mode: effective = {read}, base ignored
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      expect(handler({ toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      for (const name of ["write", "bash", "subagent"]) {
        const blocked = handler({ toolName: name } as ToolCallEvent, {} as ExtensionContext) as { block: boolean };
        expect(blocked.block).toBe(true);
      }
    });

    it("only-mode with $all allows everything", () => {
      asForkChild();
      stageOnly(["$all"], false);
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      for (const name of ALL_TOOLS) {
        expect(handler({ toolName: name } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      }
    });

    it("add adds a tool outside the base", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read"; // base = {read}
      stageAddBlock(["todo_*"], [], false); // base + todo_*
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      expect(handler({ toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      expect(handler({ toolName: "todo_init" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined(); // added by glob
      expect(handler({ toolName: "todo_add" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      const blocked = handler({ toolName: "bash" } as ToolCallEvent, {} as ExtensionContext) as { block: boolean };
      expect(blocked.block).toBe(true);
    });

    //  block vetoes add at runtime: same token in add AND block -> blocked (call-time check).
    it("add+block of the same token -> block wins at call time", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read"; // base = {read}
      stageAddBlock(["bash"], ["bash"], false); // add bash, then block bash
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      expect(handler({ toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      const blocked = handler({ toolName: "bash" } as ToolCallEvent, {} as ExtensionContext) as { block: boolean };
      expect(blocked.block).toBe(true); // block vetoes the add
    });

    it("$all in block blocks everything (fails closed)", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read,write,bash"; // base = all three
      stageAddBlock([], ["$all"], false); // block everything
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      for (const name of ["read", "write", "bash", "subagent"]) {
        const blocked = handler({ toolName: name } as ToolCallEvent, {} as ExtensionContext) as { block: boolean };
        expect(blocked.block).toBe(true);
      }
    });

    it("literal block (exact match) blocks only that tool", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read,write,bash";
      stageAddBlock([], ["bash"], false);
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      expect(handler({ toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      expect(handler({ toolName: "write" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      const blocked = handler({ toolName: "bash" } as ToolCallEvent, {} as ExtensionContext) as { block: boolean };
      expect(blocked.block).toBe(true);
    });

    // Base tokens (PI_SUBAGENT_TOOLS / TOOLS_ADD) are tool-name tokens and are matched as
    // patterns, consistent with fresh mode's expandTokens. A glob in the frontmatter whitelist
    // must allow matching tools in fork mode.
    it("a glob token in the base allows matching tools (base matched as patterns, not literal)", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "todo_*"; // base = glob {todo_*}
      stageAddBlock([], [], false); // no policy -> base-only
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      // 'todo_*' base glob matches todo_init/todo_add (NOT a literal-equals 'todo_*').
      expect(handler({ toolName: "todo_init" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      expect(handler({ toolName: "todo_add" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      const blocked = handler({ toolName: "bash" } as ToolCallEvent, {} as ExtensionContext) as { block: boolean };
      expect(blocked.block).toBe(true); // bash not in the todo_* base
    });
  });

  describe("cached set composed once across multiple tool_calls", () => {
    it("composes the predicate ONCE and serves stale on subsequent calls", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read";
      stageAddBlock([], [], false); // stash A: base-only = {read}
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      // First call composes from stash A.
      expect(handler({ toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toBeUndefined();
      const blocked1 = handler({ toolName: "write" } as ToolCallEvent, {} as ExtensionContext) as { block: boolean };
      expect(blocked1.block).toBe(true);

      // Mutate the stash to B (would now allow write via add). A cached predicate ignores B.
      _setValidatedPolicy({ policy: { mode: "addblock", add: ["write"], block: [] }, degraded: false });
      const blocked2 = handler({ toolName: "write" } as ToolCallEvent, {} as ExtensionContext) as { block: boolean };
      expect(blocked2.block).toBe(true); // stale predicate from stash A
    });
  });

  describe("composition exception -> catch -> stderr + process.exit(non-zero)", () => {
    it("catches a composition throw and exits non-zero (NOT a raw throw)", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read";
      // Override the validated-policy getter to throw on composition (simulates a
      // resolution/composition bug; emitToolCall is uncaught so a raw throw would degrade
      // per-call via beforeToolCall instead of failing closed).
      _setGetValidatedPolicy((): never => {
        throw new Error("composition exploded");
      });
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("EXIT_CALLED");
      }) as never);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      expect(() => handler({ toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toThrow("EXIT_CALLED");
      expect(exitSpy).toHaveBeenCalledWith(1); // non-zero, fail-closed
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(stderrText).toContain("enforcement failed");
      expect(stderrText).toContain("composition exploded");
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    });
  });

  describe("predicate EVALUATION exception -> catch -> stderr + process.exit(non-zero)", () => {
    it("catches an evaluation-time throw and exits non-zero (NOT a raw per-call degrade)", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read";
      // Composition succeeds (the closure builds), but evaluating it throws: a malformed stash
      // (non-array block set) makes matchesAny call .some on a non-array. This is the
      // defense-in-depth case — any evaluation-time failure must fail CLOSED (stderr + exit),
      // never degrade per-call (emitToolCall is uncaught, so a raw throw would re-throw via
      // beforeToolCall each call, leaving the child unrestricted).
      _setGetValidatedPolicy(() => ({
        policy: { mode: "addblock", add: ["read"], block: "NOT_AN_ARRAY" as unknown as string[] },
        degraded: false,
      }));
      const { pi, getHandler } = captureHandler();
      registerForkToolGuard(pi);
      const handler = getHandler();

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("EXIT_CALLED");
      }) as never);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      expect(() => handler({ toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toThrow("EXIT_CALLED");
      expect(exitSpy).toHaveBeenCalledWith(1); // non-zero, fail-closed
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(stderrText).toContain("enforcement failed");
      expect(stderrText).toContain("tokens.some");

      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    });
  });

  // Integration counterpart to the session_start self-restriction test: drives a REAL tool_call
  // event through the guard registered at FACTORY time (via the real subagentExtension factory),
  // not via a directly-invoked captured handler. Proves the factory-time registration wiring
  // (extension.ts -> registerForkToolGuard(pi) -> pi.on("tool_call", ...)) reaches the guard.
  describe("factory-time registration via the real extension (integration)", () => {
    it("a fresh child (IS_FORK unset) registers NO tool_call guard at factory time", () => {
      process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
      delete process.env.PI_SUBAGENT_IS_FORK; // fresh child
      const { emitter } = registerSubagentExtension({ sessionName: "fresh-integration" });
      // The activation gate short-circuits: no tool_call listener is registered.
      expect(emitter.listenerCount("tool_call")).toBe(0);
    });

    it("a fork child (IS_FORK=1) registers the guard; a real tool_call reaches its evaluation", () => {
      asForkChild();
      process.env.PI_SUBAGENT_TOOLS = "read"; // base = {read}
      // Stage a MALFORMED block set: composition builds the closure, but evaluating it throws
      // (tokens.some on a non-array). This makes a real tool_call OBSERVABLE: the factory-time
      // guard receives the event, evaluates the predicate, and fails CLOSED (stderr + exit). The
      // existing evaluation-exception test invokes the captured handler directly; THIS test drives
      // a real tool_call through the factory-time registration wiring.
      _setGetValidatedPolicy(() => ({
        policy: { mode: "addblock", add: ["read"], block: "NOT_AN_ARRAY" as unknown as string[] },
        degraded: false,
      }));

      const { emitter } = registerSubagentExtension({
        sessionName: "fork-guard-integration",
        extra: { getAllTools: () => [{ name: "read" }, { name: "write" }] },
      });
      // The guard WAS registered at factory time (proves the wiring extension.ts -> fork.ts).
      expect(emitter.listenerCount("tool_call")).toBe(1);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("EXIT_CALLED");
      }) as never);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      // Emit a REAL tool_call event: it flows through the factory-time-registered guard, reaches
      // predicate evaluation, throws, and fails closed.
      expect(() => emitter.emit("tool_call", { toolName: "read" } as ToolCallEvent, {} as ExtensionContext)).toThrow(
        "EXIT_CALLED",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(stderrText).toContain("enforcement failed");

      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    });
  });
});
