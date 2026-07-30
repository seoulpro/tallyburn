import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as zlib from "node:zlib";
import {
  CLAUDE_DESKTOP_QUOTA_MAX_AGE_MS,
  parseClaudeDesktopUsage,
  readClaudeDesktopQuota,
} from "../src/claude-desktop.js";

const SIMPLE_CACHE_MAGIC = 0xfcfb6d1ba7725c30n;

test("parses only Claude Desktop five-hour and seven-day usage", () => {
  const quota = parseClaudeDesktopUsage(
    {
      five_hour: {
        utilization: 70,
        resets_at: "2026-07-30T12:40:00.000Z",
        used_dollars: "private",
      },
      seven_day: {
        utilization: 121,
        resets_at: "2026-08-05T11:00:00.000Z",
      },
      spend: {
        disclaimer: "SENSITIVE_FIXTURE",
      },
      member_dashboard_available: true,
    },
    123,
  );

  assert.deepEqual(quota, {
    provider: "claude",
    timestamp: 123,
    primary: {
      usedPercent: 70,
      windowMs: 5 * 60 * 60 * 1_000,
      resetsAt: Date.parse("2026-07-30T12:40:00.000Z"),
    },
    secondary: {
      usedPercent: 100,
      windowMs: 7 * 24 * 60 * 60 * 1_000,
      resetsAt: Date.parse("2026-08-05T11:00:00.000Z"),
    },
  });
  assert.doesNotMatch(
    JSON.stringify(quota),
    /dollars|disclaimer|dashboard|private|sensitive/i,
  );
});

test("reads the newest matching Claude Desktop cache entry", async (context) => {
  const cacheDirectory = await temporaryCache(context);
  const organizationId = "fixture-org";
  const now = Date.now();
  await writeUsageEntry(
    cacheDirectory,
    organizationId,
    "?skip_spend=1",
    usage(40, 10),
    now - 3_000,
  );
  await writeUsageEntry(
    cacheDirectory,
    organizationId,
    "",
    usage(80, 21),
    now - 1_000,
  );

  const quota = await readClaudeDesktopQuota({
    organizationId,
    cacheDirectory,
    now,
  });

  assert.equal(quota?.primary?.usedPercent, 80);
  assert.equal(quota?.secondary?.usedPercent, 21);
  assert.ok((quota?.timestamp ?? 0) >= now - 1_100);
  assert.doesNotMatch(
    JSON.stringify(quota),
    /fixture-org|organization|spend/i,
  );
});

test("ignores expired, malformed, and unrelated cache data", async (context) => {
  const cacheDirectory = await temporaryCache(context);
  const organizationId = "fixture-org";
  const now = Date.now();
  await writeUsageEntry(
    cacheDirectory,
    organizationId,
    "",
    { five_hour: { utilization: "not-a-number" } },
    now - 1_000,
  );

  assert.equal(
    await readClaudeDesktopQuota({
      organizationId,
      cacheDirectory,
      now,
    }),
    undefined,
  );

  await writeUsageEntry(
    cacheDirectory,
    organizationId,
    "",
    usage(50, 25),
    now - CLAUDE_DESKTOP_QUOTA_MAX_AGE_MS - 1,
  );
  assert.equal(
    await readClaudeDesktopQuota({
      organizationId,
      cacheDirectory,
      now,
    }),
    undefined,
  );
  assert.equal(
    await readClaudeDesktopQuota({
      organizationId: "../untrusted",
      cacheDirectory,
      now,
    }),
    undefined,
  );
});

test("decodes Chromium's zstd-compressed response body", {
  skip: typeof zlib.zstdCompressSync !== "function",
}, async (context) => {
  const cacheDirectory = await temporaryCache(context);
  const organizationId = "fixture-org";
  const now = Date.now();
  await writeUsageEntry(
    cacheDirectory,
    organizationId,
    "",
    usage(67, 32),
    now - 1_000,
    true,
  );

  const quota = await readClaudeDesktopQuota({
    organizationId,
    cacheDirectory,
    now,
  });
  assert.equal(quota?.primary?.usedPercent, 67);
  assert.equal(quota?.secondary?.usedPercent, 32);
});

async function temporaryCache(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tallyburn-claude-cache-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  return directory;
}

function usage(primary: number, secondary: number): unknown {
  return {
    five_hour: {
      utilization: primary,
      resets_at: "2030-01-01T00:00:00.000Z",
    },
    seven_day: {
      utilization: secondary,
      resets_at: "2030-01-02T00:00:00.000Z",
    },
    spend: {
      used: "not retained",
    },
  };
}

async function writeUsageEntry(
  cacheDirectory: string,
  organizationId: string,
  suffix: "" | "?skip_spend=1",
  payload: unknown,
  mtimeMs: number,
  compressed = false,
): Promise<void> {
  const key =
    `1/0/https://claude.ai/api/organizations/` +
    `${organizationId}/usage${suffix}`;
  const keyBytes = Buffer.from(key);
  const header = Buffer.alloc(24);
  header.writeBigUInt64LE(SIMPLE_CACHE_MAGIC, 0);
  header.writeUInt32LE(5, 8);
  header.writeUInt32LE(keyBytes.byteLength, 12);
  const json = Buffer.from(JSON.stringify(payload));
  const body = compressed && typeof zlib.zstdCompressSync === "function"
    ? zlib.zstdCompressSync(json)
    : json;
  const hash = createHash("sha1").update(key).digest().subarray(0, 8);
  hash.reverse();
  const path = join(cacheDirectory, `${hash.toString("hex")}_0`);
  await writeFile(
    path,
    Buffer.concat([
      header,
      keyBytes,
      body,
      Buffer.alloc(24),
    ]),
  );
  const modified = new Date(mtimeMs);
  await utimes(path, modified, modified);
}
