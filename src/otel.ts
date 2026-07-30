import { createServer, type IncomingMessage, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { opaqueEventId } from "./id.js";
import type { Provider, UsageEvent } from "./model.js";

export {
  formatClaudeStatuslineQuota,
  parseClaudeStatuslineQuota,
  readClaudeStatuslineQuota,
  runClaudeStatuslineCommand,
} from "./statusline.js";
export type {
  ClaudeStatuslineCommandOptions,
  ClaudeStatuslineReadOptions,
} from "./statusline.js";

const API_REQUEST_EVENT = "claude_code.api_request";
const CLAUDE_TOKEN_USAGE_METRIC = "claude_code.token.usage";
const GEMINI_TOKEN_USAGE_METRIC = "gemini_cli.token.usage";
const GEN_AI_TOKEN_USAGE_METRIC = "gen_ai.client.token.usage";
const QWEN_TOKEN_USAGE_METRIC = "qwen-code.token.usage";
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const RECENT_PROCESS_START_TOLERANCE_MS = 15_000;
const MAX_CUMULATIVE_SERIES = 4_096;

type JsonRecord = Record<string, unknown>;
type OtlpScalar = string | number | boolean;
type LoopbackHost = "127.0.0.1" | "::1";

export class OtlpValidationError extends Error {
  constructor(message = "Invalid OTLP JSON payload") {
    super(message);
    this.name = "OtlpValidationError";
  }
}

export interface ClaudeOtlpHandlerOptions {
  /**
   * Makes allowlisted API request logs authoritative. The receiver acknowledges
   * but does not count metrics in this mode, preventing dual-export duplicates.
   * Metrics remain the default because they omit prompt and response bodies,
   * though identity and session attributes can still be present on input.
   */
  allowLogs?: boolean;
  maxBodyBytes?: number;
  providers?: readonly OtlpMetricProvider[];
  onEvents: (
    events: readonly UsageEvent[],
  ) => void | Promise<void>;
}

export interface ClaudeOtlpReceiverOptions
  extends ClaudeOtlpHandlerOptions {
  host?: LoopbackHost;
  port?: number;
}

export interface ClaudeOtlpReceiver {
  endpoint: string;
  host: LoopbackHost;
  logsEndpoint: string;
  metricsEndpoint: string;
  port: number;
  close(): Promise<void>;
}

interface MetricGroup {
  firstPointIndex: string;
  model?: string;
  present: Set<MetricComponent>;
  processKey: string;
  provider: MetricProvider;
  sessionKey: string;
  startTimestamp?: number;
  temporality: MetricTemporality;
  timestamp: number;
  timestampKey: string;
  values: Record<MetricComponent, number>;
}

export type OtlpMetricProvider = Extract<
  Provider,
  "claude" | "gemini" | "copilot" | "qwen"
>;
type MetricProvider = OtlpMetricProvider;
type MetricTemporality = "delta" | "cumulative";
type MetricComponent =
  | "freshInput"
  | "cacheRead"
  | "cacheWrite"
  | "output"
  | "reasoning";

interface MetricParseOptions {
  includeClaude: boolean;
  includeGemini: boolean;
  includeCopilot: boolean;
  includeQwen: boolean;
}

interface MetricAccumulatorOptions extends MetricParseOptions {
  startedAt?: number;
}

class OtlpMetricAccumulator {
  readonly #startedAt: number;
  readonly #includeClaude: boolean;
  readonly #includeGemini: boolean;
  readonly #includeCopilot: boolean;
  readonly #includeQwen: boolean;
  readonly #values = new Map<string, number>();
  readonly #seenProcesses = new Set<string>();

  constructor(options: MetricAccumulatorOptions) {
    this.#startedAt = options.startedAt ?? Date.now();
    this.#includeClaude = options.includeClaude;
    this.#includeGemini = options.includeGemini;
    this.#includeCopilot = options.includeCopilot;
    this.#includeQwen = options.includeQwen;
  }

  parse(payload: unknown): UsageEvent[] {
    if (this.#values.size > MAX_CUMULATIVE_SERIES) {
      this.#values.clear();
      this.#seenProcesses.clear();
    }

    const groups = collectTokenMetricGroups(payload, {
      includeClaude: this.#includeClaude,
      includeGemini: this.#includeGemini,
      includeCopilot: this.#includeCopilot,
      includeQwen: this.#includeQwen,
    });
    const previouslySeen = new Set(this.#seenProcesses);
    const events: UsageEvent[] = [];

    for (const group of groups) {
      if (group.temporality === "delta") {
        const event = metricGroupEvent(group, group.values);
        if (event) {
          events.push(event);
        }
        continue;
      }

      const values = emptyMetricValues();
      const recentProcess =
        group.startTimestamp !== undefined &&
        group.startTimestamp >=
          this.#startedAt - RECENT_PROCESS_START_TOLERANCE_MS;
      for (const component of group.present) {
        const key = JSON.stringify([
          group.processKey,
          group.model ?? "",
          component,
        ]);
        const current = group.values[component];
        const previous = this.#values.get(key);
        if (previous !== undefined && current >= previous) {
          values[component] = current - previous;
        } else if (
          previous === undefined &&
          (previouslySeen.has(group.processKey) || recentProcess)
        ) {
          values[component] = current;
        }
        this.#values.set(key, current);
      }
      const event = metricGroupEvent(group, values);
      if (event) {
        events.push(event);
      }
    }
    for (const group of groups) {
      if (group.temporality === "cumulative") {
        this.#seenProcesses.add(group.processKey);
      }
    }
    return events;
  }
}

/**
 * Decodes only primitive OTLP AnyValue variants used by Claude Code
 * attributes. Composite values are intentionally ignored.
 */
export function decodeOtlpAttributeValue(
  value: unknown,
): OtlpScalar | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  if (typeof record.stringValue === "string") {
    return record.stringValue;
  }

  const intValue = record.intValue;
  if (typeof intValue === "number") {
    return Number.isFinite(intValue) && Number.isInteger(intValue)
      ? intValue
      : undefined;
  }
  if (typeof intValue === "string" && /^-?\d+$/.test(intValue)) {
    const parsed = Number(intValue);
    return Number.isSafeInteger(parsed) ? parsed : intValue;
  }

  const doubleValue = record.doubleValue;
  if (typeof doubleValue === "number") {
    return Number.isFinite(doubleValue) ? doubleValue : undefined;
  }
  if (
    typeof doubleValue === "string" &&
    doubleValue.trim().length > 0
  ) {
    const parsed = Number(doubleValue);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return typeof record.boolValue === "boolean"
    ? record.boolValue
    : undefined;
}

/**
 * Parses OTLP/HTTP JSON log exports, retaining only token metadata from
 * claude_code.api_request records.
 */
export function parseClaudeOtlpLogs(payload: unknown): UsageEvent[] {
  const root = requireRecord(payload);
  const resourceLogs = requireArray(root, "resourceLogs");
  const events: UsageEvent[] = [];

  for (const resourceValue of resourceLogs) {
    const resourceLog = requireRecord(resourceValue);
    const resource = optionalRecord(resourceLog, "resource");
    const resourceAttributes = optionalAttributes(resource);
    const resourceSession = readStringAttribute(
      resourceAttributes,
      "session.id",
    );
    const scopeLogs = optionalArray(resourceLog, "scopeLogs");

    for (const scopeValue of scopeLogs) {
      const scopeLog = requireRecord(scopeValue);
      const logRecords = optionalArray(scopeLog, "logRecords");

      for (const logValue of logRecords) {
        const logRecord = requireRecord(logValue);
        const attributes = optionalAttributes(logRecord);
        if (!isApiRequestLog(logRecord)) {
          continue;
        }

        const event = parseApiRequestLog(
          logRecord,
          attributes,
          resourceSession,
        );
        if (event) {
          events.push(event);
        }
      }
    }
  }

  return events;
}

/**
 * Parses delta claude_code.token.usage sums. Point attributes other than
 * type, model, and session.id are never decoded or copied.
 */
export function parseClaudeOtlpMetrics(payload: unknown): UsageEvent[] {
  return collectTokenMetricGroups(payload, {
    includeClaude: true,
    includeGemini: false,
    includeCopilot: false,
    includeQwen: false,
  })
    .filter((group) => group.temporality === "delta")
    .flatMap((group) => {
      const event = metricGroupEvent(group, group.values);
      return event ? [event] : [];
    });
}

/**
 * Parses delta qwen-code.token.usage sums. The live receiver also supports
 * cumulative counters with a bounded in-memory baseline.
 */
export function parseQwenOtlpMetrics(payload: unknown): UsageEvent[] {
  return collectTokenMetricGroups(payload, {
    includeClaude: false,
    includeGemini: false,
    includeCopilot: false,
    includeQwen: true,
  })
    .filter((group) => group.temporality === "delta")
    .flatMap((group) => {
      const event = metricGroupEvent(group, group.values);
      return event ? [event] : [];
    });
}

/**
 * Parses Gemini CLI's official token counter metric. The live receiver also
 * supports cumulative counters with a bounded in-memory baseline.
 */
export function parseGeminiOtlpMetrics(payload: unknown): UsageEvent[] {
  return collectTokenMetricGroups(payload, {
    includeClaude: false,
    includeGemini: true,
    includeCopilot: false,
    includeQwen: false,
  })
    .filter((group) => group.temporality === "delta")
    .flatMap((group) => {
      const event = metricGroupEvent(group, group.values);
      return event ? [event] : [];
    });
}

/**
 * Parses the standard GenAI token histogram only when its resource identifies
 * the official GitHub Copilot CLI service. Arbitrary OTLP producers are not
 * attributed to Copilot.
 */
export function parseCopilotOtlpMetrics(payload: unknown): UsageEvent[] {
  return collectTokenMetricGroups(payload, {
    includeClaude: false,
    includeGemini: false,
    includeCopilot: true,
    includeQwen: false,
  })
    .filter((group) => group.temporality === "delta")
    .flatMap((group) => {
      const event = metricGroupEvent(group, group.values);
      return event ? [event] : [];
    });
}

function collectTokenMetricGroups(
  payload: unknown,
  options: MetricParseOptions,
): MetricGroup[] {
  const root = requireRecord(payload);
  const resourceMetrics = requireArray(root, "resourceMetrics");
  const groups: MetricGroup[] = [];

  for (
    let resourceIndex = 0;
    resourceIndex < resourceMetrics.length;
    resourceIndex += 1
  ) {
    const resourceMetric = requireRecord(resourceMetrics[resourceIndex]);
    const resource = optionalRecord(resourceMetric, "resource");
    const resourceAttributes = optionalAttributes(resource);
    const resourceSession = readStringAttribute(
      resourceAttributes,
      "session.id",
    );
    const resourceInstance =
      readStringAttribute(resourceAttributes, "service.instance.id") ??
      identifierValue(
        readAttribute(resourceAttributes, "process.pid"),
      ) ??
      `resource-${resourceIndex}`;
    const scopeMetrics = optionalArray(resourceMetric, "scopeMetrics");
    const resourceGroups = new Map<string, MetricGroup>();

    for (
      let scopeIndex = 0;
      scopeIndex < scopeMetrics.length;
      scopeIndex += 1
    ) {
      const scopeMetric = requireRecord(scopeMetrics[scopeIndex]);
      const metrics = optionalArray(scopeMetric, "metrics");

      for (
        let metricIndex = 0;
        metricIndex < metrics.length;
        metricIndex += 1
      ) {
        const metric = requireRecord(metrics[metricIndex]);
        const provider = metricProvider(
          metric.name,
          resourceAttributes,
        );
        if (
          !provider ||
          (provider === "claude" && !options.includeClaude) ||
          (provider === "gemini" && !options.includeGemini) ||
          (provider === "copilot" && !options.includeCopilot) ||
          (provider === "qwen" && !options.includeQwen)
        ) {
          continue;
        }

        const aggregation =
          provider === "copilot"
            ? optionalRecord(metric, "histogram")
            : optionalRecord(metric, "sum");
        const temporality = metricTemporality(
          aggregation?.aggregationTemporality,
        );
        if (!aggregation || !temporality) {
          continue;
        }
        const dataPoints = optionalArray(aggregation, "dataPoints");

        for (
          let pointIndex = 0;
          pointIndex < dataPoints.length;
          pointIndex += 1
        ) {
          const point = requireRecord(dataPoints[pointIndex]);
          const attributes = optionalAttributes(point);
          const component = metricComponent(
            provider,
            readStringAttribute(
              attributes,
              provider === "copilot" ? "gen_ai.token.type" : "type",
            ),
          );
          if (!component) {
            continue;
          }
          const value =
            provider === "copilot"
              ? finiteNumber(point.sum)
              : readDataPointValue(point);
          const time = parseUnixNano(
            point.timeUnixNano ?? point.observedTimeUnixNano,
          );
          if (value === undefined || value < 0 || !time) {
            continue;
          }

          const model =
            readStringAttribute(
              attributes,
              provider === "copilot" ? "gen_ai.request.model" : "model",
            ) ??
            readStringAttribute(attributes, "gen_ai.response.model");
          const session =
            readStringAttribute(attributes, "session.id") ??
            resourceSession;
          const startTime = parseUnixNano(point.startTimeUnixNano);
          if (temporality === "cumulative" && !startTime) {
            continue;
          }
          const sessionKey =
            session === undefined
              ? `instance-${resourceInstance}`
              : `session-${session}`;
          const processKey = JSON.stringify([
            provider,
            sessionKey,
            startTime?.key ?? "delta",
          ]);
          const groupKey = JSON.stringify([
            provider,
            temporality,
            sessionKey,
            startTime?.key ?? "",
            time.key,
            model ?? "",
          ]);
          let group = resourceGroups.get(groupKey);
          if (!group) {
            group = {
              firstPointIndex: `${scopeIndex}.${metricIndex}.${pointIndex}`,
              present: new Set<MetricComponent>(),
              processKey,
              provider,
              sessionKey,
              ...(startTime
                ? { startTimestamp: startTime.timestamp }
                : {}),
              temporality,
              timestamp: time.timestamp,
              timestampKey: time.key,
              values: emptyMetricValues(),
            };
            if (model) {
              group.model = model;
            }
            resourceGroups.set(groupKey, group);
          }
          group.values[component] += value;
          group.present.add(component);
        }
      }
    }
    groups.push(...resourceGroups.values());
  }

  return groups;
}

export function createClaudeOtlpRequestHandler(
  options: ClaudeOtlpHandlerOptions,
): RequestListener {
  const maxBodyBytes = validateBodyLimit(
    options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  );
  const allowLogs = options.allowLogs ?? false;
  const providers = new Set<OtlpMetricProvider>(
    options.providers ?? ["claude", "gemini", "copilot", "qwen"],
  );
  const metricAccumulator = new OtlpMetricAccumulator({
    includeClaude: !allowLogs && providers.has("claude"),
    includeGemini: providers.has("gemini"),
    includeCopilot: providers.has("copilot"),
    includeQwen: providers.has("qwen"),
  });

  return (request, response) => {
    void handleRequest(
      request,
      response,
      maxBodyBytes,
      allowLogs,
      metricAccumulator,
      options.onEvents,
    );
  };
}

/**
 * Starts an OTLP/HTTP JSON receiver bound exclusively to an IP loopback
 * address. Port 0 may be used to select an available local port.
 */
export async function startClaudeOtlpReceiver(
  options: ClaudeOtlpReceiverOptions,
): Promise<ClaudeOtlpReceiver> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new TypeError("OTLP receiver host must be a loopback address");
  }
  const port = options.port ?? 4318;
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65_535
  ) {
    throw new TypeError("OTLP receiver port must be between 0 and 65535");
  }

  const server = createServer(createClaudeOtlpRequestHandler(options));
  server.maxConnections = 16;
  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("OTLP receiver did not expose a TCP address");
  }
  const actualPort = (address as AddressInfo).port;
  const urlHost = host === "::1" ? "[::1]" : host;
  const endpoint = `http://${urlHost}:${actualPort}`;
  let closed = false;

  return {
    endpoint,
    host,
    logsEndpoint: `${endpoint}/v1/logs`,
    metricsEndpoint: `${endpoint}/v1/metrics`,
    port: actualPort,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await closeServer(server);
    },
  };
}

