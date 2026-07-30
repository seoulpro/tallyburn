import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import test from "node:test";
import {
  decodeOtlpAttributeValue,
  OtlpValidationError,
  parseClaudeOtlpLogs,
  parseClaudeOtlpMetrics,
  parseCopilotOtlpMetrics,
  parseGeminiOtlpMetrics,
  parseQwenOtlpMetrics,
  startClaudeOtlpReceiver,
} from "../src/otel.js";

const timestamp = Date.parse("2026-07-28T09:00:00.000Z");
const timeUnixNano = (BigInt(timestamp) * 1_000_000n).toString();

test("decodes primitive OTLP attribute values", () => {
  assert.equal(
    decodeOtlpAttributeValue({ stringValue: "value" }),
    "value",
  );
  assert.equal(
    decodeOtlpAttributeValue({ intValue: "42" }),
    42,
  );
  assert.equal(
    decodeOtlpAttributeValue({ doubleValue: 2.5 }),
    2.5,
  );
  assert.equal(
    decodeOtlpAttributeValue({ boolValue: true }),
    true,
  );
  assert.equal(
    decodeOtlpAttributeValue({ arrayValue: { values: [] } }),
    undefined,
  );
});

test("parses only Claude API request token metadata from OTLP logs", () => {
  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attribute("session.id", { stringValue: "session-1" }),
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                eventName: "claude_code.api_request",
                timeUnixNano,
                attributes: [
                  attribute("event.timestamp", {
                    stringValue: "2026-07-28T09:00:00.000Z",
                  }),
                  attribute("request_id", {
                    stringValue: "req-fixture-1",
                  }),
                  attribute("model", {
                    stringValue: "claude-fixture",
                  }),
                  attribute("input_tokens", { intValue: "12" }),
                  attribute("output_tokens", { doubleValue: 7 }),
                  attribute("cache_read_tokens", {
                    stringValue: "5",
                  }),
                  attribute("cache_creation_tokens", {
                    intValue: 3,
                  }),
                  attribute("success", { boolValue: true }),
                  attribute("unrelated", {
                    stringValue: "SENSITIVE_FIXTURE",
                  }),
                ],
              },
              {
                body: { stringValue: "claude_code.api_request" },
                timeUnixNano,
                attributes: [
                  attribute("event.sequence", { intValue: "9" }),
                  attribute("input_tokens", { intValue: "2" }),
                ],
              },
              {
                body: {
                  stringValue: "claude_code.api_request_body",
                },
                timeUnixNano,
                attributes: [
                  attribute("body", {
                    stringValue: "SENSITIVE_FIXTURE",
                  }),
                  attribute("input_tokens", { intValue: "999" }),
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const events = parseClaudeOtlpLogs(payload);
  assert.equal(events.length, 2);
  assert.match(events[0]?.id ?? "", /^claude:[A-Za-z0-9_-]{22}$/);
  assert.deepEqual({ ...events[0], id: undefined }, {
    id: undefined,
    provider: "claude",
    timestamp,
    model: "claude-fixture",
    freshInput: 12,
    cacheRead: 5,
    cacheWrite: 3,
    output: 7,
    reasoning: 0,
    total: 27,
  });
  assert.match(
    events[1]?.id ?? "",
    /^claude-otel-log:[A-Za-z0-9_-]{22}$/,
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /SENSITIVE_FIXTURE|req-fixture-1|session-1/,
  );
});

test("groups delta token metric points and drops all other attributes", () => {
  const payload = metricsPayload();
  const first = parseClaudeOtlpMetrics(payload);
  const replay = parseClaudeOtlpMetrics(payload);

  assert.equal(first.length, 1);
  assert.deepEqual(first, replay);
  assert.match(
    first[0]?.id ?? "",
    /^claude-otel-metric:[A-Za-z0-9_-]{22}$/,
  );
  assert.deepEqual({ ...first[0], id: undefined }, {
    id: undefined,
    provider: "claude",
    timestamp,
    model: "claude-fixture",
    freshInput: 100,
    cacheRead: 40,
    cacheWrite: 10,
    output: 20,
    reasoning: 0,
    total: 170,
  });
  assert.doesNotMatch(
    JSON.stringify(first),
    /SENSITIVE_FIXTURE|session-1/,
  );
});

test("accepts the named OTLP delta temporality encoding", () => {
  assert.equal(
    parseClaudeOtlpMetrics(
      metricsPayload("AGGREGATION_TEMPORALITY_DELTA"),
    ).length,
    1,
  );
});

test("parses Qwen token metrics without double-counting cached input", () => {
  const events = parseQwenOtlpMetrics(qwenMetricsPayload({
    aggregationTemporality: 1,
    input: 100,
    cache: 40,
    output: 20,
    thought: 5,
  }));

  assert.equal(events.length, 1);
  assert.match(
    events[0]?.id ?? "",
    /^qwen-otel-metric:[A-Za-z0-9_-]{22}$/,
  );
  assert.deepEqual({ ...events[0], id: undefined }, {
    id: undefined,
    provider: "qwen",
    timestamp,
    model: "qwen-fixture",
    freshInput: 60,
    cacheRead: 40,
    cacheWrite: 0,
    output: 25,
    reasoning: 5,
    total: 125,
  });
  assert.doesNotMatch(
    JSON.stringify(events),
    /SENSITIVE_FIXTURE|qwen-process-fixture/,
  );
});

test("parses Gemini CLI token metrics without double-counting cached input", () => {
  const events = parseGeminiOtlpMetrics(
    geminiMetricsPayload({
      input: 120,
      cache: 50,
      output: 30,
      thought: 8,
      tool: 12,
    }),
  );

  assert.equal(events.length, 1);
  assert.deepEqual({ ...events[0], id: undefined }, {
    id: undefined,
    provider: "gemini",
    timestamp,
    model: "gemini-fixture",
    freshInput: 82,
    cacheRead: 50,
    cacheWrite: 0,
    output: 38,
    reasoning: 8,
    total: 170,
  });
  assert.doesNotMatch(
    JSON.stringify(events),
    /SENSITIVE_FIXTURE|gemini-process-fixture/,
  );
});

test("parses only GitHub Copilot standard token histograms", () => {
  const events = parseCopilotOtlpMetrics(
    copilotMetricsPayload("github-copilot"),
  );
  assert.equal(events.length, 1);
  assert.deepEqual({ ...events[0], id: undefined }, {
    id: undefined,
    provider: "copilot",
    timestamp,
    model: "copilot-fixture",
    freshInput: 90,
    cacheRead: 0,
    cacheWrite: 0,
    output: 15,
    reasoning: 0,
    total: 105,
  });
  assert.deepEqual(
    parseCopilotOtlpMetrics(copilotMetricsPayload("other-service")),
    [],
  );
});

test("rejects malformed OTLP envelopes", () => {
  assert.throws(
    () => parseClaudeOtlpLogs({ resource_logs: [] }),
    OtlpValidationError,
  );
  assert.throws(
    () => parseClaudeOtlpMetrics({ resourceMetrics: {} }),
    OtlpValidationError,
  );
});

test("receives metrics on localhost and keeps logs opt-in", async (context) => {
  const received: unknown[] = [];
  const receiver = await startClaudeOtlpReceiver({
    port: 0,
    onEvents(events) {
      received.push(...events);
    },
  });
  context.after(async () => receiver.close());

  const metricsResponse = await fetch(receiver.metricsEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(metricsPayload()),
  });
  assert.equal(metricsResponse.status, 200);
  assert.equal(received.length, 1);

  const logsResponse = await fetch(receiver.logsEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resourceLogs: [] }),
  });
  assert.equal(logsResponse.status, 404);

  const wrongType = await fetch(receiver.metricsEndpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);

  const wrongMethod = await fetch(receiver.metricsEndpoint);
  assert.equal(wrongMethod.status, 405);
});

