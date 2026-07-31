import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const buildScript = resolve(process.cwd(), "scripts/build-macos-dev.sh");
const runScript = resolve(process.cwd(), "scripts/run-macos-dev.sh");

test("the Debug macOS build embeds the standalone collection engine", async () => {
  const script = await readFile(buildScript, "utf8");

  assert.match(script, /run engine:macos/);
  assert.match(
    script,
    /TALLYBURN_ENGINE_EXECUTABLE="\$project_root\/build\/engine\/tallyburn"/,
  );
  assert.match(
    script,
    /TALLYBURN_ENGINE_NOTICES="\$project_root\/build\/engine\/CollectionEngineNotices\.txt"/,
  );
});

test("the Debug macOS launcher relies on the bundled collection engine", async () => {
  const script = await readFile(runScript, "utf8");

  assert.match(script, /open -g "\$app_path"/);
  assert.doesNotMatch(script, /TALLYBURN_CLI_SCRIPT/);
  assert.doesNotMatch(script, /TALLYBURN_NODE_PATH/);
});
