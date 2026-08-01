import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiagnostics,
  type Provider,
  type SourceStatus,
  type UsageSnapshot,
} from "tallyburn";

test("diagnostics explain activity and quota availability without private data", () => {
  const now = 1_000_000;
  const snapshot = emptySnapshot(now);
  snapshot.sources.codex = source("codex", {
    available: true,
    lastEventAt: now - 30_000,
  });
  snapshot.sources.claude = source("claude", {
    available: true,
    lastEventAt: now - 90_000,
    malformedLines: 2,
  });
  snapshot.quotas.codex = {
    provider: "codex",
    timestamp: now - 5_000,
    primary: { usedPercent: 12, windowMs: 5 * 60 * 60_000 },
  };
  snapshot.accounts = {
    claude: {
      provider: "claude",
      observedAt: now - 10_000,
      loggedIn: true,
      subscriptionType: "max",
    },
  };

  const diagnostics = buildDiagnostics(snapshot, {
    providers: ["codex", "claude", "gemini"],
    running: true,
    collectionMode: "watch",
    backfill: true,
    otelEnabled: true,
    codexAccount: true,
    claudeAccount: true,
    llamaCppMetrics: false,
    vllmMetrics: false,
    demo: false,
  });

  assert.equal(diagnostics.engine.state, "watch");
  assert.equal(diagnostics.providers.codex?.activity.state, "active");
  assert.equal(diagnostics.providers.codex?.quota.state, "fresh");
  assert.equal(diagnostics.providers.codex?.quota.ageMs, 5_000);
  assert.equal(diagnostics.providers.claude?.collection, "hybrid");
  assert.equal(diagnostics.providers.claude?.activity.state, "idle");
  assert.equal(
    diagnostics.providers.claude?.activity.malformedLines,
    2,
  );
  assert.equal(
    diagnostics.providers.claude?.quota.state,
    "planDetected",
  );
  assert.equal(diagnostics.providers.gemini?.activity.state, "waiting");
  assert.doesNotMatch(JSON.stringify(diagnostics), /root|path|prompt|email/i);
});

test("diagnostics distinguish unavailable and unconfigured collection", () => {
  const snapshot = emptySnapshot(2_000_000);
  const diagnostics = buildDiagnostics(snapshot, {
    providers: ["codex", "claude", "qwen", "llamacpp"],
    running: false,
    collectionMode: "poll",
    backfill: true,
    otelEnabled: false,
    codexAccount: false,
    claudeAccount: true,
    llamaCppMetrics: true,
    vllmMetrics: false,
    demo: false,
  });

  assert.equal(diagnostics.engine.state, "stopped");
  assert.equal(diagnostics.providers.codex?.activity.state, "unavailable");
  assert.equal(diagnostics.providers.codex?.quota.state, "disabled");
  assert.equal(diagnostics.providers.claude?.quota.state, "waiting");
  assert.equal(
    diagnostics.providers.qwen?.activity.state,
    "notConfigured",
  );
  assert.equal(diagnostics.providers.llamacpp?.activity.state, "waiting");
  assert.equal(
    diagnostics.providers.llamacpp?.quota.state,
    "unsupported",
  );
});

function emptySnapshot(now: number): UsageSnapshot {
  const providers: Provider[] = [
    "codex",
    "claude",
    "gemini",
    "copilot",
    "qwen",
    "llamacpp",
    "vllm",
  ];
  return {
    generatedAt: now,
    windows: [],
    focusWindow: "1h",
    recentTokensPerMinute: 0,
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
    recentEvents: [],
    quotas: {},
    sources: Object.fromEntries(
      providers.map((provider) => [provider, source(provider)]),
    ) as Record<Provider, SourceStatus>,
  };
}

function source(
  provider: Provider,
  overrides: Partial<SourceStatus> = {},
): SourceStatus {
  return {
    provider,
    root: `/private/${provider}`,
    available: false,
    filesSeen: 0,
    filesRead: 0,
    malformedLines: 0,
    ...overrides,
  };
}
