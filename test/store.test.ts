import assert from "node:assert/strict";
import test from "node:test";
import {
  providerRecord,
  type Provider,
  type SourceStatus,
  type UsageEvent,
} from "../src/model.js";
import { snapshotEnvelope } from "../src/serialization.js";
import { cloneUsageSnapshot, UsageStore } from "../src/store.js";

test("recent pace uses the exact trailing five-minute interval", () => {
  const now = Date.parse("2026-07-28T08:00:00.000Z");
  const store = new UsageStore();
  store.upsertEvent(event("old", now - 20 * 60_000, 1_000));

  let snapshot = store.snapshot(
    [{ label: "12h", durationMs: 12 * 3_600_000 }],
    0,
    sources(),
    now,
  );
  assert.equal(snapshot.recentTokensPerMinute, 0);

  store.upsertEvent(event("recent", now - 2 * 60_000, 600));
  store.upsertEvent(event("future", now + 60_000, 99_000));
  snapshot = store.snapshot(
    [{ label: "12h", durationMs: 12 * 3_600_000 }],
    0,
    sources(),
    now,
  );
  assert.equal(snapshot.recentTokensPerMinute, 120);
  assert.equal(
    snapshot.recentEvents.some((observation) => observation.id === "future"),
    false,
  );
  assert.equal(snapshot.windows[0]?.all.total, 1_600);
});

test("observed pace uses an exact trailing one-minute counter rate", () => {
  const now = Date.parse("2026-07-28T08:00:00.000Z");
  const store = new UsageStore();
  store.upsertEvent(event("outside-live", now - 60_001, 10_000));
  store.upsertEvent(event("at-cutoff", now - 60_000, 600));
  store.upsertEvent(event("claude-live", now - 30_000, 300, "claude"));
  store.upsertEvent(event("at-now", now, 100));
  store.upsertEvent(event("future", now + 1, 99_000));

  const windows = [
    { label: "1h", durationMs: 3_600_000 },
    { label: "12h", durationMs: 12 * 3_600_000 },
  ];
  const first = store.snapshot(windows, 0, sources(), now);
  const second = store.snapshot(windows, 1, sources(), now);
  const rate = first.liveRate;

  assert.ok(rate);
  assert.equal(rate.trailingWindowMs, 60_000);
  assert.deepEqual(
    {
      observedTokens: rate.all.observedTokens,
      tokensPerMinute: rate.all.tokensPerMinute,
      observations: rate.all.observations,
      lastEventAt: rate.all.lastEventAt,
      codex: rate.providers.codex.tokensPerMinute,
      claude: rate.providers.claude.tokensPerMinute,
    },
    {
      observedTokens: 1_000,
      tokensPerMinute: 1_000,
      observations: 3,
      lastEventAt: now,
      codex: 700,
      claude: 300,
    },
  );
  assert.deepEqual(second.liveRate, rate);
  assert.equal(first.recentRateWindowMs, 5 * 60_000);
  assert.equal(first.recentTokensPerMinute, 2_200);

  const idle = store.snapshot(windows, 0, sources(), now + 60_002);
  assert.equal(idle.liveRate?.all.tokensPerMinute, 0);
  assert.equal(idle.liveRate?.all.observations, 0);
});