function parseApiRequestLog(
  record: JsonRecord,
  attributes: readonly unknown[],
  resourceSession: string | undefined,
): UsageEvent | undefined {
  const timestamp =
    parseAttributeTimestamp(
      readAttribute(attributes, "event.timestamp"),
    ) ??
    parseUnixNano(
      record.timeUnixNano ?? record.observedTimeUnixNano,
    )?.timestamp;
  if (timestamp === undefined) {
    return undefined;
  }

  const requestId = readStringAttribute(attributes, "request_id");
  const sessionId =
    readStringAttribute(attributes, "session.id") ??
    resourceSession;
  const sequence = identifierValue(
    readAttribute(attributes, "event.sequence"),
  );
  let id: string;
  if (requestId) {
    id = opaqueEventId("claude", requestId);
  } else if (sessionId && sequence !== undefined) {
    id = opaqueEventId("claude-otel-log", sessionId, sequence);
  } else {
    return undefined;
  }

  const freshInput = readTokenCount(attributes, "input_tokens");
  const output = readTokenCount(attributes, "output_tokens");
  const cacheRead = readTokenCount(attributes, "cache_read_tokens");
  const cacheWrite = readTokenCount(
    attributes,
    "cache_creation_tokens",
  );
  const total = freshInput + output + cacheRead + cacheWrite;
  if (total === 0) {
    return undefined;
  }

  const event: UsageEvent = {
    id,
    provider: "claude",
    timestamp,
    freshInput,
    cacheRead,
    cacheWrite,
    output,
    reasoning: 0,
    total,
  };
  const model =
    readStringAttribute(attributes, "model") ??
    readStringAttribute(attributes, "gen_ai.request.model");
  if (model) {
    event.model = model;
  }
  return event;
}

