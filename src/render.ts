import {
  PROVIDERS,
  type Provider,
  type ProviderAggregate,
  type QuotaWindow,
  type UsageSnapshot,
} from "./model.js";
import { displayPath } from "./display.js";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const SPARKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

interface Palette {
  title: string;
  dim: string;
  live: string;
  codex: string;
  claude: string;
  gemini: string;
  copilot: string;
  qwen: string;
  llamacpp: string;
  vllm: string;
  total: string;
  warning: string;
  reset: string;
}

const PALETTE: Palette = {
  title: "\u001b[38;5;51m\u001b[1m",
  dim: "\u001b[38;5;244m",
  live: "\u001b[38;5;83m",
  codex: "\u001b[38;5;45m",
  claude: "\u001b[38;5;177m",
  gemini: "\u001b[38;5;78m",
  copilot: "\u001b[38;5;213m",
  qwen: "\u001b[38;5;141m",
  llamacpp: "\u001b[38;5;80m",
  vllm: "\u001b[38;5;111m",
  total: "\u001b[38;5;229m\u001b[1m",
  warning: "\u001b[38;5;214m",
  reset: "\u001b[0m",
};

export interface RenderOptions {
  color: boolean;
  width?: number;
  interactive?: boolean;
  listeningPort?: number;
  otelLogs?: boolean;
  providers?: readonly Provider[];
}

