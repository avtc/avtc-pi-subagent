// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../scripts/no-design-refs.cjs");
const FIXTURE = {
  // A .ts file with: a design-doc ref (should be stripped), a clean JSDoc comment
  // (must be left BYTE-IDENTICAL), a clean line comment, and a test name with + without refs.
  tsWithRefs: `/**
 * Best-effort error message. Sanitization strips control chars (ANSI/OSC/C0)
 * within each line.
 */
function sanitize(stderr: string): string {
  // Phase A runs first, then Phase B (design-doc jargon to strip).
  return stderr.replace(/\\x1b/g, "");
}

// D27 is a decision id that must be stripped from comments.
export const X = 1;
`,
  tsClean: `/**
 * Return this slot to the gate. Safe to call more than once: later calls are
 * no-ops — no double-counting, and never more than one waiter admitted.
 *
 * @param getLimit Invoked on every acquire decision and every release to learn
 *                 the current cap. May return different values over time.
 */
export class Gate {
   /** Request a slot. Resolves immediately when inside < current cap. */
   async acquire(): Promise<Admission> {}
}
`,
};

describe("no-design-refs linter (scripts/no-design-refs.cjs)", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(path.join(tmpdir(), "ndr-"));
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  function runFix(file: string): string {
    execFileSync(process.execPath, [SCRIPT, "--fix", file], { cwd: dir, encoding: "utf8" });
    return readFileSync(file, "utf8");
  }

  function runCheck(file: string): { status: number; out: string } {
    try {
      const out = execFileSync(process.execPath, [SCRIPT, file], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, out };
    } catch (e) {
      const err = e as { stdout?: string; status?: number };
      return { status: err.status ?? 1, out: err.stdout ?? "" };
    }
  }

  it("strips design-doc refs from comments and leaves descriptive text intact", () => {
    const file = path.join(dir, "a.ts");
    writeFileSync(file, FIXTURE.tsWithRefs, "utf8");
    const fixed = runFix(file);
    expect(fixed).not.toContain("D27");
    expect(fixed).not.toContain("Phase A");
    expect(fixed).not.toContain("Phase B");
    // descriptive text survives
    expect(fixed).toContain("Best-effort error message");
    expect(fixed).toContain("design-doc jargon to strip");
    // check passes after fix
    expect(runCheck(file).status).toBe(0);
  });

  it("leaves a clean file (no refs) BYTE-IDENTICAL under --fix", () => {
    const file = path.join(dir, "clean.ts");
    writeFileSync(file, FIXTURE.tsClean, "utf8");
    const before = readFileSync(file, "utf8");
    const after = runFix(file);
    // A file with NO design-doc refs must not be reformatted at all (no whitespace
    // normalization, no JSDoc indentation changes) — the fixer is surgical.
    expect(after).toBe(before);
  });

  it("preserves JSDoc indentation and alignment in clean multi-line comments", () => {
    const file = path.join(dir, "jsdoc.ts");
    writeFileSync(file, FIXTURE.tsClean, "utf8");
    const after = runFix(file);
    // The deliberately-aligned '@param ... current cap' continuation must keep its
    // column alignment (the pre-fix bug collapsed it to a single space).
    expect(after).toContain("*                 the current cap.");
    // An indented inner JSDoc block keeps its leading indentation.
    expect(after).toContain("   /** Request a slot.");
  });

  it("does not flag 'C0' (the control-character set) as a design-doc ref", () => {
    const file = path.join(dir, "c0.ts");
    writeFileSync(file, "// strip control chars (ANSI/OSC/C0) within each line\nexport const x = 1;\n", "utf8");
    expect(runCheck(file).status).toBe(0);
  });

  it("strips design-doc ID prefixes from test names but keeps descriptions", () => {
    const file = path.join(dir, "names.ts");
    writeFileSync(
      file,
      [
        `it("detects a name defined by two distinct extensions", () => {});`,
        `it("disabled glob matching the resolved BASE name blocks a -fork variant", () => {});`,
        `it("no duplicates -> no collision", () => {});`,
        "",
      ].join("\n"),
      "utf8",
    );
    const fixed = runFix(file);
    expect(fixed).toContain('it("detects a name defined by two distinct extensions"');
    expect(fixed).toContain('it("disabled glob matching the resolved BASE name blocks a -fork variant"');
    expect(fixed).toContain('it("no duplicates -> no collision"'); // clean name untouched
    expect(runCheck(file).status).toBe(0);
  });

  it("check mode REJECTS (non-zero exit) a file containing a design-doc ref and reports it", () => {
    // The linter's primary contract: check mode (no --fix) exits 1 on any violation so CI gates
    // catch design-doc refs. A regression making check mode a silent no-op would pass the --fix
    // tests above (which assert on the rewritten file) but break the enforced check gate.
    const file = path.join(dir, "dirty.ts");
    writeFileSync(file, "// see design decision D27 for rationale\nexport const x = 1;\n", "utf8");
    const result = runCheck(file);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("D27");
  });
});
