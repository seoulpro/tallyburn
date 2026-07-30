import {
  DEFAULT_PROVIDERS,
  providerRecord,
  type Provider,
  type SourceStatus,
  type UsageEvent,
} from "./model.js";
import { UsageStore } from "./store.js";

interface DemoData {
  store: UsageStore;
  sources: Record<Provider, SourceStatus>;
  advance: (now: number) => void;
}

export function buildDemo(
  now = Date.now(),
  providers: readonly Provider[] = DEFAULT_PROVIDERS,
  retentionMs = 12 * 3_600_000,
): DemoData {
  const store = new UsageStore();
  let seed = 0x5eed;
  const random = (): number => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };

  for (let minutesAgo = 720; minutesAgo >= 0; minutesAgo -= 3) {
    for (const provider of providers) {
      if (random() < demoIdleProbability(provider)) {
        continue;
      }
      const intensity =
        0.45 +
        Math.sin((minutesAgo / 720) * Math.PI * 4) * 0.22 +
        (minutesAgo < 70 ? 0.75 : 0);
      const input = Math.round((3_000 + random() * 24_000) * intensity);
      const cacheRatio = 0.32 + random() * 0.5;
      const cacheRead = Math.round(input * cacheRatio);
      const output = Math.round(350 + random() * 2_900);
      const cacheWrite =
        provider === "claude" ? Math.round(random() * 3_200) : 0;
      const event: UsageEvent = {
        id: `demo:${provider}:${minutesAgo}`,
        provider,
        timestamp: now - minutesAgo * 60_000,
        freshInput: Math.max(0, input - cacheRead),
        cacheRead,
        cacheWrite,
        output,
        reasoning: demoReasoning(provider, output),
        total: input + cacheWrite + output,
        model: demoModel(provider),
      };
      store.upsertEvent(event);
    }
  }
  for (const provider of providers) {
    const input = demoLiveInput(provider);
    const output = demoLiveOutput(provider);
    store.upsertEvent({
      id: `demo:${provider}:live`,
      provider,
      timestamp: now - (provider === "codex" ? 2_000 : 19_000),
      freshInput: Math.round(input * 0.28),
      cacheRead: Math.round(input * 0.72),
      cacheWrite: provider === "claude" ? 2_600 : 0,
      output,
      reasoning: demoReasoning(provider, output),
      total: input + output + (provider === "claude" ? 2_600 : 0),
      model: demoModel(provider),
    });
  }
  if (providers.includes("codex")) {
    store.updateQuota({
      provider: "codex",
      timestamp: now,
      planType: "demo",
      primary: {
        usedPercent: 38,
        windowMs: 5 * 3_600_000,
        resetsAt: now + 2.1 * 3_600_000,
      },
      secondary: {
        usedPercent: 61,
        windowMs: 7 * 86_400_000,
        resetsAt: now + 3.4 * 86_400_000,
      },
    });
  }
  if (providers.includes("claude")) {
    store.updateQuota({
      provider: "claude",
      timestamp: now,
      planType: "demo",
      primary: {
        usedPercent: 27,
        windowMs: 5 * 3_600_000,
        resetsAt: now + 3.3 * 3_600_000,
      },
      secondary: {
        usedPercent: 44,
        windowMs: 7 * 86_400_000,
        resetsAt: now + 4.2 * 86_400_000,
      },
    });
  }

  const sources: Record<Provider, SourceStatus> = providerRecord(
    (provider) => ({
      provider,
      root: "demo",
      available: providers.includes(provider),
      filesSeen: providers.includes(provider) ? 1 : 0,
      filesRead: providers.includes(provider) ? 1 : 0,
      malformedLines: 0,
      ...(providers.includes(provider) ? { lastEventAt: now } : {}),
    }),
  );
  let lastLiveTick = Math.floor(now / 1_000);

  const advance = (advanceNow: number): void => {
    const tick = Math.floor(advanceNow / 1_000);
    if (tick <= lastLiveTick || providers.length === 0) {
      return;
    }
    lastLiveTick = tick;
    const provider = providers[Math.abs(tick) % providers.length];
    if (!provider) {
      return;
    }
    const timestamp = tick * 1_000;
    const wave = (Math.sin(tick / 3) + 1) / 2;
    const input = Math.round(
      demoLiveInput(provider) * 0.2 + wave * 14_000,
    );
    const output = Math.round(
      demoLiveOutput(provider) * 0.17 + wave * 2_400,
    );
    const cacheRead = Math.round(input * (0.45 + wave * 0.25));
    const cacheWrite =
      provider === "claude" ? Math.round(450 + wave * 1_100) : 0;
    store.upsertEvent({
      id: `demo:${provider}:live:${tick}`,
      provider,
      timestamp,
      freshInput: input - cacheRead,
      cacheRead,
      cacheWrite,
      output,
      reasoning: demoReasoning(provider, output),
      total: input + cacheWrite + output,
      model: demoModel(provider),
    });
    sources[provider].lastEventAt = timestamp;
    store.prune(timestamp - retentionMs - 60_000);
  };

  return {
    store,
    sources,
    advance,
  };
}

function demoIdleProbability(provider: Provider): number {
  switch (provider) {
    case "codex": return 0.52;
    case "claude": return 0.36;
    case "gemini": return 0.42;
    case "copilot": return 0.48;
    case "qwen": return 0.44;
    case "llamacpp": return 0.58;
    case "vllm": return 0.54;
  }
}

function demoLiveInput(provider: Provider): number {
  switch (provider) {
    case "codex": return 42_000;
    case "claude": return 28_000;
    case "gemini": return 31_000;
    case "copilot": return 24_000;
    case "qwen": return 34_000;
    case "llamacpp": return 12_000;
    case "vllm": return 19_000;
  }
}

function demoLiveOutput(provider: Provider): number {
  switch (provider) {
    case "codex": return 5_400;
    case "claude": return 4_200;
    case "gemini": return 4_600;
    case "copilot": return 3_800;
    case "qwen": return 4_800;
    case "llamacpp": return 1_900;
    case "vllm": return 3_100;
  }
}

function demoReasoning(provider: Provider, output: number): number {
  switch (provider) {
    case "codex": return Math.round(output * 0.28);
    case "claude": return 0;
    case "gemini": return Math.round(output * 0.22);
    case "copilot": return 0;
    case "qwen": return Math.round(output * 0.2);
    case "llamacpp":
    case "vllm":
      return 0;
  }
}

function demoModel(provider: Provider): string {
  switch (provider) {
    case "codex": return "gpt-demo-codex";
    case "claude": return "claude-demo-sonnet";
    case "gemini": return "gemini-demo-pro";
    case "copilot": return "copilot-demo";
    case "qwen": return "qwen-demo-coder";
    case "llamacpp": return "llama-demo-gguf";
    case "vllm": return "vllm-demo-model";
  }
}
