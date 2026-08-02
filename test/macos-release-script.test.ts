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
  assert.match(script, /CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO/);
  assert.match(script, /ENABLE_HARDENED_RUNTIME=YES/);
  assert.match(script, /DEPLOYMENT_POSTPROCESSING=YES/);
  assert.match(script, /STRIP_INSTALLED_PRODUCT=YES/);
  assert.match(script, /COPY_PHASE_STRIP=YES/);
});

test("the macOS release notarizes, staples, and verifies the app", async () => {
  const script = await readFile(releaseScript, "utf8");

  assert.match(script, /notarytool submit/);
  assert.match(script, /notary_status.*Accepted/s);
  assert.match(script, /get-task-allow entitlement/);
  assert.match(script, /stapler staple/);
  assert.match(script, /stapler validate/);
  assert.match(script, /codesign --verify --deep --strict/);
  assert.match(script, /spctl --assess --type execute/);
  assert.match(script, /contains the local project path/);
  assert.match(script, /contains the local user home path/);
  assert.doesNotMatch(script, /codesign [^\n]*--deep[^\n]*--sign/);
});
