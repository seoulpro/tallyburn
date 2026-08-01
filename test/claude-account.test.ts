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
  parseClaudeAccountStatus,
  readClaudeAccountStatus,
} from "../src/claude-account.js";

test("parses only sanitized Claude subscription capability", () => {
  const status = parseClaudeAccountStatus(
    {
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: "MAX",
      email: "private@example.invalid",
      orgId: "secret-org",
      orgName: "Private Organization",
      accessToken: "must-not-survive",
    },
    123,
  );

  assert.deepEqual(status, {
    provider: "claude",
    observedAt: 123,
    loggedIn: true,
    subscriptionType: "max",
  });
  assert.doesNotMatch(
    JSON.stringify(status),
    /email|org|token|private|secret/i,
  );
});

test("logged-out Claude status never implies a subscription", () => {
  assert.deepEqual(
    parseClaudeAccountStatus(
      {
        loggedIn: false,
        subscriptionType: "max",
      },
      456,
    ),
    {
      provider: "claude",
      observedAt: 456,
      loggedIn: false,
    },
  );
});

test("uses the official non-model Claude auth status command", async (context) => {
  const executable = await fakeClaude(
    context,
    `
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["auth", "status", "--json"])) {
  process.exit(9);
}
process.stdout.write(JSON.stringify({
  loggedIn: true,
  subscriptionType: "max",
  email: "private@example.invalid"
}));
`,
  );

  const status = await readClaudeAccountStatus({
    executable,
    timeoutMs: 3_000,
    now: 789,
  });
  assert.deepEqual(status, {
    provider: "claude",
    observedAt: 789,
    loggedIn: true,
    subscriptionType: "max",
  });
});

test("fails closed for unavailable, stalled, or oversized Claude status", async (context) => {
  const stalled = await fakeClaude(
    context,
    "setTimeout(() => {}, 30_000);",
  );
  const oversized = await fakeClaude(
    context,
    'process.stdout.write("x".repeat(4096));',
  );

  assert.equal(
    await readClaudeAccountStatus({
      executable: `tallyburn-missing-claude-${process.pid}`,
      timeoutMs: 100,
    }),
    undefined,
  );
  assert.equal(
    await readClaudeAccountStatus({
      executable: stalled,
      timeoutMs: 50,
    }),
    undefined,
  );
  assert.equal(
    await readClaudeAccountStatus({
      executable: oversized,
      maxOutputBytes: 128,
    }),
    undefined,
  );
});

async function fakeClaude(
  context: TestContext,
  body: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tallyburn-claude-auth-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  if (process.platform === "win32") {
    const script = join(directory, "claude-fixture.cjs");
    const executable = join(directory, "claude.cmd");
    await writeFile(script, `${body}\n`);
    await writeFile(
      executable,
      `@echo off\r\n"${process.execPath}" "%~dp0claude-fixture.cjs" %*\r\n`,
    );
    return executable;
  }
  const executable = join(directory, "claude");
  await writeFile(
    executable,
    `#!/usr/bin/env node\n${body}\n`,
    { mode: 0o755 },
  );
  await chmod(executable, 0o755);
  return executable;
}
