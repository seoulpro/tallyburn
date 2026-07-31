import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const releaseScript = resolve(process.cwd(), "scripts/release-macos.sh");

test("the macOS release fails closed without distribution credentials", async () => {
  const script = await readFile(releaseScript, "utf8");

  assert.match(script, /Developer ID Application/);
  assert.match(script, /TALLYBURN_NOTARY_PROFILE/);
  assert.match(script, /notarytool history/);
  assert.match(script, /CODE_SIGNING_ALLOWED=YES/);
  assert.match(script, /ENABLE_HARDENED_RUNTIME=YES/);
});

test("the macOS release notarizes, staples, and verifies the app", async () => {
  const script = await readFile(releaseScript, "utf8");

  assert.match(script, /notarytool submit/);
  assert.match(script, /stapler staple/);
  assert.match(script, /stapler validate/);
  assert.match(script, /codesign --verify --deep --strict/);
  assert.match(script, /spctl --assess --type execute/);
  assert.doesNotMatch(script, /codesign [^\n]*--deep[^\n]*--sign/);
});
