import { execFile } from "node:child_process";
import { prepareCommandLaunch } from "./command-launch.js";
import { asRecord, readString } from "./json.js";
import type { ProviderAccountStatus } from "./model.js";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const CLAUDE_ACCOUNT_REFRESH_INTERVAL_MS = 15 * 60_000;

export interface ClaudeAccountReadOptions {
  executable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  now?: number;
}

interface ClaudeAccountContext {
  status: ProviderAccountStatus;
  organizationId?: string;
}

/**
 * Reads Claude Code's own sanitized authentication status command.
 *
 * The command does not invoke a model. Tallyburn never opens Claude's
 * credential or account files itself, and this public adapter exposes only
 * the three allowlisted fields represented by ProviderAccountStatus.
 */
export async function readClaudeAccountStatus(
  options: ClaudeAccountReadOptions = {},
): Promise<ProviderAccountStatus | undefined> {
  return (await readClaudeAccountContext(options))?.status;
}

/**
 * Internal account read used to locate Claude Desktop's own HTTP cache entry.
 * The organization id is kept only in monitor memory long enough to derive a
 * cache filename; it is never persisted or included in a public snapshot.
 */
export async function readClaudeAccountContext(
  options: ClaudeAccountReadOptions = {},
): Promise<ClaudeAccountContext | undefined> {
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
  );
  const observedAt = Number.isFinite(options.now)
    ? (options.now as number)
    : Date.now();

  return new Promise((resolve) => {
    const launch = prepareCommandLaunch(
      options.executable ?? "claude",
      ["auth", "status", "--json"],
    );
    execFile(
      launch.command,
      launch.args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        env: launch.env,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout) => {
        if (error || typeof stdout !== "string") {
          resolve(undefined);
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(stdout) as unknown;
        } catch {
          resolve(undefined);
          return;
        }
        resolve(parseClaudeAccountContext(value, observedAt));
      },
    );
  });
}

/**
 * Accepts only the non-identifying fields returned by `claude auth status`.
 * Email, organization identifiers/names, and any future unknown fields are
 * dropped by construction.
 */
export function parseClaudeAccountStatus(
  value: unknown,
  observedAt = Date.now(),
): ProviderAccountStatus | undefined {
  return parseClaudeAccountContext(value, observedAt)?.status;
}

function parseClaudeAccountContext(
  value: unknown,
  observedAt = Date.now(),
): ClaudeAccountContext | undefined {
  const record = asRecord(value);
  if (!record || typeof record.loggedIn !== "boolean") {
    return undefined;
  }
  const result: ProviderAccountStatus = {
    provider: "claude",
    observedAt: Number.isFinite(observedAt) ? observedAt : Date.now(),
    loggedIn: record.loggedIn,
  };
  if (!record.loggedIn) {
    return { status: result };
  }
  const subscriptionType = normalizeSubscriptionType(
    readString(record, "subscriptionType"),
  );
  if (subscriptionType) {
    result.subscriptionType = subscriptionType;
  }
  const organizationId = normalizeOrganizationId(
    readString(record, "orgId"),
  );
  return {
    status: result,
    ...(organizationId ? { organizationId } : {}),
  };
}

function normalizeSubscriptionType(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-z][a-z0-9_-]{0,31}$/.test(normalized)
    ? normalized
    : undefined;
}

function normalizeOrganizationId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[a-z0-9_-]{1,128}$/i.test(normalized)
    ? normalized
    : undefined;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}
