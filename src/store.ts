import {
  LIVE_ACTIVITY_BUCKET_COUNT,
  LIVE_ACTIVITY_HISTORY_WINDOW_MS,
  LIVE_ACTIVITY_RATE_WINDOW_MS,
  LIVE_ACTIVITY_SAMPLE_INTERVAL_MS,
  LIVE_RATE_WINDOW_MS,
  PROVIDERS,
  RECENT_RATE_WINDOW_MS,
  addUsage,
  emptyAggregate,
  providerRecord,
  type ActivityRatePoint,
  type BucketPoint,
  type LiveTokenRate,
  type LiveTokenActivity,
  type Provider,
  type ProviderAggregate,
  type QuotaSnapshot,
  type QuotaWindow,
  type SourceStatus,
  type TokenRateAggregate,
  type TokenActivityAggregate,
  type UsageEvent,
  type UsageSnapshot,
  type WindowAggregate,
} from "./model.js";
import type { NamedDuration } from "./duration.js";

export type UsageSeries = Record<Provider | "all", BucketPoint[]>;
export type ActivityRateSeries = Record<
  Provider | "all",
  ActivityRatePoint[]
>;

export interface UsageSnapshotBatch {
  snapshot: UsageSnapshot;
  seriesByWindow: Record<string, UsageSeries>;
}

const seriesBySnapshot = new WeakMap<
  UsageSnapshot,
  Record<string, UsageSeries>
>();

export function seriesByWindowForSnapshot(
  snapshot: UsageSnapshot,
): Record<string, UsageSeries> | undefined {
  return seriesBySnapshot.get(snapshot);
}

export function cloneUsageSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
  const seriesByWindow = seriesBySnapshot.get(snapshot);
  if (!seriesByWindow) {
    return structuredClone(snapshot);
  }
  const cloned = structuredClone({ snapshot, seriesByWindow });
  seriesBySnapshot.set(cloned.snapshot, cloned.seriesByWindow);
  return cloned.snapshot;
}

export interface QuotaFreshnessPolicy {
  usageLagMs?: number;
  maxAgeMs?: number;
}

type QuotaWindowKey = "primary" | "secondary";

interface ResolvedQuotaFreshnessPolicy {
  usageLagMs: number;
  maxAgeMs?: number;
}

export class UsageStore {
  readonly #events = new Map<string, UsageEvent>();
  readonly #quotas = new Map<Provider, QuotaSnapshot>();
  readonly #quotaWindowObservedAt = new Map<
    Provider,
    Partial<Record<QuotaWindowKey, number>>
  >();
  readonly #quotaWindowFreshness = new Map<
    Provider,
    Partial<Record<QuotaWindowKey, ResolvedQuotaFreshnessPolicy>>
  >();

  upsertEvent(event: UsageEvent): void {
    this.#events.set(event.id, event);
  }