function isApiRequestLog(record: JsonRecord): boolean {
  if (record.eventName === API_REQUEST_EVENT) {
    return true;
  }
  const body = decodeOtlpAttributeValue(record.body);
  return body === API_REQUEST_EVENT;
}

function metricGroupEvent(
  group: MetricGroup,
  values: Readonly<Record<MetricComponent, number>>,
): UsageEvent | undefined {
  const normalizedValues =
    group.provider === "qwen" || group.provider === "gemini"
      ? normalizeOverlappingMetricValues(values)
      : { ...values };
  const total =
    normalizedValues.freshInput +
    normalizedValues.cacheRead +
    normalizedValues.cacheWrite +
    normalizedValues.output;
  if (total <= 0) {
    return undefined;
  }
  const event: UsageEvent = {
    id: opaqueEventId(
      `${group.provider}-otel-metric`,
      group.processKey,
      group.timestampKey,
      group.firstPointIndex,
      group.model ?? "",
      String(total),
    ),
    provider: group.provider,
    timestamp: group.timestamp,
    ...normalizedValues,
    total,
  };
  if (group.model) {
    event.model = group.model;
  }
  return event;
}

/**
 * Qwen and Gemini report cached prompt tokens inside their input counters.
 * Convert them into mutually exclusive display components. Thought tokens are
 * added to output and retained as its reasoning subset without being counted
 * twice.
 */
