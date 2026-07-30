import { execFile } from "node:child_process";
import { prepareCommandLaunch } from "./command-launch.js";
import type { AppConfig } from "./config.js";
import { displayPath, sanitizeTerminalText } from "./display.js";
import type {
  Provider,
  QuotaSnapshot,
  SourceStatus,
} from "./model.js";

const CLIENT_KEYS = [
  "codex",
  "claude",
  "gemini",
  "copilot",
  "qwen",
] as const;

type ClientKey = (typeof CLIENT_KEYS)[number];

export interface DoctorClientStatus {
  available: boolean;
  command: string;
  version?: string;
}

export interface DoctorSourceStatus {
  available: boolean;
  location: string;
  filesSeen: number;
  filesRead: number;
  malformedLines: number;
  lastEventAt?: number;
}

export interface DoctorReport {
  schemaVersion: 1;
  type: "doctor";
  generatedAt: number;
  healthy: boolean;
  clients: Record<ClientKey, DoctorClientStatus>;
  sources: Record<Provider, DoctorSourceStatus>;
  claudeQuota:
    | { available: false }
    | {
        available: true;
        observedAt: number;
        primary?: QuotaSnapshot["primary"];
        secondary?: QuotaSnapshot["secondary"];
      };
  collection: {
    backfill: boolean;
    otlp: {
      enabled: boolean;
      logs: boolean;
      port?: number;
    };
    llamaCppMetrics?: string;
    vllmMetrics?: string;
    codexAccount: boolean;
    claudeAccount: boolean;
  };
  paths: {
    config: string;
    state: string;
    codexHome: string;
    claudeHome: string;
  };
}

export async function renderDoctor(
  config: AppConfig,
  statuses: Record<Provider, SourceStatus>,
  liveClaudeQuota?: QuotaSnapshot,
): Promise<{
  output: string;
  healthy: boolean;
  report: DoctorReport;
}> {
  const [codex, claude, gemini, copilot, qwen] = await Promise.all([
    commandStatus(config.codexExecutable ?? "codex"),
    commandStatus(config.claudeExecutable ?? "claude"),
    commandStatus("gemini"),
    commandStatus("copilot"),
    commandStatus("qwen"),
  ]);
  const clients: Record<ClientKey, DoctorClientStatus> = {
    codex,
    claude,
    gemini,
    copilot,
    qwen,
  };
  const healthy =
    statuses.codex.available ||
    statuses.claude.available ||
    statuses.gemini.available ||
    statuses.copilot.available ||
    statuses.qwen.available ||
    statuses.llamacpp.available ||
    statuses.vllm.available ||
    config.otelPort !== undefined;
  const report = buildReport(
    config,
    statuses,
    clients,
    healthy,
    liveClaudeQuota,
  );
  const lines = [
    "Tallyburn doctor",
    "",
    "Credentials",
    "  not opened by Tallyburn (official client status commands may inspect their own login)",
    "",
    "Official clients",
    clientLine("Codex", clients.codex),
    clientLine("Claude Code", clients.claude),
    clientLine("Gemini CLI", clients.gemini),
    clientLine("Copilot CLI", clients.copilot),
    clientLine("Qwen Code", clients.qwen),
    "",
    "Local numeric sources",
    sourceLine("Codex", statuses.codex),
    sourceLine("Claude", statuses.claude),
    sourceLine("Gemini OTLP", statuses.gemini),
    sourceLine("Copilot OTLP", statuses.copilot),
    sourceLine("Qwen OTLP", statuses.qwen),
    sourceLine("llama.cpp", statuses.llamacpp),
    sourceLine("vLLM", statuses.vllm),
    `  Claude quota ${liveClaudeQuota ? `verified · updated ${new Date(liveClaudeQuota.timestamp).toLocaleString()}` : "waiting for a current provider observation"}`,
    "",
    "Optional official live paths",
    `  CLI OTLP     ${config.otelPort ? `listen requested on 127.0.0.1:${config.otelPort}` : "enable with --otel-port 4318"}`,
    `  llama.cpp    ${config.llamaCppMetrics ?? "enable with --llamacpp-metrics URL"}`,
    `  vLLM         ${config.vllmMetrics ?? "enable with --vllm-metrics URL"}`,
    `  Codex quota  ${config.codexAccount ? "official app-server read enabled" : "enable with --codex-account"}`,
    `  Claude plan  ${config.claudeAccount ? "official auth status read enabled" : "enable with --claude-account"}`,
    "",
    `Config: ${displayPath(config.configPath)}`,
    `State:  ${displayPath(config.stateDirectory)}`,
  ];

  return { output: lines.join("\n"), healthy, report };
}

