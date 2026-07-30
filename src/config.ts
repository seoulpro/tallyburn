import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseDuration,
  parseWindows,
  type NamedDuration,
} from "./duration.js";
import { PROVIDERS, type Provider } from "./model.js";

export type Command = "watch" | "stream" | "doctor" | "statusline";

const VALUE_OPTIONS = new Set([
  "--windows",
  "--refresh",
  "--provider",
  "--providers",
  "--otel-port",
  "--llamacpp-metrics",
  "--vllm-metrics",
  "--codex-home",
  "--claude-home",
  "--codex-executable",
  "--claude-executable",
  "--config",
]);

const FLAG_OPTIONS = new Set([
  "--once",
  "--json",
  "--demo",
  "--otel-logs",
  "--codex-account",
  "--no-codex-account",
  "--claude-account",
  "--no-claude-account",
  "--offline",
  "--no-backfill",
  "--no-color",
  "--help",
  "-h",
  "--version",
  "-v",
]);

export interface AppConfig {
  command: Command;
  windows: NamedDuration[];
  refreshMs: number;
  providers: Provider[];
  codexHome: string;
  claudeHome: string;
  codexExecutable?: string;
  claudeExecutable?: string;
  color: boolean;
  once: boolean;
  json: boolean;
  demo: boolean;
  backfill: boolean;
  codexAccount: boolean;
  claudeAccount: boolean;
  help: boolean;
  version: boolean;
  otelPort?: number;
  otelLogs: boolean;
  llamaCppMetrics?: string;
  vllmMetrics?: string;
  configPath: string;
  stateDirectory: string;
}

interface FileConfig {
  windows?: unknown;
  refresh?: unknown;
  providers?: unknown;
  codexHome?: unknown;
  claudeHome?: unknown;
  codexExecutable?: unknown;
  claudeExecutable?: unknown;
  color?: unknown;
  otelPort?: unknown;
  otelLogs?: unknown;
  llamaCppMetrics?: unknown;
  vllmMetrics?: unknown;
  codexAccount?: unknown;
  claudeAccount?: unknown;
  backfill?: unknown;
}

