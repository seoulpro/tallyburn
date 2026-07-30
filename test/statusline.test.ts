import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  parseClaudeStatuslineQuota,
  readClaudeStatuslineQuota,
  runClaudeStatuslineCommand,
} from "../src/statusline.js";

test("extracts only official five-hour and seven-day rate limits", () => {
  const quota = parseClaudeStatuslineQuota(
    {
      session_id: "session-fixture",
      transcript_path: "fixture-path",
      model: { display_name: "fixture" },
      rate_limits: {
        five_hour: {
          used_percentage: 23.5,
          resets_at: 1_800_000_000,
          unrelated: "SENSITIVE_FIXTURE",
        },
        seven_day: {
          used_percentage: 141.2,
          resets_at: 1_800_100_000,
        },
        other_window: {
          used_percentage: 99,
        },
      },
    },
    123,
  );

  assert.deepEqual(quota, {
    provider: "claude",
    timestamp: 123,
    primary: {
      usedPercent: 23.5,
      windowMs: 5 * 60 * 60 * 1_000,
      resetsAt: 1_800_000_000_000,
    },
    secondary: {
      usedPercent: 100,
      windowMs: 7 * 24 * 60 * 60 * 1_000,
      resetsAt: 1_800_100_000_000,
    },
  });
  assert.doesNotMatch(
    JSON.stringify(quota),
    /session-fixture|synthetic|SENSITIVE_FIXTURE|fixture/,
  );
});

test("handles absent and malformed statusline fields", async () => {
  assert.equal(parseClaudeStatuslineQuota({}), undefined);
  assert.equal(
    parseClaudeStatuslineQuota({
      rate_limits: {
        five_hour: { used_percentage: "20" },
      },
    }),
    undefined,
  );
  assert.equal(
    await readClaudeStatuslineQuota(
      Readable.from(["not json"]),
    ),
    undefined,
  );
});

test("statusline command emits quota text and sends only a snapshot", async () => {
  let output = "";
  let received: unknown;
  const result = await runClaudeStatuslineCommand({
    input: Readable.from([
      JSON.stringify({
        model: { display_name: "SENSITIVE_FIXTURE" },
        rate_limits: {
          five_hour: { used_percentage: 23.5 },
          seven_day: { used_percentage: 41.2 },
        },
      }),
    ]),
    now: () => 456,
    onQuota(quota) {
      received = quota;
    },
    output: {
      write(chunk) {
        output += chunk;
      },
    },
  });

  assert.equal(output, "[Tallyburn] 5h 24% · 7d 41%\n");
  assert.deepEqual(received, result);
  assert.doesNotMatch(JSON.stringify(received), /SENSITIVE_FIXTURE/);
});

test("statusline command degrades safely when input exceeds its limit", async () => {
  let output = "";
  const result = await runClaudeStatuslineCommand({
    input: Readable.from(["x".repeat(64)]),
    maxInputBytes: 32,
    output: {
      write(chunk) {
        output += chunk;
      },
    },
  });
  assert.equal(result, undefined);
  assert.equal(output, "[Tallyburn]\n");
});

test("statusline still renders when quota persistence fails", async () => {
  let output = "";
  let failed = false;
  const quota = await runClaudeStatuslineCommand({
    input: Readable.from([
      JSON.stringify({
        rate_limits: {
          five_hour: {
            used_percentage: 12,
            resets_at: 1_800_000_000,
          },
        },
      }),
    ]),
    output: {
      write(chunk) {
        output += chunk;
      },
    },
    async onQuota() {
      throw new Error("synthetic write failure");
    },
    onQuotaError() {
      failed = true;
    },
  });

  assert.equal(quota?.primary?.usedPercent, 12);
  assert.equal(output, "[Tallyburn] 5h 12%\n");
  assert.equal(failed, true);
});