  updateQuota(
    quota: QuotaSnapshot,
    freshness: QuotaFreshnessPolicy = {},
  ): void {
    const resolvedFreshness = resolveQuotaFreshness(freshness);
    const current = this.#quotas.get(quota.provider);
    if (!current) {
      this.#quotas.set(quota.provider, quota);
      this.#quotaWindowObservedAt.set(quota.provider, {
        ...(quota.primary ? { primary: quota.timestamp } : {}),
        ...(quota.secondary ? { secondary: quota.timestamp } : {}),
      });
      this.#quotaWindowFreshness.set(quota.provider, {
        ...(quota.primary ? { primary: resolvedFreshness } : {}),
        ...(quota.secondary ? { secondary: resolvedFreshness } : {}),
      });
      return;
    }

    const observedAt = this.#quotaWindowObservedAt.get(quota.provider) ?? {};
    const currentFreshness =
      this.#quotaWindowFreshness.get(quota.provider) ?? {};
    const next: QuotaSnapshot = {
      provider: quota.provider,
      timestamp: Math.max(current.timestamp, quota.timestamp),
      ...(current.planType ? { planType: current.planType } : {}),
      ...(current.primary ? { primary: { ...current.primary } } : {}),
      ...(current.secondary ? { secondary: { ...current.secondary } } : {}),
    };
    const nextObservedAt = { ...observedAt };
    const nextFreshness = { ...currentFreshness };
    let changed = false;

    for (const key of ["primary", "secondary"] as const) {
      const incoming = quota[key];
      const currentWindowTimestamp =
        observedAt[key] ??
        (current[key] ? current.timestamp : Number.NEGATIVE_INFINITY);
      if (incoming && currentWindowTimestamp <= quota.timestamp) {
        next[key] = { ...incoming };
        nextObservedAt[key] = quota.timestamp;
        nextFreshness[key] = resolvedFreshness;
        changed = true;
      } else if (
        !incoming &&
        current[key] &&
        currentWindowTimestamp <= quota.timestamp
      ) {
        delete next[key];
        delete nextObservedAt[key];
        delete nextFreshness[key];
        changed = true;
      }
    }
    if (quota.planType && current.timestamp <= quota.timestamp) {
      next.planType = quota.planType;
      changed = true;
    }
    if (changed) {
      this.#quotas.set(quota.provider, next);
      this.#quotaWindowObservedAt.set(quota.provider, nextObservedAt);
      this.#quotaWindowFreshness.set(quota.provider, nextFreshness);
    }
  }

  updateQuotaWindow(
    provider: Provider,
    key: "primary" | "secondary",
    window: QuotaWindow,
    timestamp: number,
  ): void {
    const current = this.#quotas.get(provider);
    const observedAt = this.#quotaWindowObservedAt.get(provider) ?? {};
    const currentWindowTimestamp =
      observedAt[key] ?? current?.timestamp ?? Number.NEGATIVE_INFINITY;
    if (currentWindowTimestamp > timestamp) {
      return;
    }

    const next: QuotaSnapshot = {
      provider,
      timestamp: Math.max(current?.timestamp ?? timestamp, timestamp),
      ...(current?.planType ? { planType: current.planType } : {}),
      ...(current?.primary ? { primary: { ...current.primary } } : {}),
      ...(current?.secondary ? { secondary: { ...current.secondary } } : {}),
    };
    next[key] = { ...window };
    this.#quotas.set(provider, next);
    this.#quotaWindowObservedAt.set(provider, {
      ...observedAt,
      [key]: timestamp,
    });
    this.#quotaWindowFreshness.set(provider, {
      ...(this.#quotaWindowFreshness.get(provider) ?? {}),
      [key]: { usageLagMs: 0 },
    });
  }

  prune(before: number): void {
    for (const [id, event] of this.#events) {
      if (event.timestamp < before) {
        this.#events.delete(id);
      }
    }
  }

  snapshot(
    windows: readonly NamedDuration[],
    focusIndex: number,
    sources: Readonly<Record<Provider, SourceStatus>>,
    now = Date.now(),
    bucketCount = 28,
  ): UsageSnapshot {
    return this.snapshotWithSeries(
      windows,
      focusIndex,
      sources,
      now,
      bucketCount,
    ).snapshot;
  }

  snapshotWithSeries(
    windows: readonly NamedDuration[],
    focusIndex: number,
    sources: Readonly<Record<Provider, SourceStatus>>,
    now = Date.now(),
    bucketCount = 28,
  ): UsageSnapshotBatch {
    const safeFocusIndex = Math.max(0, Math.min(focusIndex, windows.length - 1));
    const focus =
      windows[safeFocusIndex] ??
      ({ label: "1h", durationMs: 3_600_000 } satisfies NamedDuration);
    const events = [...this.#events.values()];
    const aggregates = windows.map(emptyWindowAggregate);
    const seriesWindows = windows.length > 0 ? windows : [focus];
    const seriesForWindows = seriesWindows.map((window) =>
      emptySeries(window.durationMs, now, bucketCount),
    );
    const paceDurationMs = RECENT_RATE_WINDOW_MS;
    const paceCutoff = now - paceDurationMs;
    const liveRate = emptyLiveRate(LIVE_RATE_WINDOW_MS);
    const liveRateCutoff = now - liveRate.trailingWindowMs;
    const liveActivity = emptyLiveActivity(
      LIVE_ACTIVITY_HISTORY_WINDOW_MS,
      LIVE_ACTIVITY_SAMPLE_INTERVAL_MS,
      LIVE_ACTIVITY_RATE_WINDOW_MS,
      now,
    );
    const liveActivityCutoff =
      liveActivity.series.all[0]?.start
      ?? now - liveActivity.historyWindowMs;
    const liveActivityRateSeriesCutoff =
      (liveActivity.rateSeries?.all[0]?.at ?? now)
      - liveActivity.rateWindowMs;
    const activityRateCutoff = now - liveActivity.rateWindowMs;
    const recentCutoff = now - focus.durationMs;
    let recentTokens = 0;
    const recentEvents: UsageEvent[] = [];

    for (const event of events) {
      if (event.timestamp > now) {
        continue;
      }
      if (event.timestamp >= paceCutoff) {
        recentTokens += event.total;
      }
      if (event.timestamp >= liveRateCutoff) {
        addRateEvent(liveRate.providers[event.provider], event);
        addRateEvent(liveRate.all, event);
      }
      if (event.timestamp >= liveActivityCutoff) {
        addEventToSeries(
          liveActivity.series,
          event,
          liveActivity.sampleIntervalMs,
        );
      }
      if (event.timestamp >= liveActivityRateSeriesCutoff) {
        addEventToActivityRateSeries(
          liveActivity.rateSeries,
          event,
          liveActivity.rateWindowMs,
          liveActivity.sampleIntervalMs,
        );
      }
      if (event.timestamp >= activityRateCutoff) {
        addActivityEvent(liveActivity.providers[event.provider], event);
        addActivityEvent(liveActivity.all, event);
      }
      if (event.timestamp >= recentCutoff) {
        recentEvents.push(event);
      }

      for (let index = 0; index < seriesWindows.length; index += 1) {
        const window = seriesWindows[index];
        const windowSeries = seriesForWindows[index];
        if (
          !window ||
          !windowSeries ||
          event.timestamp < now - window.durationMs
        ) {
          continue;
        }
        const aggregate = aggregates[index];
        if (aggregate) {
          addEvent(aggregate.providers[event.provider], event);
          addEvent(aggregate.all, event);
        }
        addEventToSeries(
          windowSeries,
          event,
          window.durationMs,
          now,
        );
      }
    }

    const recentTokensPerMinute = Math.round(
      recentTokens / (paceDurationMs / 60_000),
    );
    finalizeLiveRate(liveRate);
    finalizeLiveActivity(liveActivity);

    const publicRecentEvents = recentEvents
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, 6)
      .map((event) => ({ ...event }));

    const quotas: Partial<Record<Provider, QuotaSnapshot>> = {};
    for (const provider of PROVIDERS) {
      const quota = this.#quotas.get(provider);
      const fresh = quota
        ? freshQuotaSnapshot(
          quota,
          now,
          this.#quotaWindowObservedAt.get(provider),
          this.#quotaWindowFreshness.get(provider),
          provider === "claude"
            ? sources.claude.lastEventAt
            : undefined,
        )
        : undefined;
      if (fresh) {
        quotas[provider] = fresh;
      }
    }

    const seriesByWindow: Record<string, UsageSeries> = {};
    windows.forEach((window, index) => {
      const windowSeries = seriesForWindows[index];
      if (windowSeries) {
        seriesByWindow[window.label] = windowSeries;
      }
    });
    const focusSeries =
      seriesForWindows[windows.length > 0 ? safeFocusIndex : 0] ??
      emptySeries(focus.durationMs, now, bucketCount);
    const snapshot: UsageSnapshot = {
      generatedAt: now,
      windows: aggregates,
      focusWindow: focus.label,
      recentTokensPerMinute,
      recentRateWindowMs: paceDurationMs,
      liveRate,
      liveActivity,
      series: focusSeries,
      recentEvents: publicRecentEvents,
      quotas,
      sources: providerRecord((provider) => ({ ...sources[provider] })),
    };
    seriesBySnapshot.set(snapshot, seriesByWindow);
    return { snapshot, seriesByWindow };
  }
}

