import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePrometheusTokenCounters,
  PrometheusTokenCollector,
  validatePrometheusMetricsUrl,
} from "../src/prometheus.js";

test("parses only exact llama.cpp and vLLM token counters", () => {
  const llama = parsePrometheusTokenCounters(
    [
      "# HELP ignored",
      "llamacpp:prompt_tokens_total 120",
      "llamacpp:tokens_predicted_total 30",
      "llamacpp:prompt_tokens_total_evil 999",
      "process_cpu_seconds_total 42",
    ].join("\n"),
    "llamacpp",
  );
  assert.deepEqual(
    llama.map(({ component, value }) => ({ component, value })),
    [
      { component: "freshInput", value: 120 },
      { component: "output", value: 30 },
    ],
  );

  const vllm = parsePrometheusTokenCounters(
    [
      'vllm:prompt_tokens_total{model_name="qwen/test",worker="a"} 100',
      'vllm:generation_tokens_total{model_name="qwen/test",worker="a"} 20',
    ].join("\n"),
    "vllm",
  );
  assert.deepEqual(vllm.map(({ model }) => model), [
    "qwen/test",
    "qwen/test",
  ]);
});

test("local runtime collector baselines lifetime counters and emits deltas", async () => {
  const bodies = [
    [
      'vllm:prompt_tokens_total{model_name="fixture"} 100',
      'vllm:generation_tokens_total{model_name="fixture"} 20',
    ].join("\n"),
    [
      'vllm:prompt_tokens_total{model_name="fixture"} 135',
      'vllm:generation_tokens_total{model_name="fixture"} 29',
    ].join("\n"),
  ];
  const collector = new PrometheusTokenCollector({
    provider: "vllm",
    url: "http://127.0.0.1:8000/metrics",
    fetch: async () =>
      new Response(bodies.shift() ?? "", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
  });

  const first = await collector.poll(1_000);
  const second = await collector.poll(2_000);
  assert.equal(first.available, true);
  assert.deepEqual(first.events, []);
  assert.deepEqual(
    second.events.map(({ id: _id, ...event }) => event),
    [
      {
        provider: "vllm",
        timestamp: 2_000,
        model: "fixture",
        freshInput: 35,
        cacheRead: 0,
        cacheWrite: 0,
        output: 9,
        reasoning: 0,
        total: 44,
      },
    ],
  );
});

test("Prometheus adapters accept only unauthenticated loopback HTTP URLs", () => {
  assert.equal(
    validatePrometheusMetricsUrl(
      "http://localhost:8080/metrics",
    ).hostname,
    "localhost",
  );
  for (const value of [
    "https://127.0.0.1/metrics",
    "http://example.com/metrics",
    "http://user:pass@127.0.0.1/metrics",
    "http://127.0.0.1/metrics?secret=value",
  ]) {
    assert.throws(
      () => validatePrometheusMetricsUrl(value),
      /loopback HTTP URL/,
    );
  }
});
