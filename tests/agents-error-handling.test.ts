// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { discoverAgents, loadAgentsFromDir } from "../src/agents.js";

// Note: the per-module logger (log.child("agents")) now routes through the shared
// avtc-pi-logger file sink. These tests assert the error-HANDLING behavior (the
// returned empty result / projectAgentsDir); the log line itself is an implementation
// detail and is not asserted here. (vi.mock of the log singleton is unreliable under
// this repo's isolate:false vitest config due to shared module-cache load ordering.)

describe("agents error handling", () => {
  test("returns empty when directory is unreadable", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-dir-err-"));

    try {
      // Create a file where a directory is expected — causes readdirSync to fail
      // with ENOTDIR. chmod 0o000 does NOT prevent reads on Windows.
      const fileAsDir = path.join(tmpDir, "iam-a-file");
      fs.writeFileSync(fileAsDir, "content");

      const result = loadAgentsFromDir(fileAsDir);

      expect(result).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns empty when agent file is unreadable", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-file-err-"));
    const agentFile = path.join(tmpDir, "broken.md");

    fs.writeFileSync(agentFile, "---\nname: broken\ndescription: desc\n---\nbody");

    try {
      // On non-Windows, chmod should work
      if (process.platform !== "win32") {
        fs.chmodSync(agentFile, 0o000);
      }

      const result = loadAgentsFromDir(tmpDir);

      if (process.platform === "win32") {
        // On Windows, file is readable so agent loads successfully
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("broken");
      } else {
        expect(result).toEqual([]);
      }
    } finally {
      try {
        fs.chmodSync(agentFile, 0o644);
      } catch {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("discoverAgents tolerates isDirectory stat failures", () => {
    const result = discoverAgents("/nonexistent/path");

    expect(result.projectAgentsDir).toBeNull();
  });
});
