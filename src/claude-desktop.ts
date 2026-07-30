import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { asRecord, readNumber, readRecord, readString } from "./json.js";
import type { QuotaSnapshot, QuotaWindow } from "./model.js";

const SIMPLE_CACHE_MAGIC = 0xfcfb6d1ba7725c30n;
const SIMPLE_CACHE_VERSION = 5;
const SIMPLE_CACHE_HEADER_BYTES = 24;
const MAX_CACHE_KEY_BYTES = 4 * 1024;
const MAX_CACHE_ENTRY_BYTES = 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 256 * 1024;
const CLOCK_SKEW_MS = 60_000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

export const CLAUDE_DESKTOP_QUOTA_MAX_AGE_MS = 10 * 60_000;
export const CLAUDE_DESKTOP_QUOTA_REFRESH_INTERVAL_MS = 15_000;

export interface ClaudeDesktopQuotaReadOptions {
  organizationId: string;
  cacheDirectory?: string;
  now?: number;
  maxAgeMs?: number;
}

interface CacheCandidate {
  key: string;
  path: string;
}

/**
 * Reads Claude Desktop's already-authenticated, local HTTP cache only.
 *
 * No credential, cookie, response header, account identity, or unrelated
 * cache entry is returned. Cache incompatibility is treated as unavailable
 * quota so the status-line source remains the portable fallback.
 */
export async function readClaudeDesktopQuota(
  options: ClaudeDesktopQuotaReadOptions,
): Promise<QuotaSnapshot | undefined> {
  if (process.platform !== "darwin" && options.cacheDirectory === undefined) {
    return undefined;
  }
  const organizationId = normalizeOrganizationId(options.organizationId);
  if (!organizationId) {
    return undefined;
  }
  const now = Number.isFinite(options.now) ? (options.now as number) : Date.now();
  const maxAgeMs = positiveDuration(
    options.maxAgeMs ?? CLAUDE_DESKTOP_QUOTA_MAX_AGE_MS,
  );
  const cacheDirectory =
    options.cacheDirectory ??
    join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "Cache",
      "Cache_Data",
    );

  const candidates = cacheCandidates(cacheDirectory, organizationId);
  const snapshots = await Promise.all(
    candidates.map((candidate) =>
      readCacheCandidate(candidate, now, maxAgeMs),
    ),
  );
  return snapshots
    .filter((quota): quota is QuotaSnapshot => quota !== undefined)
    .sort((left, right) => right.timestamp - left.timestamp)[0];
}