function normalizeOverlappingMetricValues(
  values: Readonly<Record<MetricComponent, number>>,
): Record<MetricComponent, number> {
  const cacheRead =
    values.freshInput > 0
      ? Math.min(values.cacheRead, values.freshInput)
      : values.cacheRead;
  return {
    freshInput: Math.max(0, values.freshInput - cacheRead),
    cacheRead,
    cacheWrite: values.cacheWrite,
    output: values.output + values.reasoning,
    reasoning: values.reasoning,
  };
}

function emptyMetricValues(): Record<MetricComponent, number> {
  return {
    freshInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
  };
}

function metricProvider(
  value: unknown,
  resourceAttributes: readonly unknown[],
): MetricProvider | undefined {
  if (value === CLAUDE_TOKEN_USAGE_METRIC) {
    return "claude";
  }
  if (value === GEMINI_TOKEN_USAGE_METRIC) {
    return "gemini";
  }
  if (value === QWEN_TOKEN_USAGE_METRIC) {
    return "qwen";
  }
  if (
    value === GEN_AI_TOKEN_USAGE_METRIC &&
    readStringAttribute(resourceAttributes, "service.name") ===
      "github-copilot"
  ) {
    return "copilot";
  }
  return undefined;
}

function metricComponent(
  provider: MetricProvider,
  value: string | undefined,
): MetricComponent | undefined {
  if (provider === "claude") {
    switch (value) {
      case "input": return "freshInput";
      case "output": return "output";
      case "cacheRead": return "cacheRead";
      case "cacheCreation": return "cacheWrite";
      default: return undefined;
    }
  }
  if (provider === "copilot") {
    switch (value) {
      case "input": return "freshInput";
      case "output": return "output";
      default: return undefined;
    }
  }
  switch (value) {
    case "input":
    case "tool":
      return "freshInput";
    case "output": return "output";
    case "thought": return "reasoning";
    case "cache": return "cacheRead";
    default: return undefined;
  }
}