export async function resolveConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppConfig> {
  const command = detectCommand(argv);
  const taskHome = homedir();
  const defaultConfigPath = join(
    env.XDG_CONFIG_HOME ?? join(taskHome, ".config"),
    "tallyburn",
    "config.json",
  );
  const configPath = resolve(
    optionValue(argv, "--config") ?? env.TALLYBURN_CONFIG ?? defaultConfigPath,
  );
  const fileConfig = await loadFileConfig(configPath);

  const windowsInput =
    optionValue(argv, "--windows") ??
    env.TALLYBURN_WINDOWS ??
    stringList(fileConfig.windows) ??
    "1h,3h,12h";
  const refreshInput =
    optionValue(argv, "--refresh") ??
    env.TALLYBURN_REFRESH ??
    stringValue(fileConfig.refresh) ??
    "1s";
  const providersInput =
    optionValue(argv, "--provider") ??
    optionValue(argv, "--providers") ??
    env.TALLYBURN_PROVIDERS ??
    stringList(fileConfig.providers) ??
    "codex,claude";
  const codexHome = resolve(
    optionValue(argv, "--codex-home") ??
      env.CODEX_HOME ??
      stringValue(fileConfig.codexHome) ??
      join(taskHome, ".codex"),
  );
  const claudeHome = resolve(
    optionValue(argv, "--claude-home") ??
      env.CLAUDE_CONFIG_DIR ??
      stringValue(fileConfig.claudeHome) ??
      join(taskHome, ".claude"),
  );
  const stateDirectory = resolveStateDirectory(env);
  const codexExecutable =
    optionValue(argv, "--codex-executable") ??
    env.TALLYBURN_CODEX_EXECUTABLE ??
    stringValue(fileConfig.codexExecutable);
  const claudeExecutable =
    optionValue(argv, "--claude-executable") ??
    env.TALLYBURN_CLAUDE_EXECUTABLE ??
    stringValue(fileConfig.claudeExecutable);
  const otelValue =
    optionValue(argv, "--otel-port") ??
    env.TALLYBURN_OTEL_PORT ??
    numberOrString(fileConfig.otelPort);
  const llamaCppMetrics =
    optionValue(argv, "--llamacpp-metrics") ??
    env.TALLYBURN_LLAMACPP_METRICS ??
    stringValue(fileConfig.llamaCppMetrics);
  const vllmMetrics =
    optionValue(argv, "--vllm-metrics") ??
    env.TALLYBURN_VLLM_METRICS ??
    stringValue(fileConfig.vllmMetrics);

  const config: AppConfig = {
    command,
    windows: parseWindows(windowsInput),
    refreshMs: parseDuration(refreshInput),
    providers: parseProviders(providersInput),
    codexHome,
    claudeHome,
    ...(codexExecutable
      ? { codexExecutable: resolve(codexExecutable) }
      : {}),
    ...(claudeExecutable
      ? { claudeExecutable: resolve(claudeExecutable) }
      : {}),
    color:
      !argv.includes("--no-color") &&
      env.NO_COLOR === undefined &&
      fileConfig.color !== false,
    once: argv.includes("--once"),
    json: argv.includes("--json"),
    demo: argv.includes("--demo"),
    backfill:
      !argv.includes("--no-backfill") &&
      env.TALLYBURN_BACKFILL !== "0" &&
      fileConfig.backfill !== false,
    codexAccount:
      !argv.includes("--offline") &&
      !argv.includes("--no-codex-account") &&
      (argv.includes("--codex-account") ||
        env.TALLYBURN_CODEX_ACCOUNT === "1" ||
        fileConfig.codexAccount === true),
    claudeAccount:
      !argv.includes("--offline") &&
      !argv.includes("--no-claude-account") &&
      (argv.includes("--claude-account") ||
        env.TALLYBURN_CLAUDE_ACCOUNT === "1" ||
        fileConfig.claudeAccount === true),
    help: argv.includes("--help") || argv.includes("-h"),
    version: argv.includes("--version") || argv.includes("-v"),
    configPath,
    stateDirectory,
    otelLogs:
      argv.includes("--otel-logs") ||
      env.TALLYBURN_OTEL_LOGS === "1" ||
      fileConfig.otelLogs === true,
    ...(llamaCppMetrics ? { llamaCppMetrics } : {}),
    ...(vllmMetrics ? { vllmMetrics } : {}),
  };
  if (otelValue !== undefined) {
    const port = Number(otelValue);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid OTLP port "${otelValue}".`);
    }
    config.otelPort = port;
  }
  if (config.refreshMs < 250) {
    throw new Error("Refresh interval must be at least 250ms.");
  }
  if (config.refreshMs > 86_400_000) {
    throw new Error("Refresh interval cannot exceed 24 hours.");
  }
  if (config.otelLogs && config.otelPort === undefined) {
    throw new Error("--otel-logs requires --otel-port.");
  }
  if (config.windows.length > 6) {
    throw new Error("At most six rolling windows can be displayed.");
  }
  return config;
}

export function detectCommand(argv: readonly string[]): Command {
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (argument?.startsWith("-")) {
      const equalsAt = argument.indexOf("=");
      const name = equalsAt === -1 ? argument : argument.slice(0, equalsAt);
      if (VALUE_OPTIONS.has(name)) {
        if (equalsAt === -1) {
          index += 1;
          if (index >= argv.length || argv[index]?.startsWith("-")) {
            throw new Error(`Option ${name} requires a value.`);
          }
        } else if (equalsAt === argument.length - 1) {
          throw new Error(`Option ${name} requires a value.`);
        }
        continue;
      }
      if (!FLAG_OPTIONS.has(argument)) {
        throw new Error(`Unknown option "${argument}".`);
      }
      continue;
    }
    if (argument !== undefined) {
      positional.push(argument);
    }
  }

  if (positional.length > 1) {
    throw new Error(`Unexpected argument "${positional[1]}".`);
  }
  const command = positional[0] ?? "watch";
  if (
    command === "watch" ||
    command === "stream" ||
    command === "doctor" ||
    command === "statusline"
  ) {
    return command;
  }
  throw new Error(`Unknown command "${command}".`);
}

export function resolveStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const taskHome = homedir();
  return resolve(
    env.TALLYBURN_STATE_DIR ??
      join(env.XDG_STATE_HOME ?? join(taskHome, ".local", "state"), "tallyburn"),
  );
}

function optionValue(
  argv: readonly string[],
  name: string,
): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === name) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Option ${name} requires a value.`);
      }
      return value;
    }
    if (argument?.startsWith(`${name}=`)) {
      return argument.slice(name.length + 1);
    }
  }
  return undefined;
}

async function loadFileConfig(path: string): Promise<FileConfig> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(`Config file is not valid JSON: ${path}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Config file must contain a JSON object: ${path}`);
  }
  return value as FileConfig;
}

function parseProviders(input: string): Provider[] {
  const values = input
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.includes("all")) {
    return [...PROVIDERS];
  }
  const result = [...new Set(values)];
  for (const value of result) {
    if (!PROVIDERS.includes(value as Provider)) {
      throw new Error(
        `Unknown provider "${value}". Choose ${PROVIDERS.join(", ")}, or all.`,
      );
    }
  }
  if (result.length === 0) {
    throw new Error("At least one provider is required.");
  }
  return result as Provider[];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringList(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  ) {
    return value.join(",");
  }
  return undefined;
}

function numberOrString(value: unknown): string | undefined {
  return typeof value === "number" || typeof value === "string"
    ? String(value)
    : undefined;
}
