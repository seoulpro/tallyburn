import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  appendFile,
  chmod,
  mkdtemp,
  mkdir,
  open,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createTallyburnMonitor,
  snapshotEnvelope,
  type SnapshotEnvelope,
} from "tallyburn";

const execFileAsync = promisify(execFile);

test("public monitor API starts, refreshes, subscribes, and stops", async () => {
  const monitor = await createTallyburnMonitor({
    windows: ["1h", "3h", "12h"],
    refreshMs: 250,
    demo: true,
  });
  let emissions = 0;
  const unsubscribe = monitor.subscribe(() => {
    emissions += 1;
  });

  const initial = monitor.snapshot();
  assert.equal(initial.windows.length, 3);
  assert.ok((initial.windows[0]?.all.total ?? 0) > 0);
  assert.equal(emissions, 1);

  await monitor.refresh();
  assert.equal(emissions, 2);
  await monitor.start();
  await monitor.start();
  assert.equal(monitor.running, true);
  assert.ok(emissions >= 3);

  unsubscribe();
  await monitor.stop();
  await monitor.stop();
  assert.equal(monitor.running, false);
  await assert.rejects(() => monitor.refresh(), /closed/);
});

test("public snapshots cannot mutate stored events", async () => {
  const monitor = await createTallyburnMonitor({
    windows: ["1h"],
    demo: true,
  });
  const first = monitor.snapshot();
  const event = first.recentEvents[0];
  assert.ok(event);
  const originalTotal = event.total;
  event.total = 0;

  const second = monitor.snapshot();
  assert.equal(second.recentEvents[0]?.total, originalTotal);
  await monitor.close();
});

test("versioned stream envelope excludes event ids and source paths", async () => {
  const monitor = await createTallyburnMonitor({
    windows: ["1h"],
    demo: true,
  });
  const envelope: SnapshotEnvelope = snapshotEnvelope(
    monitor.snapshot(),
    7,
  );
  const serialized = JSON.stringify(envelope);

  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.type, "snapshot");
  assert.equal(envelope.sequence, 7);
  assert.equal("recentEvents" in envelope.snapshot, false);
  assert.equal("root" in envelope.snapshot.sources.codex, false);
  assert.doesNotMatch(serialized, /demo:codex|demo:claude/);
  await monitor.close();
});

test("public snapshots expose only Claude subscription capability", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-claude-account-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const executable = join(root, "claude");
  await writeFile(
    executable,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  loggedIn: true,
  subscriptionType: "max",
  email: "private@example.invalid",
  orgId: "secret-org"
}));
`,
    { mode: 0o755 },
  );
  await chmod(executable, 0o755);

  const monitor = await createTallyburnMonitor({
    windows: ["1h"],
    providers: ["claude"],
    claudeHome: join(root, "missing-claude-home"),
    codexHome: join(root, "missing-codex-home"),
    stateDirectory: join(root, "state"),
    backfill: false,
    claudeAccount: true,
    claudeExecutable: executable,
  });
  context.after(async () => monitor.close());

  const snapshot = monitor.snapshot();
  assert.deepEqual(snapshot.accounts?.claude, {
    provider: "claude",
    observedAt: snapshot.accounts?.claude?.observedAt,
    loggedIn: true,
    subscriptionType: "max",
  });
  const serialized = JSON.stringify(snapshotEnvelope(snapshot, 1));
  assert.match(serialized, /"subscriptionType":"max"/);
  assert.doesNotMatch(serialized, /email|orgId|private|secret/i);
});

test("long-lived monitor observes appended usage without restarting", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-monitor-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const claudeHome = join(root, "claude");
  const project = join(claudeHome, "projects", "fixture");
  const log = join(project, "session.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(log, "");

  const monitor = await createTallyburnMonitor({
    windows: ["1h"],
    refreshMs: 250,
    providers: ["claude"],
    codexHome: join(root, "codex"),
    claudeHome,
    stateDirectory: join(root, "state"),
  });
  context.after(async () => monitor.close());
  const observed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for appended usage.")),
      3_000,
    );
    monitor.subscribe((snapshot) => {
      if ((snapshot.windows[0]?.all.total ?? 0) === 60) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await monitor.start();
  assert.equal(
    monitor.collectionMode,
    process.platform === "darwin" || process.platform === "win32"
      ? "watch"
      : "poll",
  );

  await appendFile(
    log,
    `${JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: {
        id: "live-append",
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
  await observed;
  await monitor.close();
});