test("Qwen cumulative metrics use a baseline and ignore exporter replays", async (context) => {
  const received: Array<{ provider?: string; total?: number }> = [];
  const receiver = await startClaudeOtlpReceiver({
    port: 0,
    onEvents(events) {
      received.push(...events);
    },
  });
  context.after(async () => receiver.close());

  const startTimestamp = Date.now() - 60_000;
  const firstTimestamp = startTimestamp + 10_000;
  const secondTimestamp = firstTimestamp + 10_000;
  const first = qwenMetricsPayload({
    aggregationTemporality: 2,
    startTimestamp,
    pointTimestamp: firstTimestamp,
    input: 100,
    cache: 40,
    output: 20,
    thought: 5,
  });
  const second = qwenMetricsPayload({
    aggregationTemporality: 2,
    startTimestamp,
    pointTimestamp: secondTimestamp,
    input: 120,
    cache: 50,
    output: 25,
    thought: 8,
  });

  assert.equal(await postMetrics(receiver.metricsEndpoint, first), 200);
  assert.equal(received.length, 0);
  assert.equal(await postMetrics(receiver.metricsEndpoint, second), 200);
  assert.deepEqual(
    received.map(({ provider, total }) => ({ provider, total })),
    [{ provider: "qwen", total: 28 }],
  );
  assert.equal(await postMetrics(receiver.metricsEndpoint, second), 200);
  assert.equal(received.length, 1);

  const reset = qwenMetricsPayload({
    aggregationTemporality: 2,
    startTimestamp,
    pointTimestamp: secondTimestamp + 10_000,
    input: 10,
    cache: 2,
    output: 1,
    thought: 0,
  });
  const afterReset = qwenMetricsPayload({
    aggregationTemporality: 2,
    startTimestamp,
    pointTimestamp: secondTimestamp + 20_000,
    input: 15,
    cache: 3,
    output: 2,
    thought: 1,
  });
  assert.equal(await postMetrics(receiver.metricsEndpoint, reset), 200);
  assert.equal(received.length, 1);
  assert.equal(
    await postMetrics(receiver.metricsEndpoint, afterReset),
    200,
  );
  assert.deepEqual(received.map(({ total }) => total), [28, 7]);
});

