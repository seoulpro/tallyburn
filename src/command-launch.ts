import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

const DEFAULT_WINDOWS_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];
const WINDOWS_SCRIPT_EXTENSIONS = new Set([".bat", ".cmd"]);
const TARGET_VARIABLE = "TALLYBURN_COMMAND_TARGET";
const ARGUMENT_VARIABLE_PREFIX = "TALLYBURN_COMMAND_ARGUMENT_";

export interface CommandLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  windowsScript: boolean;
}

interface CommandLaunchOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  exists?: (path: string) => boolean;
}

/**
 * Resolves Windows command shims without enabling a general-purpose shell.
 *
 * npm-installed CLIs are commonly exposed as .cmd files on Windows. Those
 * files require cmd.exe, while native executables and POSIX commands remain
 * direct child processes. Environment expansion keeps the selected path and
 * fixed arguments out of a shell-interpolated command string.
 */
export function prepareCommandLaunch(
  command: string,
  args: readonly string[],
  options: CommandLaunchOptions = {},
): CommandLaunch {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "win32") {
    return {
      command,
      args: [...args],
      env,
      windowsScript: false,
    };
  }

  const resolved = resolveWindowsCommand(
    command,
    env,
    options.cwd ?? process.cwd(),
    options.exists ?? existsSync,
  );
  if (!WINDOWS_SCRIPT_EXTENSIONS.has(win32.extname(resolved).toLowerCase())) {
    return {
      command: resolved,
      args: [...args],
      env,
      windowsScript: false,
    };
  }

  assertWindowsShellValue(resolved, "command");
  args.forEach((argument, index) => {
    assertWindowsShellValue(argument, `argument ${index}`);
  });

  const variableNames = [
    TARGET_VARIABLE,
    ...args.map((_, index) => `${ARGUMENT_VARIABLE_PREFIX}${index}`),
  ];
  const shellEnvironment = withoutEnvironmentKeys(env, variableNames);
  shellEnvironment[TARGET_VARIABLE] = resolved;
  args.forEach((argument, index) => {
    shellEnvironment[`${ARGUMENT_VARIABLE_PREFIX}${index}`] = argument;
  });
  const argumentReferences = args
    .map((_, index) => ` "%${ARGUMENT_VARIABLE_PREFIX}${index}%"`)
    .join("");
  const commandLine = `""%${TARGET_VARIABLE}%"${argumentReferences}"`;

  return {
    command: environmentValue(env, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", commandLine],
    env: shellEnvironment,
    windowsScript: true,
  };
}

export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const extensions = windowsExtensions(env);
  const hasDirectory = /[\\/]/.test(command);
  const directories = hasDirectory
    ? [""]
    : [
        cwd,
        ...windowsPath(env)
          .split(";")
          .map((entry) => stripOuterQuotes(entry.trim()))
          .filter(Boolean),
      ];
  const candidates = commandCandidates(command, extensions);

  for (const directory of directories) {
    for (const candidate of candidates) {
      const path = directory ? win32.join(directory, candidate) : candidate;
      if (exists(path)) {
        return path;
      }
    }
  }
  return command;
}

export async function terminateCommandProcess(
  child: ChildProcess,
  windowsScript: boolean,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.pid === undefined
  ) {
    return;
  }
  if (process.platform !== "win32" || !windowsScript) {
    child.kill(signal);
    return;
  }

  const killer = spawn(
    "taskkill.exe",
    ["/pid", String(child.pid), "/t", "/f"],
    {
      stdio: "ignore",
      windowsHide: true,
    },
  );
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1_000);
    killer.once("error", finish);
    killer.once("exit", finish);
  });
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
}

function commandCandidates(
  command: string,
  extensions: readonly string[],
): string[] {
  return win32.extname(command)
    ? [command]
    : [command, ...extensions.map((extension) => `${command}${extension}`)];
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const value = environmentValue(env, "PATHEXT");
  if (!value) {
    return DEFAULT_WINDOWS_EXTENSIONS;
  }
  const extensions = value
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );
  return extensions.length > 0 ? extensions : DEFAULT_WINDOWS_EXTENSIONS;
}

function windowsPath(env: NodeJS.ProcessEnv): string {
  return environmentValue(env, "PATH") ?? "";
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const normalized = key.toLowerCase();
  for (const [candidate, value] of Object.entries(env)) {
    if (candidate.toLowerCase() === normalized) {
      return value;
    }
  }
  return undefined;
}

function withoutEnvironmentKeys(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): NodeJS.ProcessEnv {
  const reserved = new Set(keys.map((key) => key.toLowerCase()));
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !reserved.has(key.toLowerCase()),
    ),
  );
}

function stripOuterQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function assertWindowsShellValue(value: string, label: string): void {
  if (/[\0\r\n"]/.test(value)) {
    throw new TypeError(`Windows ${label} contains unsupported characters`);
  }
}