test("start and concurrent close calls share one complete shutdown", async () => {
  const monitor = await createTallyburnMonitor({
    windows: ["1h"],
    refreshMs: 250,
    demo: true,
  });
  const starting = monitor.start();
  const firstClose = monitor.close();
  const secondClose = monitor.close();

  assert.equal(firstClose, secondClose);
  await Promise.all([starting, firstClose, secondClose]);
  assert.equal(monitor.running, false);
});

test("queued refresh observes changes made after the active scan", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-refresh-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const claudeHome = join(root, "claude");
  const project = join(claudeHome, "projects", "fixture");
  const stateDirectory = join(root, "state");
  const log = join(project, "session.jsonl");
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
  ]);
  const now = Date.now();
  await writeFile(log, `${claudeUsageLine(now - 2_000, "first", 10)}\n`);

  const monitor = await createTallyburnMonitor({
    windows: ["1h"],
    providers: ["claude"],
    claudeHome,
    codexHome: join(root, "codex"),
    stateDirectory,
  });
  context.after(async () => monitor.close());

  const fifo = join(stateDirectory, "claude-quota.json");
  await execFileAsync("mkfifo", [fifo]);
  const firstRefresh = monitor.refresh(now);
  const writer = await open(fifo, "w");
  await appendFile(
    log,
    `${claudeUsageLine(now - 1_000, "second", 20)}\n`,
  );
  const secondRefresh = monitor.refresh(now + 1);
  await unlink(fifo);
  await writer.writeFile("{}");
  await writer.close();

  const first = await firstRefresh;
  const second = await secondRefresh;
  assert.equal(first.windows[0]?.all.total, 10);
  assert.equal(second.windows[0]?.all.total, 30);
});

test("watch topology recovers when a provider tree appears later", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-topology-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const claudeHome = join(root, "claude");
  const project = join(claudeHome, "projects", "fixture");
  const log = join(project, "session.jsonl");
  await mkdir(claudeHome, { recursive: true });
  const now = Date.now();

  const monitor = await createTallyburnMonitor({
    windows: ["1h"],
    refreshMs: 250,
    providers: ["claude"],
    claudeHome,
    codexHome: join(root, "codex"),
    stateDirectory: join(root, "state"),
  });
  context.after(async () => monitor.close());
  await monitor.start();
  assert.equal(monitor.collectionMode, "poll");

  await mkdir(project, { recursive: true });
  await writeFile(log, `${claudeUsageLine(now, "first", 10)}\n`);
  await waitFor(() => monitor.snapshot().windows[0]?.all.total === 10);
  if (process.platform === "darwin" || process.platform === "win32") {
    await waitFor(() => monitor.collectionMode === "watch");
  } else {
    assert.equal(monitor.collectionMode, "poll");
  }

  await appendFile(
    log,
    `${claudeUsageLine(now + 1, "second", 20)}\n`,
  );
  await waitFor(() => monitor.snapshot().windows[0]?.all.total === 30);
});

test("five-minute pace remains complete with a shorter rolling window", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-rate-retention-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const claudeHome = join(root, "claude");
  const project = join(claudeHome, "projects", "fixture");
  const log = join(project, "session.jsonl");
  const now = Date.now();
  await mkdir(project, { recursive: true });
  await writeFile(
    log,
    `${claudeUsageLine(now - 2 * 60_000, "five-minute-rate", 600)}\n`,
  );

  const monitor = await createTallyburnMonitor({
    windows: ["30s"],
    providers: ["claude"],
    claudeHome,
    codexHome: join(root, "codex"),
    stateDirectory: join(root, "state"),
  });
  context.after(async () => monitor.close());
  const snapshot = monitor.snapshot(0, now);

  assert.equal(snapshot.windows[0]?.all.total, 0);
  assert.equal(snapshot.liveRate?.all.tokensPerMinute, 0);
  assert.equal(snapshot.recentRateWindowMs, 5 * 60_000);
  assert.equal(snapshot.recentTokensPerMinute, 120);
});

