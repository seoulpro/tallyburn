#!/usr/bin/env node

import { stderr, stdin, stdout } from "node:process";
import {
  detectCommand,
  resolveConfig,
  resolveStateDirectory,
  type AppConfig,
} from "./config.js";
import { sanitizeTerminalText } from "./display.js";
import { renderDoctor } from "./doctor.js";
import {
  TallyburnMonitor,
  type TallyburnMonitorOptions,
} from "./monitor.js";
import { runClaudeStatuslineCommand } from "./otel.js";
import { renderSnapshot } from "./render.js";
import { snapshotEnvelope, snapshotForJson } from "./serialization.js";
import { writeClaudeQuotaState } from "./state.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(`${helpText()}\n`);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    stdout.write(`${VERSION}\n`);
    return;
  }
  if (detectCommand(argv) === "statusline") {
    await runClaudeStatuslineCommand({
      onQuota: async (quota) => {
        await writeClaudeQuotaState(resolveStateDirectory(), quota);
      },
      onQuotaError: () => {
        stderr.write("tallyburn statusline: quota state was not updated\n");
      },
    });
    return;
  }
  const config = await resolveConfig(argv);
  const monitor = await TallyburnMonitor.create(monitorOptions(config));
  try {
    if (config.command === "doctor") {
      const result = await renderDoctor(
        config,
        monitor.sources,
        monitor.snapshot().quotas.claude,
      );
      stdout.write(`${result.output}\n`);
      if (!result.healthy) {
        process.exitCode = 1;
      }
      return;
    }

    if (config.command === "stream") {
      await runStream(config, monitor);
      return;
    }

    const isInteractive =
      !config.once && !config.json && stdin.isTTY && stdout.isTTY;
    if (!isInteractive) {
      try {
        await monitor.refreshAccountQuota();
      } catch {
        // Local logs remain usable when Codex app-server is unavailable.
      }
      const snapshot = monitor.snapshot();
      if (config.json) {
        stdout.write(`${JSON.stringify(snapshotForJson(snapshot), null, 2)}\n`);
      } else {
        stdout.write(
          `${renderSnapshot(snapshot, {
            color: config.color && stdout.isTTY,
            width: stdout.columns || 100,
            providers: config.providers,
          })}\n`,
        );
      }
      return;
    }

    await runInteractive(config, monitor);
  } finally {
    await monitor.close();
  }
}

async function runInteractive(
  config: AppConfig,
  monitor: TallyburnMonitor,
): Promise<void> {
  let focusIndex = 0;
  let stopped = false;
  let runtimeError: unknown;
  let terminalActive = false;

  const render = (): void => {
    const snapshot = monitor.snapshot(focusIndex);
    stdout.write("\u001b[H\u001b[2J");
    stdout.write(
      renderSnapshot(snapshot, {
        color: config.color,
        width: stdout.columns || 100,
        interactive: true,
        providers: config.providers,
        ...(monitor.listeningPort !== undefined
          ? {
              listeningPort: monitor.listeningPort,
              otelLogs: config.otelLogs,
            }
          : {}),
      }),
    );
  };
  let finish: () => void = () => {};
  const stoppedPromise = new Promise<void>((resolve) => {
    finish = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      resolve();
    };
  });
  const triggerRefresh = (): void => {
    if (!stopped) {
      void monitor.refresh().catch((error: unknown) => {
        runtimeError = error;
        finish();
      });
    }
  };
  const onData = (key: string): void => {
    try {
      if (key === "q" || key === "\u0003") {
        finish();
      } else if (key === "w" || key === "\u001b[C") {
        focusIndex = (focusIndex + 1) % config.windows.length;
        render();
      } else if (key === "W" || key === "\u001b[D") {
        focusIndex =
          (focusIndex - 1 + config.windows.length) % config.windows.length;
        render();
      } else if (key === "r") {
        triggerRefresh();
      }
    } catch (error) {
      runtimeError = error;
      finish();
    }
  };
  const unsubscribeSnapshots = monitor.subscribe(
    () => {
      if (terminalActive && !stopped) {
        render();
      }
    },
    { emitCurrent: false },
  );
  const unsubscribeErrors = monitor.subscribeErrors((error) => {
    runtimeError = error;
    finish();
  });

  try {
    await monitor.start();
    stdout.write("\u001b[?1049h\u001b[?25l");
    terminalActive = true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    render();
    await stoppedPromise;
  } finally {
    stopped = true;
    unsubscribeSnapshots();
    unsubscribeErrors();
    stdin.off("data", onData);
    process.off("SIGINT", finish);
    process.off("SIGTERM", finish);
    stdin.pause();
    if (terminalActive) {
      try {
        stdin.setRawMode(false);
      } catch {
        // The terminal may already be detached during shutdown.
      }
      stdout.write("\u001b[?25h\u001b[?1049l");
    }
    await monitor.close();
  }

  if (runtimeError !== undefined) {
    throw runtimeError;
  }
}

