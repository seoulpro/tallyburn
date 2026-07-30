export const PROVIDERS = [
  "codex",
  "claude",
  "gemini",
  "copilot",
  "qwen",
  "llamacpp",
  "vllm",
] as const;

export type Provider = (typeof PROVIDERS)[number];

export const DEFAULT_PROVIDERS = ["codex", "claude"] as const satisfies
  readonly Provider[];

export const TRANSCRIPT_PROVIDERS = ["codex", "claude"] as const satisfies
  readonly Provider[];

export type TranscriptProvider = (typeof TRANSCRIPT_PROVIDERS)[number];

export function providerRecord<T>(
  create: (provider: Provider) => T,
): Record<Provider, T> {
  return Object.fromEntries(
    PROVIDERS.map((provider) => [provider, create(provider)]),
  ) as Record<Provider, T>;
}

export interface TokenUsage {
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

export interface UsageEvent extends TokenUsage {
  id: string;
  provider: Provider;
  timestamp: number;
  model?: string;
}

export interface QuotaWindow {
  usedPercent: number;
  windowMs: number;
  resetsAt?: number;
}

export interface QuotaSnapshot {
  provider: Provider;
  timestamp: number;
  planType?: string;
  primary?: QuotaWindow;
  secondary?: QuotaWindow;
}

/**
 * Sanitized account capability reported by an official provider CLI.
 *
 * This is deliberately separate from QuotaSnapshot: a subscription can be
 * detected without a fresh 5h/7d usage percentage, and must never be presented
 * as an estimated quota.
 */
export interface ProviderAccountStatus {
  provider: Provider;
  observedAt: number;
  loggedIn: boolean;
  subscriptionType?: string;
}

export interface ProviderAggregate extends TokenUsage {
  provider: Provider | "all";
  observations: number;
  lastEventAt?: number;
}

export interface TokenRateAggregate {
  provider: Provider | "all";
  observedTokens: number;
  tokensPerMinute: number;
  observations: number;
  lastEventAt?: number;
}

export interface LiveTokenRate {
  trailingWindowMs: number;
  all: TokenRateAggregate;
  providers: Record<Provider, TokenRateAggregate>;
}

export interface TokenActivityAggregate {
  provider: Provider | "all";
  observedTokens: number;
  tokensPerSecond: number;
  observations: number;
  lastEventAt?: number;
}

export interface LiveTokenActivity {
  historyWindowMs: number;
  sampleIntervalMs: number;
  rateWindowMs: number;
  all: TokenActivityAggregate;
  providers: Record<Provider, TokenActivityAggregate>;
  series: Record<Provider | "all", BucketPoint[]>;
  rateSeries?: Record<Provider | "all", ActivityRatePoint[]>;
}

export interface WindowAggregate {
  label: string;
  durationMs: number;
  all: ProviderAggregate;
  providers: Record<Provider, ProviderAggregate>;
}

export interface BucketPoint {
  start: number;
  tokens: number;
}

export interface ActivityRatePoint {
  at: number;
  tokensPerSecond: number;
}

export interface SourceStatus {
  provider: Provider;
  root: string;
  available: boolean;
  filesSeen: number;
  filesRead: number;
  malformedLines: number;
  lastEventAt?: number;
}

export interface UsageSnapshot {
  generatedAt: number;
  windows: WindowAggregate[];
  focusWindow: string;
  recentTokensPerMinute: number;
  recentRateWindowMs?: number;
  liveRate?: LiveTokenRate;
  liveActivity?: LiveTokenActivity;
  series: Record<Provider | "all", BucketPoint[]>;
  recentEvents: UsageEvent[];
  quotas: Partial<Record<Provider, QuotaSnapshot>>;
  accounts?: Partial<Record<Provider, ProviderAccountStatus>>;
  sources: Record<Provider, SourceStatus>;
}

export const LIVE_RATE_WINDOW_MS = 60_000;
export const LIVE_ACTIVITY_HISTORY_WINDOW_MS = 60_000;
export const LIVE_ACTIVITY_BUCKET_COUNT = 60;
export const LIVE_ACTIVITY_SAMPLE_INTERVAL_MS = 1_000;
export const LIVE_ACTIVITY_RATE_WINDOW_MS = 60_000;
export const RECENT_RATE_WINDOW_MS = 5 * 60_000;

export const ZERO_USAGE: Readonly<TokenUsage> = Object.freeze({
  freshInput: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  total: 0,
});

export function emptyAggregate(
  provider: Provider | "all",
): ProviderAggregate {
  return {
    provider,
    observations: 0,
    ...ZERO_USAGE,
  };
}

export function addUsage(
  target: TokenUsage,
  usage: TokenUsage,
): TokenUsage {
  target.freshInput += usage.freshInput;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.output += usage.output;
  target.reasoning += usage.reasoning;
  target.total += usage.total;
  return target;
}
