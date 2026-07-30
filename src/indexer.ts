import { constants } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { opaqueEventId } from "./id.js";
import { parseClaudeLine } from "./parsers/claude.js";
import { parseCodexLine } from "./parsers/codex.js";
import type {
  LineParser,
  ParsedLine,
  ParserState,
} from "./parsers/types.js";
import {
  TRANSCRIPT_PROVIDERS,
  providerRecord,
  type Provider,
  type SourceStatus,
  type UsageEvent,
} from "./model.js";
import { UsageStore } from "./store.js";

interface SourceDefinition {
  provider: Provider;
  displayRoot: string;
  roots: string[];
  parser: LineParser;
}

interface FileState {
  device: number;
  inode: number;
  offset: number;
  boundaryDigest?: string;
  remainder: Buffer[];
  remainderBytes: number;
  discardingLine: boolean;
  parserState: ParserState;
  codexUsageSignatures?: number[];
  codexReplay?: CodexReplayState;
}

type CodexReplayState =
  | { mode: "matching-parent"; index: number }
  | { mode: "rewritten-burst"; previousAt: number }
  | { mode: "done" };

interface DiscoveryResult {
  available: boolean;
  filesSeen: number;
  candidates: string[];
}

const READ_CHUNK_BYTES = 256 * 1024;
const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;
const CODEX_REPLAY_BURST_GAP_MS = 1_000;

export interface UsageIndexerOptions {
  codexHome: string;
  claudeHome: string;
  retentionMs: number;
  providers?: readonly Provider[];
}

export class UsageIndexer {
  readonly store = new UsageStore();
  readonly #sources: SourceDefinition[];
  readonly #retentionMs: number;
  readonly #files = new Map<string, FileState>();
  readonly #codexFilesBySession = new Map<string, FileState>();
  readonly #statuses: Record<Provider, SourceStatus>;
  readonly #eventUpperBounds: Partial<Record<Provider, number>> = {};
  #cutoff = 0;

