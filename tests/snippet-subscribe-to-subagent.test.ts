// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { subscribeToSubagent } from "../src/snippets/canonical/subscribe-to-subagent.js";

/** Minimal ExtensionAPI shape the snippet needs: an `on` for session_shutdown and an
 *  events.on that synchronously delivers the pi-subagent:ready payload. */
function fakePi(readyPayload: Record<string, unknown>) {
  const shutdownHandlers: Array<() => void> = [];
  return {
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "session_shutdown") shutdownHandlers.push(handler);
    }),
    events: {
      on: vi.fn((event: string) => {
        if (event === "pi-subagent:ready") return () => {};
        return () => {};
      }),
    },
    _shutdownHandlers: shutdownHandlers,
    _readyPayload: readyPayload,
  };
}

describe("canonical subscribe-to-subagent forwards extensionName", () => {
  it("forwards extensionName to api.addAgentsPaths(paths, extensionName)", () => {
    const addAgentsPaths = vi.fn();
    const pi = fakePi({ addAgentsPaths });
    // Drive the ready listener the snippet registers: emit synchronously by calling
    // the events.on("pi-subagent:ready") callback with the payload.
    const readyCalls: Array<(data: unknown) => void> = [];
    const piWithEmit = {
      on: pi.on,
      events: {
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          if (event === "pi-subagent:ready") readyCalls.push(handler);
          return () => {};
        }),
      },
    };

    subscribeToSubagent(piWithEmit as unknown as ExtensionAPI, null, null, null, ["/some/agents"], "my-extension");

    // Emit the ready event.
    expect(readyCalls).toHaveLength(1);
    readyCalls[0]({ addAgentsPaths });

    expect(addAgentsPaths).toHaveBeenCalledWith(["/some/agents"], "my-extension");
  });

  it("does not call api.addAgentsPaths when addAgentsPaths is null", () => {
    const addAgentsPaths = vi.fn();
    const readyCalls: Array<(data: unknown) => void> = [];
    const pi = {
      on: vi.fn(),
      events: {
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          if (event === "pi-subagent:ready") readyCalls.push(handler);
          return () => {};
        }),
      },
    };

    subscribeToSubagent(pi as unknown as ExtensionAPI, null, null, null, null, "my-extension");

    readyCalls[0]({ addAgentsPaths });
    expect(addAgentsPaths).not.toHaveBeenCalled();
  });
});