function emptyLiveRate(trailingWindowMs: number): LiveTokenRate {
  return {
    trailingWindowMs,
    all: emptyRateAggregate("all"),
    providers: providerRecord(emptyRateAggregate),
  };
}

function emptyLiveActivity(
  historyWindowMs: number,
  sampleIntervalMs: number,
  rateWindowMs: number,
  now: number,
): LiveTokenActivity {
  return {
    historyWindowMs,
    sampleIntervalMs,
    rateWindowMs,
    all: emptyActivityAggregate("all"),
    providers: providerRecord(emptyActivityAggregate),
    series: emptySeries(
      historyWindowMs,
      now,
      LIVE_ACTIVITY_BUCKET_COUNT,
      sampleIntervalMs,
    ),
    rateSeries: emptyActivityRateSeries(
      now,
      historyWindowMs,
      sampleIntervalMs,
    ),
  };
}

function emptyActivityRateSeries(
  now: number,
  historyWindowMs: number,
  sampleIntervalMs: number,
): ActivityRateSeries {
  const count = Math.max(
    1,
    Math.floor(historyWindowMs / sampleIntervalMs),
  );
  const firstSampleAt = now - (count - 1) * sampleIntervalMs;
  const points = (): ActivityRatePoint[] =>
    Array.from({ length: count }, (_, index) => ({
      at: firstSampleAt + index * sampleIntervalMs,
      tokensPerSecond: 0,
    }));
  return {
    all: points(),
    ...providerRecord(() => points()),
  };
}

