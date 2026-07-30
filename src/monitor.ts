import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CLAUDE_ACCOUNT_REFRESH_INTERVAL_MS,
  readClaudeAccountContext,
} from "./claude-account.js";
import {
  CLAUDE_DESKTOP_QUOTA_MAX_AGE_MS,
  CLAUDE_DESKTOP_QUOTA_REFRESH_INTERVAL_MS,
  readClaudeDesktopQuota,
} from "./claude-desktop.js";
import { startCodexAccountBridge, type CodexAccountBridge } from "./codex-account.js";
import { buildDemo } from "./demo.js";
import { parseWindows, type NamedDuration } from "./duration.js";
import { UsageIndexer } from "./indexer.js";
import {
  RECENT_RATE_WINDOW_MS,
  DEFAULT_PROVIDERS,
  PROVIDERS,
  TRANSCRIPT_PROVIDERS,
  providerRecord,
  type Provider,
  type ProviderAccountStatus,
  type SourceStatus,
  type TranscriptProvider,
  type UsageSnapshot,
} from "./model.js";
import {
  startClaudeOtlpReceiver,
  type ClaudeOtlpReceiver,
  type OtlpMetricProvider,
} from "./otel.js";
import { PrometheusTokenCollector } from "./prometheus.js";
import { readClaudeQuotaState } from "./state.js";
import { cloneUsageSnapshot, UsageStore } from "./store.js";

export interface TallyburnMonitorOptions {
  windows?: readonly string[] | readonly NamedDuration[];
  refreshMs?: number;
  providers?: readonly Provider[];
  codexHome?: string;
  claudeHome?: string;
  stateDirectory?: string;
  backfill?: boolean;
  codexAccount?: boolean;
  codexExecutable?: string;
  claudeAccount?: boolean;
  claudeExecutable?: string;
  otelPort?: number;
  otelLogs?: boolean;
  llamaCppMetrics?: string;
  vllmMetrics?: string;
  demo?: boolean;
}

interface ResolvedMonitorOptions {
  windows: NamedDuration[];
  refreshMs: number;
  providers: Provider[];
  codexHome: string;
  claudeHome: string;
  stateDirectory: string;
  backfill: boolean;
  codexAccount: boolean;
  codexExecutable?: string;
  claudeAccount: boolean;
  claudeExecutable?: string;
  otelPort?: number;
  otelLogs: boolean;
  llamaCppMetrics?: string;
  vllmMetrics?: string;
  demo: boolean;
}

export type SnapshotListener = (snapshot: UsageSnapshot) => void;
export type MonitorErrorListener = (error: unknown) => void;
export type Unsubscribe = () => void;

interface QueuedRefresh {
  now: number;
  promise: Promise<UsageSnapshot>;
  resolve: (snapshot: UsageSnapshot) => void;
  reject: (error: unknown) => void;
}

