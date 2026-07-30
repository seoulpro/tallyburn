import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_ACTIVITY_BUCKET_COUNT,
  LIVE_ACTIVITY_HISTORY_WINDOW_MS,
  LIVE_ACTIVITY_RATE_WINDOW_MS,
  LIVE_ACTIVITY_SAMPLE_INTERVAL_MS,
  type ActivityRatePoint,
  type LiveTokenActivity,
  type TokenActivityAggregate,
} from "tallyburn";

test("package root exports the live activity contract", () => {
  const aggregate: TokenActivityAggregate = {
    provider: "all",
    observedTokens: 1,
    tokensPerSecond: 0.2,
    observations: 1,
  };
  const point: ActivityRatePoint = {
    at: 1_000,
    tokensPerSecond: 0.2,
  };
  const activity: LiveTokenActivity = {
    historyWindowMs: LIVE_ACTIVITY_HISTORY_WINDOW_MS,
    sampleIntervalMs: LIVE_ACTIVITY_SAMPLE_INTERVAL_MS,
    rateWindowMs: LIVE_ACTIVITY_RATE_WINDOW_MS,
    all: aggregate,
    providers: {
      codex: { ...aggregate, provider: "codex" },
      claude: { ...aggregate, provider: "claude" },
      gemini: { ...aggregate, provider: "gemini" },
      copilot: { ...aggregate, provider: "copilot" },
      qwen: { ...aggregate, provider: "qwen" },
      llamacpp: { ...aggregate, provider: "llamacpp" },
      vllm: { ...aggregate, provider: "vllm" },
    },
    series: {
      all: [],
      codex: [],
      claude: [],
      gemini: [],
      copilot: [],
      qwen: [],
      llamacpp: [],
      vllm: [],
    },
    rateSeries: {
      all: [point],
      codex: [point],
      claude: [point],
      gemini: [point],
      copilot: [point],
      qwen: [point],
      llamacpp: [point],
      vllm: [point],
    },
  };

  assert.equal(LIVE_ACTIVITY_BUCKET_COUNT, 60);
  assert.equal(activity.historyWindowMs, 60_000);
  assert.equal(activity.sampleIntervalMs, 1_000);
  assert.equal(activity.rateWindowMs, 60_000);
});
