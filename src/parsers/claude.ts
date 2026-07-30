import {
  asRecord,
  nonNegative,
  parseTimestamp,
  readNumber,
  readRecord,
  readString,
} from "../json.js";
import { opaqueEventId } from "../id.js";
import type { UsageEvent } from "../model.js";
import type { ParsedLine, ParserState } from "./types.js";

export function parseClaudeLine(
  value: unknown,
  state: Readonly<ParserState>,
): ParsedLine {
  const record = asRecord(value);
  if (!record || readString(record, "type") !== "assistant") {
    return {};
  }

  const message = readRecord(record, "message");
  const timestamp = parseTimestamp(record.timestamp);
  if (!message || timestamp === undefined) {
    return {};
  }

  const quotaWindowUpdate = parseClaudeLimitEvent(
    record,
    message,
    timestamp,
  );
  if (quotaWindowUpdate) {
    return { quotaWindowUpdate };
  }

  const usage = readRecord(message, "usage");
  if (!usage) {
    return {};
  }

  const messageId =
    readString(message, "id") ??
    readString(record, "requestId", "uuid") ??
    `${state.sourceKey}:${timestamp}`;
  const freshInput = nonNegative(readNumber(usage, "input_tokens"));
  const cacheRead = nonNegative(
    readNumber(usage, "cache_read_input_tokens"),
  );
  const cacheWrite = nonNegative(
    readNumber(usage, "cache_creation_input_tokens"),
  );
  const output = nonNegative(readNumber(usage, "output_tokens"));
  const total = freshInput + cacheRead + cacheWrite + output;
  if (total === 0) {
    return {};
  }

  const event: UsageEvent = {
    id: opaqueEventId("claude", messageId),
    provider: "claude",
    timestamp,
    freshInput,
    cacheRead,
    cacheWrite,
    output,
    reasoning: 0,
    total,
  };
  const model = readString(message, "model");
  if (model) {
    event.model = model;
  }
  return { event };
}

function parseClaudeLimitEvent(
  record: Record<string, unknown>,
  message: Record<string, unknown>,
  timestamp: number,
): NonNullable<ParsedLine["quotaWindowUpdate"]> | undefined {
  if (
    record.isApiErrorMessage !== true
    || readNumber(record, "apiErrorStatus") !== 429
    || readString(record, "error") !== "rate_limit"
  ) {
    return undefined;
  }

  const text = readApiErrorText(message);
  if (!text) {
    return undefined;
  }

  let key: "primary" | "secondary";
  let windowMs: number;
  if (/^You've hit your session limit\b/i.test(text)) {
    key = "primary";
    windowMs = 5 * 60 * 60 * 1_000;
  } else if (/^You've hit your weekly limit\b/i.test(text)) {
    key = "secondary";
    windowMs = 7 * 24 * 60 * 60 * 1_000;
  } else {
    return undefined;
  }

  const resetsAt = parseResetAt(text, timestamp);
  return {
    provider: "claude",
    key,
    timestamp,
    window: {
      usedPercent: 100,
      windowMs,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    },
  };
}

function readApiErrorText(
  message: Record<string, unknown>,
): string | undefined {
  const content = message.content;
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : undefined;
  }
  for (const item of content) {
    const block = asRecord(item);
    if (readString(block, "type") !== "text") {
      continue;
    }
    const text = readString(block, "text");
    if (text) {
      return text;
    }
  }
  return undefined;
}

function parseResetAt(text: string, timestamp: number): number | undefined {
  const match =
    /\bresets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^()]+)\)\s*$/i.exec(
      text,
    );
  if (!match) {
    return undefined;
  }
  const rawHour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3]?.toLowerCase();
  const timeZone = match[4]?.trim();
  if (
    !Number.isInteger(rawHour)
    || rawHour < 1
    || rawHour > 12
    || !Number.isInteger(minute)
    || minute < 0
    || minute > 59
    || !meridiem
    || !timeZone
  ) {
    return undefined;
  }
  const hour = rawHour % 12 + (meridiem === "pm" ? 12 : 0);
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return undefined;
  }

  const firstMinute = Math.ceil(timestamp / 60_000) * 60_000;
  const lastMinute = firstMinute + 26 * 60 * 60_000;
  for (
    let candidate = firstMinute;
    candidate <= lastMinute;
    candidate += 60_000
  ) {
    const parts = formatter.formatToParts(new Date(candidate));
    const candidateHour = Number(
      parts.find((part) => part.type === "hour")?.value,
    );
    const candidateMinute = Number(
      parts.find((part) => part.type === "minute")?.value,
    );
    if (candidateHour === hour && candidateMinute === minute) {
      return candidate;
    }
  }
  return undefined;
}