export function parseClaudeDesktopUsage(
  value: unknown,
  timestamp = Date.now(),
): QuotaSnapshot | undefined {
  const root = asRecord(value);
  if (!root) {
    return undefined;
  }
  const primary = parseUsageWindow(
    readRecord(root, "five_hour"),
    FIVE_HOURS_MS,
  );
  const secondary = parseUsageWindow(
    readRecord(root, "seven_day"),
    SEVEN_DAYS_MS,
  );
  if (!primary && !secondary) {
    return undefined;
  }
  return {
    provider: "claude",
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

async function readCacheCandidate(
  candidate: CacheCandidate,
  now: number,
  maxAgeMs: number,
): Promise<QuotaSnapshot | undefined> {
  try {
    const info = await lstat(candidate.path);
    if (!safeCacheFile(info, now, maxAgeMs)) {
      return undefined;
    }
    const contents = await readFile(candidate.path);
    if (
      contents.byteLength !== info.size ||
      contents.byteLength < SIMPLE_CACHE_HEADER_BYTES
    ) {
      return undefined;
    }
    const encoded = readSimpleCacheBody(contents, candidate.key);
    if (!encoded) {
      return undefined;
    }
    const decoded = decodeResponseBody(encoded);
    if (!decoded || decoded.byteLength > MAX_DECOMPRESSED_BYTES) {
      return undefined;
    }
    const json = extractJsonObject(decoded);
    if (!json) {
      return undefined;
    }
    return parseClaudeDesktopUsage(
      JSON.parse(json) as unknown,
      Math.floor(info.mtimeMs),
    );
  } catch {
    return undefined;
  }
}

function safeCacheFile(
  info: Stats,
  now: number,
  maxAgeMs: number,
): boolean {
  return (
    info.isFile() &&
    !info.isSymbolicLink() &&
    info.size >= SIMPLE_CACHE_HEADER_BYTES &&
    info.size <= MAX_CACHE_ENTRY_BYTES &&
    info.mtimeMs <= now + CLOCK_SKEW_MS &&
    info.mtimeMs > now - maxAgeMs
  );
}

function readSimpleCacheBody(
  contents: Buffer,
  expectedKey: string,
): Buffer | undefined {
  if (
    contents.readBigUInt64LE(0) !== SIMPLE_CACHE_MAGIC ||
    contents.readUInt32LE(8) !== SIMPLE_CACHE_VERSION
  ) {
    return undefined;
  }
  const keyLength = contents.readUInt32LE(12);
  if (
    keyLength <= 0 ||
    keyLength > MAX_CACHE_KEY_BYTES ||
    SIMPLE_CACHE_HEADER_BYTES + keyLength >= contents.byteLength
  ) {
    return undefined;
  }
  const keyEnd = SIMPLE_CACHE_HEADER_BYTES + keyLength;
  const key = contents.toString(
    "utf8",
    SIMPLE_CACHE_HEADER_BYTES,
    keyEnd,
  );
  if (key !== expectedKey) {
    return undefined;
  }
  return contents.subarray(keyEnd);
}

function decodeResponseBody(encoded: Buffer): Buffer | undefined {
  if (encoded.subarray(0, ZSTD_MAGIC.byteLength).equals(ZSTD_MAGIC)) {
    if (typeof zlib.zstdDecompressSync !== "function") {
      return undefined;
    }
    return zlib.zstdDecompressSync(encoded, {
      maxOutputLength: MAX_DECOMPRESSED_BYTES,
    });
  }
  if (encoded.subarray(0, GZIP_MAGIC.byteLength).equals(GZIP_MAGIC)) {
    return zlib.gunzipSync(encoded, {
      maxOutputLength: MAX_DECOMPRESSED_BYTES,
    });
  }
  if (encoded[0] === 0x7b) {
    return encoded;
  }
  return undefined;
}

function extractJsonObject(buffer: Buffer): string | undefined {
  const text = buffer.toString("utf8");
  if (!text.startsWith("{")) {
    return undefined;
  }
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        quoted = false;
      }
      continue;
    }
    if (character === "\"") {
      quoted = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(0, index + 1);
      }
      if (depth < 0) {
        return undefined;
      }
    }
  }
  return undefined;
}

function parseUsageWindow(
  record: ReturnType<typeof asRecord>,
  windowMs: number,
): QuotaWindow | undefined {
  const utilization = readNumber(record, "utilization");
  if (
    utilization === undefined ||
    !Number.isFinite(utilization) ||
    utilization < 0
  ) {
    return undefined;
  }
  const window: QuotaWindow = {
    usedPercent: Math.min(100, utilization),
    windowMs,
  };
  const resetsAt = readString(record, "resets_at");
  if (resetsAt) {
    const parsed = Date.parse(resetsAt);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      window.resetsAt = parsed;
    }
  }
  return window;
}

function cacheCandidates(
  cacheDirectory: string,
  organizationId: string,
): CacheCandidate[] {
  return ["", "?skip_spend=1"].map((suffix) => {
    const key =
      `1/0/https://claude.ai/api/organizations/` +
      `${organizationId}/usage${suffix}`;
    const hash = createHash("sha1").update(key).digest().subarray(0, 8);
    hash.reverse();
    return {
      key,
      path: join(cacheDirectory, `${hash.toString("hex")}_0`),
    };
  });
}

function normalizeOrganizationId(value: string): string | undefined {
  const normalized = value.trim();
  return /^[a-z0-9_-]{1,128}$/i.test(normalized)
    ? normalized
    : undefined;
}

function positiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("maxAgeMs must be a positive integer");
  }
  return value;
}
