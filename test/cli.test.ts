import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("help, version, and statusline bypass unrelated malformed config", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-cli-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const config = join(root, "broken.json");
  const state = join(root, "state");
  await writeFile(config, "{not-json");
  const environment = {
    ...process.env,
    TALLYBURN_STATE_DIR: state,
  };

  const help = spawnSync(
    process.execPath,
    [cli, "--config", config, "--help"],
    { encoding: "utf8", env: environment },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage/);

  const version = spawnSync(
    process.execPath,
    [cli, "--config", config, "--version"],
    { encoding: "utf8", env: environment },
  );
  const packageRoot = dirname(dirname(dirname(cli)));
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as { version: string };
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), packageJson.version);

  const statusline = spawnSync(
    process.execPath,
    [cli, "--config", config, "statusline"],
    {
      encoding: "utf8",
      env: environment,
      input: JSON.stringify({
        rate_limits: {
          five_hour: {
            used_percentage: 21,
            resets_at: 1_900_000_000,
          },
        },
      }),
    },
  );
  assert.equal(statusline.status, 0);
  assert.equal(statusline.stdout, "[Tallyburn] 5h 21%\n");
});

test("provider filtering and no-backfill are honored end to end", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-cli-filter-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const claudeHome = join(root, "claude");
  const project = join(claudeHome, "projects", "fixture");
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, "session.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: {
        id: "must-not-be-indexed",
        usage: { output_tokens: 999 },
      },
    })}\n`,
  );

  const json = spawnSync(
    process.execPath,
    [
      cli,
      "--provider",
      "claude",
      "--claude-home",
      claudeHome,
      "--no-backfill",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(json.status, 0, json.stderr);
  const envelope = JSON.parse(json.stdout) as {
    schemaVersion: number;
    type: string;
    sequence: number;
    snapshot: {
      windows: Array<{ all: { total: number } }>;
      sources: { claude: { filesSeen: number } };
    };
  };
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.type, "snapshot");
  assert.equal(envelope.sequence, 1);
  assert.equal(envelope.snapshot.windows[0]?.all.total, 0);
  assert.equal(envelope.snapshot.sources.claude.filesSeen, 0);
  assert.equal("root" in envelope.snapshot.sources.claude, false);

  const demo = spawnSync(
    process.execPath,
    [
      cli,
      "snapshot",
      "--demo",
      "--provider",
      "codex",
      "--no-color",
    ],
    { encoding: "utf8" },
  );
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.stdout, /CODEX/);
  assert.doesNotMatch(demo.stdout, /CLAUDE/);
});

test("doctor JSON is versioned and never revives expired Claude quota", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-cli-doctor-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex");
  const claudeHome = join(root, "claude");
  const state = join(root, "state");
  const config = join(root, "config.json");
  await mkdir(state, { recursive: true });
  await writeFile(
    join(state, "claude-quota.json"),
    `${JSON.stringify({
      version: 1,
      provider: "claude",
      timestamp: Date.now() - 24 * 60 * 60_000,
      primary: {
        usedPercent: 68,
        windowMs: 5 * 60 * 60_000,
        resetsAt: Date.now() - 1_000,
      },
    })}\n`,
  );

  const doctor = spawnSync(
    process.execPath,
    [
      cli,
      "doctor",
      "--json",
      "--offline",
      "--no-backfill",
      "--otel-port",
      "4318",
      "--codex-home",
      codexHome,
      "--claude-home",
      claudeHome,
      "--codex-executable",
      process.execPath,
      "--config",
      config,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TALLYBURN_STATE_DIR: state,
      },
    },
  );
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout) as {
    schemaVersion: number;
    type: string;
    healthy: boolean;
    clients: {
      codex: { available: boolean; version?: string };
    };
    claudeQuota: { available: boolean };
    collection: { otlp: { enabled: boolean; port?: number } };
    paths: { config: string; state: string };
  };
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.type, "doctor");
  assert.equal(report.healthy, true);
  assert.equal(report.clients.codex.available, true);
  assert.match(report.clients.codex.version ?? "", /^v\d+/);
  assert.equal(report.claudeQuota.available, false);
  assert.deepEqual(report.collection.otlp, {
    enabled: true,
    logs: false,
    port: 4318,
  });
  assert.doesNotMatch(report.paths.config, /[\u001b\n\r]/);
  assert.doesNotMatch(report.paths.state, /[\u001b\n\r]/);
});

test(
  "one-shot output exits quietly when a downstream pipe closes",
  { skip: process.platform === "win32" },
  () => {
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        '"$TALLYBURN_TEST_NODE" "$TALLYBURN_TEST_CLI" snapshot --demo --json | head -c 1',
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TALLYBURN_TEST_NODE: process.execPath,
          TALLYBURN_TEST_CLI: cli,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "{");
    assert.doesNotMatch(result.stderr, /EPIPE|Unhandled 'error'/);
  },
);
