import type { QuotaSnapshot, QuotaWindow } from "./model.js";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;

type JsonRecord = Record<string, unknown>;

export class ClaudeStatuslineInputError extends Error {
  constructor(message = "Invalid Claude statusline input") {
    super(message);
    this.name = "ClaudeStatuslineInputError";
  }
}

export interface ClaudeStatuslineReadOptions {
  maxInputBytes?: number;
  now?: number;
}

export interface ClaudeStatuslineCommandOptions {
  input?: AsyncIterable<unknown>;
  maxInputBytes?: number;
  now?: () => number;
  onQuota?: (
    quota: QuotaSnapshot,
  ) => void | Promise<void>;
  onQuotaError?: (error: unknown) => void;
  output?: {
    write(chunk: string): unknown;
  };
}

/**
 * Extracts only Claude subscription rate limits. No model, path, transcript,
 * prompt, response, or other statusline input is copied into the result.
 */
export function parseClaudeStatuslineQuota(
  value: unknown,
  now = Date.now(),
): QuotaSnapshot | undefined {
  const root = asRecord(value);
  const rateLimits = asRecord(root?.rate_limits);
  if (!rateLimits) {
    return undefined;
  }

  const primary = parseQuotaWindow(
    rateLimits.five_hour,
    FIVE_HOURS_MS,
  );
  const secondary = parseQuotaWindow(
    rateLimits.seven_day,
    SEVEN_DAYS_MS,
  );
  if (!primary && !secondary) {
    return undefined;
  }

  const quota: QuotaSnapshot = {
    provider: "claude",
    timestamp: Number.isFinite(now) ? now : Date.now(),
  };
  if (primary) {
    quota.primary = primary;
  }
  if (secondary) {
    quota.secondary = secondary;
  }
  return quota;
}

/**
 * Reads one Claude statusline JSON document with a strict memory bound.
 * Malformed JSON and absent rate limits are treated as no quota data.
 */
export async function readClaudeStatuslineQuota(
  input: AsyncIterable<unknown> = process.stdin,
  options: ClaudeStatuslineReadOptions = {},
): Promise<QuotaSnapshot | undefined> {
  const maxInputBytes = validateInputLimit(
    options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
  );
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of input) {
    let buffer: Buffer;
    if (typeof chunk === "string") {
      buffer = Buffer.from(chunk);
    } else if (chunk instanceof Uint8Array) {
      buffer = Buffer.from(
        chunk.buffer,
        chunk.byteOffset,
        chunk.byteLength,
      );
    } else {
      throw new ClaudeStatuslineInputError();
    }
    bytes += buffer.byteLength;
    if (bytes > maxInputBytes) {
      chunks.length = 0;
      throw new ClaudeStatuslineInputError(
        "Claude statusline input exceeds the size limit",
      );
    }
    chunks.push(buffer);
  }

  if (bytes === 0) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.concat(chunks, bytes).toString("utf8"),
    ) as unknown;
  } catch {
    return undefined;
  }
  return parseClaudeStatuslineQuota(
    value,
    options.now ?? Date.now(),
  );
}

export function formatClaudeStatuslineQuota(
  quota: QuotaSnapshot | undefined,
): string {
  const parts: string[] = [];
  if (quota?.primary) {
    parts.push(`5h ${Math.round(quota.primary.usedPercent)}%`);
  }
  if (quota?.secondary) {
    parts.push(`7d ${Math.round(quota.secondary.usedPercent)}%`);
  }
  return parts.length > 0
    ? `[Tallyburn] ${parts.join(" · ")}`
    : "[Tallyburn]";
}

/**
 * Claude statusline command entry helper. It always emits a compact status
 * line; when quota data exists, the callback receives only the sanitized
 * QuotaSnapshot suitable for persistence by the caller.
 */
export async function runClaudeStatuslineCommand(
  options: ClaudeStatuslineCommandOptions = {},
): Promise<QuotaSnapshot | undefined> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const now = options.now?.() ?? Date.now();
  let quota: QuotaSnapshot | undefined;

  try {
    const readOptions: ClaudeStatuslineReadOptions = { now };
    if (options.maxInputBytes !== undefined) {
      readOptions.maxInputBytes = options.maxInputBytes;
    }
    quota = await readClaudeStatuslineQuota(input, readOptions);
  } catch (error) {
    if (!(error instanceof ClaudeStatuslineInputError)) {
      throw error;
    }
  }

  output.write(`${formatClaudeStatuslineQuota(quota)}\n`);
  if (quota && options.onQuota) {
    try {
      await options.onQuota(quota);
    } catch (error) {
      options.onQuotaError?.(error);
    }
  }
  return quota;
}

function parseQuotaWindow(
  value: unknown,
  windowMs: number,
): QuotaWindow | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const usedPercentage = record.used_percentage;
  if (
    typeof usedPercentage !== "number" ||
    !Number.isFinite(usedPercentage)
  ) {
    return undefined;
  }

  const result: QuotaWindow = {
    usedPercent: Math.max(0, Math.min(100, usedPercentage)),
    windowMs,
  };
  const resetsAt = record.resets_at;
  if (
    typeof resetsAt === "number" &&
    Number.isFinite(resetsAt) &&
    resetsAt >= 0
  ) {
    const milliseconds = resetsAt * 1_000;
    if (Number.isSafeInteger(milliseconds)) {
      result.resetsAt = milliseconds;
    }
  }
  return result;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function validateInputLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("maxInputBytes must be a positive integer");
  }
  return value;
}
