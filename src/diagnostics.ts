import {
  LIVE_RATE_WINDOW_MS,
  type CollectionEngineState,
  type DiagnosticsSnapshot,
  type Provider,
  type ProviderActivityDiagnostic,
  type ProviderCollectionKind,
  type ProviderDiagnostic,
  type ProviderQuotaDiagnostic,
  type UsageSnapshot,
} from "./model.js";

export interface DiagnosticsOptions {
  providers: readonly Provider[];
  running: boolean;
  collectionMode: "watch" | "poll";
  backfill: boolean;
  otelEnabled: boolean;
  codexAccount: boolean;
  claudeAccount: boolean;
  llamaCppMetrics: boolean;
  vllmMetrics: boolean;
  demo: boolean;
}

export function buildDiagnostics(
  snapshot: UsageSnapshot,
  options: DiagnosticsOptions,
): DiagnosticsSnapshot {
  const engineState: CollectionEngineState = options.demo
    ? "demo"
    : options.running
      ? options.collectionMode
      : "stopped";
  const providers: Partial<Record<Provider, ProviderDiagnostic>> = {};
  for (const provider of options.providers) {
    const collection = collectionKind(provider, options);
    providers[provider] = {
      provider,
      collection,
      activity: activityDiagnostic(
        snapshot,
        provider,
        collection,
      ),
      quota: quotaDiagnostic(snapshot, provider, options),
    };
  }
  return {
    generatedAt: snapshot.generatedAt,
    engine: { state: engineState },
    providers,
  };
}

function collectionKind(
  provider: Provider,
  options: DiagnosticsOptions,
): ProviderCollectionKind {
  if (options.demo) {
    return "demo";
  }
  if (provider === "codex") {
    return options.backfill ? "transcript" : "none";
  }
  if (provider === "claude") {
    if (options.backfill && options.otelEnabled) {
      return "hybrid";
    }
    if (options.backfill) {
      return "transcript";
    }
    return options.otelEnabled ? "telemetry" : "none";
  }
  if (
    provider === "gemini" ||
    provider === "copilot" ||
    provider === "qwen"
  ) {
    return options.otelEnabled ? "telemetry" : "none";
  }
  if (provider === "llamacpp") {
    return options.llamaCppMetrics ? "metrics" : "none";
  }
  return options.vllmMetrics ? "metrics" : "none";
}

function activityDiagnostic(
  snapshot: UsageSnapshot,
  provider: Provider,
  collection: ProviderCollectionKind,
): ProviderActivityDiagnostic {
  const source = snapshot.sources[provider];
  const common = {
    filesSeen: source.filesSeen,
    filesRead: source.filesRead,
    malformedLines: source.malformedLines,
    ...(source.lastEventAt !== undefined
      ? { lastEventAt: source.lastEventAt }
      : {}),
  };
  if (collection === "none") {
    return {
      state: "notConfigured",
      reason: "collectionNotConfigured",
      ...common,
    };
  }
  if (source.lastEventAt !== undefined) {
    const recent =
      snapshot.generatedAt - source.lastEventAt <= LIVE_RATE_WINDOW_MS;
    return {
      state: recent ? "active" : "idle",
      reason: recent ? "recentActivity" : "noRecentActivity",
      ...common,
    };
  }
  if (!source.available && collection === "transcript") {
    return {
      state: "unavailable",
      reason: "sourceUnavailable",
      ...common,
    };
  }
  return {
    state: "waiting",
    reason: "awaitingFirstEvent",
    ...common,
  };
}

function quotaDiagnostic(
  snapshot: UsageSnapshot,
  provider: Provider,
  options: DiagnosticsOptions,
): ProviderQuotaDiagnostic {
  if (provider !== "codex" && provider !== "claude") {
    return emptyQuota("unsupported");
  }
  const enabled =
    provider === "codex" ? options.codexAccount : options.claudeAccount;
  if (!enabled) {
    return emptyQuota("disabled");
  }
  const quota = snapshot.quotas[provider];
  if (quota) {
    return {
      state: "fresh",
      observedAt: quota.timestamp,
      ageMs: Math.max(0, snapshot.generatedAt - quota.timestamp),
      hasPrimary: quota.primary !== undefined,
      hasSecondary: quota.secondary !== undefined,
    };
  }
  const account = snapshot.accounts?.[provider];
  if (account?.loggedIn === false) {
    return {
      ...emptyQuota("signedOut"),
      observedAt: account.observedAt,
      ageMs: Math.max(0, snapshot.generatedAt - account.observedAt),
    };
  }
  if (account?.loggedIn === true) {
    return {
      ...emptyQuota("planDetected"),
      observedAt: account.observedAt,
      ageMs: Math.max(0, snapshot.generatedAt - account.observedAt),
    };
  }
  return emptyQuota("waiting");
}

function emptyQuota(
  state: ProviderQuotaDiagnostic["state"],
): ProviderQuotaDiagnostic {
  return {
    state,
    hasPrimary: false,
    hasSecondary: false,
  };
}