export function renderSnapshot(
  snapshot: UsageSnapshot,
  options: RenderOptions,
): string {
  const width = Math.max(66, Math.min(132, options.width ?? 100));
  const providers = options.providers ?? PROVIDERS;
  const innerWidth = width - 2;
  const paint = colorizer(options.color);
  const lines: string[] = [];
  const push = (content = ""): void => {
    lines.push(boxLine(content, innerWidth));
  };
  const horizontal = "─".repeat(innerWidth);

  lines.push(`╭${horizontal}╮`);
  push(
    `${paint(PALETTE.title, " TALLYBURN ")} ${paint(PALETTE.live, "● LIVE")}  ` +
      `${paint(PALETTE.dim, formatClock(snapshot.generatedAt))}  ` +
      `${paint(PALETTE.dim, "credentials untouched · allowlisted output")}`,
  );
  push(
    ` ${paint(PALETTE.total, "Observed pace")}  ` +
      `${paint(PALETTE.live, `${formatTokens(
        snapshot.liveRate?.all.tokensPerMinute ??
          snapshot.recentTokensPerMinute,
      )} tok/min`)}  ` +
      `${paint(
        PALETTE.dim,
        snapshot.liveRate
          ? `· trailing ${formatQuotaDuration(snapshot.liveRate.trailingWindowMs)} · reported responses`
          : "· recent reported responses",
      )}`,
  );
  push(
    ` ${paint(PALETTE.dim, "Rolling token usage")}  ${snapshot.windows
      .map(
        (window) =>
          `${window.label} ${paint(PALETTE.total, formatTokens(window.all.total))}`,
      )
      .join("   ")}`,
  );
  lines.push(`├${horizontal}┤`);

  const maxWindows = Math.max(1, Math.floor((innerWidth - 41) / 12));
  const visibleWindows = snapshot.windows.slice(0, maxWindows);
  const hiddenCount = snapshot.windows.length - visibleWindows.length;
  push(
    ` ${pad("PROVIDER", 10)}${visibleWindows
      .map((window) => pad(window.label.toUpperCase(), 12, "right"))
      .join("")}${pad("1-MIN PACE", 12, "right")}${pad("OBS", 8, "right")}${pad("LAST", 9, "right")}`,
  );
  for (const provider of providers) {
    push(
      renderProviderRow(
        provider,
        snapshot,
        visibleWindows.length,
        paint,
      ),
    );
  }
  push(renderAllRow(snapshot, visibleWindows.length, paint));
  if (hiddenCount > 0) {
    push(
      ` ${paint(PALETTE.dim, `+ ${hiddenCount} wider window${hiddenCount === 1 ? "" : "s"} hidden at this terminal width`)}`,
    );
  }

  lines.push(`├${horizontal}┤`);
  const focus =
    snapshot.windows.find(
      (window) => window.label === snapshot.focusWindow,
    ) ?? snapshot.windows[0];
  if (focus) {
    const allSeries = snapshot.series.all.map((point) => point.tokens);
    const sparkWidth = Math.min(36, Math.max(16, innerWidth - 42));
    const spark = sparkline(resample(allSeries, sparkWidth));
    const cacheBase =
      focus.all.freshInput + focus.all.cacheRead + focus.all.cacheWrite;
    const cacheHit =
      cacheBase > 0 ? (focus.all.cacheRead / cacheBase) * 100 : 0;
    push(
      ` ${paint(PALETTE.total, `FOCUS ${focus.label}`)}  ${paint(PALETTE.live, spark)}  ` +
        `${formatTokens(snapshot.recentTokensPerMinute)}/min · ` +
        `${formatQuotaDuration(snapshot.recentRateWindowMs ?? 5 * 60_000)} avg`,
    );
    push(
      ` ${paint(PALETTE.dim, "fresh")} ${formatTokens(focus.all.freshInput)}  ` +
        `${paint(PALETTE.dim, "cache read")} ${formatTokens(focus.all.cacheRead)}  ` +
        `${paint(PALETTE.dim, "cache write")} ${formatTokens(focus.all.cacheWrite)}  ` +
        `${paint(PALETTE.dim, "output")} ${formatTokens(focus.all.output)}  ` +
        `${paint(PALETTE.dim, "cache hit")} ${cacheHit.toFixed(0)}%`,
    );
  }

  lines.push(`├${horizontal}┤`);
  push(` ${paint(PALETTE.dim, "SUBSCRIPTION QUOTA · provider-reported, not raw tokens")}`);
  for (const provider of providers) {
    push(renderQuota(provider, snapshot, innerWidth, paint));
  }

  lines.push(`├${horizontal}┤`);
  for (const provider of providers) {
    const source = snapshot.sources[provider];
    const providerColor = providerPalette(provider);
    const isMetricsProvider =
      provider !== "codex" && provider !== "claude";
    const state =
      isMetricsProvider
        ? source.available
          ? "metrics connected"
          : "metrics waiting"
        : source.available
          ? `${source.filesRead}/${source.filesSeen} recent logs`
          : "source not found";
    const last =
      source.lastEventAt === undefined
        ? "no events"
        : `last ${relativeTime(source.lastEventAt, snapshot.generatedAt)}`;
    const malformed =
      source.malformedLines > 0
        ? paint(PALETTE.warning, ` · ${source.malformedLines} skipped`)
        : "";
    push(
      ` ${paint(providerColor, providerLabel(provider))}  ${state} · ${last}` +
        `${isMetricsProvider ? "" : ` · ${displayPath(source.root)}`}${malformed}`,
    );
  }
  if (options.listeningPort !== undefined) {
    const signalPath = options.otelLogs ? "logs" : "metrics";
    push(
      ` ${paint(PALETTE.live, "OTLP")}  listening on http://127.0.0.1:${options.listeningPort}/v1/${signalPath}`,
    );
  }

  if (options.interactive) {
    lines.push(`├${horizontal}┤`);
    push(
      ` ${paint(PALETTE.dim, "q")} quit   ${paint(PALETTE.dim, "w")} cycle window   ` +
        `${paint(PALETTE.dim, "r")} refresh`,
    );
  }
  lines.push(`╰${horizontal}╯`);
  return lines.join("\n");
}

