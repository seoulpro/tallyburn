import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const __TALLYBURN_BUNDLED_VERSION__: string | undefined;

export const VERSION = readPackageVersion();

function readPackageVersion(): string {
  if (
    typeof __TALLYBURN_BUNDLED_VERSION__ === "string" &&
    __TALLYBURN_BUNDLED_VERSION__.length > 0
  ) {
    return __TALLYBURN_BUNDLED_VERSION__;
  }
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const value = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      ) as unknown;
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        "name" in value &&
        value.name === "tallyburn" &&
        "version" in value &&
        typeof value.version === "string"
      ) {
        return value.version;
      }
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error("Unable to locate the Tallyburn package version.");
}
