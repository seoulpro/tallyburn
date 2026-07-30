import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCodexRateLimits } from "../src/codex-account.js";
import {
  readClaudeQuotaState,
  writeClaudeQuotaState,
} from "../src/state.js";

test("parses official Codex account rate-limit snapshots", () => {
  const quota = parseCodexRateLimits(
    {
      rateLimits: {
        primary: {
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
        },
        secondary: {
          usedPercent: 40,
          windowDurationMins: 10_080,
          resetsAt: 1_800_100_000,
        },
      },
    },
    123,
    "pro",
  );
  assert.equal(quota?.primary?.windowMs, 5 * 3_600_000);
  assert.equal(quota?.secondary?.windowMs, 7 * 86_400_000);
  assert.equal(quota?.planType, "pro");
});

test("persists only sanitized Claude quota fields", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "tallyburn-state-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  await writeClaudeQuotaState(directory, {
    provider: "claude",
    timestamp: 123,
    primary: { usedPercent: 20, windowMs: 18_000_000 },
    secondary: { usedPercent: 30, windowMs: 604_800_000 },
  });
  const raw = await readFile(join(directory, "claude-quota.json"), "utf8");
  assert.doesNotMatch(raw, /prompt|email|token|credential/i);
  const restored = await readClaudeQuotaState(directory);
  assert.equal(restored?.primary?.usedPercent, 20);
  assert.equal(restored?.secondary?.usedPercent, 30);
  const mode = (await stat(join(directory, "claude-quota.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.deepEqual(await readdir(directory), ["claude-quota.json"]);
});

test("concurrent Claude quota writes keep the newest observation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "tallyburn-state-order-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      writeClaudeQuotaState(directory, {
        provider: "claude",
        timestamp: index + 1,
        primary: {
          usedPercent: index,
          windowMs: 18_000_000,
        },
      }),
    ),
  );

  const restored = await readClaudeQuotaState(directory);
  assert.equal(restored?.timestamp, 20);
  assert.equal(restored?.primary?.usedPercent, 19);
});