function emptyRateAggregate(
  provider: Provider | "all",
): TokenRateAggregate {
  return {
    provider,
    observedTokens: 0,
    tokensPerMinute: 0,
    observations: 0,
  };
}

function emptyActivityAggregate(
  provider: Provider | "all",
): TokenActivityAggregate {
  return {
    provider,
    observedTokens: 0,
    tokensPerSecond: 0,
    observations: 0,
  };
}

function addRateEvent(
  target: TokenRateAggregate,
  event: UsageEvent,
): void {
  target.observedTokens += event.total;
  target.observations += 1;
  if (target.lastEventAt === undefined || target.lastEventAt < event.timestamp) {
    target.lastEventAt = event.timestamp;
  }
}

function finalizeLiveRate(rate: LiveTokenRate): void {
  for (const aggregate of [
    rate.all,
    ...PROVIDERS.map((provider) => rate.providers[provider]),
  ]) {
    aggregate.tokensPerMinute = Math.round(
      aggregate.observedTokens * 60_000 / rate.trailingWindowMs,
    );
  }
}

function addActivityEvent(
  target: TokenActivityAggregate,
  event: UsageEvent,
): void {
  target.observedTokens += event.total;
  target.observations += 1;
  if (target.lastEventAt === undefined || target.lastEventAt < event.timestamp) {
    target.lastEventAt = event.timestamp;
  }
}

function addEventToActivityRateSeries(
  series: ActivityRateSeries | undefined,
  event: UsageEvent,
  rateWindowMs: number,
  sampleIntervalMs: number,
): void {
  const allPoints = series?.all;
  if (!series || !allPoints || allPoints.length === 0) {
    return;
  }
  const firstSampleAt = allPoints[0]?.at ?? event.timestamp;
  const firstIndex = Math.max(
    0,
    Math.ceil((event.timestamp - firstSampleAt) / sampleIntervalMs),
  );
  const lastIndex = Math.min(
    allPoints.length - 1,
    Math.floor(
      (event.timestamp + rateWindowMs - firstSampleAt) / sampleIntervalMs,
    ),
  );
  const tokensPerSecond = event.total / (rateWindowMs / 1_000);
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const allPoint = series.all[index];
    const providerPoint = series[event.provider][index];
    if (allPoint) {
      allPoint.tokensPerSecond += tokensPerSecond;
    }
    if (providerPoint) {
      providerPoint.tokensPerSecond += tokensPerSecond;
    }
  }
}

function finalizeLiveActivity(activity: LiveTokenActivity): void {
  for (const aggregate of [
    activity.all,
    ...PROVIDERS.map((provider) => activity.providers[provider]),
  ]) {
    aggregate.tokensPerSecond =
      aggregate.observedTokens / (activity.rateWindowMs / 1_000);
  }
}