test("Qwen counts the first cumulative export from a newly started process", async (context) => {
  const received: Array<{ total?: number }> = [];
  const receiver = await startClaudeOtlpReceiver({
    port: 0,
    onEvents(events) {
      received.push(...events);
    },
  });
  context.after(async () => receiver.close());

  const startTimestamp = Date.now();
  const response = await postMetrics(
    receiver.metricsEndpoint,
    qwenMetricsPayload({
      aggregationTemporality: 2,
      startTimestamp,
      pointTimestamp: startTimestamp + 1,
      input: 50,
      cache: 10,
      output: 12,
      thought: 3,
    }),
  );
  assert.equal(response, 200);
  assert.deepEqual(received.map(({ total }) => total), [65]);
});

test("log mode acknowledges but does not count duplicate metrics", async (context) => {
  const received: unknown[] = [];
  const receiver = await startClaudeOtlpReceiver({
    port: 0,
    allowLogs: true,
    onEvents(events) {
      received.push(...events);
    },
  });
  context.after(async () => receiver.close());

  const metricsResponse = await fetch(receiver.metricsEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metricsPayload()),
  });
  assert.equal(metricsResponse.status, 200);
  assert.equal(received.length, 0);

  const logsResponse = await fetch(receiver.logsEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  eventName: "claude_code.api_request",
                  timeUnixNano,
                  attributes: [
                    attribute("request_id", {
                      stringValue: "same-request",
                    }),
                    attribute("input_tokens", { intValue: "100" }),
                    attribute("output_tokens", { intValue: "20" }),
                    attribute("cache_read_tokens", { intValue: "40" }),
                    attribute("cache_creation_tokens", { intValue: "10" }),
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  assert.equal(logsResponse.status, 200);
  assert.equal(received.length, 1);
});

test("Claude log mode still accepts Qwen metrics", async (context) => {
  const received: Array<{ provider?: string }> = [];
  const receiver = await startClaudeOtlpReceiver({
    port: 0,
    allowLogs: true,
    onEvents(events) {
      received.push(...events);
    },
  });
  context.after(async () => receiver.close());

  const response = await postMetrics(
    receiver.metricsEndpoint,
    qwenMetricsPayload({
      aggregationTemporality: 1,
      input: 10,
      cache: 2,
      output: 3,
      thought: 1,
    }),
  );
  assert.equal(response, 200);
  assert.deepEqual(received.map(({ provider }) => provider), ["qwen"]);
});

test("receiver can restrict accepted metric providers", async (context) => {
  const received: Array<{ provider?: string }> = [];
  const receiver = await startClaudeOtlpReceiver({
    port: 0,
    providers: ["gemini"],
    onEvents(events) {
      received.push(...events);
    },
  });
  context.after(async () => receiver.close());

  assert.equal(
    await postMetrics(receiver.metricsEndpoint, metricsPayload()),
    200,
  );
  assert.equal(
    await postMetrics(
      receiver.metricsEndpoint,
      geminiMetricsPayload({
        input: 10,
        cache: 2,
        output: 3,
        thought: 1,
        tool: 0,
      }),
    ),
    200,
  );
  assert.deepEqual(received.map(({ provider }) => provider), ["gemini"]);
});

test("enforces the OTLP HTTP body limit", async (context) => {
  const receiver = await startClaudeOtlpReceiver({
    port: 0,
    maxBodyBytes: 32,
    onEvents() {},
  });
  context.after(async () => receiver.close());

  const response = await fetch(receiver.metricsEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resourceMetrics: [],
      padding: "x".repeat(64),
    }),
  });
  assert.equal(response.status, 413);
});

test("log-authoritative mode also bounds ignored metric bodies", async (context) => {
  const receiver = await startClaudeOtlpReceiver({
    port: 0,
    allowLogs: true,
    maxBodyBytes: 32,
    onEvents() {},
  });
  context.after(async () => receiver.close());

  const response = await fetch(receiver.metricsEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resourceMetrics: [],
      padding: "x".repeat(64),
    }),
  });
  assert.equal(response.status, 413);
});

