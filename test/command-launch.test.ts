import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareCommandLaunch,
  resolveWindowsCommand,
} from "../src/command-launch.js";

test("keeps POSIX commands as direct child processes", () => {
  const env = { PATH: "/usr/bin" };
  assert.deepEqual(
    prepareCommandLaunch("claude", ["--version"], {
      platform: "linux",
      env,
    }),
    {
      command: "claude",
      args: ["--version"],
      env,
      windowsScript: false,
    },
  );
});

test("resolves Windows commands using case-insensitive PATH and PATHEXT", () => {
  const existing = new Set([
    String.raw`C:\CLI Tools\claude.CMD`,
    String.raw`C:\Tools\codex.EXE`,
  ]);
  const env = {
    Path: String.raw`C:\Tools;"C:\CLI Tools"`,
    Pathext: ".EXE;.CMD",
  };
  const exists = (path: string): boolean => existing.has(path);

  assert.equal(
    resolveWindowsCommand("claude", env, String.raw`C:\Work`, exists),
    String.raw`C:\CLI Tools\claude.CMD`,
  );
  assert.equal(
    resolveWindowsCommand("codex", env, String.raw`C:\Work`, exists),
    String.raw`C:\Tools\codex.EXE`,
  );
});

test("wraps only Windows command scripts with a constrained cmd invocation", () => {
  const command = String.raw`C:\CLI Tools\claude.cmd`;
  const launch = prepareCommandLaunch(
    command,
    ["auth", "status", "--json"],
    {
      platform: "win32",
      env: {
        ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
        tallyburn_command_target: "must-not-survive",
      },
      exists: (path) => path === command,
    },
  );

  assert.equal(launch.command, String.raw`C:\Windows\System32\cmd.exe`);
  assert.deepEqual(launch.args.slice(0, 4), [
    "/d",
    "/s",
    "/v:off",
    "/c",
  ]);
  assert.equal(
    launch.args[4],
    '""%TALLYBURN_COMMAND_TARGET%" "%TALLYBURN_COMMAND_ARGUMENT_0%" "%TALLYBURN_COMMAND_ARGUMENT_1%" "%TALLYBURN_COMMAND_ARGUMENT_2%""',
  );
  assert.equal(launch.env.TALLYBURN_COMMAND_TARGET, command);
  assert.equal(launch.env.TALLYBURN_COMMAND_ARGUMENT_0, "auth");
  assert.equal(launch.env.TALLYBURN_COMMAND_ARGUMENT_1, "status");
  assert.equal(launch.env.TALLYBURN_COMMAND_ARGUMENT_2, "--json");
  assert.equal("tallyburn_command_target" in launch.env, false);
  assert.equal(launch.windowsScript, true);
});

test("keeps native Windows executables direct", () => {
  const command = String.raw`C:\Tools\codex.exe`;
  const env = { PATH: String.raw`C:\Tools` };
  assert.deepEqual(
    prepareCommandLaunch(command, ["--version"], {
      platform: "win32",
      env,
      exists: (path) => path === command,
    }),
    {
      command,
      args: ["--version"],
      env,
      windowsScript: false,
    },
  );
});

test("rejects values that cannot be represented safely in cmd.exe", () => {
  const command = String.raw`C:\Tools\claude.cmd`;
  assert.throws(
    () =>
      prepareCommandLaunch(command, ['bad"argument'], {
        platform: "win32",
        exists: (path) => path === command,
      }),
    /unsupported characters/,
  );
});
