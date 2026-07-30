import {
  asRecord,
  nonNegative,
  parseTimestamp,
  readNumber,
  readRecord,
  readString,
  type JsonRecord,
} from "../json.js";
import { opaqueEventId } from "../id.js";
import type {
  QuotaSnapshot,
  QuotaWindow,
  UsageEvent,
} from "../model.js";
import type {
  CodexCounters,
  ParsedLine,
  ParserState,
} from "./types.js";

function parseQuotaWindow(value: unknown): QuotaWindow | undefined {
  const window = asRecord(value);
  const usedPercent = readNumber(window, "used_percent", "usedPercent");
  const windowMinutes = readNumber(
    window,
    "window_minutes",
    "windowDurationMins",
  );
  if (usedPercent === undefined || windowMinutes === undefined) {
    return undefined;
  }

  const result: QuotaWindow = {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowMs: Math.max(0, windowMinutes * 60_000),
  };
  const resetsAt = readNumber(window, "resets_at", "resetsAt");
  if (resetsAt !== undefined) {
    result.resetsAt = resetsAt > 10_000_000_000 ? resetsAt : resetsAt * 1_000;
  }
  return result;
}

function parseQuota(
  payload: JsonRecord,
  timestamp: number,
): QuotaSnapshot | undefined {
  const value = readRecord(payload, "rate_limits");
  if (!value) {
    return undefined;
  }

  const primary = parseQuotaWindow(value.primary);
  const secondary = parseQuotaWindow(value.secondary);
  if (!primary && !secondary) {
    return undefined;
  }

  const quota: QuotaSnapshot = {
    provider: "codex",
    timestamp,
  };
  const planType = readString(value, "plan_type", "planType");
  if (planType) {
    quota.planType = planType;
  }
  if (primary) {
    quota.primary = primary;
  }
  if (secondary) {
    quota.secondary = secondary;
  }
  return quota;
}

function parseTokenEvent(
  record: JsonRecord,
  payload: JsonRecord,
  state: Readonly<ParserState>,
): ParsedLine {
  const timestamp = parseTimestamp(record.timestamp);
  if (timestamp === undefined) {
    return {};
  }

  const info = readRecord(payload, "info");
  const lastUsage = readRecord(info, "last_token_usage");
  if (!lastUsage) {
    const quota = parseQuota(payload, timestamp);
    return quota ? { quota } : {};
  }

  const last = readCounters(lastUsage);
  const cumulativeRecord = readRecord(info, "total_token_usage");
  const cumulative = cumulativeRecord
    ? readCounters(cumulativeRecord)
    : undefined;
  const quota = parseQuota(payload, timestamp);

  let delta = last;
  if (cumulative) {
    const previous = state.codexCumulative;
    if (previous && cumulative.total === previous.total) {
      return quota ? { quota, codexCumulative: cumulative } : { codexCumulative: cumulative };
    }
    if (
      previous &&
      cumulative.total > previous.total &&
      countersAreMonotonic(cumulative, previous)
    ) {
      delta = subtractCounters(cumulative, previous);
    } else if (previous && cumulative.total > previous.total) {
      // Component counters can reset independently during a schema or model
      // transition even while the authoritative total keeps increasing.
      delta = last;
    } else if (previous && cumulative.total < previous.total) {
      // A reset or schema transition is re-baselined from the provider's last
      // request counters rather than subtracting into negative usage.
      delta = last;
    } else if (!previous && cumulative.total !== last.total) {
      // A full file scan normally starts at zero. If a partial or migrated log
      // begins with an existing cumulative value, count only the explicit last
      // request to avoid attributing unknown history to the current instant.
      delta = last;
    }
  }
  if (delta.total === 0) {
    return cumulative
      ? quota
        ? { quota, codexCumulative: cumulative }
        : { codexCumulative: cumulative }
      : quota
        ? { quota }
        : {};
  }

  const stableSession = state.sessionId ?? state.sourceKey;
  const normalized = normalizeUsage(delta);
  const event: UsageEvent = {
    id: cumulative
      ? opaqueEventId(
          "codex",
          stableSession,
          String(timestamp),
          String(cumulative.total),
        )
      : opaqueEventId(
          "codex",
          stableSession,
          String(timestamp),
          String(delta.total),
        ),
    provider: "codex",
    timestamp,
    freshInput: normalized.freshInput,
    cacheRead: normalized.cacheRead,
    cacheWrite: normalized.cacheWrite,
    output: normalized.output,
    reasoning: normalized.reasoning,
    total: delta.total,
  };
  if (state.model) {
    event.model = state.model;
  }

  const parsed: ParsedLine = { event };
  if (quota) {
    parsed.quota = quota;
  }
  if (cumulative) {
    parsed.codexCumulative = cumulative;
  }
  return parsed;
}

