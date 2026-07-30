import assert from "node:assert/strict";
import test from "node:test";
import { parseDuration, parseWindows } from "../src/duration.js";

test("parses compact durations and sorts rolling windows", () => {
  assert.equal(parseDuration("1.5h"), 5_400_000);
  assert.deepEqual(parseWindows("12h, 1h,3h,1h"), [
    { label: "1h", durationMs: 3_600_000 },
    { label: "3h", durationMs: 10_800_000 },
    { label: "12h", durationMs: 43_200_000 },
  ]);
});

test("rejects ambiguous or excessive durations", () => {
  assert.throws(() => parseDuration("1 hour"), /Invalid duration/);
  assert.throws(() => parseDuration("0.1ms"), /greater than zero/);
  assert.throws(() => parseWindows("31d"), /cannot exceed 30 days/);
});