function metricTemporality(
  value: unknown,
): MetricTemporality | undefined {
  if (
    value === 1 ||
    value === "1" ||
    value === "AGGREGATION_TEMPORALITY_DELTA" ||
    value === "DELTA"
  ) {
    return "delta";
  }
  if (
    value === 2 ||
    value === "2" ||
    value === "AGGREGATION_TEMPORALITY_CUMULATIVE" ||
    value === "CUMULATIVE"
  ) {
    return "cumulative";
  }
  return undefined;
}

function readDataPointValue(
  point: JsonRecord,
): number | undefined {
  const value = point.asInt ?? point.asDouble;
  return finiteNumber(value);
}

function readTokenCount(
  attributes: readonly unknown[],
  key: string,
): number {
  const value = finiteNumber(readAttribute(attributes, key));
  return value === undefined ? 0 : Math.max(0, value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (
    typeof value === "string" &&
    value.trim().length > 0
  ) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function identifierValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function parseAttributeTimestamp(
  value: unknown,
): number | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  return undefined;
}

function parseUnixNano(
  value: unknown,
): { key: string; timestamp: number } | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    try {
      const nanos = BigInt(value);
      const timestamp = Number(nanos / 1_000_000n);
      return Number.isFinite(timestamp)
        ? { key: value, timestamp }
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  ) {
    const nanos = Math.trunc(value);
    return {
      key: String(nanos),
      timestamp: Math.floor(nanos / 1_000_000),
    };
  }
  return undefined;
}

