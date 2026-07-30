import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const stageRoot = join(projectRoot, "build", "npm", "tallyburn");
const sourceRoot = join(projectRoot, "dist", "src");
const packageJson = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
);

await requireDirectory(sourceRoot);
await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });
await cp(sourceRoot, join(stageRoot, "dist", "src"), {
  recursive: true,
});
await Promise.all(
  ["LICENSE", "NOTICE"].map((name) =>
    cp(join(projectRoot, name), join(stageRoot, name)),
  ),
);
await writeFile(
  join(stageRoot, "package.json"),
  `${JSON.stringify(publishManifest(packageJson), null, 2)}\n`,
  "utf8",
);

await verifyStage(stageRoot);
process.stdout.write(`${stageRoot}\n`);

function publishManifest(source) {
  const fields = [
    "name",
    "version",
    "description",
    "type",
    "main",
    "types",
    "exports",
    "bin",
    "files",
    "engines",
    "keywords",
    "license",
    "author",
    "repository",
    "bugs",
    "homepage",
  ];
  return Object.fromEntries(
    fields
      .filter((field) => source[field] !== undefined)
      .map((field) => [field, source[field]]),
  );
}

async function verifyStage(root) {
  const files = await walk(root);
  const relativeFiles = files.map((path) => relative(root, path));
  const required = [
    "LICENSE",
    "NOTICE",
    "package.json",
    join("dist", "src", "cli.js"),
    join("dist", "src", "index.js"),
    join("dist", "src", "index.d.ts"),
  ];
  for (const file of required) {
    if (!relativeFiles.includes(file)) {
      throw new Error(`CLI package is missing ${file}.`);
    }
  }
  for (const file of relativeFiles) {
    if (
      file.startsWith("test") ||
      file.startsWith("docs") ||
      /^readme(?:\.|$)/i.test(file)
    ) {
      throw new Error(`CLI package contains unintended documentation: ${file}`);
    }
  }

  const forbidden = [projectRoot, homedir()];
  for (const file of files) {
    const info = await stat(file);
    if (info.size > 2 * 1024 * 1024) {
      throw new Error(`CLI package file is unexpectedly large: ${file}`);
    }
    const contents = await readFile(file, "utf8");
    for (const value of forbidden) {
      if (value && contents.includes(value)) {
        throw new Error(
          `CLI package contains a forbidden local or unrelated reference in ${relative(root, file)}.`,
        );
      }
    }
  }
}

async function walk(root) {
  const result = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...await walk(path));
    } else if (entry.isFile()) {
      result.push(path);
    } else {
      throw new Error(`CLI package contains an unsupported entry: ${path}`);
    }
  }
  return result;
}

async function requireDirectory(path) {
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      return;
    }
  } catch {
    // Fall through to the actionable build instruction.
  }
  throw new Error("Run `pnpm build` before staging the CLI package.");
}
