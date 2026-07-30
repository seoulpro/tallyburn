import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeLine } from "../src/parsers/claude.js";
import { parseCodexLine } from "../src/parsers/codex.js";
import { providerRecord, type Provider } from "../src/model.js";
import type { ParserState } from "../src/parsers/types.js";
import { UsageStore } from "../src/store.js";

test("Codex keeps the fork file identity when parent metadata is replayed", () => {
  const state: ParserState = { sourceKey: "fixture" };
  const child = parseCodexLine(
    {
      timestamp: "2026-07-28T00:00:10.000Z",
      type: "session_meta",
      payload: {
        id: "child-session",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "parent-session",
            },
          },
        },
      },
    },
    state,
  );
  assert.ok(child.sessionId);
  assert.ok(child.codexParentSessionId);
  assert.equal(
    child.codexSessionStartedAt,
    Date.parse("2026-07-28T00:00:10.000Z"),
  );
  state.sessionId = child.sessionId;
  state.codexParentSessionId = child.codexParentSessionId;

  const replayedParent = parseCodexLine(
    {
      timestamp: "2026-07-28T00:00:10.001Z",
      type: "session_meta",
      payload: { id: "parent-session" },
    },
    state,
  );
  assert.deepEqual(replayedParent, {});
});

test("Codex uses cumulative deltas and ignores replayed counters", () => {
  const state: ParserState = { sourceKey: "fixture" };
  const meta = parseCodexLine(
    { type: "session_meta", payload: { id: "session-1" } },
    state,
  );
  assert.ok(meta.sessionId);
  state.sessionId = meta.sessionId;

  const first = parseCodexLine(
    codexTokenLine(
      "2026-07-28T00:00:00.000Z",
      counters(100, 30, 10),
      counters(100, 30, 10),
    ),
    state,
  );
  assert.equal(first.event?.total, 110);
  assert.equal(first.event?.freshInput, 70);
  assert.ok(first.codexCumulative);
  state.codexCumulative = first.codexCumulative;

  const replay = parseCodexLine(
    codexTokenLine(
      "2026-07-28T00:00:01.000Z",
      counters(100, 30, 10),
      counters(100, 30, 10),
    ),
    state,
  );
  assert.equal(replay.event, undefined);
  assert.ok(replay.codexCumulative);
  state.codexCumulative = replay.codexCumulative;

  const second = parseCodexLine(
    codexTokenLine(
      "2026-07-28T00:01:00.000Z",
      counters(40, 20, 5),
      counters(140, 50, 15),
    ),
    state,
  );
  assert.equal(second.event?.total, 45);
  assert.equal(second.event?.freshInput, 20);
  assert.equal(second.event?.cacheRead, 20);
});

test("Codex cumulative resets cannot overwrite an earlier equal total", () => {
  const state: ParserState = {
    sourceKey: "fixture",
    sessionId: "session-reset",
  };
  const store = new UsageStore();
  const observations = [
    codexTokenLine(
      "2026-07-28T00:00:00.000Z",
      counters(90, 0, 10),
      counters(90, 0, 10),
    ),
    codexTokenLine(
      "2026-07-28T00:01:00.000Z",
      counters(90, 0, 10),
      counters(180, 0, 20),
    ),
    codexTokenLine(
      "2026-07-28T00:02:00.000Z",
      counters(90, 0, 10),
      counters(90, 0, 10),
    ),
  ];

  const ids: string[] = [];
  for (const observation of observations) {
    const parsed = parseCodexLine(observation, state);
    assert.ok(parsed.event);
    assert.ok(parsed.codexCumulative);
    store.upsertEvent(parsed.event);
    state.codexCumulative = parsed.codexCumulative;
    ids.push(parsed.event.id);
  }

  assert.equal(new Set(ids).size, 3);
  const snapshot = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    providerRecord(status),
    Date.parse("2026-07-28T00:30:00.000Z"),
  );
  assert.equal(snapshot.windows[0]?.providers.codex.total, 300);
});

test("Codex re-baselines when component counters reset independently", () => {
  const state: ParserState = {
    sourceKey: "fixture",
    sessionId: "session-components",
    codexCumulative: {
      input: 100,
      cacheRead: 60,
      cacheWrite: 0,
      output: 100,
      reasoning: 50,
      total: 200,
    },
  };
  const parsed = parseCodexLine(
    codexTokenLine(
      "2026-07-28T00:01:00.000Z",
      counters(50, 20, 100),
      counters(50, 20, 200),
    ),
    state,
  );

  assert.equal(parsed.event?.total, 150);
  assert.equal(
    (parsed.event?.freshInput ?? 0) +
      (parsed.event?.cacheRead ?? 0) +
      (parsed.event?.cacheWrite ?? 0) +
      (parsed.event?.output ?? 0),
    150,
  );
});

