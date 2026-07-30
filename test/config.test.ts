import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolveConfig } from "../src/config.js";

test("option values are not mistaken for commands", async () => {
  const config = await resolveConfig(
    [
      "--windows",
      "30m,1h",
      "--provider",
      "codex",
      "--refresh",
      "2s",
      "doctor",
      "--config",
      join(tmpdir(), `tallyburn-${randomUUID()}.json`),
    ],
    {},
  );

  assert.equal(config.command, "doctor");
  assert.deepEqual(
    config.windows.map((window) => window.label),
    ["30m", "1h"],
  );
  assert.deepEqual(config.providers, ["codex"]);
  assert.equal(config.refreshMs, 2_000);
});

test("unknown options and extra positional arguments fail closed", async () => {
  await assert.rejects(
    resolveConfig(["--definitely-unknown"], {}),
    /Unknown option/,
  );
  await assert.rejects(
    resolveConfig(["doctor", "extra"], {}),
    /Unexpected argument/,
  );
});

test("offline and explicit opt-outs disable account reads", async () => {
  const configPath = join(tmpdir(), `tallyburn-${randomUUID()}.json`);
  const offline = await resolveConfig(
    [
      "--codex-account",
      "--claude-account",
      "--offline",
      "--config",
      configPath,
    ],
    {},
  );
  const optedOut = await resolveConfig(
    [
      "--codex-account",
      "--no-codex-account",
      "--claude-account",
      "--no-claude-account",
      "--config",
      configPath,
    ],
    {},
  );

  assert.equal(offline.codexAccount, false);
  assert.equal(offline.claudeAccount, false);
  assert.equal(optedOut.codexAccount, false);
  assert.equal(optedOut.claudeAccount, false);
});

test("stream and explicit provider executables resolve without ambiguity", async () => {
  const configPath = join(tmpdir(), `tallyburn-${randomUUID()}.json`);
  const codexExecutable = join(tmpdir(), "codex-test");
  const claudeExecutable = join(tmpdir(), "claude-test");
  const config = await resolveConfig(
    [
      "stream",
      "--codex-account",
      "--codex-executable",
      codexExecutable,
      "--claude-account",
      "--claude-executable",
      claudeExecutable,
      "--config",
      configPath,
    ],
    {},
  );

  assert.equal(config.command, "stream");
  assert.equal(config.codexAccount, true);
  assert.equal(config.codexExecutable, codexExecutable);
  assert.equal(config.claudeAccount, true);
  assert.equal(config.claudeExecutable, claudeExecutable);
});

test("refresh intervals cannot overflow Node timers", async () => {
  await assert.rejects(
    resolveConfig(
      [
        "--refresh",
        "30d",
        "--config",
        join(tmpdir(), `tallyburn-${randomUUID()}.json`),
      ],
      {},
    ),
    /cannot exceed 24 hours/,
  );
});

test("all official and local providers are selectable", async () => {
  const explicit = await resolveConfig(
    [
      "--provider",
      "qwen",
      "--config",
      join(tmpdir(), `tallyburn-${randomUUID()}.json`),
    ],
    {},
  );
  const all = await resolveConfig(
    [
      "--provider",
      "all",
      "--config",
      join(tmpdir(), `tallyburn-${randomUUID()}.json`),
    ],
    {},
  );

  assert.deepEqual(explicit.providers, ["qwen"]);
  assert.deepEqual(all.providers, [
    "codex",
    "claude",
    "gemini",
    "copilot",
    "qwen",
    "llamacpp",
    "vllm",
  ]);
});

test("local runtime metric URLs resolve from CLI and environment", async () => {
  const config = await resolveConfig(
    [
      "--provider",
      "llamacpp,vllm",
      "--llamacpp-metrics",
      "http://127.0.0.1:8080/metrics",
      "--config",
      join(tmpdir(), `tallyburn-${randomUUID()}.json`),
    ],
    {
      TALLYBURN_VLLM_METRICS: "http://127.0.0.1:8000/metrics",
    },
  );
  assert.equal(
    config.llamaCppMetrics,
    "http://127.0.0.1:8080/metrics",
  );
  assert.equal(
    config.vllmMetrics,
    "http://127.0.0.1:8000/metrics",
  );
});