test("receiver close terminates incomplete local requests", async () => {
  const receiver = await startClaudeOtlpReceiver({
    port: 0,
    onEvents() {},
  });
  const socket = createConnection({
    host: receiver.host,
    port: receiver.port,
  });
  await once(socket, "connect");
  socket.write(
    "POST /v1/metrics HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "Content-Type: application/json\r\n" +
      "Content-Length: 100\r\n\r\n{",
  );

  const started = Date.now();
  await receiver.close();
  assert.ok(Date.now() - started < 500);
  socket.destroy();
});

function metricsPayload(
  aggregationTemporality: unknown = 1,
): unknown {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            attribute("session.id", { stringValue: "session-1" }),
            attribute("unrelated", {
              stringValue: "SENSITIVE_FIXTURE",
            }),
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.token.usage",
                sum: {
                  aggregationTemporality,
                  dataPoints: [
                    metricPoint("input", { asInt: "100" }),
                    metricPoint("output", { asDouble: 20 }),
                    metricPoint("cacheRead", { asInt: 40 }),
                    metricPoint("cacheCreation", {
                      asDouble: "10",
                    }),
                  ],
                },
              },
              {
                name: "claude_code.token.usage",
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    metricPoint("input", { asInt: "999" }),
                  ],
                },
              },
              {
                name: "claude_code.cost.usage",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    metricPoint("input", { asInt: "999" }),
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function metricPoint(
  type: string,
  value: Record<string, unknown>,
): unknown {
  return {
    timeUnixNano,
    attributes: [
      attribute("unrelated", {
        stringValue: "SENSITIVE_FIXTURE",
      }),
      attribute("type", { stringValue: type }),
      attribute("model", { stringValue: "claude-fixture" }),
    ],
    ...value,
  };
}

function qwenMetricsPayload(options: {
  aggregationTemporality: unknown;
  input: number;
  cache: number;
  output: number;
  thought: number;
  startTimestamp?: number;
  pointTimestamp?: number;
}): unknown {
  const pointTime = options.pointTimestamp ?? timestamp;
  const commonPoint = {
    timeUnixNano: unixNano(pointTime),
    ...(options.startTimestamp === undefined
      ? {}
      : { startTimeUnixNano: unixNano(options.startTimestamp) }),
  };
  const point = (type: string, value: number): unknown => ({
    ...commonPoint,
    asInt: String(value),
    attributes: [
      attribute("type", { stringValue: type }),
      attribute("model", { stringValue: "qwen-fixture" }),
      attribute("response.body", {
        stringValue: "SENSITIVE_FIXTURE",
      }),
    ],
  });
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            attribute("service.instance.id", {
              stringValue: "qwen-process-fixture",
            }),
            attribute("unrelated", {
              stringValue: "SENSITIVE_FIXTURE",
            }),
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "qwen-code.token.usage",
                sum: {
                  aggregationTemporality:
                    options.aggregationTemporality,
                  dataPoints: [
                    point("input", options.input),
                    point("cache", options.cache),
                    point("output", options.output),
                    point("thought", options.thought),
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function geminiMetricsPayload(options: {
  input: number;
  cache: number;
  output: number;
  thought: number;
  tool: number;
}): unknown {
  const point = (type: string, value: number): unknown => ({
    timeUnixNano,
    asInt: String(value),
    attributes: [
      attribute("type", { stringValue: type }),
      attribute("model", { stringValue: "gemini-fixture" }),
      attribute("user.email", {
        stringValue: "SENSITIVE_FIXTURE",
      }),
    ],
  });
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            attribute("service.instance.id", {
              stringValue: "gemini-process-fixture",
            }),
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "gemini_cli.token.usage",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point("input", options.input),
                    point("cache", options.cache),
                    point("output", options.output),
                    point("thought", options.thought),
                    point("tool", options.tool),
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function copilotMetricsPayload(serviceName: string): unknown {
  const point = (type: string, sum: number): unknown => ({
    timeUnixNano,
    sum,
    count: 1,
    attributes: [
      attribute("gen_ai.token.type", { stringValue: type }),
      attribute("gen_ai.request.model", {
        stringValue: "copilot-fixture",
      }),
      attribute("gen_ai.input.messages", {
        stringValue: "SENSITIVE_FIXTURE",
      }),
    ],
  });
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            attribute("service.name", { stringValue: serviceName }),
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "gen_ai.client.token.usage",
                histogram: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point("input", 90),
                    point("output", 15),
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

async function postMetrics(
  endpoint: string,
  payload: unknown,
): Promise<number> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.status;
}

function unixNano(value: number): string {
  return (BigInt(value) * 1_000_000n).toString();
}

function attribute(
  key: string,
  value: Record<string, unknown>,
): unknown {
  return { key, value };
}