test("an available provider keeps live watch when another provider root is absent", {
  skip: process.platform !== "darwin",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-partial-topology-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const claudeHome = join(root, "claude");
  const project = join(claudeHome, "projects", "fixture");
  const log = join(project, "session.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(log, "");

  const monitor = await createTallyburnMonitor({
    windows: ["1h"],
    refreshMs: 250,
    providers: ["codex", "claude"],
    claudeHome,
    codexHome: join(root, "missing-codex"),
    stateDirectory: join(root, "state"),
  });
  context.after(async () => monitor.close());
  await monitor.start();
  assert.equal(monitor.collectionMode, "watch");

  await appendFile(
    log,
    `${claudeUsageLine(Date.now(), "partial-topology", 25)}\n`,
  );
  await waitFor(() => monitor.snapshot().windows[0]?.all.total === 25);
});

test("directory and file events in one debounce batch trigger a full scan", {
  skip: process.platform !== "darwin",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-mixed-watch-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const claudeHome = join(root, "claude");
  const projects = join(claudeHome, "projects");
  const existingProject = join(projects, "existing");
  const existingLog = join(existingProject, "session.jsonl");
  await mkdir(existingProject, { recursive: true });
  await writeFile(existingLog, "");

  const monitor = await createTallyburnMonitor({
    windows: ["1h"],
    refreshMs: 250,
    providers: ["claude"],
    claudeHome,
    codexHome: join(root, "codex"),
    stateDirectory: join(root, "state"),
  });
  context.after(async () => monitor.close());
  await monitor.start();
  assert.equal(monitor.collectionMode, "watch");

  const now = Date.now();
  const stagedProject = join(root, "staged");
  await mkdir(stagedProject);
  await writeFile(
    join(stagedProject, "session.jsonl"),
    `${claudeUsageLine(now, "new-directory", 50)}\n`,
  );
  await rename(stagedProject, join(projects, "new-directory"));
  await appendFile(
    existingLog,
    `${claudeUsageLine(now + 1, "existing-append", 1)}\n`,
  );

  await waitFor(() => monitor.snapshot().windows[0]?.all.total === 51);
});

test("snapshot listeners are isolated from mutation and async rejection", async () => {
  const monitor = await createTallyburnMonitor({
    windows: ["1h"],
    demo: true,
  });
  let observed = 0;
  monitor.subscribe((snapshot) => {
    const aggregate = snapshot.windows[0]?.all;
    if (aggregate) {
      aggregate.total = 0;
    }
  }, { emitCurrent: false });
  monitor.subscribe(async () => {
    throw new Error("listener failure");
  }, { emitCurrent: false });
  monitor.subscribe((snapshot) => {
    observed = snapshot.windows[0]?.all.total ?? 0;
  }, { emitCurrent: false });

  const refreshed = await monitor.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observed, refreshed.windows[0]?.all.total);
  assert.ok(observed > 0);
  await monitor.close();
});

test("demo mode never opens live adapters", async () => {
  const monitor = await createTallyburnMonitor({
    windows: ["1h"],
    providers: ["claude"],
    demo: true,
    otelPort: 0,
    otelLogs: true,
  });
  await monitor.start();
  assert.equal(monitor.listeningPort, undefined);
  await monitor.close();
});

