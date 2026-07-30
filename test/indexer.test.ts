import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  mkdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UsageIndexer } from "../src/indexer.js";

test("indexes synthetic Codex and Claude logs incrementally", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-indexer-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex");
  const claudeHome = join(root, "claude");
  const codexSessions = join(codexHome, "sessions", "2026", "07", "28");
  const claudeProjects = join(claudeHome, "projects", "fixture");
  await Promise.all([
    mkdir(codexSessions, { recursive: true }),
    mkdir(claudeProjects, { recursive: true }),
  ]);
  const now = Date.now();
  await writeFile(
    join(codexSessions, "rollout-fixture.jsonl"),
    [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-1" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date(now - 1_000).toISOString(),
        payload: {
          type: "token_count",
          info: {
            last_token_usage: usage(100, 50, 20),
            total_token_usage: usage(100, 50, 20),
          },
        },
      }),
      "",
    ].join("\n"),
  );
  await writeFile(
    join(claudeProjects, "session-fixture.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      timestamp: new Date(now - 500).toISOString(),
      message: {
        id: "claude-1",
        model: "fixture",
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 8,
          output_tokens: 10,
        },
      },
    })}\n`,
  );

  const indexer = new UsageIndexer({
    codexHome,
    claudeHome,
    retentionMs: 3_600_000,
  });
  await indexer.scan(now);
  const snapshot = indexer.store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    indexer.statuses,
    now,
  );
  assert.equal(snapshot.windows[0]?.providers.codex.total, 120);
  assert.equal(snapshot.windows[0]?.providers.claude.total, 60);
  assert.equal(snapshot.windows[0]?.all.observations, 2);

  await indexer.scan(now + 100);
  const unchanged = indexer.store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    indexer.statuses,
    now + 100,
  );
  assert.equal(unchanged.windows[0]?.all.observations, 2);
});

test("removes replayed parent usage from forked Codex sessions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-codex-fork-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex");
  const sessions = join(codexHome, "sessions", "2026", "07", "28");
  await mkdir(sessions, { recursive: true });
  const now = Date.now();
  const parentFirst = usage(100, 80, 20);
  const parentSecond = usage(40, 20, 10);
  const parentTotal = usage(140, 100, 30);
  const childOwn = usage(30, 10, 5);
  const childTotal = usage(170, 110, 35);

  await writeFile(
    join(sessions, "rollout-2026-07-28T10-00-00-parent.jsonl"),
    [
      sessionMeta("parent", now - 20_000),
      codexUsageLine(now - 19_000, parentFirst, parentFirst),
      codexUsageLine(now - 18_000, parentSecond, parentTotal),
      // The parent can keep working after the child forked. An identical
      // child response must not match this post-fork parent event.
      codexUsageLine(now - 5_000, childOwn, childTotal),
      "",
    ].join("\n"),
  );
  await writeFile(
    join(sessions, "rollout-2026-07-28T10-01-00-child.jsonl"),
    [
      sessionMeta("child", now - 10_000, "parent"),
      sessionMeta("parent", now - 9_999),
      codexUsageLine(now - 9_998, parentFirst, parentFirst),
      codexUsageLine(now - 9_997, parentSecond, parentTotal),
      codexUsageLine(now - 3_000, childOwn, childTotal),
      "",
    ].join("\n"),
  );

  const indexer = new UsageIndexer({
    codexHome,
    claudeHome: join(root, "claude"),
    retentionMs: 3_600_000,
    providers: ["codex"],
  });
  await indexer.scan(now);
  const snapshot = indexer.store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    indexer.statuses,
    now,
  );

  assert.equal(snapshot.windows[0]?.providers.codex.total, 240);
  assert.equal(snapshot.windows[0]?.providers.codex.observations, 4);

  await appendFile(
    join(sessions, "rollout-2026-07-28T10-01-00-child.jsonl"),
    `${codexUsageLine(
      now - 1_000,
      usage(20, 5, 5),
      usage(190, 115, 40),
    )}\n`,
  );
  await indexer.scan(now);
  const incremental = indexer.store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    indexer.statuses,
    now,
  );
  assert.equal(incremental.windows[0]?.providers.codex.total, 265);
  assert.equal(incremental.windows[0]?.providers.codex.observations, 5);
});

test("drops a rewritten fork burst when the Codex parent is unavailable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-codex-burst-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex");
  const sessions = join(codexHome, "sessions");
  await mkdir(sessions, { recursive: true });
  const now = Date.now();
  const startedAt = now - 10_000;

  await writeFile(
    join(sessions, "rollout-2026-07-28T10-01-00-child.jsonl"),
    [
      sessionMeta("child", startedAt, "missing-parent"),
      codexUsageLine(
        startedAt + 10,
        usage(100, 80, 20),
        usage(100, 80, 20),
      ),
      codexUsageLine(
        startedAt + 20,
        usage(40, 20, 10),
        usage(140, 100, 30),
      ),
      codexUsageLine(
        startedAt + 3_000,
        usage(20, 5, 5),
        usage(160, 105, 35),
      ),
      "",
    ].join("\n"),
  );

  const indexer = new UsageIndexer({
    codexHome,
    claudeHome: join(root, "claude"),
    retentionMs: 3_600_000,
    providers: ["codex"],
  });
  await indexer.scan(now);
  const snapshot = indexer.store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    indexer.statuses,
    now,
  );

  assert.equal(snapshot.windows[0]?.providers.codex.total, 25);
  assert.equal(snapshot.windows[0]?.providers.codex.observations, 1);
});

test("keeps a fork's first real Codex response when no history was replayed", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-codex-no-replay-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex");
  const sessions = join(codexHome, "sessions");
  await mkdir(sessions, { recursive: true });
  const now = Date.now();

  await writeFile(
    join(sessions, "rollout-2026-07-28T10-01-00-child.jsonl"),
    [
      sessionMeta("child", now - 10_000, "missing-parent"),
      codexUsageLine(
        now - 5_000,
        usage(20, 5, 5),
        usage(20, 5, 5),
      ),
      "",
    ].join("\n"),
  );

  const indexer = new UsageIndexer({
    codexHome,
    claudeHome: join(root, "claude"),
    retentionMs: 3_600_000,
    providers: ["codex"],
  });
  await indexer.scan(now);
  const snapshot = indexer.store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    indexer.statuses,
    now,
  );

  assert.equal(snapshot.windows[0]?.providers.codex.total, 25);
  assert.equal(snapshot.windows[0]?.providers.codex.observations, 1);
});

test("bounds partial lines, recovers, and forgets deleted files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-bounded-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const claudeHome = join(root, "claude");
  const project = join(claudeHome, "projects", "fixture");
  await mkdir(project, { recursive: true });
  const log = join(project, "large.jsonl");
  await writeFile(log, "x".repeat(4 * 1024 * 1024 + 1));

  const now = Date.now();
  const indexer = new UsageIndexer({
    codexHome: join(root, "codex"),
    claudeHome,
    retentionMs: 3_600_000,
    providers: ["claude"],
  });
  await indexer.scan(now);
  assert.equal(indexer.trackedFileCount, 1);
  assert.equal(indexer.statuses.claude.malformedLines, 1);

  await appendFile(
    log,
    `\n${JSON.stringify({
      type: "assistant",
      timestamp: new Date(now + 1_000).toISOString(),
      message: {
        id: "recovered",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
      },
    })}\n`,
  );
  await indexer.scan(now + 2_000);
  const recovered = indexer.store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    indexer.statuses,
    now + 2_000,
  );
  assert.equal(recovered.windows[0]?.providers.claude.total, 15);

  await unlink(log);
  await indexer.scan(now + 3_000);
  assert.equal(indexer.trackedFileCount, 0);
});

test("detects same-path file replacement and ignores symlinks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-rotation-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const claudeHome = join(root, "claude");
  const project = join(claudeHome, "projects", "fixture");
  await mkdir(project, { recursive: true });
  const log = join(project, "session.jsonl");
  const first = claudeUsageLine(Date.now() - 2_000, "first", 10);
  await writeFile(log, `${first}\n`);

  const indexer = new UsageIndexer({
    codexHome: join(root, "codex"),
    claudeHome,
    retentionMs: 3_600_000,
    providers: ["claude"],
  });
  const now = Date.now();
  await indexer.scan(now);

  const replacement = join(project, "replacement.tmp");
  const priorSize = (await stat(log)).size;
  const second = claudeUsageLine(now - 1_000, "second", 20);
  await writeFile(replacement, `${second.padEnd(priorSize + 64, " ")}\n`);
  await rename(replacement, log);
  await indexer.scan(now);

  const snapshot = indexer.store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    indexer.statuses,
    now,
  );
  assert.equal(snapshot.windows[0]?.providers.claude.total, 30);

  const sameInodeSize = (await stat(log)).size;
  const third = claudeUsageLine(now - 500, "third", 30);
  await writeFile(log, `${third.padEnd(sameInodeSize + 64, " ")}\n`);
  await indexer.scan(now);
  const rewritten = indexer.store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    indexer.statuses,
    now,
  );
  assert.equal(rewritten.windows[0]?.providers.claude.total, 60);

  const outside = join(root, "outside.jsonl");
  await writeFile(outside, `${claudeUsageLine(now, "outside", 999)}\n`);
  await symlink(outside, join(project, "linked.jsonl"));
  await indexer.scan(now);
  const unchanged = indexer.store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    indexer.statuses,
    now,
  );
  assert.equal(unchanged.windows[0]?.providers.claude.total, 60);
});

function usage(input: number, cached: number, output: number) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 5,
    total_tokens: input + output,
  };
}

function sessionMeta(
  id: string,
  timestamp: number,
  parentId?: string,
): string {
  return JSON.stringify({
    timestamp: new Date(timestamp).toISOString(),
    type: "session_meta",
    payload: {
      id,
      ...(parentId ? { forked_from_id: parentId } : {}),
    },
  });
}

function codexUsageLine(
  timestamp: number,
  last: ReturnType<typeof usage>,
  total: ReturnType<typeof usage>,
): string {
  return JSON.stringify({
    timestamp: new Date(timestamp).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: last,
        total_token_usage: total,
      },
    },
  });
}

function claudeUsageLine(
  timestamp: number,
  id: string,
  output: number,
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(timestamp).toISOString(),
    message: {
      id,
      usage: {
        output_tokens: output,
      },
    },
  });
}