test("live activity uses one-second buckets and an exact one-minute rate", () => {
  const now = Date.parse("2026-07-28T08:00:00.000Z");
  const store = new UsageStore();
  store.upsertEvent(event("outside-history", now - 60_001, 10_000));
  store.upsertEvent(event("history-only", now - 30_000, 300));
  store.upsertEvent(event("outside-rate", now - 5_001, 200));
  store.upsertEvent(event("at-rate-cutoff", now - 5_000, 400, "claude"));
  store.upsertEvent(event("at-now", now, 101));
  store.upsertEvent(event("future", now + 1, 99_000));

  const snapshot = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    sources(),
    now,
  );
  const activity = snapshot.liveActivity;

  assert.ok(activity);
  assert.equal(activity.historyWindowMs, 60_000);
  assert.equal(activity.sampleIntervalMs, 1_000);
  assert.equal(activity.rateWindowMs, 60_000);
  assert.equal(activity.series.all.length, 60);
  assert.equal(activity.series.codex.length, 60);
  assert.equal(activity.series.claude.length, 60);
  assert.equal(activity.rateSeries?.all.length, 60);
  assert.equal(activity.rateSeries?.codex.length, 60);
  assert.equal(activity.rateSeries?.claude.length, 60);
  assert.equal(sumSeries(activity.series.all), 1_001);
  assert.equal(sumSeries(activity.series.codex), 601);
  assert.equal(sumSeries(activity.series.claude), 400);
  assert.deepEqual(
    {
      observedTokens: activity.all.observedTokens,
      tokensPerSecond: activity.all.tokensPerSecond,
      observations: activity.all.observations,
      lastEventAt: activity.all.lastEventAt,
      codex: activity.providers.codex.tokensPerSecond,
      claude: activity.providers.claude.tokensPerSecond,
    },
    {
      observedTokens: 1_001,
      tokensPerSecond: 1_001 / 60,
      observations: 4,
      lastEventAt: now,
      codex: 601 / 60,
      claude: 400 / 60,
    },
  );
  const firstPoint = activity.series.all[0];
  const secondPoint = activity.series.all[1];
  assert.ok(firstPoint);
  assert.ok(secondPoint);
  assert.equal(secondPoint.start - firstPoint.start, 1_000);
  activity.series.all.forEach((point, index) => {
    assert.equal(
      point.tokens,
      (activity.series.codex[index]?.tokens ?? 0) +
        (activity.series.claude[index]?.tokens ?? 0),
    );
  });
  const allRateSeries = activity.rateSeries?.all;
  const codexRateSeries = activity.rateSeries?.codex;
  const claudeRateSeries = activity.rateSeries?.claude;
  assert.ok(allRateSeries);
  assert.ok(codexRateSeries);
  assert.ok(claudeRateSeries);
  assert.equal(allRateSeries[0]?.at, now - 59_000);
  assert.equal(allRateSeries.at(-1)?.at, now);
  assert.equal(
    allRateSeries.at(-1)?.tokensPerSecond,
    activity.all.tokensPerSecond,
  );
  allRateSeries.forEach((point, index) => {
    assert.equal(
      point.tokensPerSecond,
      (codexRateSeries[index]?.tokensPerSecond ?? 0) +
        (claudeRateSeries[index]?.tokensPerSecond ?? 0),
    );
  });

  const sameSecond = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    sources(),
    now + 200,
  ).liveActivity;
  assert.deepEqual(
    sameSecond?.series.all.map((point) => point.start),
    activity.series.all.map((point) => point.start),
  );
  assert.equal(
    sameSecond?.rateSeries?.all.at(-1)?.at,
    now + 200,
  );
  assert.equal(
    sameSecond?.rateSeries?.all.at(-1)?.tokensPerSecond,
    sameSecond?.all.tokensPerSecond,
  );

  const nextSecond = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    sources(),
    now + 1_000,
  ).liveActivity;
  assert.equal(
    nextSecond?.series.all[0]?.start,
    activity.series.all[0]!.start + 1_000,
  );

  const idle = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    sources(),
    now + 60_002,
  ).liveActivity;
  assert.equal(idle?.all.tokensPerSecond, 0);
  assert.equal(sumSeries(idle?.series.all), 0);
  assert.equal(idle?.rateSeries?.all.at(-1)?.tokensPerSecond, 0);
});