test("Claude repeated content blocks collapse to the final message usage", () => {
  const store = new UsageStore();
  const state: ParserState = { sourceKey: "fixture" };
  const early = parseClaudeLine(
    claudeLine("2026-07-28T00:00:00.000Z", "msg-1", 100),
    state,
  );
  const final = parseClaudeLine(
    claudeLine("2026-07-28T00:00:01.000Z", "msg-1", 180),
    state,
  );
  assert.equal(early.event?.id, final.event?.id);
  assert.ok(early.event);
  assert.ok(final.event);
  store.upsertEvent(early.event);
  store.upsertEvent(final.event);
  const snapshot = store.snapshot(
    [{ label: "1h", durationMs: 3_600_000 }],
    0,
    providerRecord(status),
    Date.parse("2026-07-28T00:30:00.000Z"),
  );
  assert.equal(snapshot.windows[0]?.providers.claude.observations, 1);
  assert.equal(snapshot.windows[0]?.providers.claude.output, 180);
});

test("Claude structured limit errors update the matching quota window", () => {
  const sessionTimestamp = Date.parse("2026-07-28T00:05:00.000Z");
  const session = parseClaudeLine(
    claudeLimitLine(
      sessionTimestamp,
      "You've hit your session limit · resets 4:30am (UTC)",
    ),
    { sourceKey: "fixture" },
  );
  assert.deepEqual(session.quotaWindowUpdate, {
    provider: "claude",
    key: "primary",
    timestamp: sessionTimestamp,
    window: {
      usedPercent: 100,
      windowMs: 5 * 3_600_000,
      resetsAt: Date.parse("2026-07-28T04:30:00.000Z"),
    },
  });

  const weeklyTimestamp = Date.parse("2026-07-28T21:05:00.000Z");
  const weekly = parseClaudeLine(
    claudeLimitLine(
      weeklyTimestamp,
      "You've hit your weekly limit · resets 8pm (UTC)",
    ),
    { sourceKey: "fixture" },
  );
  assert.deepEqual(weekly.quotaWindowUpdate, {
    provider: "claude",
    key: "secondary",
    timestamp: weeklyTimestamp,
    window: {
      usedPercent: 100,
      windowMs: 7 * 24 * 3_600_000,
      resetsAt: Date.parse("2026-07-29T20:00:00.000Z"),
    },
  });
});

test("Claude limit text is ignored without the structured API error marker", () => {
  const timestamp = Date.parse("2026-07-28T00:05:00.000Z");
  const ordinary = claudeLimitLine(
    timestamp,
    "You've hit your session limit · resets 4:30am (UTC)",
  );
  delete ordinary.isApiErrorMessage;
  assert.deepEqual(
    parseClaudeLine(ordinary, { sourceKey: "fixture" }),
    {},
  );

  const unrelated = claudeLimitLine(
    timestamp,
    "A different rate limit message",
  );
  assert.deepEqual(
    parseClaudeLine(unrelated, { sourceKey: "fixture" }),
    {},
  );
});

test("parsers ignore transcript content and malformed shapes", () => {
  const canary = "SECRET-PROMPT-CANARY";
  const ignored = parseClaudeLine(
    {
      type: "user",
      message: { content: canary },
      timestamp: "2026-07-28T00:00:00.000Z",
    },
    { sourceKey: "fixture" },
  );
  assert.deepEqual(ignored, {});

  const claude = parseClaudeLine(
    {
      type: "assistant",
      timestamp: "2026-07-28T00:00:00.000Z",
      transcript_path: canary,
      message: {
        id: "recognized-claude",
        content: [{ type: "text", text: canary }],
        usage: {
          input_tokens: 5,
          output_tokens: 7,
        },
      },
    },
    { sourceKey: "fixture" },
  );
  const codex = parseCodexLine(
    {
      timestamp: "2026-07-28T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        prompt: canary,
        tool_arguments: { path: canary },
        info: {
          last_token_usage: counters(5, 0, 7),
          total_token_usage: counters(5, 0, 7),
        },
      },
    },
    { sourceKey: "fixture" },
  );

  assert.equal(claude.event?.total, 12);
  assert.equal(codex.event?.total, 12);
  assert.doesNotMatch(
    JSON.stringify({ ignored, claude, codex }),
    /SECRET-PROMPT-CANARY/,
  );
});

function counters(input: number, cached: number, output: number) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: Math.floor(output / 2),
    total_tokens: input + output,
  };
}

function codexTokenLine(
  timestamp: string,
  last: ReturnType<typeof counters>,
  total: ReturnType<typeof counters>,
) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: last,
        total_token_usage: total,
      },
    },
  };
}

function claudeLine(timestamp: string, id: string, output: number) {
  return {
    type: "assistant",
    timestamp,
    message: {
      id,
      model: "claude-fixture",
      usage: {
        input_tokens: 5,
        cache_read_input_tokens: 90,
        cache_creation_input_tokens: 10,
        output_tokens: output,
      },
      content: [{ type: "text", text: "not inspected" }],
    },
  };
}

function claudeLimitLine(
  timestamp: number,
  text: string,
): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: new Date(timestamp).toISOString(),
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    error: "rate_limit",
    message: {
      id: `limit-${timestamp}`,
      model: "<synthetic>",
      content: [{ type: "text", text }],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  };
}

function status(provider: Provider) {
  return {
    provider,
    root: "fixture",
    available: true,
    filesSeen: 1,
    filesRead: 1,
    malformedLines: 0,
  };
}
