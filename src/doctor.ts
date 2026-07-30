import { spawnSync } from "node:child_process";
import type { AppConfig } from "./config.js";
import { displayPath, sanitizeTerminalText } from "./display.js";
import type {
  Provider,
  QuotaSnapshot,
  SourceStatus,
} from "./model.js";
import { readClaudeQuotaState } from "./state.js";

export async function renderDoctor(
  config: AppConfig,
  statuses: Record<Provider, SourceStatus>,
  liveClaudeQuota?: QuotaSnapshot,
): Promise<{ output: string; healthy: boolean }> {
  const codexVersion = commandVersion("codex");
  const claudeVersion = commandVersion("claude");
  const geminiVersion = commandVersion("gemini");
  const copilotVersion = commandVersion("copilot");
  const qwenVersion = commandVersion("qwen");
  const claudeQuota =
    liveClaudeQuota ??
    await readClaudeQuotaState(config.stateDirectory);
  const lines = [
    "Tallyburn doctor",
    "",
    "Credentials",
    "  not opened by Tallyburn (official client status commands may inspect their own login)",
    "",
    "Official clients",
    `  Codex       ${sanitizeTerminalText(codexVersion ?? "not found in PATH")}`,
    `  Claude Code ${sanitizeTerminalText(claudeVersion ?? "not found in PATH")}`,
    `  Gemini CLI  ${sanitizeTerminalText(geminiVersion ?? "not found in PATH")}`,
    `  Copilot CLI ${sanitizeTerminalText(copilotVersion ?? "not found in PATH")}`,
    `  Qwen Code   ${sanitizeTerminalText(qwenVersion ?? "not found in PATH")}`,
    "",
    "Local numeric sources",
    sourceLine("Codex", statuses.codex),
    sourceLine("Claude", statuses.claude),
    sourceLine("Gemini OTLP", statuses.gemini),
    sourceLine("Copilot OTLP", statuses.copilot),
    sourceLine("Qwen OTLP", statuses.qwen),
    sourceLine("llama.cpp", statuses.llamacpp),
    sourceLine("vLLM", statuses.vllm),
    `  Claude quota ${claudeQuota ? `ready · updated ${new Date(claudeQuota.timestamp).toLocaleString()}` : "waiting for status line or Claude Desktop usage"}`,
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

  const healthy =
    statuses.codex.available ||
    statuses.claude.available ||
    statuses.gemini.available ||
    statuses.copilot.available ||
    statuses.qwen.available ||
    statuses.llamacpp.available ||
    statuses.vllm.available ||
    config.otelPort !== undefined;
  return { output: lines.join("\n"), healthy };
}

function commandVersion(command: string): string | undefined {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 2_000,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  const version = `${result.stdout}${result.stderr}`.trim().split("\n")[0];
  return version || "installed";
}

function sourceLine(label: string, status: SourceStatus): string {
  if (status.provider !== "codex" && status.provider !== "claude") {
    const last =
      status.lastEventAt === undefined
        ? "no token events yet"
        : `last event ${new Date(status.lastEventAt).toLocaleString()}`;
    return `  ${label.padEnd(11)}${status.available ? "connected" : "waiting"} · ${last}`;
  }
  if (!status.available) {
    return `  ${label.padEnd(11)}not found · ${displayPath(status.root)}`;
  }
  const last =
    status.lastEventAt === undefined
      ? "no token events yet"
      : `last event ${new Date(status.lastEventAt).toLocaleString()}`;
  return `  ${label.padEnd(11)}ready · ${status.filesRead}/${status.filesSeen} recent logs · ${last}`;
}