test("quota windows disappear after their reset or observation lifetime", () => {
  const now = Date.parse("2026-07-28T08:00:00.000Z");
  const store = new UsageStore();
  store.updateQuota({
    provider: "claude",
    timestamp: now - 6 * 3_600_000,
    primary: {
      usedPercent: 40,
      windowMs: 5 * 3_600_000,
    },
    secondary: {
      usedPercent: 50,
      windowMs: 7 * 86_400_000,
      resetsAt: now + 3_600_000,
    },
  });

  const snapshot = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    sources(),
    now,
  );
  assert.equal(snapshot.quotas.claude?.primary, undefined);
  assert.equal(snapshot.quotas.claude?.secondary?.usedPercent, 50);
});

test("a structured limit hit updates one window without reviving stale values", () => {
  const observed = Date.parse("2026-07-28T08:00:00.000Z");
  const usedAfterObservation = observed + 60_000;
  const limitHit = observed + 2 * 60_000;
  const reset = observed + 3 * 60_000;
  const store = new UsageStore();
  store.updateQuota({
    provider: "claude",
    timestamp: observed,
    primary: {
      usedPercent: 68,
      windowMs: 5 * 3_600_000,
      resetsAt: reset,
    },
    secondary: {
      usedPercent: 5,
      windowMs: 7 * 86_400_000,
      resetsAt: observed + 5 * 86_400_000,
    },
  });
  store.updateQuotaWindow(
    "claude",
    "primary",
    {
      usedPercent: 100,
      windowMs: 5 * 3_600_000,
      resetsAt: reset,
    },
    limitHit,
  );
  const sourceState = sources();
  sourceState.claude.lastEventAt = usedAfterObservation;

  const beforeReset = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    sourceState,
    limitHit,
  );
  assert.equal(beforeReset.quotas.claude?.primary?.usedPercent, 100);
  assert.equal(beforeReset.quotas.claude?.secondary, undefined);

  const afterReset = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    sourceState,
    reset,
  );
  assert.equal(afterReset.quotas.claude, undefined);
});

test("an older full snapshot can refresh a different quota window", () => {
  const official = Date.parse("2026-07-28T08:00:00.000Z");
  const limitHit = official + 2 * 60_000;
  const store = new UsageStore();
  store.updateQuotaWindow(
    "claude",
    "primary",
    {
      usedPercent: 100,
      windowMs: 5 * 3_600_000,
      resetsAt: limitHit + 60_000,
    },
    limitHit,
  );
  store.updateQuota({
    provider: "claude",
    timestamp: official,
    primary: {
      usedPercent: 68,
      windowMs: 5 * 3_600_000,
      resetsAt: limitHit + 60_000,
    },
    secondary: {
      usedPercent: 5,
      windowMs: 7 * 86_400_000,
      resetsAt: official + 5 * 86_400_000,
    },
  });

  const snapshot = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    sources(),
    limitHit,
  );
  assert.equal(snapshot.quotas.claude?.primary?.usedPercent, 100);
  assert.equal(snapshot.quotas.claude?.secondary?.usedPercent, 5);
});

test("Claude quota values disappear after unobserved subsequent usage", () => {
  const observed = Date.parse("2026-07-28T08:00:00.000Z");
  const store = new UsageStore();
  store.updateQuota({
    provider: "claude",
    timestamp: observed,
    primary: {
      usedPercent: 20,
      windowMs: 5 * 3_600_000,
      resetsAt: observed + 4 * 3_600_000,
    },
    secondary: {
      usedPercent: 30,
      windowMs: 7 * 86_400_000,
      resetsAt: observed + 6 * 86_400_000,
    },
  });
  const sourceState = sources();
  sourceState.claude.lastEventAt = observed + 1;

  const snapshot = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    sourceState,
    observed + 2,
  );
  assert.equal(snapshot.quotas.claude, undefined);
});