function readStringAttribute(
  attributes: readonly unknown[],
  key: string,
): string | undefined {
  const value = readAttribute(attributes, key);
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}

function readAttribute(
  attributes: readonly unknown[],
  key: string,
): OtlpScalar | undefined {
  for (const attributeValue of attributes) {
    const attribute = requireRecord(attributeValue);
    if (attribute.key === key) {
      return decodeOtlpAttributeValue(attribute.value);
    }
  }
  return undefined;
}

function optionalAttributes(
  record: JsonRecord | undefined,
): readonly unknown[] {
  return record ? optionalArray(record, "attributes") : [];
}

function requireArray(
  record: JsonRecord,
  key: string,
): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new OtlpValidationError();
  }
  return value;
}

function optionalArray(
  record: JsonRecord,
  key: string,
): unknown[] {
  const value = record[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new OtlpValidationError();
  }
  return value;
}

function optionalRecord(
  record: JsonRecord,
  key: string,
): JsonRecord | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  return requireRecord(value);
}

function requireRecord(value: unknown): JsonRecord {
  const record = asRecord(value);
  if (!record) {
    throw new OtlpValidationError();
  }
  return record;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

async function handleRequest(
  request: IncomingMessage,
  response: Parameters<RequestListener>[1],
  maxBodyBytes: number,
  allowLogs: boolean,
  metricAccumulator: OtlpMetricAccumulator,
  onEvents: ClaudeOtlpHandlerOptions["onEvents"],
): Promise<void> {
  const signal =
    request.url === "/v1/metrics"
      ? "metrics"
      : request.url === "/v1/logs" && allowLogs
        ? "logs"
        : undefined;
  if (!signal) {
    writeResponse(response, 404);
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    writeResponse(response, 405);
    return;
  }
  if (!hasJsonContentType(request)) {
    writeResponse(response, 415);
    return;
  }
  if (!hasSupportedContentEncoding(request)) {
    writeResponse(response, 415);
    return;
  }
  let payload: unknown;
  try {
    payload = await readJsonBody(request, maxBodyBytes);
  } catch (error) {
    writeResponse(
      response,
      error instanceof BodyLimitError ? 413 : 400,
    );
    return;
  }

  let events: UsageEvent[];
  try {
    events =
      signal === "metrics"
        ? metricAccumulator.parse(payload)
        : parseClaudeOtlpLogs(payload);
  } catch (error) {
    writeResponse(
      response,
      error instanceof OtlpValidationError ? 400 : 500,
    );
    return;
  }

  try {
    if (events.length > 0) {
      await onEvents(events);
    }
  } catch {
    writeResponse(response, 500);
    return;
  }
  writeResponse(response, 200);
}

function hasJsonContentType(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string") {
    return false;
  }
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json";
}

