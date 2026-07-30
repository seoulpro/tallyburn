import assert from "node:assert/strict";
import test from "node:test";
import { buildDemo } from "../src/demo.js";
import { providerRecord } from "../src/model.js";
import { renderSnapshot } from "../src/render.js";
import { UsageStore } from "../src/store.js";

test("renders a bounded, readable no-color dashboard", () => {
  const now = Date.parse("2026-07-28T08:00:00.000Z");
  const demo = buildDemo(now);
  const snapshot = demo.store.snapshot(
    [
      { label: "1h", durationMs: 3_600_000 },
      { label: "3h", durationMs: 10_800_000 },
      { label: "12h", durationMs: 43_200_000 },
    ],
    0,
    demo.sources,
    now,
  );
  const output = renderSnapshot(snapshot, {
    color: false,
    width: 100,
  });
  assert.match(output, /TALLYBURN/);
  assert.match(output, /Observed pace/);
  assert.match(output, /trailing 1m/);
  assert.match(output, /Rolling token usage/);
  assert.match(output, /1-MIN PACE/);
  assert.match(output, /\/min/);
  assert.match(output, /5m avg/);
  assert.match(output, /CODEX/);
  assert.match(output, /CLAUDE/);
  assert.match(output, /SUBSCRIPTION QUOTA/);
  assert.doesNotMatch(output, /Token load average/);
  for (const line of output.split("\n")) {
    assert.ok(line.length <= 100, `line exceeded width: ${line.length}`);
  }
});

test("rate table observations and recency use the one-minute window", () => {
  const now = Date.parse("2026-07-28T08:00:00.000Z");
  const store = new UsageStore();
  for (const [id, timestamp, total] of [
    ["old", now - 10 * 60_000, 10],
    ["live", now - 1_000, 100],
  ] as const) {
    store.upsertEvent({
      id,
      provider: "codex",
      timestamp,
      freshInput: total,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total,
    });
  }
  const snapshot = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    providerRecord((provider) => ({
      provider,
      root:
        provider === "codex" || provider === "claude"
          ? "fixture"
          : "metrics",
      available: provider === "codex",
      filesSeen: provider === "codex" ? 1 : 0,
      filesRead: provider === "codex" ? 1 : 0,
      malformedLines: 0,
    })),
    now,
  );
  const output = renderSnapshot(snapshot, {
    color: false,
    width: 100,
  });
  const allRow = output
    .split("\n")
    .find((line) => line.includes("Σ ALL"));

  assert.ok(allRow);
  assert.match(allRow, /100\/min\s+1\s+now/);
  assert.doesNotMatch(allRow, /100\/min\s+2\s+/);
});

test("renders a detected Claude plan without inventing quota usage", () => {
  const now = Date.parse("2026-07-28T08:00:00.000Z");
  const demo = buildDemo(now);
  const snapshot = demo.store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    demo.sources,
    now,
  );
  snapshot.quotas = {};
  snapshot.accounts = {
    claude: {
      provider: "claude",
      observedAt: now,
      loggedIn: true,
      subscriptionType: "max",
    },
  };

  const output = renderSnapshot(snapshot, {
    color: false,
    width: 100,
  });
  assert.match(output, /MAX plan detected · usage unverified/);
  assert.doesNotMatch(output, /CLAUDE\s+.*0%/);
});