function commandStatus(command: string): Promise<DoctorClientStatus> {
  return new Promise((resolve) => {
    const launch = prepareCommandLaunch(command, ["--version"]);
    execFile(
      launch.command,
      launch.args,
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 64 * 1024,
        env: launch.env,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            available: false,
            command: displayPath(command),
          });
          return;
        }
        const version = `${stdout}${stderr}`.trim().split("\n")[0];
        resolve({
          available: true,
          command: displayPath(command),
          version: sanitizeTerminalText(version || "installed"),
        });
      },
    );
  });
}

function clientLine(
  label: string,
  status: DoctorClientStatus,
): string {
  const detail = status.available
    ? status.version ?? "installed"
    : `not found · ${status.command}`;
  return `  ${label.padEnd(12)}${detail}`;
}

function sourceLine(label: string, status: SourceStatus): string {
  if (status.provider !== "codex" && status.provider !== "claude") {
    const last =
      status.lastEventAt === undefined
        ? "no token events yet"
        : `last event ${new Date(status.lastEventAt).toLocaleString()}`;
    return `  ${label.padEnd(13)}${status.available ? "connected" : "waiting"} · ${last}`;
  }
  if (!status.available) {
    return `  ${label.padEnd(13)}not found · ${displayPath(status.root)}`;
  }
  const last =
    status.lastEventAt === undefined
      ? "no token events yet"
      : `last event ${new Date(status.lastEventAt).toLocaleString()}`;
  return `  ${label.padEnd(13)}ready · ${status.filesRead}/${status.filesSeen} recent logs · ${last}`;
}

function buildReport(
  config: AppConfig,
  statuses: Record<Provider, SourceStatus>,
  clients: Record<ClientKey, DoctorClientStatus>,
  healthy: boolean,
  liveClaudeQuota?: QuotaSnapshot,
): DoctorReport {
  return {
    schemaVersion: 1,
    type: "doctor",
    generatedAt: Date.now(),
    healthy,
    clients,
    sources: Object.fromEntries(
      Object.entries(statuses).map(([provider, status]) => [
        provider,
        {
          available: status.available,
          location: displayPath(status.root),
          filesSeen: status.filesSeen,
          filesRead: status.filesRead,
          malformedLines: status.malformedLines,
          ...(status.lastEventAt !== undefined
            ? { lastEventAt: status.lastEventAt }
            : {}),
        },
      ]),
    ) as Record<Provider, DoctorSourceStatus>,
    claudeQuota: liveClaudeQuota
      ? {
          available: true,
          observedAt: liveClaudeQuota.timestamp,
          ...(liveClaudeQuota.primary
            ? { primary: liveClaudeQuota.primary }
            : {}),
          ...(liveClaudeQuota.secondary
            ? { secondary: liveClaudeQuota.secondary }
            : {}),
        }
      : { available: false },
    collection: {
      backfill: config.backfill,
      otlp: {
        enabled: config.otelPort !== undefined,
        logs: config.otelLogs,
        ...(config.otelPort !== undefined ? { port: config.otelPort } : {}),
      },
      ...(config.llamaCppMetrics
        ? { llamaCppMetrics: config.llamaCppMetrics }
        : {}),
      ...(config.vllmMetrics
        ? { vllmMetrics: config.vllmMetrics }
        : {}),
      codexAccount: config.codexAccount,
      claudeAccount: config.claudeAccount,
    },
    paths: {
      config: displayPath(config.configPath),
      state: displayPath(config.stateDirectory),
      codexHome: displayPath(config.codexHome),
      claudeHome: displayPath(config.claudeHome),
    },
  };
}
