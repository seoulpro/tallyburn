import { opaqueEventId } from "./id.js";
import type { Provider, UsageEvent } from "./model.js";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

type PrometheusProvider = Extract<Provider, "llamacpp" | "vllm">;
type TokenComponent = "freshInput" | "output";

interface MetricDefinition {
  component: TokenComponent;
  name: string;
}

interface ParsedCounter {
  component: TokenComponent;
  model?: string;
  seriesKey: string;
  value: number;
}

export interface PrometheusTokenCollectorOptions {
  provider: PrometheusProvider;
  url: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  fetch?: typeof fetch;
}

export interface PrometheusPollResult {
  available: boolean;
  events: UsageEvent[];
}

/**
 * Polls exact, allowlisted token counters from a loopback-only Prometheus
 * endpoint. The first successful scrape establishes a baseline, so attaching
 * Tallyburn to a long-running server never presents old lifetime counters as
 * current activity.
 */
export class PrometheusTokenCollector {
  readonly #provider: PrometheusProvider;
  readonly #url: URL;
  readonly #timeoutMs: number;
  readonly #maxBodyBytes: number;
  readonly #fetch: typeof fetch;
  readonly #values = new Map<string, number>();

  constructor(options: PrometheusTokenCollectorOptions) {
    this.#provider = options.provider;
    this.#url = validatePrometheusMetricsUrl(options.url);
    this.#timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Prometheus timeout",
    );
    this.#maxBodyBytes = positiveInteger(
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      "Prometheus body limit",
    );
    this.#fetch = options.fetch ?? fetch;
  }

  get provider(): PrometheusProvider {
    return this.#provider;
  }

  get url(): string {
    return this.#url.href;
  }

  async poll(now = Date.now()): Promise<PrometheusPollResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#url, {
        headers: { accept: "text/plain" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok || response.status >= 300) {
        return { available: false, events: [] };
      }
      const body = await readBoundedText(response, this.#maxBodyBytes);
      const counters = parsePrometheusTokenCounters(
        body,
        this.#provider,
      );
      return {
        available: true,
        events: this.#eventsFromCounters(counters, now),
      };
    } catch {
      return { available: false, events: [] };
    } finally {
      clearTimeout(timeout);
    }
  }

  #eventsFromCounters(
    counters: readonly ParsedCounter[],
    timestamp: number,
  ): UsageEvent[] {
    const groups = new Map<
      string,
      { freshInput: number; output: number; model?: string }
    >();
    for (const counter of counters) {
      const key = `${counter.component}:${counter.seriesKey}`;
      const previous = this.#values.get(key);
      this.#values.set(key, counter.value);
      if (previous === undefined || counter.value < previous) {
        continue;
      }
      const delta = counter.value - previous;
      if (delta <= 0) {
        continue;
      }
      const modelKey = counter.model ?? "";
      let group = groups.get(modelKey);
      if (!group) {
        group = { freshInput: 0, output: 0 };
        if (counter.model) {
          group.model = counter.model;
        }
        groups.set(modelKey, group);
      }
      group[counter.component] += delta;
    }

    const events: UsageEvent[] = [];
    for (const [modelKey, group] of groups) {
      const total = group.freshInput + group.output;
      if (total <= 0) {
        continue;
      }
      const event: UsageEvent = {
        id: opaqueEventId(
          `${this.#provider}-prometheus`,
          this.#url.href,
          String(timestamp),
          modelKey,
          String(total),
        ),
        provider: this.#provider,
        timestamp,
        freshInput: group.freshInput,
        cacheRead: 0,
        cacheWrite: 0,
        output: group.output,
        reasoning: 0,
        total,
      };
      if (group.model) {
        event.model = group.model;
      }
      events.push(event);
    }
    return events;
  }
}

export function validatePrometheusMetricsUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError(`Invalid Prometheus metrics URL "${input}".`);
  }
  if (
    url.protocol !== "http:" ||
    !ALLOWED_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      "Prometheus metrics URL must be an unauthenticated loopback HTTP URL.",
    );
  }
  return url;
}

export function parsePrometheusTokenCounters(
  body: string,
  provider: PrometheusProvider,
): ParsedCounter[] {
  const definitions = metricDefinitions(provider);
  const byName = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );
  const counters: ParsedCounter[] = [];

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match =
      /^([A-Za-z_:][A-Za-z0-9_:]*)(\{[^]*\})?\s+([^\s]+)(?:\s+\d+)?$/.exec(
        trimmed,
      );
    if (!match) {
      continue;
    }
    const definition = byName.get(match[1] ?? "");
    const value = Number(match[3]);
    if (!definition || !Number.isFinite(value) || value < 0) {
      continue;
    }
    const labels = match[2] ?? "";
    const model = readPrometheusLabel(labels, "model_name");
    counters.push({
      component: definition.component,
      ...(model ? { model } : {}),
      seriesKey: `${match[1]}${labels}`,
      value,
    });
  }
  return counters;
}

function metricDefinitions(
  provider: PrometheusProvider,
): readonly MetricDefinition[] {
  return provider === "llamacpp"
    ? [
        {
          name: "llamacpp:prompt_tokens_total",
          component: "freshInput",
        },
        {
          name: "llamacpp:tokens_predicted_total",
          component: "output",
        },
      ]
    : [
        {
          name: "vllm:prompt_tokens_total",
          component: "freshInput",
        },
        {
          name: "vllm:generation_tokens_total",
          component: "output",
        },
      ];
}

function readPrometheusLabel(
  labels: string,
  key: string,
): string | undefined {
  if (!labels) {
    return undefined;
  }
  const pattern = new RegExp(
    `(?:^|[,{}])\\s*${escapeRegExp(key)}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`,
  );
  const match = pattern.exec(labels);
  if (!match?.[1]) {
    return undefined;
  }
  return match[1]
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

async function readBoundedText(
  response: Response,
  maxBodyBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maxBodyBytes
  ) {
    throw new RangeError("Prometheus metrics body is too large.");
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    bytes += value.byteLength;
    if (bytes > maxBodyBytes) {
      await reader.cancel();
      throw new RangeError("Prometheus metrics body is too large.");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