test("Qwen OTLP activity flows through the public monitor snapshot", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tallyburn-qwen-otel-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const monitor = await createTallyburnMonitor({
    windows: ["1h"],
    refreshMs: 250,
    providers: ["qwen"],
    codexHome: join(root, "codex"),
    claudeHome: join(root, "claude"),
    stateDirectory: join(root, "state"),
    backfill: false,
    otelPort: 0,
  });
  context.after(async () => monitor.close());
  await monitor.start();
  const port = monitor.listeningPort;
  assert.ok(port);
  const now = Date.now();
  const timeUnixNano = (BigInt(now) * 1_000_000n).toString();
  const metricPoint = (type: string, value: number): unknown => ({
    timeUnixNano,
    asInt: String(value),
    attributes: [
      {
        key: "type",
        value: { stringValue: type },
      },
      {
        key: "model",
        value: { stringValue: "qwen-integration" },
      },
    ],
  });
  const response = await fetch(`http://127.0.0.1:${port}/v1/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "qwen-code.token.usage",
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      metricPoint("input", 30),
                      metricPoint("cache", 10),
                      metricPoint("output", 12),
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  await waitFor(
    () => monitor.snapshot(0, now + 1).windows[0]?.providers.qwen.total === 42,
  );

  const snapshot = monitor.snapshot(0, now + 1);
  assert.equal(snapshot.windows[0]?.all.total, 42);
  assert.equal(snapshot.windows[0]?.providers.qwen.observations, 1);
  assert.equal(snapshot.sources.qwen.available, true);
  assert.equal(snapshot.sources.qwen.lastEventAt, now);
});

test("vLLM Prometheus activity flows through the public monitor snapshot", async (context) => {
  const bodies = [
    [
      'vllm:prompt_tokens_total{model_name="integration"} 100',
      'vllm:generation_tokens_total{model_name="integration"} 20',
    ].join("\n"),
    [
      'vllm:prompt_tokens_total{model_name="integration"} 130',
      'vllm:generation_tokens_total{model_name="integration"} 32',
    ].join("\n"),
  ];
  let requestIndex = 0;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(bodies[Math.min(requestIndex, bodies.length - 1)]);
    requestIndex += 1;
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address() as AddressInfo;
  const root = await mkdtemp(join(tmpdir(), "tallyburn-vllm-metrics-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const monitor = await createTallyburnMonitor({
    windows: ["1h"],
    providers: ["vllm"],
    codexHome: join(root, "codex"),
    claudeHome: join(root, "claude"),
    stateDirectory: join(root, "state"),
    backfill: false,
    vllmMetrics: `http://127.0.0.1:${address.port}/metrics`,
  });
  context.after(async () => monitor.close());

  const now = Date.now();
  const baseline = await monitor.refresh(now);
  assert.equal(baseline.windows[0]?.all.total, 0);
  const snapshot = await monitor.refresh(now + 1);
  assert.equal(snapshot.windows[0]?.all.total, 42);
  assert.equal(snapshot.windows[0]?.providers.vllm.observations, 1);
  assert.equal(snapshot.recentEvents[0]?.model, "integration");
  assert.equal(snapshot.sources.vllm.available, true);
  assert.equal(snapshot.sources.vllm.lastEventAt, now + 1);
});

test("demo mode keeps the live graph moving after seed activity expires", async () => {
  const monitor = await createTallyburnMonitor({
    windows: ["1h"],
    providers: ["codex", "claude"],
    demo: true,
  });
  const later = Date.now() + 65_000;

  const snapshot = await monitor.refresh(later);
  const activity = snapshot.liveActivity;

  assert.ok(activity);
  assert.ok(activity.all.tokensPerSecond > 0);
  assert.equal(
    activity.rateSeries?.all.at(-1)?.tokensPerSecond,
    activity.all.tokensPerSecond,
  );
  assert.ok(
    (activity.series.all.at(-1)?.tokens ?? 0) > 0,
  );
  await monitor.close();
});

test("library options reject non-finite scheduling and invalid windows", async () => {
  await assert.rejects(
    () => createTallyburnMonitor({ refreshMs: Number.NaN }),
    /Refresh interval/,
  );
  for (const durationMs of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    31 * 86_400_000,
  ]) {
    await assert.rejects(
      () =>
        createTallyburnMonitor({
          windows: [{ label: "invalid", durationMs }],
        }),
      /Rolling window durations/,
    );
  }
  await assert.rejects(
    () =>
      createTallyburnMonitor({
        windows: [
          { label: "same", durationMs: 1_000 },
          { label: "same", durationMs: 2_000 },
        ],
      }),
    /must be unique/,
  );
});

function claudeUsageLine(
  timestamp: number,
  id: string,
  outputTokens: number,
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(timestamp).toISOString(),
    message: {
      id,
      model: "fixture",
      usage: {
        output_tokens: outputTokens,
      },
    },
  });
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for monitor state.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