function freshQuotaSnapshot(
  quota: QuotaSnapshot,
  now: number,
  observedAt: Partial<Record<QuotaWindowKey, number>> = {},
  freshness: Partial<
    Record<QuotaWindowKey, ResolvedQuotaFreshnessPolicy>
  > = {},
  latestUsageAt?: number,
): QuotaSnapshot | undefined {
  const isFresh = (
    key: QuotaWindowKey,
    window: NonNullable<QuotaSnapshot["primary"]>,
  ): boolean => {
    const observed = observedAt[key] ?? quota.timestamp;
    const policy = freshness[key];
    const usageLagMs = policy?.usageLagMs ?? 0;
    const freshUntil = policy?.maxAgeMs === undefined
      ? Number.POSITIVE_INFINITY
      : observed + policy.maxAgeMs;
    const expiresAt = window.resetsAt ?? observed + window.windowMs;
    return observed <= now
      && freshUntil > now
      && expiresAt > now
      && (
        latestUsageAt === undefined ||
        latestUsageAt <= observed + usageLagMs
      );
  };
  const primary = quota.primary && isFresh("primary", quota.primary)
    ? quota.primary
    : undefined;
  const secondary = quota.secondary && isFresh("secondary", quota.secondary)
    ? quota.secondary
    : undefined;
  if (!primary && !secondary) {
    return undefined;
  }
  return {
    provider: quota.provider,
    timestamp: quota.timestamp,
    ...(quota.planType ? { planType: quota.planType } : {}),
    ...(primary ? { primary: { ...primary } } : {}),
    ...(secondary ? { secondary: { ...secondary } } : {}),
  };
}

function resolveQuotaFreshness(
  policy: QuotaFreshnessPolicy,
): ResolvedQuotaFreshnessPolicy {
  const usageLagMs = policy.usageLagMs ?? 0;
  if (!Number.isSafeInteger(usageLagMs) || usageLagMs < 0) {
    throw new TypeError("usageLagMs must be a non-negative integer");
  }
  const maxAgeMs = policy.maxAgeMs;
  if (
    maxAgeMs !== undefined &&
    (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0)
  ) {
    throw new TypeError("maxAgeMs must be a positive integer");
  }
  return {
    usageLagMs,
    ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
  };
}

function emptyWindowAggregate(
  window: NamedDuration,
): WindowAggregate {
  return {
    label: window.label,
    durationMs: window.durationMs,
    all: emptyAggregate("all"),
    providers: providerRecord(emptyAggregate),
  };
}

function addEvent(target: ProviderAggregate, event: UsageEvent): void {
  addUsage(target, event);
  target.observations += 1;
  if (target.lastEventAt === undefined || target.lastEventAt < event.timestamp) {
    target.lastEventAt = event.timestamp;
  }
}

function emptySeries(
  durationMs: number,
  now: number,
  bucketCount: number,
  alignedBucketMs?: number,
): UsageSeries {
  const count = Math.max(1, bucketCount);
  const bucketMs = durationMs / count;
  const start = alignedBucketMs === undefined
    ? now - durationMs
    : Math.floor(now / alignedBucketMs) * alignedBucketMs
      - (count - 1) * alignedBucketMs;
  const points = (): BucketPoint[] =>
    Array.from({ length: count }, (_, index) => ({
      start: start + index * bucketMs,
      tokens: 0,
    }));
  return {
    all: points(),
    ...providerRecord(() => points()),
  };
}

function addEventToSeries(
  series: UsageSeries,
  event: UsageEvent,
  durationOrBucketMs: number,
  now?: number,
): void {
  const points = series.all;
  const bucketMs = now === undefined
    ? durationOrBucketMs
    : durationOrBucketMs / points.length;
  const start = now === undefined
    ? points[0]?.start ?? event.timestamp
    : now - durationOrBucketMs;
  const index = Math.min(
    points.length - 1,
    Math.max(0, Math.floor((event.timestamp - start) / bucketMs)),
  );
  const allPoint = series.all[index];
  const providerPoint = series[event.provider][index];
  if (allPoint) {
    allPoint.tokens += event.total;
  }
  if (providerPoint) {
    providerPoint.tokens += event.total;
  }
}
