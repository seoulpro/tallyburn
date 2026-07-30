import { displayPath } from "./display.js";
import type {
  BucketPoint,
  LiveTokenActivity,
  LiveTokenRate,
  Provider,
  ProviderAccountStatus,
  QuotaSnapshot,
  SourceStatus,
  UsageSnapshot,
  WindowAggregate,
} from "./model.js";
import { providerRecord } from "./model.js";
import { seriesByWindowForSnapshot } from "./store.js";

export interface PublicSourceStatus {
  provider: Provider;
  available: boolean;
  filesSeen: number;
  filesRead: number;
  malformedLines: number;
  lastEventAt?: number;
}

export interface PublicUsageSnapshot {
  generatedAt: number;
  windows: WindowAggregate[];
  focusWindow: string;
  recentTokensPerMinute: number;
  recentRateWindowMs?: number;
  liveRate?: LiveTokenRate;
  liveActivity?: LiveTokenActivity;
  series: Record<Provider | "all", BucketPoint[]>;
  seriesByWindow?: Record<
    string,
    Record<Provider | "all", BucketPoint[]>
  >;
  quotas: Partial<Record<Provider, QuotaSnapshot>>;
  accounts?: Partial<Record<Provider, ProviderAccountStatus>>;
  sources: Record<Provider, PublicSourceStatus>;
}

export interface SnapshotEnvelope {
  schemaVersion: 1;
  type: "snapshot";
  sequence: number;
  snapshot: PublicUsageSnapshot;
}

export function snapshotForJson(snapshot: UsageSnapshot): UsageSnapshot {
  return {
    ...snapshot,
    sources: Object.fromEntries(
      Object.entries(snapshot.sources).map(([provider, source]) => [
        provider,
        {
          ...source,
          root: displayPath(source.root),
        },
      ]),
    ) as Record<Provider, SourceStatus>,
  };
}

export function snapshotEnvelope(
  snapshot: UsageSnapshot,
  sequence: number,
  seriesByWindow?: Record<
    string,
    Record<Provider | "all", BucketPoint[]>
  >,
): SnapshotEnvelope {
  const publicSnapshot = snapshotForPublicIpc(snapshot, seriesByWindow);
  return {
    schemaVersion: 1,
    type: "snapshot",
    sequence,
    snapshot: publicSnapshot,
  };
}

export function snapshotForPublicIpc(
  snapshot: UsageSnapshot,
  seriesByWindow?: Record<
    string,
    Record<Provider | "all", BucketPoint[]>
  >,
): PublicUsageSnapshot {
  const effectiveSeriesByWindow =
    seriesByWindow ?? seriesByWindowForSnapshot(snapshot);
  return {
    generatedAt: snapshot.generatedAt,
    windows: snapshot.windows,
    focusWindow: snapshot.focusWindow,
    recentTokensPerMinute: snapshot.recentTokensPerMinute,
    ...(snapshot.recentRateWindowMs !== undefined
      ? { recentRateWindowMs: snapshot.recentRateWindowMs }
      : {}),
    ...(snapshot.liveRate ? { liveRate: snapshot.liveRate } : {}),
    ...(snapshot.liveActivity
      ? { liveActivity: snapshot.liveActivity }
      : {}),
    series: snapshot.series,
    ...(effectiveSeriesByWindow
      ? { seriesByWindow: effectiveSeriesByWindow }
      : {}),
    quotas: snapshot.quotas,
    ...(snapshot.accounts ? { accounts: snapshot.accounts } : {}),
    sources: providerRecord((provider) =>
      publicSource(snapshot.sources[provider])
    ),
  };
}

function publicSource(source: SourceStatus): PublicSourceStatus {
  return {
    provider: source.provider,
    available: source.available,
    filesSeen: source.filesSeen,
    filesRead: source.filesRead,
    malformedLines: source.malformedLines,
    ...(source.lastEventAt !== undefined
      ? { lastEventAt: source.lastEventAt }
      : {}),
  };
}
