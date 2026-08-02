import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const NODE_VERSION = "24.18.0";
const NODE_BASE_URL = `https://nodejs.org/download/release/v${NODE_VERSION}`;
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const TARGETS = [
  {
    nodeArch: "arm64",
    macArch: "arm64",
    sha256: "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1",
  },
  {
    nodeArch: "x64",
    macArch: "x86_64",
    sha256: "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
  },
];

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const packageJson = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
);
const engineRoot = join(projectRoot, "build", "engine");
const cacheRoot = join(engineRoot, "cache");
const workRoot = join(engineRoot, "work");
const output = join(engineRoot, "tallyburn");
const notices = join(engineRoot, "CollectionEngineNotices.txt");
const bundle = join(workRoot, "tallyburn.cjs");
const seaConfig = join(workRoot, "sea-config.json");
const seaBlob = join(workRoot, "tallyburn.blob");
const postject = join(projectRoot, "node_modules", "postject", "dist", "cli.js");
const entitlements = join(
  projectRoot,
  "scripts",
  "macos-engine.entitlements",
);

if (platform() !== "darwin") {
  throw new Error("The universal collection engine must be built on macOS.");
}
if (!["arm64", "x64"].includes(arch())) {
  throw new Error(`Unsupported macOS build architecture: ${arch()}`);
}
if (typeof packageJson.version !== "string") {
  throw new Error("package.json is missing a valid version.");
}

await access(join(projectRoot, "dist", "src", "cli.js"), constants.R_OK);
await access(postject, constants.R_OK);
await access(entitlements, constants.R_OK);
await mkdir(cacheRoot, { recursive: true });
await rm(workRoot, { recursive: true, force: true });
await mkdir(workRoot, { recursive: true });

const distributions = [];
for (const { nodeArch, macArch, sha256: expected } of TARGETS) {
  distributions.push(
    await prepareNodeDistribution(nodeArch, macArch, expected),
  );
}

await build({
  entryPoints: [join(projectRoot, "dist", "src", "cli.js")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: [`node${NODE_VERSION}`],
  sourcemap: false,
  legalComments: "none",
  minifySyntax: true,
  logOverride: {
    // The bundled version guard returns before this filesystem fallback.
    "empty-import-meta": "silent",
  },
  define: {
    __TALLYBURN_BUNDLED_VERSION__: JSON.stringify(packageJson.version),
  },
});
await writeFile(
  seaConfig,
  `${JSON.stringify(
    {
      main: "tallyburn.cjs",
      output: seaBlob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgvExtension: "none",
    },
    null,
    2,
  )}\n`,
);

const hostNodeArch = arch() === "arm64" ? "arm64" : "x64";
const hostDistribution = distributions.find(
  (distribution) => distribution.nodeArch === hostNodeArch,
);
if (!hostDistribution) {
  throw new Error("A matching Node.js host binary was not prepared.");
}
await run(hostDistribution.node, [
  "--experimental-sea-config",
  seaConfig,
], { cwd: workRoot });

const slices = [];
for (const distribution of distributions) {
  const slice = join(workRoot, `tallyburn-${distribution.macArch}`);
  await copyFile(distribution.node, slice);
  await chmod(slice, 0o755);
  await removeSignature(slice);
  await run(process.execPath, [
    postject,
    slice,
    "NODE_SEA_BLOB",
    seaBlob,
    "--sentinel-fuse",
    SEA_FUSE,
    "--macho-segment-name",
    "NODE_SEA",
  ]);
  slices.push(slice);
}

await rm(output, { force: true });
await run("/usr/bin/lipo", [
  "-create",
  ...slices,
  "-output",
  output,
]);
await chmod(output, 0o755);
await run("/usr/bin/codesign", [
  "--force",
  "--options",
  "runtime",
  "--entitlements",
  entitlements,
  "--sign",
  "-",
  output,
]);
await run("/usr/bin/codesign", [
  "--verify",
  "--strict",
  "--verbose=2",
  output,
]);

const architectureOutput = await run("/usr/bin/lipo", ["-archs", output]);
for (const { macArch } of TARGETS) {
  if (!architectureOutput.trim().split(/\s+/).includes(macArch)) {
    throw new Error(`The engine is missing architecture ${macArch}.`);
  }
}
const versionOutput = await run(output, ["--version"]);
if (versionOutput.trim() !== packageJson.version) {
  throw new Error("The standalone engine reported an unexpected version.");
}
const snapshotOutput = await run(
  output,
  ["snapshot", "--demo", "--provider", "codex", "--json"],
  { maxBuffer: 4 * 1024 * 1024 },
);
const envelope = JSON.parse(snapshotOutput);
if (
  envelope?.schemaVersion !== 1 ||
  envelope?.type !== "snapshot" ||
  envelope?.snapshot?.windows?.length < 1
) {
  throw new Error("The standalone engine snapshot smoke test failed.");
}

const nodeLicense = await readFile(hostDistribution.license, "utf8");
await writeFile(
  notices,
  [
    "Tallyburn Collection Engine",
    `Tallyburn ${packageJson.version}`,
    "",
    `This executable includes Node.js ${NODE_VERSION}.`,
    "The Node.js license and bundled third-party notices follow.",
    "",
    nodeLicense.trimEnd(),
    "",
  ].join("\n"),
);

process.stdout.write(
  `${JSON.stringify(
    {
      executable: output,
      notices,
      nodeVersion: NODE_VERSION,
      architectures: TARGETS.map(({ macArch }) => macArch),
    },
    null,
    2,
  )}\n`,
);

async function prepareNodeDistribution(nodeArch, macArch, expected) {
  const archiveName = `node-v${NODE_VERSION}-darwin-${nodeArch}.tar.gz`;
  const archive = join(cacheRoot, archiveName);
  if ((await sha256(archive)) !== expected) {
    await downloadVerified(`${NODE_BASE_URL}/${archiveName}`, archive, expected);
  }

  const directory = join(
    cacheRoot,
    `node-v${NODE_VERSION}-darwin-${nodeArch}`,
  );
  const node = join(directory, "bin", "node");
  const license = join(directory, "LICENSE");
  if (
    !(await isReadable(node)) ||
    !(await isReadable(license))
  ) {
    await rm(directory, { recursive: true, force: true });
    await run("/usr/bin/tar", ["-xzf", archive, "-C", cacheRoot]);
  }
  await access(node, constants.X_OK);
  await access(license, constants.R_OK);
  return {
    nodeArch,
    macArch,
    node,
    license,
  };
}

async function downloadVerified(url, destination, expected) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to download ${url} (${response.status}).`);
  }
  const temporary = `${destination}.download`;
  await writeFile(temporary, new Uint8Array(await response.arrayBuffer()));
  const actual = await sha256(temporary);
  if (actual !== expected) {
    await rm(temporary, { force: true });
    throw new Error(`Checksum verification failed for ${destination}.`);
  }
  await rename(temporary, destination);
}

async function sha256(path) {
  try {
    const contents = await readFile(path);
    return createHash("sha256").update(contents).digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function isReadable(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function removeSignature(path) {
  try {
    await run("/usr/bin/codesign", ["--remove-signature", path]);
  } catch (error) {
    if (!String(error).includes("code object is not signed")) {
      throw error;
    }
  }
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
    cwd: options.cwd,
    env: process.env,
  });
  return result.stdout;
}
