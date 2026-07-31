#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const packageJson = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
);
const version =
  process.argv[2] ??
  process.env.TALLYBURN_RELEASE_VERSION ??
  packageJson.version;

if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
  throw new Error(`Invalid release version: ${version}`);
}

const outputDirectory = resolve(
  process.argv[3] ??
    process.env.TALLYBURN_VERIFY_DIR ??
    (process.env.CI && process.env.RUNNER_TEMP
      ? join(process.env.RUNNER_TEMP, `tallyburn-npm-${version}`)
      : join(projectRoot, "build", "release-verification", version, "npm")),
);
await mkdir(outputDirectory, { recursive: true });

const registryBase = "https://registry.npmjs.org";
const metadataUrl = `${registryBase}/${encodeURIComponent(packageJson.name)}/${encodeURIComponent(version)}`;
const metadata = await fetchJson(metadataUrl);
if (metadata.name !== packageJson.name || metadata.version !== version) {
  throw new Error("The npm registry returned a different package or version.");
}

const tarballUrl = metadata.dist?.tarball;
const integrity = metadata.dist?.integrity;
if (typeof tarballUrl !== "string" || typeof integrity !== "string") {
  throw new Error("The npm release has no tarball URL or integrity digest.");
}
const parsedTarballUrl = new URL(tarballUrl);
if (
  parsedTarballUrl.protocol !== "https:" ||
  parsedTarballUrl.hostname !== "registry.npmjs.org"
) {
  throw new Error("The npm tarball URL must use the official HTTPS registry.");
}

const tarballResponse = await fetch(tarballUrl, {
  headers: { "user-agent": `tallyburn-release-verifier/${packageJson.version}` },
});
if (!tarballResponse.ok) {
  throw new Error(
    `Unable to download the npm tarball: ${tarballResponse.status} ${tarballResponse.statusText}`,
  );
}
const tarball = Buffer.from(await tarballResponse.arrayBuffer());
verifySubresourceIntegrity(tarball, integrity);

const tarballName = `${packageJson.name}-${version}.tgz`;
const tarballPath = join(outputDirectory, tarballName);
await writeFile(tarballPath, tarball);

const installRoot = join(outputDirectory, "install");
await rm(installRoot, { recursive: true, force: true });
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
await run(npmCommand, [
  "install",
  "--prefix",
  installRoot,
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--package-lock=false",
  tarballPath,
]);

const executable = join(
  installRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tallyburn.cmd" : "tallyburn",
);
const installedVersion = (await run(executable, ["--version"])).trim();
if (installedVersion !== version) {
  throw new Error(
    `The installed CLI reported ${installedVersion}; expected ${version}.`,
  );
}

const snapshot = JSON.parse(
  await run(executable, [
    "snapshot",
    "--demo",
    "--json",
  ]),
);
if (
  snapshot.schemaVersion !== 1 ||
  snapshot.type !== "snapshot" ||
  !Array.isArray(snapshot.snapshot?.windows) ||
  snapshot.snapshot.windows.length === 0
) {
  throw new Error("The installed CLI returned an invalid demo snapshot.");
}

const doctor = JSON.parse(
  await run(executable, ["doctor", "--demo", "--json"]),
);
if (
  doctor.schemaVersion !== 1 ||
  doctor.type !== "doctor" ||
  doctor.healthy !== true
) {
  throw new Error("The installed CLI failed its demo doctor check.");
}

const report = {
  schemaVersion: 1,
  type: "npm-release-verification",
  verifiedAt: new Date().toISOString(),
  package: packageJson.name,
  version,
  registryMetadata: metadataUrl,
  tarball: {
    url: tarballUrl,
    filename: basename(tarballPath),
    bytes: tarball.byteLength,
    integrity,
    sha256: createHash("sha256").update(tarball).digest("hex"),
  },
  smokeTests: {
    installedVersion: true,
    demoSnapshot: true,
    demoDoctor: true,
  },
};
const reportPath = join(outputDirectory, "npm-verification.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": `tallyburn-release-verifier/${packageJson.version}` },
  });
  if (!response.ok) {
    throw new Error(
      `Unable to read npm metadata: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

function verifySubresourceIntegrity(contents, value) {
  const supported = value
    .split(/\s+/)
    .map((entry) => entry.match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/))
    .find(Boolean);
  if (!supported) {
    throw new Error("The npm release uses an unsupported integrity digest.");
  }
  const [, algorithm, expected] = supported;
  const actual = createHash(algorithm).update(contents).digest("base64");
  if (actual !== expected) {
    throw new Error("The downloaded npm tarball failed its integrity check.");
  }
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code === 0) {
        resolveRun(stdout);
        return;
      }
      rejectRun(
        new Error(
          `${command} ${args.join(" ")} exited with ${code}.\n${stderr.trim()}`,
        ),
      );
    });
  });
}
