import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { SnapshotEnvelope } from "../src/serialization.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("stream emits ordered versioned NDJSON and exits on SIGTERM", async () => {
  const child = spawn(
    process.execPath,
    [
      cli,
      "stream",
      "--demo",
      "--refresh",
      "250ms",
      "--offline",
      "--no-backfill",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const lines: string[] = [];
  let stdoutBuffer = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const twoLines = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out waiting for stream snapshots."));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const records = stdoutBuffer.split("\n");
      stdoutBuffer = records.pop() ?? "";
      lines.push(...records.filter(Boolean));
      if (lines.length >= 2) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  await twoLines;
  child.kill("SIGTERM");
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  assert.equal(result.code, 0, stderr);
  assert.equal(result.signal, null);
  const first = JSON.parse(lines[0] ?? "") as SnapshotEnvelope;
  const second = JSON.parse(lines[1] ?? "") as SnapshotEnvelope;
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.type, "snapshot");
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal("recentEvents" in first.snapshot, false);
  assert.equal("root" in first.snapshot.sources.codex, false);
  assert.equal(first.snapshot.liveRate?.trailingWindowMs, 60_000);
  assert.ok((first.snapshot.liveRate?.all.tokensPerMinute ?? 0) > 0);
  assert.equal(
    first.snapshot.liveRate?.all.tokensPerMinute,
    (first.snapshot.liveRate?.providers.codex.tokensPerMinute ?? 0) +
      (first.snapshot.liveRate?.providers.claude.tokensPerMinute ?? 0),
  );
  assert.equal(first.snapshot.recentRateWindowMs, 5 * 60_000);
  assert.equal(first.snapshot.liveActivity?.historyWindowMs, 60_000);
  assert.equal(first.snapshot.liveActivity?.sampleIntervalMs, 1_000);
  assert.equal(first.snapshot.liveActivity?.rateWindowMs, 60_000);
  assert.equal(first.snapshot.liveActivity?.series.all.length, 60);
  assert.equal(first.snapshot.liveActivity?.rateSeries?.all.length, 60);
  const liveSeries = first.snapshot.liveActivity?.series;
  const activityRateSeries = first.snapshot.liveActivity?.rateSeries;
  assert.ok(liveSeries);
  assert.ok(activityRateSeries);
  liveSeries.all.forEach((point, index) => {
    assert.equal(
      point.tokens,
      (liveSeries.codex[index]?.tokens ?? 0) +
      (liveSeries.claude[index]?.tokens ?? 0),
    );
  });
  activityRateSeries.all.forEach((point, index) => {
    assert.equal(
      point.tokensPerSecond,
      (activityRateSeries.codex[index]?.tokensPerSecond ?? 0) +
        (activityRateSeries.claude[index]?.tokensPerSecond ?? 0),
    );
  });
  assert.equal(
    activityRateSeries.all.at(-1)?.tokensPerSecond,
    first.snapshot.liveActivity?.all.tokensPerSecond,
  );
  assert.deepEqual(
    Object.keys(first.snapshot.seriesByWindow ?? {}),
    ["1h", "3h", "12h"],
  );
  for (const window of first.snapshot.windows) {
    const series = first.snapshot.seriesByWindow?.[window.label];
    assert.ok(series);
    assert.equal(sumTokens(series.all), window.all.total);
    assert.equal(sumTokens(series.codex), window.providers.codex.total);
    assert.equal(sumTokens(series.claude), window.providers.claude.total);
  }
});

function sumTokens(points: readonly { tokens: number }[]): number {
  return points.reduce((total, point) => total + point.tokens, 0);
}
