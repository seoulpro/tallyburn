export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

export function readRecord(
  record: JsonRecord | undefined,
  key: string,
): JsonRecord | undefined {
  return asRecord(record?.[key]);
}

export function readString(
  record: JsonRecord | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function readNumber(
  record: JsonRecord | undefined,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function nonNegative(value: number | undefined): number {
  return value === undefined ? 0 : Math.max(0, value);
}

export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
