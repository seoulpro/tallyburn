import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const npmVerifier = resolve(
  process.cwd(),
  "scripts/verify-public-npm.mjs",
);
const releaseVerifier = resolve(
  process.cwd(),
  "scripts/verify-release-artifacts.sh",
);
const workflow = resolve(
  process.cwd(),
  ".github/workflows/verify-release.yml",
);

test("the npm release verifier downloads and checks the registry tarball", async () => {
  const script = await readFile(npmVerifier, "utf8");

  assert.match(script, /https:\/\/registry\.npmjs\.org/);
  assert.match(script, /hostname !== "registry\.npmjs\.org"/);
  assert.match(script, /verifySubresourceIntegrity\(tarball, integrity\)/);
  assert.match(script, /createHash\("sha256"\)/);
  assert.match(script, /"--ignore-scripts"/);
  assert.match(script, /"snapshot"[\s\S]*"--demo"[\s\S]*"--json"/);
  assert.match(script, /"doctor", "--demo", "--json"/);
  assert.match(script, /process\.platform !== "win32"/);
  assert.match(script, /"\/d", "\/s", "\/v:off", "\/c"/);
  assert.doesNotMatch(script, /shell:\s*true/);
});

test("the macOS release verifier checks the downloaded public app", async () => {
  const script = await readFile(releaseVerifier, "utf8");

  assert.match(script, /releases\/download\/v\$version/);
  assert.match(script, /codesign --verify --deep --strict/);
  assert.match(script, /stapler validate/);
  assert.match(script, /spctl --assess --type execute/);
  assert.match(script, /Developer ID Application/);
  assert.match(script, /get-task-allow/);
  assert.match(script, /for architecture in arm64 x86_64/);
  assert.match(script, /SHA256SUMS/);
  assert.match(script, /verify-public-npm\.mjs/);
});

test("release verification is manually repeatable on every supported OS", async () => {
  const source = await readFile(workflow, "utf8");

  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /ubuntu-latest/);
  assert.match(source, /windows-latest/);
  assert.match(source, /macos-26/);
  assert.match(source, /verify-public-npm\.mjs/);
  assert.match(source, /verify-release-artifacts\.sh/);
});