test("bounded cache freshness tolerates short usage lag and then expires", () => {
  const observed = Date.parse("2026-07-28T08:00:00.000Z");
  const fiveMinutes = 5 * 60_000;
  const tenMinutes = 10 * 60_000;
  const store = new UsageStore();
  store.updateQuota(
    {
      provider: "claude",
      timestamp: observed,
      primary: {
        usedPercent: 40,
        windowMs: 5 * 3_600_000,
        resetsAt: observed + 4 * 3_600_000,
      },
    },
    {
      usageLagMs: fiveMinutes,
      maxAgeMs: tenMinutes,
    },
  );
  const sourceState = sources();
  sourceState.claude.lastEventAt = observed + fiveMinutes;

  const withinLag = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    sourceState,
    observed + fiveMinutes,
  );
  assert.equal(
    withinLag.quotas.claude?.primary?.usedPercent,
    40,
  );

  sourceState.claude.lastEventAt = observed + fiveMinutes + 1;
  const afterLag = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    sourceState,
    observed + fiveMinutes + 1,
  );
  assert.equal(afterLag.quotas.claude, undefined);

  delete sourceState.claude.lastEventAt;
  const afterMaxAge = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    sourceState,
    observed + tenMinutes,
  );
  assert.equal(afterMaxAge.quotas.claude, undefined);
});

test("one snapshot batch produces accurate series for every window", () => {
  const now = Date.parse("2026-07-28T08:00:00.000Z");
  const windows = [
    { label: "1h", durationMs: 3_600_000 },
    { label: "3h", durationMs: 3 * 3_600_000 },
    { label: "12h", durationMs: 12 * 3_600_000 },
  ];
  const store = new CountingUsageStore();
  store.upsertEvent(event("codex-recent", now - 30 * 60_000, 100));
  store.upsertEvent(
    event("claude-medium", now - 2 * 3_600_000, 200, "claude"),
  );
  store.upsertEvent(event("codex-old", now - 10 * 3_600_000, 300));
  store.upsertEvent(event("future", now + 1, 10_000));
  store.upsertEvent(event("expired", now - 13 * 3_600_000, 10_000));

  const snapshot = store.snapshot(windows, 1, sources(), now, 4);
  const clonedSnapshot = cloneUsageSnapshot(snapshot);
  const envelope = snapshotEnvelope(clonedSnapshot, 1);
  const seriesByWindow = envelope.snapshot.seriesByWindow;

  assert.ok(seriesByWindow);
  assert.equal(store.batchCalls, 1);
  assert.strictEqual(clonedSnapshot.series, seriesByWindow["3h"]);
  assert.notStrictEqual(clonedSnapshot.series, snapshot.series);
  assert.deepEqual(
    Object.fromEntries(
      windows.map((window) => [
        window.label,
        {
          all: sumSeries(seriesByWindow[window.label]?.all),
          codex: sumSeries(seriesByWindow[window.label]?.codex),
          claude: sumSeries(seriesByWindow[window.label]?.claude),
        },
      ]),
    ),
    {
      "1h": { all: 100, codex: 100, claude: 0 },
      "3h": { all: 300, codex: 100, claude: 200 },
      "12h": { all: 600, codex: 400, claude: 200 },
    },
  );
  assert.equal(seriesByWindow["12h"]?.all.length, 4);
});

class CountingUsageStore extends UsageStore {
  batchCalls = 0;

  override snapshotWithSeries(
    ...args: Parameters<UsageStore["snapshotWithSeries"]>
  ): ReturnType<UsageStore["snapshotWithSeries"]> {
    this.batchCalls += 1;
    return super.snapshotWithSeries(...args);
  }
}

function event(
  id: string,
  timestamp: number,
  total: number,
  provider: Provider = "codex",
): UsageEvent {
  return {
    id,
    provider,
    timestamp,
    freshInput: total,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total,
  };
}

function sumSeries(
  points: readonly { tokens: number }[] | undefined,
): number {
  return points?.reduce((total, point) => total + point.tokens, 0) ?? 0;
}

function sources(): Record<Provider, SourceStatus> {
  return providerRecord(status);
}

function status(provider: Provider): SourceStatus {
  return {
    provider,
    root: "fixture",
    available: true,
    filesSeen: 0,
    filesRead: 0,
    malformedLines: 0,
  };
}