function countersAreMonotonic(
  current: CodexCounters,
  previous: CodexCounters,
): boolean {
  return (
    current.input >= previous.input &&
    current.cacheRead >= previous.cacheRead &&
    current.cacheWrite >= previous.cacheWrite &&
    current.output >= previous.output &&
    current.reasoning >= previous.reasoning
  );
}

function normalizeUsage(delta: CodexCounters): {
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
} {
  const input = Math.min(delta.input, delta.total);
  const cacheRead = Math.min(delta.cacheRead, input);
  const cacheWrite = Math.min(delta.cacheWrite, input - cacheRead);
  const output = Math.max(0, delta.total - input);
  return {
    freshInput: input - cacheRead - cacheWrite,
    cacheRead,
    cacheWrite,
    output,
    reasoning: Math.min(delta.reasoning, output),
  };
}

function readCounters(record: JsonRecord): CodexCounters {
  const input = nonNegative(readNumber(record, "input_tokens"));
  const output = nonNegative(readNumber(record, "output_tokens"));
  return {
    input,
    cacheRead: nonNegative(readNumber(record, "cached_input_tokens")),
    cacheWrite: nonNegative(
      readNumber(record, "cache_write_input_tokens"),
    ),
    output,
    reasoning: nonNegative(readNumber(record, "reasoning_output_tokens")),
    total: nonNegative(readNumber(record, "total_tokens")) || input + output,
  };
}

function subtractCounters(
  current: CodexCounters,
  previous: CodexCounters,
): CodexCounters {
  return {
    input: Math.max(0, current.input - previous.input),
    cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - previous.cacheWrite),
    output: Math.max(0, current.output - previous.output),
    reasoning: Math.max(0, current.reasoning - previous.reasoning),
    total: Math.max(0, current.total - previous.total),
  };
}

export function parseCodexLine(
  value: unknown,
  state: Readonly<ParserState>,
): ParsedLine {
  const record = asRecord(value);
  if (!record) {
    return {};
  }

  const type = readString(record, "type");
  const payload = readRecord(record, "payload");
  if (!payload) {
    return {};
  }

  if (type === "session_meta") {
    // A forked Codex rollout can replay the parent's session_meta immediately
    // after its own first line. The first metadata record owns this file;
    // accepting a later replay would silently change event identity back to
    // the parent session.
    if (state.sessionId) {
      return {};
    }
    const rawSessionId =
      readString(payload, "id", "session_id", "sessionId") ??
      readString(readRecord(payload, "meta"), "id");
    if (!rawSessionId) {
      return {};
    }
    const parentSessionId = readParentSessionId(payload);
    const startedAt = parseTimestamp(record.timestamp);
    return {
      sessionId: opaqueEventId("codex-session", rawSessionId),
      ...(parentSessionId
        ? {
            codexParentSessionId: opaqueEventId(
              "codex-session",
              parentSessionId,
            ),
          }
        : {}),
      ...(startedAt !== undefined
        ? { codexSessionStartedAt: startedAt }
        : {}),
    };
  }

  if (type === "turn_context") {
    const model = readString(payload, "model", "model_slug", "modelSlug");
    return model ? { model } : {};
  }

  if (type === "event_msg" && readString(payload, "type") === "token_count") {
    return parseTokenEvent(record, payload, state);
  }

  return {};
}

function readParentSessionId(payload: JsonRecord): string | undefined {
  const direct = readString(
    payload,
    "forked_from_id",
    "forkedFromId",
    "parent_thread_id",
    "parentThreadId",
  );
  if (direct) {
    return direct;
  }
  const source = readRecord(payload, "source");
  const subagent = readRecord(source, "subagent");
  const threadSpawn =
    readRecord(subagent, "thread_spawn") ??
    readRecord(subagent, "threadSpawn");
  return readString(
    threadSpawn,
    "parent_thread_id",
    "parentThreadId",
  );
}