function renderProviderRow(
  provider: Provider,
  snapshot: UsageSnapshot,
  windowCount: number,
  paint: (code: string, value: string) => string,
): string {
  const palette = providerPalette(provider);
  const focus =
    snapshot.windows.find(
      (window) => window.label === snapshot.focusWindow,
    ) ?? snapshot.windows[0];
  const aggregate = focus?.providers[provider];
  const rateAggregate = snapshot.liveRate?.providers[provider];
  const lastEventAt = snapshot.liveRate
    ? rateAggregate?.lastEventAt
    : aggregate?.lastEventAt;
  return (
    ` ${paint(palette, pad(`● ${providerLabel(provider)}`, 10))}` +
    snapshot.windows
      .slice(0, windowCount)
      .map((window) => pad(formatTokens(window.providers[provider].total), 12, "right"))
      .join("") +
    pad(
      `${formatTokens(
        rateAggregate?.tokensPerMinute ?? 0,
      )}/min`,
      12,
      "right",
    ) +
    pad(
      String(rateAggregate?.observations ?? aggregate?.observations ?? 0),
      8,
      "right",
    ) +
    pad(
      lastEventAt === undefined
        ? "—"
        : relativeTime(lastEventAt, snapshot.generatedAt),
      9,
      "right",
    )
  );
}

function renderAllRow(
  snapshot: UsageSnapshot,
  windowCount: number,
  paint: (code: string, value: string) => string,
): string {
  const focus =
    snapshot.windows.find(
      (window) => window.label === snapshot.focusWindow,
    ) ?? snapshot.windows[0];
  const rateAggregate = snapshot.liveRate?.all;
  const lastEventAt = snapshot.liveRate
    ? rateAggregate?.lastEventAt
    : focus?.all.lastEventAt;
  return (
    ` ${paint(PALETTE.total, pad("Σ ALL", 10))}` +
    snapshot.windows
      .slice(0, windowCount)
      .map((window) => pad(formatTokens(window.all.total), 12, "right"))
      .join("") +
    pad(
      `${formatTokens(
        rateAggregate?.tokensPerMinute ??
          snapshot.recentTokensPerMinute,
      )}/min`,
      12,
      "right",
    ) +
    pad(
      String(rateAggregate?.observations ?? focus?.all.observations ?? 0),
      8,
      "right",
    ) +
    pad(
      lastEventAt === undefined
        ? "—"
        : relativeTime(lastEventAt, snapshot.generatedAt),
      9,
      "right",
    )
  );
}

function renderQuota(
  provider: Provider,
  snapshot: UsageSnapshot,
  innerWidth: number,
  paint: (code: string, value: string) => string,
): string {
  const quota = snapshot.quotas[provider];
  const providerColor = providerPalette(provider);
  if (!quota || (!quota.primary && !quota.secondary)) {
    const account = snapshot.accounts?.[provider];
    if (account?.loggedIn && account.subscriptionType) {
      return (
        ` ${paint(providerColor, pad(providerLabel(provider), 8))}  ` +
        `${paint(PALETTE.dim, `${account.subscriptionType.toUpperCase()} plan detected · usage unverified`)}`
      );
    }
    return ` ${paint(providerColor, pad(providerLabel(provider), 8))}  ${paint(PALETTE.dim, "waiting for provider-reported quota")}`;
  }

  const windows = [quota.primary, quota.secondary].filter(
    (window): window is QuotaWindow => window !== undefined,
  );
  const barWidth = innerWidth >= 98 ? 14 : 9;
  const values = windows.map((window) => {
    const label = formatQuotaDuration(window.windowMs);
    const percent = `${window.usedPercent.toFixed(0)}%`;
    return `${label} ${quotaBar(window.usedPercent, barWidth)} ${pad(percent, 4, "right")} ` +
      `${formatReset(window.resetsAt, snapshot.generatedAt)}`;
  });
  return ` ${paint(providerColor, pad(providerLabel(provider), 8))}  ${values.join("   ")}`;
}

