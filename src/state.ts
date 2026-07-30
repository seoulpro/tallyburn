import {
  mkdir,
  lstat,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { asRecord, readNumber, readRecord, readString } from "./json.js";
import type {
  Provider,
  QuotaSnapshot,
  QuotaWindow,
} from "./model.js";

const CLAUDE_QUOTA_FILE = "claude-quota.json";
const CLAUDE_QUOTA_LOCK = ".claude-quota.lock";
const LOCK_WAIT_MS = 2_000;

export async function writeClaudeQuotaState(
  directory: string,
  quota: QuotaSnapshot,
): Promise<void> {
  if (quota.provider !== "claude") {
    throw new Error("Claude state can only contain a Claude quota snapshot.");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await acquireStateLock(directory);
  try {
    const current = await readClaudeQuotaState(directory);
    if (current && current.timestamp >= quota.timestamp) {
      return;
    }
    await writeQuotaFile(directory, quota);
  } finally {
    await releaseStateLock(directory, lock);
  }
}

async function writeQuotaFile(
  directory: string,
  quota: QuotaSnapshot,
): Promise<void> {
  const target = join(directory, CLAUDE_QUOTA_FILE);
  const temporary = join(directory, `.${CLAUDE_QUOTA_FILE}.${randomUUID()}.tmp`);
  const sanitized = {
    version: 1,
    provider: "claude",
    timestamp: quota.timestamp,
    ...(quota.primary ? { primary: quota.primary } : {}),
    ...(quota.secondary ? { secondary: quota.secondary } : {}),
  };
  try {
    await writeFile(temporary, `${JSON.stringify(sanitized)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    });
  }
}

export async function readClaudeQuotaState(
  directory: string,
): Promise<QuotaSnapshot | undefined> {
  let contents: string;
  try {
    contents = await readFile(join(directory, CLAUDE_QUOTA_FILE), "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return undefined;
  }
  const record = asRecord(value);
  if (
    !record ||
    readString(record, "provider") !== "claude" ||
    readNumber(record, "version") !== 1
  ) {
    return undefined;
  }
  const timestamp = readNumber(record, "timestamp");
  if (timestamp === undefined) {
    return undefined;
  }

  const quota: QuotaSnapshot = {
    provider: "claude",
    timestamp,
  };
  const primary = parseStoredWindow(readRecord(record, "primary"));
  const secondary = parseStoredWindow(readRecord(record, "secondary"));
  if (primary) {
    quota.primary = primary;
  }
  if (secondary) {
    quota.secondary = secondary;
  }
  return quota.primary || quota.secondary ? quota : undefined;
}

export function quotaStateFile(
  directory: string,
  provider: Provider,
): string {
  return join(directory, `${provider}-quota.json`);
}

async function acquireStateLock(directory: string): Promise<FileHandle> {
  const path = join(directory, CLAUDE_QUOTA_LOCK);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      return await open(path, "wx", 0o600);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out waiting for the Tallyburn state lock; remove a stale .claude-quota.lock only after confirming no statusline writer is running.",
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function releaseStateLock(
  directory: string,
  handle: FileHandle,
): Promise<void> {
  const held = await handle.stat();
  await handle.close();
  const path = join(directory, CLAUDE_QUOTA_LOCK);
  try {
    const current = await lstat(path);
    if (current.dev === held.dev && current.ino === held.ino) {
      await unlink(path);
    }
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function parseStoredWindow(
  record: ReturnType<typeof asRecord>,
): QuotaWindow | undefined {
  const usedPercent = readNumber(record, "usedPercent");
  const windowMs = readNumber(record, "windowMs");
  if (
    usedPercent === undefined ||
    windowMs === undefined ||
    usedPercent < 0 ||
    usedPercent > 100 ||
    windowMs <= 0
  ) {
    return undefined;
  }
  const result: QuotaWindow = { usedPercent, windowMs };
  const resetsAt = readNumber(record, "resetsAt");
  if (resetsAt !== undefined) {
    result.resetsAt = resetsAt;
  }
  return result;
}
