import assert from "node:assert/strict";
import test from "node:test";
import {
  displayPath,
  sanitizeTerminalText,
} from "../src/display.js";

test("redacts Unix and Windows home directories", () => {
  assert.equal(
    displayPath("/Users/alice/.codex", "/Users/alice"),
    "~/.codex",
  );
  assert.equal(
    displayPath("C:\\Users\\Alice\\.claude", "c:\\users\\alice"),
    "~/.claude",
  );
});

test("escapes terminal control characters", () => {
  const value = sanitizeTerminalText("before\u001b[31m\nafter");
  assert.doesNotMatch(value, /[\u0000-\u001f\u007f-\u009f]/);
  assert.equal(value, "before\\x1b[31m\\x0aafter");
});
