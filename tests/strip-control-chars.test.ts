// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Unit tests for stripControlChars — the security sanitizer for child-controlled strings.
 *
 * stripControlChars strips ALL C0 control chars + DEL ([\x00-\x1f\x7f]), which subsumes
 * ANSI escape sequences (every ANSI sequence starts with ESC=0x1b). It defends the operator
 * terminal/logs against display-spoofing (CR line-overwrite, OSC 8 fake hyperlinks, ESC-c
 * screen wipes, BEL, NUL) from buggy or hostile child output.
 */
import { describe, expect, test } from "vitest";
import { __internal } from "../src/extension.js";

const { stripControlChars } = __internal;

describe("stripControlChars", () => {
  test("strips ANSI CSI sequences (subsumes stripAnsi)", () => {
    expect(stripControlChars("\x1b[31mred\x1b[0m text")).toBe("red text");
    expect(stripControlChars("\x1b[1;33;40mbold yellow\x1b[0m")).toBe("bold yellow");
  });

  test("strips OSC sequences incl. OSC 8 clickable hyperlinks", () => {
    // OSC 8 hyperlink that would render as a clickable link in the operator terminal.
    const osc8 = "\x1b]8;;https://evil.example\x07click me\x1b]8;;\x07";
    expect(stripControlChars(osc8)).toBe("click me");
  });

  test("strips 2-char ESC sequences (e.g. ESC c full reset)", () => {
    // ESC c — terminal full reset (would wipe the screen).
    expect(stripControlChars("a\x1bcb")).toBe("ab");
  });

  test("strips C0 control chars: CR, NUL, BEL, BS, VT, FF", () => {
    // CR enables line-overwrite spoofing; BEL is audible; NUL/BS/VT/FF corrupt layout.
    expect(stripControlChars("ok\rEVIL")).toBe("okEVIL");
    expect(stripControlChars("a\x00b")).toBe("ab");
    expect(stripControlChars("a\x07b")).toBe("ab"); // BEL
    expect(stripControlChars("a\bb")).toBe("ab"); // BS
    expect(stripControlChars("a\x0bb")).toBe("ab"); // VT
    expect(stripControlChars("a\x0cb")).toBe("ab"); // FF
  });

  test("strips DEL (0x7f)", () => {
    expect(stripControlChars("a\x7fb")).toBe("ab");
  });

  test("preserves all printable + high-unicode text", () => {
    expect(stripControlChars("Hello, 世界! 🚀 `code` $cmd")).toBe("Hello, 世界! 🚀 `code` $cmd");
    // Newlines (\n=0x0a, \t=0x09) ARE control chars and get stripped — sanitizer is for
    // single-line terminal/log interpolation, not multi-line text. Documented behavior.
    expect(stripControlChars("line1\nline2\ttab")).toBe("line1line2tab");
  });

  test("empty / no-control input passes through unchanged", () => {
    expect(stripControlChars("")).toBe("");
    expect(stripControlChars("plain text")).toBe("plain text");
  });

  test("mixed real-world hostile payload is neutralized", () => {
    const hostile = "\x1b[2J\x1b[H\x1b]8;;https://evil.example\x07legit\x1b]8;;\x07\r overwritten";
    expect(stripControlChars(hostile)).toBe("legit overwritten");
  });
});