export class TallyburnMonitor {
  readonly #options: ResolvedMonitorOptions;
  readonly #store: UsageStore;
  readonly #sources: Record<Provider, SourceStatus>;
  readonly #indexer: UsageIndexer | undefined;
  readonly #snapshotListeners = new Set<SnapshotListener>();
  readonly #errorListeners = new Set<MonitorErrorListener>();
  readonly #metricCollectors: PrometheusTokenCollector[];
  readonly #watchers: FSWatcher[] = [];
  readonly #watchedPaths = new Set<string>();
  readonly #pendingWatchFiles: Record<TranscriptProvider, Set<string>> = {
    codex: new Set<string>(),
    claude: new Set<string>(),
  };
  readonly #accounts: Partial<Record<Provider, ProviderAccountStatus>> = {};
  #activeRefresh: Promise<UsageSnapshot> | undefined;
  #queuedRefresh: QueuedRefresh | undefined;
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #reconcileTimer: NodeJS.Timeout | undefined;
  #watchDebounce: NodeJS.Timeout | undefined;
  #otlp: ClaudeOtlpReceiver | undefined;
  #codexAbort: AbortController | undefined;
  #codexBridgePromise: Promise<CodexAccountBridge | undefined> | undefined;
  #lastClaudeAccountAttemptAt = 0;
  #lastClaudeDesktopQuotaAttemptAt = 0;
  #claudeOrganizationId: string | undefined;
  #running = false;
  #closed = false;
  #filesystemWatching = false;
  #needsFullWatchRefresh = false;
  readonly #advanceDemo: ((now: number) => void) | undefined;

  private constructor(
    options: ResolvedMonitorOptions,
    store: UsageStore,
    sources: Record<Provider, SourceStatus>,
    indexer?: UsageIndexer,
    advanceDemo?: (now: number) => void,
  ) {
    this.#options = options;
    this.#store = store;
    this.#sources = sources;
    this.#indexer = indexer;
    this.#advanceDemo = advanceDemo;
    this.#metricCollectors = createPrometheusCollectors(options);
    for (const collector of this.#metricCollectors) {
      this.#sources[collector.provider].root = collector.url;
    }
  }

  static async create(
    options: TallyburnMonitorOptions = {},
  ): Promise<TallyburnMonitor> {
    const resolved = resolveMonitorOptions(options);
    if (resolved.demo) {
      const retentionMs = Math.max(
        RECENT_RATE_WINDOW_MS,
        ...resolved.windows.map((window) => window.durationMs),
      );
      const demo = buildDemo(
        Date.now(),
        resolved.providers,
        retentionMs,
      );
      return new TallyburnMonitor(
        resolved,
        demo.store,
        demo.sources,
        undefined,
        demo.advance,
      );
    }

    const retentionMs = Math.max(
      RECENT_RATE_WINDOW_MS,
      ...resolved.windows.map((window) => window.durationMs),
    );
    const indexer = new UsageIndexer({
      codexHome: resolved.codexHome,
      claudeHome: resolved.claudeHome,
      retentionMs,
      providers: resolved.backfill ? resolved.providers : [],
    });
    await indexer.scan();
    const monitor = new TallyburnMonitor(
      resolved,
      indexer.store,
      indexer.statuses,
      indexer,
    );
    const now = Date.now();
    await monitor.#refreshClaudeAccount(now, true);
    await monitor.#mergeClaudeQuota(now, true);
    return monitor;
  }

  get running(): boolean {
    return this.#running;
  }

  get listeningPort(): number | undefined {
    return this.#otlp?.port;
  }

  get collectionMode(): "watch" | "poll" {
    return this.#filesystemWatching ? "watch" : "poll";
  }

  get sources(): Record<Provider, SourceStatus> {
    return providerRecord((provider) => ({ ...this.#sources[provider] }));
  }

  snapshot(
    focusIndex = 0,
    now = Date.now(),
    bucketCount = 28,
  ): UsageSnapshot {
    const snapshot = this.#store.snapshot(
      this.#options.windows,
      focusIndex,
      this.#sources,
      now,
      bucketCount,
    );
    if (Object.keys(this.#accounts).length > 0) {
      snapshot.accounts = structuredClone(this.#accounts);
    }
    return snapshot;
  }

  subscribe(
    listener: SnapshotListener,
    options: { emitCurrent?: boolean } = {},
  ): Unsubscribe {
    this.#assertOpen();
    this.#snapshotListeners.add(listener);
    if (options.emitCurrent !== false) {
      this.#notifySnapshotListener(listener, this.snapshot());
    }
    return () => {
      this.#snapshotListeners.delete(listener);
    };
  }

  subscribeErrors(listener: MonitorErrorListener): Unsubscribe {
    this.#assertOpen();
    this.#errorListeners.add(listener);
    return () => {
      this.#errorListeners.delete(listener);
    };
  }

  async refresh(now = Date.now()): Promise<UsageSnapshot> {
    this.#assertOpen();
    if (this.#activeRefresh) {
      if (this.#queuedRefresh) {
        this.#queuedRefresh.now = now;
        return this.#queuedRefresh.promise;
      }
      let resolveQueued!: (snapshot: UsageSnapshot) => void;
      let rejectQueued!: (error: unknown) => void;
      const promise = new Promise<UsageSnapshot>((resolve, reject) => {
        resolveQueued = resolve;
        rejectQueued = reject;
      });
      this.#queuedRefresh = {
        now,
        promise,
        resolve: resolveQueued,
        reject: rejectQueued,
      };
      return promise;
    }
    return this.#beginTrackedRefresh(() => this.#performRefresh(now));
  }

  async refreshAccountQuota(timeoutMs = 2_500): Promise<void> {
    this.#assertOpen();
    if (
      this.#options.demo ||
      !this.#options.codexAccount ||
      !this.#options.providers.includes("codex")
    ) {
      return;
    }
    const bridge = await startCodexAccountBridge({
      timeoutMs,
      ...(this.#options.codexExecutable
        ? { executable: this.#options.codexExecutable }
        : {}),
      onQuota: (quota) => {
        if (!this.#closed) {
          this.#store.updateQuota(quota);
          this.#emitSnapshot();
        }
      },
    });
    await bridge.close();
  }

  start(): Promise<void> {
    this.#assertOpen();
    if (this.#running) {
      return this.#startPromise ?? Promise.resolve();
    }
    this.#running = true;
    const operation = this.#performStart();
    const pending = operation.finally(() => {
      if (this.#startPromise === pending) {
        this.#startPromise = undefined;
      }
    });
    this.#startPromise = pending;
    return pending;
  }

  async #performStart(): Promise<void> {
    try {
      if (
        !this.#options.demo &&
        this.#options.otelPort !== undefined &&
        (
          this.#options.providers.includes("claude") ||
          this.#options.providers.includes("gemini") ||
          this.#options.providers.includes("copilot") ||
          this.#options.providers.includes("qwen")
        )
      ) {
        const otlpProviders = this.#options.providers.filter(
          (provider): provider is OtlpMetricProvider =>
            provider === "claude" ||
            provider === "gemini" ||
            provider === "copilot" ||
            provider === "qwen",
        );
        this.#otlp = await startClaudeOtlpReceiver({
          port: this.#options.otelPort,
          allowLogs: this.#options.otelLogs,
          providers: otlpProviders,
          onEvents: (events) => {
            if (this.#closed) {
              return;
            }
            for (const event of events) {
              if (!this.#options.providers.includes(event.provider)) {
                continue;
              }
              this.#store.upsertEvent(event);
              const source = this.#sources[event.provider];
              source.available = true;
              if (
                source.lastEventAt === undefined ||
                source.lastEventAt < event.timestamp
              ) {
                source.lastEventAt = event.timestamp;
              }
            }
            this.#emitSnapshot();
          },
        });
        if (this.#options.providers.includes("claude")) {
          this.#indexer?.setProviderEventUpperBound(
            "claude",
            Date.now(),
          );
        }
      }

      if (
        !this.#options.demo &&
        this.#options.codexAccount &&
        this.#options.providers.includes("codex")
      ) {
        this.#codexAbort = new AbortController();
        this.#codexBridgePromise = startCodexAccountBridge({
          signal: this.#codexAbort.signal,
          ...(this.#options.codexExecutable
            ? { executable: this.#options.codexExecutable }
            : {}),
          onQuota: (quota) => {
            if (!this.#closed) {
              this.#store.updateQuota(quota);
              this.#emitSnapshot();
            }
          },
        }).catch(() => undefined);
      }

      if (this.#closed) {
        return;
      }
      this.#syncFilesystemWatchers();
      await this.refresh();
      if (this.#closed) {
        return;
      }
      this.#timer = setInterval(() => {
        if (
          this.#filesystemWatching &&
          this.#metricCollectors.length === 0
        ) {
          this.#emitSnapshot();
        } else {
          void this.refresh().catch((error: unknown) => {
            this.#emitError(error);
          });
        }
      }, this.#options.refreshMs);
      this.#syncReconcileTimer();
    } catch (error) {
      this.#running = false;
      this.#closeSchedulers();
      await this.#closeLiveAdapters();
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#running = false;
    const pending = this.#performClose();
    this.#closePromise = pending;
    return pending;
  }

  async #performClose(): Promise<void> {
    this.#closeSchedulers();
    const starting = this.#startPromise;
    if (starting) {
      await starting.catch(() => {});
    }
    this.#closeSchedulers();
    while (this.#activeRefresh) {
      await this.#activeRefresh.catch(() => {});
    }
    await this.#closeLiveAdapters();
    this.#snapshotListeners.clear();
    this.#errorListeners.clear();
  }

  async stop(): Promise<void> {
    await this.close();
  }

  #beginTrackedRefresh(
    operation: () => Promise<UsageSnapshot>,
  ): Promise<UsageSnapshot> {
    let pending!: Promise<UsageSnapshot>;
    pending = (async (): Promise<UsageSnapshot> => {
      try {
        return await operation();
      } finally {
        if (this.#activeRefresh === pending) {
          this.#activeRefresh = undefined;
          this.#startQueuedRefresh();
        }
      }
    })();
    this.#activeRefresh = pending;
    return pending;
  }

  #startQueuedRefresh(): void {
    const queued = this.#queuedRefresh;
    this.#queuedRefresh = undefined;
    if (!queued) {
      return;
    }
    if (this.#closed) {
      queued.reject(new Error("Tallyburn monitor is closed."));
      return;
    }
    const pending = this.#beginTrackedRefresh(
      () => this.#performRefresh(queued.now),
    );
    void pending.then(queued.resolve, queued.reject);
  }

  async #performRefresh(now: number): Promise<UsageSnapshot> {
    await this.#indexer?.scan(now);
    await this.#pollPrometheusMetrics(now);
    this.#advanceDemo?.(now);
    await this.#refreshClaudeAccount(now);
    await this.#mergeClaudeQuota(now);
    this.#syncFilesystemWatchers();
    const snapshot = this.snapshot(0, now);
    this.#emitSnapshot(snapshot);
    return snapshot;
  }

  async #pollPrometheusMetrics(now: number): Promise<void> {
    const results = await Promise.all(
      this.#metricCollectors.map(async (collector) => ({
        collector,
        result: await collector.poll(now),
      })),
    );
    for (const { collector, result } of results) {
      const source = this.#sources[collector.provider];
      source.available = result.available;
      for (const event of result.events) {
        this.#store.upsertEvent(event);
        if (
          source.lastEventAt === undefined ||
          source.lastEventAt < event.timestamp
        ) {
          source.lastEventAt = event.timestamp;
        }
      }
    }
  }

  async #mergeClaudeQuota(
    now = Date.now(),
    forceDesktopRead = false,
  ): Promise<void> {
    if (
      this.#options.demo ||
      !this.#options.providers.includes("claude")
    ) {
      return;
    }
    const quota = await readClaudeQuotaState(this.#options.stateDirectory);
    if (quota) {
      this.#store.updateQuota(quota);
    }
    if (
      !this.#options.claudeAccount ||
      !this.#claudeOrganizationId ||
      (
        !forceDesktopRead &&
        now - this.#lastClaudeDesktopQuotaAttemptAt <
          CLAUDE_DESKTOP_QUOTA_REFRESH_INTERVAL_MS
      )
    ) {
      return;
    }
    this.#lastClaudeDesktopQuotaAttemptAt = now;
    const desktopQuota = await readClaudeDesktopQuota({
      organizationId: this.#claudeOrganizationId,
      now,
    });
    if (desktopQuota) {
      this.#store.updateQuota(desktopQuota, {
        usageLagMs: CLAUDE_DESKTOP_QUOTA_MAX_AGE_MS,
        maxAgeMs: CLAUDE_DESKTOP_QUOTA_MAX_AGE_MS,
      });
    }
  }

  async #refreshClaudeAccount(
    now: number,
    force = false,
  ): Promise<void> {
    if (
      this.#options.demo ||
      !this.#options.claudeAccount ||
      !this.#options.providers.includes("claude") ||
      (!force &&
        now - this.#lastClaudeAccountAttemptAt <
          CLAUDE_ACCOUNT_REFRESH_INTERVAL_MS)
    ) {
      return;
    }
    this.#lastClaudeAccountAttemptAt = now;
    const context = await readClaudeAccountContext({
      now,
      ...(this.#options.claudeExecutable
        ? { executable: this.#options.claudeExecutable }
        : {}),
    });
    if (context) {
      this.#accounts.claude = context.status;
      this.#claudeOrganizationId = context.organizationId;
    }
  }

  #emitSnapshot(snapshot = this.snapshot()): void {
    if (this.#closed) {
      return;
    }
    for (const listener of this.#snapshotListeners) {
      this.#notifySnapshotListener(listener, snapshot);
    }
  }

  #notifySnapshotListener(
    listener: SnapshotListener,
    snapshot: UsageSnapshot,
  ): void {
    try {
      const result = (
        listener as (value: UsageSnapshot) => unknown
      )(cloneUsageSnapshot(snapshot));
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
      }
    } catch {
      // One view must not stop collection for every other view.
    }
  }

  #emitError(error: unknown): void {
    for (const listener of this.#errorListeners) {
      try {
        const result = (
          listener as (value: unknown) => unknown
        )(error);
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {});
        }
      } catch {
        // Error observers are isolated from the monitor lifecycle.
      }
    }
  }

  async #closeLiveAdapters(): Promise<void> {
    this.#codexAbort?.abort();
    const bridge = await this.#codexBridgePromise?.catch(() => undefined);
    const otlp = this.#otlp;
    this.#codexAbort = undefined;
    this.#codexBridgePromise = undefined;
    this.#otlp = undefined;
    await Promise.allSettled(
      [otlp?.close(), bridge?.close()].filter(
        (promise): promise is Promise<void> => promise !== undefined,
      ),
    );
  }

  #filesystemTargets(): Array<{
    provider: TranscriptProvider;
    path: string;
  }> {
    const targets: Array<{
      provider: TranscriptProvider;
      path: string;
    }> = [];
    if (this.#options.providers.includes("codex")) {
      for (const path of [
        join(this.#options.codexHome, "sessions"),
        join(this.#options.codexHome, "archived_sessions"),
      ]) {
        if (existsSync(path)) {
          targets.push({ provider: "codex", path });
        }
      }
    }
    if (this.#options.providers.includes("claude")) {
      const path = join(this.#options.claudeHome, "projects");
      if (existsSync(path)) {
        targets.push({ provider: "claude", path });
      }
    }
    return targets;
  }

  #syncFilesystemWatchers(): void {
    if (
      !this.#running ||
      this.#closed ||
      this.#options.demo ||
      !this.#options.backfill
    ) {
      return;
    }
    if (!supportsReliableRecursiveWatch()) {
      this.#disableFilesystemWatchers();
      this.#syncReconcileTimer();
      return;
    }

    const targets = this.#filesystemTargets();
    const desiredPaths = new Set(
      targets.map((target) => `${target.provider}:${target.path}`),
    );
    if (
      this.#filesystemWatching &&
      setsEqual(desiredPaths, this.#watchedPaths)
    ) {
      this.#syncReconcileTimer();
      return;
    }

    this.#disableFilesystemWatchers(true);
    if (targets.length === 0) {
      this.#clearPendingWatchChanges();
      this.#syncReconcileTimer();
      return;
    }

    try {
      for (const target of targets) {
        const watcher = watch(
          target.path,
          {
            persistent: false,
            recursive: true,
          },
          (_eventType, filename) => {
            const relativePath = filename?.toString();
            if (relativePath) {
              const changedPath = resolve(target.path, relativePath);
              if (changedPath.endsWith(".jsonl")) {
                this.#pendingWatchFiles[target.provider].add(changedPath);
              } else {
                this.#needsFullWatchRefresh = true;
              }
            } else {
              this.#needsFullWatchRefresh = true;
            }
            this.#scheduleFilesystemRefresh();
          },
        );
        watcher.on("error", () => {
          if (!this.#watchers.includes(watcher)) {
            return;
          }
          this.#disableFilesystemWatchers();
          this.#syncReconcileTimer();
        });
        this.#watchers.push(watcher);
        this.#watchedPaths.add(`${target.provider}:${target.path}`);
      }
      this.#filesystemWatching = true;
      if (
        this.#needsFullWatchRefresh ||
        this.#pendingWatchFiles.codex.size > 0 ||
        this.#pendingWatchFiles.claude.size > 0
      ) {
        this.#scheduleFilesystemRefresh();
      }
    } catch {
      this.#disableFilesystemWatchers();
    }
    this.#syncReconcileTimer();
  }

  #syncReconcileTimer(): void {
    if (this.#filesystemWatching && this.#running && !this.#closed) {
      if (!this.#reconcileTimer) {
        this.#reconcileTimer = setInterval(() => {
          void this.refresh().catch((error: unknown) => {
            this.#emitError(error);
          });
        }, 30_000);
      }
      return;
    }
    if (this.#reconcileTimer) {
      clearInterval(this.#reconcileTimer);
      this.#reconcileTimer = undefined;
    }
  }

  #scheduleFilesystemRefresh(): void {
    if (this.#closed || !this.#filesystemWatching) {
      return;
    }
    if (this.#watchDebounce) {
      clearTimeout(this.#watchDebounce);
    }
    this.#watchDebounce = setTimeout(() => {
      this.#watchDebounce = undefined;
      void this.#flushFilesystemChanges().catch((error: unknown) => {
        this.#emitError(error);
      });
    }, 300);
  }

  async #flushFilesystemChanges(): Promise<void> {
    while (this.#activeRefresh) {
      await this.#activeRefresh.catch(() => {});
    }
    if (this.#closed || !this.#filesystemWatching) {
      return;
    }

    const needsFullRefresh = this.#needsFullWatchRefresh;
    this.#needsFullWatchRefresh = false;
    const files: Record<TranscriptProvider, string[]> = {
      codex: [...this.#pendingWatchFiles.codex],
      claude: [...this.#pendingWatchFiles.claude],
    };
    this.#pendingWatchFiles.codex.clear();
    this.#pendingWatchFiles.claude.clear();
    const hasChangedFiles =
      files.codex.length > 0 || files.claude.length > 0;

    if (needsFullRefresh) {
      await this.refresh();
      return;
    }
    if (!this.#indexer || !hasChangedFiles) {
      return;
    }

    const now = Date.now();
    await this.#beginTrackedRefresh(
      async (): Promise<UsageSnapshot> => {
        for (const provider of TRANSCRIPT_PROVIDERS) {
          if (files[provider].length > 0) {
            await this.#indexer?.scanFiles(
              provider,
              files[provider],
              now,
            );
          }
        }
        await this.#mergeClaudeQuota(now);
        const snapshot = this.snapshot(0, now);
        this.#emitSnapshot(snapshot);
        return snapshot;
      },
    );
  }

  #disableFilesystemWatchers(preservePending = false): void {
    this.#filesystemWatching = false;
    for (const watcher of this.#watchers.splice(0)) {
      watcher.close();
    }
    this.#watchedPaths.clear();
    if (this.#watchDebounce) {
      clearTimeout(this.#watchDebounce);
      this.#watchDebounce = undefined;
    }
    if (!preservePending) {
      this.#clearPendingWatchChanges();
    }
  }

  #clearPendingWatchChanges(): void {
    this.#needsFullWatchRefresh = false;
    this.#pendingWatchFiles.codex.clear();
    this.#pendingWatchFiles.claude.clear();
  }

  #closeSchedulers(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (this.#reconcileTimer) {
      clearInterval(this.#reconcileTimer);
      this.#reconcileTimer = undefined;
    }
    this.#disableFilesystemWatchers();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Tallyburn monitor is closed.");
    }
  }
}