function hasSupportedContentEncoding(
  request: IncomingMessage,
): boolean {
  const encoding = request.headers["content-encoding"];
  return (
    encoding === undefined ||
    (typeof encoding === "string" &&
      encoding.trim().toLowerCase() === "identity")
  );
}

class BodyLimitError extends Error {}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (
    typeof contentLength === "string" &&
    (/^\d+$/.test(contentLength) === false ||
      Number(contentLength) > maxBodyBytes)
  ) {
    request.resume();
    if (/^\d+$/.test(contentLength)) {
      throw new BodyLimitError();
    }
    throw new SyntaxError("Invalid Content-Length");
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  await new Promise<void>((resolve, reject) => {
    request.on("data", (chunk: Buffer | string) => {
      if (tooLarge) {
        return;
      }
      const buffer =
        typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.byteLength;
      if (bytes > maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", resolve);
    request.once("aborted", () => {
      reject(new Error("Request aborted"));
    });
    request.once("error", reject);
  });
  if (tooLarge) {
    throw new BodyLimitError();
  }
  if (bytes === 0) {
    throw new SyntaxError("Empty JSON body");
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
}

function writeResponse(
  response: Parameters<RequestListener>[1],
  statusCode: number,
): void {
  if (response.headersSent || response.destroyed) {
    return;
  }
  const body = "{}";
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function validateBodyLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("maxBodyBytes must be a positive integer");
  }
  return value;
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  server.closeAllConnections();
  await closed;
}
