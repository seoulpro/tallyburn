import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  requestTimeoutMs,
  startCodexAccountBridge,
} from "../src/codex-account.js";
import type { QuotaSnapshot } from "../src/model.js";

test("Codex app-server bridge performs the documented read handshake", async (context) => {
  const executable = await fakeAppServer(context, true);
  let quota: QuotaSnapshot | undefined;
  const bridge = await startCodexAccountBridge({
    executable,
    timeoutMs: 5_000,
    onQuota(value) {
      quota = value;
    },
  });
  await bridge.close();

  assert.equal(quota?.primary?.usedPercent, 25);
  assert.equal(quota?.primary?.windowMs, 5 * 3_600_000);
});

test("Codex bridge shares one deadline across requests", () => {
  assert.equal(requestTimeoutMs(5_000, 1_000, 4_750), 250);
  assert.equal(requestTimeoutMs(5_000, 1_000, 3_000), 1_000);
  assert.equal(requestTimeoutMs(5_000, 1_000, 5_001), 0);
});

test("Codex bridge closes a partial server within its total deadline", async (context) => {
  const executable = await fakeAppServer(context, false);
  const started = Date.now();
  let bridge:
    | Awaited<ReturnType<typeof startCodexAccountBridge>>
    | undefined;
  try {
    bridge = await startCodexAccountBridge({
      executable,
      timeoutMs: 1_000,
      onQuota() {},
    });
  } catch (error) {
    assert.match(String(error), /timed out/);
  }
  await bridge?.close();
  assert.ok(Date.now() - started < 2_500);
});

test("Codex bridge fails cleanly when the executable is absent", async () => {
  const started = Date.now();
  await assert.rejects(
    startCodexAccountBridge({
      executable: `tallyburn-missing-${process.pid}`,
      timeoutMs: 100,
      onQuota() {},
    }),
    /unavailable|closed|timed out/i,
  );
  assert.ok(Date.now() - started < 600);
});

async function fakeAppServer(
  context: TestContext,
  answerRateLimits: boolean,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tallyburn-app-server-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const body = `
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  } else if (
    message.method === "account/rateLimits/read" &&
    ${answerRateLimits ? "true" : "false"}
  ) {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        rateLimits: {
          primary: {
            usedPercent: 25,
            windowDurationMins: 300
          }
        }
      }
    }) + "\\n");
  }
});
process.on("SIGTERM", () => process.exit(0));
`;
  if (process.platform === "win32") {
    const script = join(directory, "fake-app-server.cjs");
    const executable = join(directory, "fake-app-server.cmd");
    await writeFile(script, body);
    await writeFile(
      executable,
      `@echo off\r\n"${process.execPath}" "%~dp0fake-app-server.cjs" %*\r\n`,
    );
    return executable;
  }
  const executable = join(directory, "fake-app-server");
  await writeFile(
    executable,
    `#!/usr/bin/env node${body}`,
    { mode: 0o755 },
  );
  await chmod(executable, 0o755);
  return executable;
}