function resolveMonitorOptions(
  options: TallyburnMonitorOptions,
): ResolvedMonitorOptions {
  const taskHome = homedir();
  const windows = resolveWindows(options.windows);
  const providers = [
    ...new Set(options.providers ?? DEFAULT_PROVIDERS),
  ];
  const refreshMs = options.refreshMs ?? 1_000;

  if (windows.length === 0 || windows.length > 6) {
    throw new Error("Tallyburn requires between one and six rolling windows.");
  }
  if (providers.length === 0) {
    throw new Error("Tallyburn requires at least one provider.");
  }
  if (
    !Number.isSafeInteger(refreshMs) ||
    refreshMs < 250 ||
    refreshMs > 86_400_000
  ) {
    throw new Error("Refresh interval must be between 250ms and 24 hours.");
  }
  for (const provider of providers) {
    if (!PROVIDERS.includes(provider)) {
      throw new Error(`Unsupported provider "${provider}".`);
    }
  }
  if (
    options.otelPort !== undefined &&
    (!Number.isInteger(options.otelPort) ||
      options.otelPort < 0 ||
      options.otelPort > 65_535)
  ) {
    throw new Error("OTLP port must be between 0 and 65535.");
  }
  if (options.otelLogs && options.otelPort === undefined) {
    throw new Error("OTLP logs require an OTLP listener port.");
  }

  return {
    windows,
    refreshMs,
    providers,
    codexHome: resolve(options.codexHome ?? join(taskHome, ".codex")),
    claudeHome: resolve(options.claudeHome ?? join(taskHome, ".claude")),
    stateDirectory: resolve(
      options.stateDirectory ??
        join(taskHome, ".local", "state", "tallyburn"),
    ),
    backfill: options.backfill !== false,
    codexAccount: options.codexAccount === true,
    ...(options.codexExecutable
      ? { codexExecutable: options.codexExecutable }
      : {}),
    claudeAccount: options.claudeAccount === true,
    ...(options.claudeExecutable
      ? { claudeExecutable: options.claudeExecutable }
      : {}),
    ...(options.otelPort !== undefined
      ? { otelPort: options.otelPort }
      : {}),
    ...(options.llamaCppMetrics
      ? { llamaCppMetrics: options.llamaCppMetrics }
      : {}),
    ...(options.vllmMetrics
      ? { vllmMetrics: options.vllmMetrics }
      : {}),
    otelLogs: options.otelLogs === true,
    demo: options.demo === true,
  };
}