  constructor(options: UsageIndexerOptions) {
    const enabled = new Set(
      options.providers ?? TRANSCRIPT_PROVIDERS,
    );
    this.#retentionMs = options.retentionMs;
    const sources: SourceDefinition[] = [
      {
        provider: "codex",
        displayRoot: options.codexHome,
        roots: [
          join(options.codexHome, "sessions"),
          join(options.codexHome, "archived_sessions"),
        ],
        parser: parseCodexLine,
      },
      {
        provider: "claude",
        displayRoot: options.claudeHome,
        roots: [join(options.claudeHome, "projects")],
        parser: parseClaudeLine,
      },
    ];
    this.#sources = sources.filter((source) => enabled.has(source.provider));
    this.#statuses = providerRecord((provider) =>
      emptyStatus(
        provider,
        provider === "codex"
          ? options.codexHome
          : provider === "claude"
            ? options.claudeHome
            : provider === "llamacpp" || provider === "vllm"
              ? "Prometheus metrics"
              : "OTLP metrics",
      )
    );
  }

  get statuses(): Readonly<Record<Provider, SourceStatus>> {
    return this.#statuses;
  }

  get trackedFileCount(): number {
    return this.#files.size;
  }

  setProviderEventUpperBound(
    provider: Provider,
    timestamp: number | undefined,
  ): void {
    if (timestamp === undefined) {
      delete this.#eventUpperBounds[provider];
    } else {
      this.#eventUpperBounds[provider] = timestamp;
    }
  }

  async scan(now = Date.now()): Promise<void> {
    this.#cutoff = now - this.#retentionMs - 60_000;
    const liveFiles = new Set<string>();
    for (const source of this.#sources) {
      await this.#scanSource(source, liveFiles);
    }
    for (const path of this.#files.keys()) {
      if (!liveFiles.has(path)) {
        this.#forgetFile(path);
      }
    }
    this.store.prune(now - this.#retentionMs - 60_000);
    this.#refreshLastEventTimes();
  }

  async scanFiles(
    provider: Provider,
    paths: readonly string[],
    now = Date.now(),
  ): Promise<void> {
    const source = this.#sources.find(
      (candidate) => candidate.provider === provider,
    );
    if (!source) {
      return;
    }
    this.#cutoff = now - this.#retentionMs - 60_000;
    const status = this.#statuses[provider];
    for (const path of new Set(paths)) {
      if (
        !path.endsWith(".jsonl") ||
        !source.roots.some((root) => isWithin(root, path))
      ) {
        continue;
      }
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.mtimeMs < this.#cutoff) {
          this.#forgetFile(path);
          continue;
        }
        status.available = true;
        await this.#tailFile(path, source, status);
      } catch (error) {
        this.#forgetFile(path);
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          status.malformedLines += 1;
        }
      }
    }
    this.store.prune(now - this.#retentionMs - 60_000);
    this.#refreshLastEventTimes();
  }

  async #scanSource(
    source: SourceDefinition,
    liveFiles: Set<string>,
  ): Promise<void> {
    const discoveries = await Promise.all(
      source.roots.map((root) => discoverJsonl(root, this.#cutoff)),
    );
    const status = this.#statuses[source.provider];
    status.available = discoveries.some((result) => result.available);
    status.filesSeen = discoveries.reduce(
      (total, result) => total + result.filesSeen,
      0,
    );
    const candidates = discoveries
      .flatMap((result) => result.candidates)
      .sort(compareCandidatePaths);
    status.filesRead = candidates.length;

    for (const path of candidates) {
      liveFiles.add(path);
      try {
        await this.#tailFile(path, source, status);
      } catch {
        status.malformedLines += 1;
      }
    }
  }

  async #tailFile(
    path: string,
    source: SourceDefinition,
    status: SourceStatus,
  ): Promise<void> {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      throw new Error("JSONL source is not a regular file.");
    }
    let fileState = this.#files.get(path);
    if (
      !fileState ||
      metadata.dev !== fileState.device ||
      metadata.ino !== fileState.inode ||
      metadata.size < fileState.offset
    ) {
      this.#forgetFile(path);
      fileState = {
        device: metadata.dev,
        inode: metadata.ino,
        offset: 0,
        remainder: [],
        remainderBytes: 0,
        discardingLine: false,
        parserState: {
          sourceKey: opaqueEventId(
            "source",
            basename(path, ".jsonl"),
          ),
        },
        ...(source.provider === "codex"
          ? { codexUsageSignatures: [] }
          : {}),
      };
      this.#files.set(path, fileState);
    }

    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const openedMetadata = await handle.stat();
      if (
        !openedMetadata.isFile() ||
        openedMetadata.dev !== fileState.device ||
        openedMetadata.ino !== fileState.inode
      ) {
        throw new Error("JSONL source changed during open.");
      }
      if (
        fileState.offset > 0 &&
        fileState.boundaryDigest !== undefined
      ) {
        const currentDigest = await readBoundaryDigest(
          handle,
          fileState.offset,
        );
        if (currentDigest !== fileState.boundaryDigest) {
          this.#unregisterCodexFile(fileState);
          resetFileState(fileState, metadata.dev, metadata.ino);
        }
      }
      while (fileState.offset < metadata.size) {
        const length = Math.min(
          READ_CHUNK_BYTES,
          metadata.size - fileState.offset,
        );
        const chunk = Buffer.allocUnsafe(length);
        const result = await handle.read(
          chunk,
          0,
          length,
          fileState.offset,
        );
        if (result.bytesRead === 0) {
          break;
        }
        fileState.offset += result.bytesRead;
        this.#consumeChunk(
          chunk.subarray(0, result.bytesRead),
          fileState,
          source,
          status,
        );
      }
      if (fileState.offset > 0) {
        fileState.boundaryDigest = await readBoundaryDigest(
          handle,
          fileState.offset,
        );
      }
    } finally {
      await handle.close();
    }
  }

  #consumeChunk(
    chunk: Buffer,
    fileState: FileState,
    source: SourceDefinition,
    status: SourceStatus,
  ): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(start, end);

      if (fileState.discardingLine) {
        if (newline !== -1) {
          fileState.discardingLine = false;
        }
      } else if (
        fileState.remainderBytes + segment.byteLength >
        MAX_JSONL_LINE_BYTES
      ) {
        fileState.remainder = [];
        fileState.remainderBytes = 0;
        fileState.discardingLine = newline === -1;
        status.malformedLines += 1;
      } else {
        if (segment.byteLength > 0) {
          fileState.remainder.push(segment);
          fileState.remainderBytes += segment.byteLength;
        }
        if (newline !== -1) {
          this.#consumeLine(fileState, source, status);
        }
      }

      if (newline === -1) {
        break;
      }
      start = newline + 1;
    }
  }

  #consumeLine(
    fileState: FileState,
    source: SourceDefinition,
    status: SourceStatus,
  ): void {
    let line = Buffer.concat(
      fileState.remainder,
      fileState.remainderBytes,
    );
    fileState.remainder = [];
    fileState.remainderBytes = 0;
    if (line.at(-1) === 0x0d) {
      line = line.subarray(0, line.length - 1);
    }
    if (line.length === 0) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line.toString("utf8"));
    } catch {
      status.malformedLines += 1;
      return;
    }
    const parsed = source.parser(value, fileState.parserState);
    this.#applyParsed(parsed, fileState);
  }

  #applyParsed(parsed: ParsedLine, fileState: FileState): void {
    const state = fileState.parserState;
    if (parsed.sessionId) {
      state.sessionId = parsed.sessionId;
      fileState.codexUsageSignatures ??= [];
      this.#codexFilesBySession.set(parsed.sessionId, fileState);
    }
    if (parsed.codexParentSessionId) {
      state.codexParentSessionId = parsed.codexParentSessionId;
      fileState.codexReplay = {
        mode: "matching-parent",
        index: 0,
      };
    }
    if (parsed.codexSessionStartedAt !== undefined) {
      state.codexSessionStartedAt = parsed.codexSessionStartedAt;
    }
    if (parsed.model) {
      state.model = parsed.model;
    }
    if (parsed.codexCumulative) {
      state.codexCumulative = parsed.codexCumulative;
    }
    if (parsed.event) {
      const shouldIndex =
        parsed.event.provider !== "codex" ||
        this.#shouldIndexCodexEvent(fileState, parsed.event);
      const upperBound = this.#eventUpperBounds[parsed.event.provider];
      if (
        shouldIndex &&
        parsed.event.timestamp >= this.#cutoff &&
        (upperBound === undefined || parsed.event.timestamp < upperBound)
      ) {
        this.store.upsertEvent(parsed.event);
      }
    }
    if (parsed.quota) {
      this.store.updateQuota(parsed.quota);
    }
    if (parsed.quotaWindowUpdate) {
      const update = parsed.quotaWindowUpdate;
      this.store.updateQuotaWindow(
        update.provider,
        update.key,
        update.window,
        update.timestamp,
      );
    }
  }

  #shouldIndexCodexEvent(
    fileState: FileState,
    event: UsageEvent,
  ): boolean {
    const signature = codexUsageSignature(event);
    const signatures = fileState.codexUsageSignatures ??= [];
    // A flat numeric pair keeps replay matching compact while retaining the
    // parent timestamp needed to stop exactly at the fork boundary.
    signatures.push(signature, event.timestamp);

    const parentSessionId = fileState.parserState.codexParentSessionId;
    if (!parentSessionId) {
      return true;
    }
    const replay = fileState.codexReplay ?? {
      mode: "matching-parent",
      index: 0,
    };

    if (replay.mode === "done") {
      return true;
    }
    if (replay.mode === "rewritten-burst") {
      const gap = event.timestamp - replay.previousAt;
      if (gap >= 0 && gap <= CODEX_REPLAY_BURST_GAP_MS) {
        fileState.codexReplay = {
          mode: "rewritten-burst",
          previousAt: event.timestamp,
        };
        return false;
      }
      fileState.codexReplay = { mode: "done" };
      return true;
    }

    const parent = this.#codexFilesBySession.get(parentSessionId);
    const parentOffset = replay.index * 2;
    const expected = parent?.codexUsageSignatures?.[parentOffset];
    const expectedAt = parent?.codexUsageSignatures?.[parentOffset + 1];
    const startedAt = fileState.parserState.codexSessionStartedAt;
    if (
      expectedAt !== undefined &&
      startedAt !== undefined &&
      expectedAt > startedAt
    ) {
      fileState.codexReplay = { mode: "done" };
      return true;
    }
    if (expected !== undefined && expected === signature) {
      fileState.codexReplay = {
        mode: "matching-parent",
        index: replay.index + 1,
      };
      return false;
    }
    if (replay.index > 0) {
      fileState.codexReplay = { mode: "done" };
      return true;
    }

    // When the parent log is unavailable or cannot anchor the prefix, Codex's
    // replayed history is still recognizable as a dense burst rewritten to
    // the fork instant. A real first response follows after model work rather
    // than completing within this one-second guard.
    if (
      startedAt !== undefined &&
      event.timestamp >= startedAt &&
      event.timestamp - startedAt <= CODEX_REPLAY_BURST_GAP_MS
    ) {
      fileState.codexReplay = {
        mode: "rewritten-burst",
        previousAt: event.timestamp,
      };
      return false;
    }
    fileState.codexReplay = { mode: "done" };
    return true;
  }

  #forgetFile(path: string): void {
    const fileState = this.#files.get(path);
    if (fileState) {
      this.#unregisterCodexFile(fileState);
      this.#files.delete(path);
    }
  }

  #unregisterCodexFile(fileState: FileState): void {
    const sessionId = fileState.parserState.sessionId;
    if (
      sessionId &&
      this.#codexFilesBySession.get(sessionId) === fileState
    ) {
      this.#codexFilesBySession.delete(sessionId);
    }
  }

  #refreshLastEventTimes(): void {
    const snapshot = this.store.snapshot(
      [{ label: "retention", durationMs: this.#retentionMs }],
      0,
      this.#statuses,
    );
    for (const provider of TRANSCRIPT_PROVIDERS) {
      const lastEventAt =
        snapshot.windows[0]?.providers[provider].lastEventAt;
      if (lastEventAt === undefined) {
        delete this.#statuses[provider].lastEventAt;
      } else {
        this.#statuses[provider].lastEventAt = lastEventAt;
      }
    }
  }
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

function emptyStatus(provider: Provider, root: string): SourceStatus {
  return {
    provider,
    root,
    available: false,
    filesSeen: 0,
    filesRead: 0,
    malformedLines: 0,
  };
}

function resetFileState(
  fileState: FileState,
  device: number,
  inode: number,
): void {
  fileState.device = device;
  fileState.inode = inode;
  fileState.offset = 0;
  delete fileState.boundaryDigest;
  fileState.remainder = [];
  fileState.remainderBytes = 0;
  fileState.discardingLine = false;
  fileState.codexUsageSignatures = [];
  delete fileState.codexReplay;
  fileState.parserState = {
    sourceKey: fileState.parserState.sourceKey,
  };
}

function compareCandidatePaths(left: string, right: string): number {
  const byName = basename(left).localeCompare(basename(right));
  return byName !== 0 ? byName : left.localeCompare(right);
}

function codexUsageSignature(
  event: UsageEvent,
): number {
  let hash = 0x811c9dc5;
  for (const value of [
    event.freshInput,
    event.cacheRead,
    event.cacheWrite,
    event.output,
    event.reasoning,
    event.total,
  ]) {
    const low = value >>> 0;
    const high = Math.floor(value / 0x1_0000_0000) >>> 0;
    hash = Math.imul(hash ^ low, 0x01000193);
    hash = Math.imul(hash ^ high, 0x01000193);
  }
  return hash >>> 0;
}

async function readBoundaryDigest(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
): Promise<string> {
  const length = Math.min(256, offset);
  const buffer = Buffer.allocUnsafe(length);
  const result = await handle.read(
    buffer,
    0,
    length,
    offset - length,
  );
  if (result.bytesRead !== length) {
    throw new Error("JSONL source changed while checking its boundary.");
  }
  return createHash("sha256")
    .update(buffer.subarray(0, result.bytesRead))
    .digest("base64url");
}

async function discoverJsonl(
  root: string,
  cutoff: number,
): Promise<DiscoveryResult> {
  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      return { available: false, filesSeen: 0, candidates: [] };
    }
  } catch {
    return { available: false, filesSeen: 0, candidates: [] };
  }

  let filesSeen = 0;
  const candidates: string[] = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      filesSeen += 1;
      try {
        const metadata = await stat(path);
        if (metadata.mtimeMs >= cutoff) {
          candidates.push(path);
        }
      } catch {
        // A writer can rotate a log between directory listing and stat.
      }
    }
  }
  return { available: true, filesSeen, candidates };
}