function monitorOptions(config: AppConfig): TallyburnMonitorOptions {
  return {
    windows: config.windows,
    refreshMs: config.refreshMs,
    providers: config.providers,
    codexHome: config.codexHome,
    claudeHome: config.claudeHome,
    stateDirectory: config.stateDirectory,
    backfill: config.backfill,
    codexAccount: config.codexAccount,
    claudeAccount: config.claudeAccount,
    ...(config.codexExecutable
      ? { codexExecutable: config.codexExecutable }
      : {}),
    ...(config.claudeExecutable
      ? { claudeExecutable: config.claudeExecutable }
      : {}),
    ...(config.otelPort !== undefined
      ? { otelPort: config.otelPort }
      : {}),
    ...(config.llamaCppMetrics
      ? { llamaCppMetrics: config.llamaCppMetrics }
      : {}),
    ...(config.vllmMetrics
      ? { vllmMetrics: config.vllmMetrics }
      : {}),
    otelLogs: config.otelLogs,
    demo: config.demo,
  };
}

async function runStream(
  config: AppConfig,
  monitor: TallyburnMonitor,
): Promise<void> {
  let stopped = false;
  let runtimeError: unknown;
  let sequence = 0;
  let finish: () => void = () => {};
  const stoppedPromise = new Promise<void>((resolve) => {
    finish = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      resolve();
    };
  });
  const onSignal = (): void => finish();
  const onStdoutError = (error: NodeJS.ErrnoException): void => {
    if (error.code !== "EPIPE") {
      runtimeError = error;
    }
    finish();
  };
  const unsubscribeSnapshots = monitor.subscribe(
    (snapshot) => {
      if (stopped) {
        return;
      }
      sequence += 1;
      stdout.write(
        `${JSON.stringify(snapshotEnvelope(snapshot, sequence))}\n`,
      );
    },
    { emitCurrent: false },
  );
  const unsubscribeErrors = monitor.subscribeErrors((error) => {
    runtimeError = error;
    finish();
  });

  try {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    stdout.on("error", onStdoutError);
    await monitor.start();
    await stoppedPromise;
  } finally {
    unsubscribeSnapshots();
    unsubscribeErrors();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    stdout.off("error", onStdoutError);
    await monitor.close();
  }

  if (runtimeError !== undefined) {
    throw runtimeError;
  }
}

function helpText(): string {
  return `Tallyburn ${VERSION} — local-first observed token pace and rolling usage

Usage
  tallyburn [watch] [options]
  tallyburn stream [options]
  tallyburn doctor [options]
  tallyburn statusline

Options
  --windows 1h,3h,12h    rolling windows (up to six, max 30d)
  --refresh 1s           dashboard refresh interval
  --provider all         codex, claude, gemini, copilot, qwen, llamacpp, vllm
  --once                 print one snapshot and exit
  --json                 print one machine-readable snapshot and exit
  --demo                 use synthetic data
  --otel-port 4318       receive official CLI OTLP/HTTP on loopback
  --otel-logs            opt in to allowlisted /v1/logs events
  --llamacpp-metrics URL poll a local llama.cpp /metrics endpoint
  --vllm-metrics URL     poll a local vLLM /metrics endpoint
  --codex-account        read quota through official Codex app-server
  --claude-account       read plan type through official Claude auth status
  --offline              disable authenticated provider control-plane reads
  --no-backfill          do not open local transcript JSONL files
  --codex-home PATH      override CODEX_HOME
  --claude-home PATH     override CLAUDE_CONFIG_DIR
  --codex-executable PATH
                         override the official Codex executable
  --claude-executable PATH
                         override the official Claude executable
  --config PATH          JSON config file
  --no-color             disable ANSI color
  -h, --help             show help
  -v, --version          show version

Tallyburn never opens provider credentials. Optional account discovery invokes
official client status commands and keeps only allowlisted plan fields. OTLP
and backfill inputs can be sensitive; only allowlisted usage fields and opaque
IDs survive parsing.`;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`tallyburn: ${sanitizeTerminalText(message)}\n`);
  process.exitCode = 1;
});
