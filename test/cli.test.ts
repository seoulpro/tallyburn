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
  const snapshot = JSON.parse(json.stdout) as {
    windows: Array<{ all: { total: number } }>;
    sources: { claude: { filesSeen: number } };
  };
  assert.equal(snapshot.windows[0]?.all.total, 0);
  assert.equal(snapshot.sources.claude.filesSeen, 0);

  const demo = spawnSync(
    process.execPath,
    [cli, "--demo", "--provider", "codex", "--once", "--no-color"],
    { encoding: "utf8" },
  );
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.stdout, /CODEX/);
  assert.doesNotMatch(demo.stdout, /CLAUDE/);
});