function quotaBar(percent: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function sparkline(values: readonly number[]): string {
  const max = Math.max(0, ...values);
  if (max === 0) {
    return "▁".repeat(values.length);
  }
  return values
    .map((value) => {
      const index = Math.min(
        SPARKS.length - 1,
        Math.floor((value / max) * (SPARKS.length - 1)),
      );
      return SPARKS[index] ?? SPARKS[0];
    })
    .join("");
}

function resample(values: readonly number[], width: number): number[] {
  if (values.length <= width) {
    return [...values];
  }
  const result: number[] = [];
  for (let index = 0; index < width; index += 1) {
    const start = Math.floor((index / width) * values.length);
    const end = Math.max(
      start + 1,
      Math.floor(((index + 1) / width) * values.length),
    );
    result.push(
      values.slice(start, end).reduce((total, value) => total + value, 0),
    );
  }
  return result;
}

export function formatTokens(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 1_000) {
    return Math.round(value).toLocaleString("en-US");
  }
  const units: Array<[number, string]> = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (const [unit, suffix] of units) {
    if (absolute >= unit) {
      const scaled = value / unit;
      const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
      return `${scaled.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, "$1")}${suffix}`;
    }
  }
  return String(value);
}

function formatQuotaDuration(durationMs: number): string {
  if (durationMs >= 86_400_000 && durationMs % 86_400_000 === 0) {
    return `${durationMs / 86_400_000}d`;
  }
  if (durationMs >= 3_600_000) {
    return `${Math.round(durationMs / 3_600_000)}h`;
  }
  return `${Math.round(durationMs / 60_000)}m`;
}

function formatReset(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) {
    return "";
  }
  const remaining = Math.max(0, resetsAt - now);
  if (remaining < 60_000) {
    return "resets <1m";
  }
  if (remaining < 3_600_000) {
    return `resets ${Math.ceil(remaining / 60_000)}m`;
  }
  if (remaining < 86_400_000) {
    return `resets ${(remaining / 3_600_000).toFixed(1)}h`;
  }
  return `resets ${(remaining / 86_400_000).toFixed(1)}d`;
}

function relativeTime(timestamp: number, now: number): string {
  const difference = Math.max(0, now - timestamp);
  if (difference < 5_000) {
    return "now";
  }
  if (difference < 60_000) {
    return `${Math.floor(difference / 1_000)}s`;
  }
  if (difference < 3_600_000) {
    return `${Math.floor(difference / 60_000)}m`;
  }
  return `${Math.floor(difference / 3_600_000)}h`;
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function providerLabel(provider: Provider): string {
  switch (provider) {
    case "codex": return "CODEX";
    case "claude": return "CLAUDE";
    case "gemini": return "GEMINI";
    case "copilot": return "COPILOT";
    case "qwen": return "QWEN";
    case "llamacpp": return "LLAMA.CPP";
    case "vllm": return "VLLM";
  }
}

function providerPalette(provider: Provider): string {
  switch (provider) {
    case "codex": return PALETTE.codex;
    case "claude": return PALETTE.claude;
    case "gemini": return PALETTE.gemini;
    case "copilot": return PALETTE.copilot;
    case "qwen": return PALETTE.qwen;
    case "llamacpp": return PALETTE.llamacpp;
    case "vllm": return PALETTE.vllm;
  }
}

function pad(
  value: string,
  width: number,
  align: "left" | "right" = "left",
): string {
  if (value.length >= width) {
    return value.slice(0, width);
  }
  return align === "right" ? value.padStart(width) : value.padEnd(width);
}

function boxLine(content: string, width: number): string {
  const visible = content.replace(ANSI_PATTERN, "");
  let safe = content;
  let length = visible.length;
  if (length > width) {
    safe = `${visible.slice(0, Math.max(0, width - 1))}…`;
    length = width;
  }
  return `│${safe}${" ".repeat(Math.max(0, width - length))}│`;
}

function colorizer(
  enabled: boolean,
): (code: string, value: string) => string {
  return enabled
    ? (code, value) => `${code}${value}${PALETTE.reset}`
    : (_code, value) => value;
}
