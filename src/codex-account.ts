import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  prepareCommandLaunch,
  terminateCommandProcess,
} from "./command-launch.js";
import {
  asRecord,
  readNumber,
  readRecord,
  readString,
  type JsonRecord,
} from "./json.js";
import type {
  QuotaSnapshot,
  QuotaWindow,
} from "./model.js";
import { VERSION } from "./version.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface CodexAccountBridge {
  close(): Promise<void>;
}

export interface CodexAccountOptions {
  executable?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onQuota: (quota: QuotaSnapshot) => void;
}

export async function startCodexAccountBridge(
  options: CodexAccountOptions,
): Promise<CodexAccountBridge> {
  const launch = prepareCommandLaunch(
    options.executable ?? "codex",
    ["app-server", "--listen", "stdio://"],
  );
  const child = spawn(
    launch.command,
    launch.args,
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env,
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsScript,
    },
  );
  const connection = new JsonRpcConnection(
    child,
    options.timeoutMs ?? 4_000,
    options.signal,
    launch.windowsScript,
  );
  connection.onNotification = (method, params) => {
    if (method === "account/rateLimits/updated") {
      const quota = parseCodexRateLimits(params, Date.now());
      if (quota) {
        options.onQuota(quota);
      }
    }
  };

  try {
    await connection.request("initialize", {
      clientInfo: {
        name: "tallyburn",
        title: "Tallyburn",
        version: VERSION,
      },
    });
  } catch (error) {
    await connection.close();
    throw error;
  }
  connection.notify("initialized", {});

  try {
    const result = await connection.request("account/rateLimits/read", {});
    const quota = parseCodexRateLimits(result, Date.now());
    if (quota) {
      options.onQuota(quota);
    }
  } catch {
    // A logged-out or API-key-only account has no ChatGPT quota to expose.
  }

  return {
    async close(): Promise<void> {
      await connection.close();
    },
  };
}

export function parseCodexRateLimits(
  value: unknown,
  timestamp = Date.now(),
  inheritedPlanType?: string,
): QuotaSnapshot | undefined {
  const root = asRecord(value);
  const params = readRecord(root, "params") ?? root;
  const result = readRecord(params, "result") ?? params;
  if (!result) {
    return undefined;
  }
  let limits =
    readRecord(result, "rateLimits") ??
    readRecord(result, "rate_limits") ??
    directLimitRecord(result);

  if (!limits) {
    const byId =
      readRecord(result, "rateLimitsByLimitId") ??
      readRecord(result, "rate_limits_by_limit_id");
    if (byId) {
      limits =
        readRecord(byId, "codex") ??
        Object.values(byId)
          .map(asRecord)
          .find((candidate) => candidate !== undefined);
    }
  }
  if (!limits) {
    return undefined;
  }

  const primary = parseWindow(
    readRecord(limits, "primary"),
  );
  const secondary = parseWindow(
    readRecord(limits, "secondary"),
  );
  if (!primary && !secondary) {
    return undefined;
  }

  const quota: QuotaSnapshot = {
    provider: "codex",
    timestamp,
  };
  const planType =
    readString(limits, "planType", "plan_type") ?? inheritedPlanType;
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

class JsonRpcConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #timeoutMs: number;
  readonly #deadlineAt: number;
  readonly #windowsScript: boolean;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;
  onNotification?: (method: string, params: unknown) => void;

  constructor(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
    signal?: AbortSignal,
    windowsScript = false,
  ) {
    this.#child = child;
    this.#timeoutMs = timeoutMs;
    this.#deadlineAt = Date.now() + timeoutMs;
    this.#windowsScript = windowsScript;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    child.on("error", () => this.#failPending("Codex app-server unavailable."));
    child.on("exit", () => this.#failPending("Codex app-server exited."));
    child.stdin.on("error", () => {
      this.#failPending("Codex app-server input closed.");
    });
    child.stderr.resume();
    signal?.addEventListener(
      "abort",
      () => {
        this.#failPending("Codex app-server request aborted.");
      },
      { once: true },
    );
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error("Codex app-server is closed."));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const remainingMs = requestTimeoutMs(
      this.#deadlineAt,
      this.#timeoutMs,
    );
    if (remainingMs <= 0) {
      return Promise.reject(
        new Error(`Codex app-server timed out during ${method}.`),
      );
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex app-server timed out during ${method}.`));
      }, remainingMs);
      this.#pending.set(id, { resolve, reject, timeout });
    });
    this.#write({ method, id, params });
    return promise;
  }

  notify(method: string, params: unknown): void {
    if (!this.#closed) {
      this.#write({ method, params });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#failPending("Codex app-server closed.");
    if (
      this.#child.exitCode !== null ||
      this.#child.signalCode !== null ||
      this.#child.pid === undefined
    ) {
      return;
    }
    await terminateCommandProcess(
      this.#child,
      this.#windowsScript,
      "SIGTERM",
    );
    if (!(await this.#waitForExit(1_000))) {
      await terminateCommandProcess(
        this.#child,
        this.#windowsScript,
        "SIGKILL",
      );
      await this.#waitForExit(500);
    }
  }

  #write(message: JsonRecord): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const record = asRecord(value);
    if (!record) {
      return;
    }
    const id = readNumber(record, "id");
    if (id !== undefined) {
      const pending = this.#pending.get(id);
      if (!pending) {
        return;
      }
      this.#pending.delete(id);
      clearTimeout(pending.timeout);
      if (record.error !== undefined) {
        pending.reject(new Error("Codex app-server rejected a request."));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    const method = readString(record, "method");
    if (method) {
      this.onNotification?.(method, record.params);
    }
  }

  #failPending(message: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.#pending.clear();
  }

  #waitForExit(timeoutMs: number): Promise<boolean> {
    if (
      this.#child.exitCode !== null ||
      this.#child.signalCode !== null
    ) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.#child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      this.#child.once("exit", onExit);
    });
  }
}

export function requestTimeoutMs(
  deadlineAt: number,
  perRequestMs: number,
  now = Date.now(),
): number {
  return Math.max(0, Math.min(perRequestMs, deadlineAt - now));
}

function directLimitRecord(record: JsonRecord): JsonRecord | undefined {
  return record.primary !== undefined || record.secondary !== undefined
    ? record
    : undefined;
}

function parseWindow(record: JsonRecord | undefined): QuotaWindow | undefined {
  if (!record) {
    return undefined;
  }
  const usedPercent = readNumber(record, "usedPercent", "used_percent");
  const durationMinutes = readNumber(
    record,
    "windowDurationMins",
    "window_minutes",
  );
  if (usedPercent === undefined || durationMinutes === undefined) {
    return undefined;
  }
  const window: QuotaWindow = {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowMs: Math.max(0, durationMinutes * 60_000),
  };
  const resetsAt = readNumber(record, "resetsAt", "resets_at");
  if (resetsAt !== undefined) {
    window.resetsAt = resetsAt > 10_000_000_000 ? resetsAt : resetsAt * 1_000;
  }
  return window;
}