function createPrometheusCollectors(
  options: ResolvedMonitorOptions,
): PrometheusTokenCollector[] {
  const collectors: PrometheusTokenCollector[] = [];
  if (
    options.llamaCppMetrics &&
    options.providers.includes("llamacpp")
  ) {
    collectors.push(
      new PrometheusTokenCollector({
        provider: "llamacpp",
        url: options.llamaCppMetrics,
      }),
    );
  }
  if (options.vllmMetrics && options.providers.includes("vllm")) {
    collectors.push(
      new PrometheusTokenCollector({
        provider: "vllm",
        url: options.vllmMetrics,
      }),
    );
  }
  return collectors;
}

export async function createTallyburnMonitor(
  options: TallyburnMonitorOptions = {},
): Promise<TallyburnMonitor> {
  return TallyburnMonitor.create(options);
}

function resolveWindows(
  windows: TallyburnMonitorOptions["windows"],
): NamedDuration[] {
  if (windows === undefined) {
    return parseWindows("1h,3h,12h");
  }
  if (!Array.isArray(windows)) {
    throw new Error("Rolling windows must be an array.");
  }
  if (windows.every((window) => typeof window === "string")) {
    return parseWindows(windows.join(","));
  }
  if (windows.some((window) => typeof window === "string")) {
    throw new Error("Rolling windows must use one consistent representation.");
  }
  const labels = new Set<string>();
  const durations = new Set<number>();
  const resolved = windows.map((window) => {
    if (
      typeof window !== "object" ||
      window === null ||
      typeof window.label !== "string" ||
      typeof window.durationMs !== "number"
    ) {
      throw new Error("Each rolling window requires a label and durationMs.");
    }
    const label = window.label.trim();
    if (
      label.length === 0 ||
      label.length > 64 ||
      /[\u0000-\u001f\u007f]/u.test(label)
    ) {
      throw new Error("Rolling window labels must be 1–64 printable characters.");
    }
    if (
      !Number.isSafeInteger(window.durationMs) ||
      window.durationMs <= 0 ||
      window.durationMs > 30 * 86_400_000
    ) {
      throw new Error("Rolling window durations must be between 1ms and 30 days.");
    }
    if (labels.has(label) || durations.has(window.durationMs)) {
      throw new Error("Rolling window labels and durations must be unique.");
    }
    labels.add(label);
    durations.add(window.durationMs);
    return { label, durationMs: window.durationMs };
  });
  return resolved.sort(
    (left, right) => left.durationMs - right.durationMs,
  );
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function supportsReliableRecursiveWatch(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}
