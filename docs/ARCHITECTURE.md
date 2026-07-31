# Architecture

## Design goals

Tallyburn treats token activity like host telemetry: numeric, local,
incremental, and observable without becoming part of the inference path.

The system has five boundaries:

1. **Provider-owned clients** authenticate and make model requests.
2. **Numeric adapters** accept official telemetry, sanitized official account
   capability, or allowlisted local fields.
3. **The monitor library** owns adapter lifecycle, refresh coalescing, and
   subscriptions.
4. **The event store** retains only normalized token and quota numbers in
   memory.
5. **Views** consume snapshots through the Node API or versioned NDJSON and
   render terminal, JSON, or macOS menu bar output.

There is no inference proxy and no credential adapter.

## Library and application boundary

`TallyburnMonitor` is the shared measurement lifecycle. Importing the package
has no side effects. A caller creates a monitor, subscribes to immutable
snapshots, starts collection, and stops it at application shutdown.

The terminal UI imports this API directly. The native SwiftUI app cannot load
Node ESM in process, so it owns one child helper running `tallyburn stream`.
Each stdout line is one protocol message:

```text
schemaVersion: 1
type: snapshot
sequence: monotonically increasing integer
snapshot: observed rate, aggregates, chart buckets, quota, and source health
```

The IPC snapshot deliberately excludes recent events, opaque event IDs, and
source paths. The helper writes protocol data only to stdout. The native app
does not log helper stderr or raw provider records.

Protocol version 1 consumers must ignore unknown fields. Additive fields such
as `liveRate` are optional so a new app can fall back when paired with an
older helper and an older app can ignore them when paired with a new helper.

Only one helper belongs to one app instance. This prevents the menu app from
starting a new scanner every second and gives OTLP and Codex child processes a
single owner. A standalone CLI invocation owns its own independent monitor.

## macOS shell

The macOS app is a native SwiftUI `MenuBarExtra` with `LSUIElement` enabled, so
it stays in the menu bar without a Dock icon. It provides:

- an explicit first-run choice before transcript access;
- Now, History, and Limits modes covering the live rate, rolling windows, and
  plan quota;
- pause, settings, quit, and Launch at Login controls;
- bounded sidecar reconnection and stale/error presentation.

A development build resolves a checkout or globally linked CLI. The published
build embeds the collection engine as a Node.js single executable: nested code
is signed before the outer app, Hardened Runtime is enabled, and the result is
notarized and stapled before being packaged as a universal archive. End users
therefore install no separate runtime.

## Normalized event

Each normalized observation becomes:

```text
provider
timestamp
opaque stable dedupe id
fresh input
cache read
cache write
output
reasoning (an output subset)
authoritative total
optional model id
```

Provider session, request, message, and source-file identifiers are converted
to truncated SHA-256 keys as they enter parser state. The normalized event key
uses those opaque values, so long-lived in-memory state and JSON snapshots do
not reproduce provider identifiers.

Fresh input, cache read, cache write, and output are non-overlapping display
categories. Reasoning is retained as an output detail and is not added to the
total a second time.

For Codex, `cached_input_tokens` is part of input and
`reasoning_output_tokens` is part of output. When `total_tokens` is present it
is authoritative.

For Claude, total activity is input plus cache read plus cache creation plus
output.

For Qwen, cached prompt tokens are a subset of the input counter. The adapter
subtracts cache from input to form non-overlapping context and cache slices.
Qwen thought tokens are added to output and retained as its reasoning subset,
matching Qwen's component-total fallback without double counting.

Gemini uses the same non-overlapping projection. Its prompt counter includes
cached content; tool-use prompt tokens are additional input, and thought
tokens are retained inside output as reasoning.

GitHub Copilot's standard GenAI histogram exposes input and output totals. Its
histogram `sum` is token activity; `count` is the number of recorded
observations and is never treated as tokens.

## Adapter precedence

### Claude

1. OTLP `claude_code.api_request` logs when `--otel-logs` is enabled; metrics
   are acknowledged but not counted in this mode
2. Otherwise, OTLP metrics (`claude_code.token.usage`, delta temporality)
3. Transcript JSONL for history before the receiver started
4. Official `claude auth status --json` for sanitized plan presence only
5. Recent Claude Desktop `/usage` cache on macOS for plan quota only
6. Status-line input for portable plan quota collection
7. Structured transcript `429` limits for the affected window only

Once OTLP is active, the transcript adapter receives an upper timestamp bound.
This makes the transcript primarily a backfill source instead of a second live
counter. Export batches and retries spanning startup can still overlap, so the
boundary is best-effort rather than billing-grade reconciliation.

Claude assistant records can repeat once per streamed content block. The
adapter uses `message.id` as the stable key and keeps the final observation.

### Qwen Code

1. Official OTLP `qwen-code.token.usage` metrics
2. No plan-quota adapter until Qwen publishes a stable official signal

Qwen uses an OpenTelemetry Counter and normally exports cumulative values.
The receiver keys a bounded baseline by process or opted-in session identity,
counter start time, model, and component. It emits only positive increases,
ignores equal replays, and re-baselines after a counter reset. A newly started
Qwen process can contribute its first export; an older process first seeds a
baseline so pre-observer history is not misrepresented as a current spike.

### Gemini CLI

1. Official OTLP `gemini_cli.token.usage` metrics
2. Ignore Gemini's simultaneous standard GenAI histogram to prevent duplicate
   counting
3. No plan-quota adapter until Gemini publishes a stable official signal

### GitHub Copilot CLI

1. Standard OTLP `gen_ai.client.token.usage` histogram
2. Accept only resources with the official `service.name=github-copilot`
3. No plan-quota adapter until Copilot publishes a stable official signal

### llama.cpp and vLLM

1. Poll exact allowlisted Prometheus token counters from an explicitly
   configured loopback endpoint
2. Seed a baseline on the first scrape and emit only positive per-series
   deltas
3. Re-baseline after counter reset and retain vLLM's model label

### Codex

1. Codex app-server for account quota
2. Session JSONL for cross-process response activity and passive quota
   snapshots

Codex token-count events include cumulative session counters. The adapter
tracks the previous vector, ignores equal totals, subtracts increasing totals,
and re-baselines safely if the total decreases. Event identity uses session
ID, observation timestamp, and cumulative total so both archive replay and a
reset to a previously observed total remain idempotent.

Forked Codex and subagent rollouts can begin with a replay of the parent's
usage history whose timestamps are rewritten to the fork instant. The
incremental indexer keeps only one compact numeric signature per token event,
matches the child's leading sequence against its parent, and drops the matched
prefix. If the parent file is unavailable, a one-second dense-burst guard
handles the rewritten prefix. The first metadata record remains authoritative
so replayed parent metadata cannot replace the child's event identity. No raw
session identifier is retained.

## Incremental file reader

The reader remembers a byte offset and incomplete trailing bytes for each
candidate JSONL file. It:

- reads appended bytes only;
- splits on newline bytes before UTF-8 decoding;
- keeps an incomplete final record until the writer completes it;
- resets safely after truncation;
- ignores symlinks and unknown file types;
- parses only files modified within the largest configured rolling window.

The JSON parser immediately projects an input record into the small normalized
event. It never keeps the original object after a line is processed.

Long-lived monitors do not recursively rediscover every transcript on every
screen tick. After the initial scan, supported filesystems use recursive
change notifications with a short debounce. The display can still refresh its
clock once per second without touching transcript files. A 30-second
reconciliation scan covers dropped notifications and file rotation. If
recursive watching is unavailable, the monitor falls back to the configured
poll interval.

## Rolling aggregation

Timestamps are Unix milliseconds. Each configured window is calculated from
`now - duration` through `now`; local timezone and daylight-saving changes do
not change membership. Sparklines resample the focused window into equal
duration buckets.

Raw token activity is a counter, not a point-in-time gauge. `liveRate` sums
events reported during the exact trailing 60 seconds and normalizes the result
to tokens per minute. It is recalculated on each display refresh, which is one
second by default. `recentTokensPerMinute` remains the exact trailing
five-minute average for protocol compatibility and a less volatile comparison.

`liveActivity` is the higher-frequency view. `series` retains raw reports in
60 epoch-aligned one-second buckets, whose boundaries do not slide when
multiple filesystem or telemetry notifications arrive within the same second.
`rateSeries` evaluates the exact trailing-one-minute rate once per second for
60 display points. Its last point uses `generatedAt` and therefore equals the
headline `all.tokensPerSecond`. Computing the oldest displayed rate point
requires up to one additional minute of events beyond the raw graph. The macOS
client renders this rate history as a step graph rather than inventing values
between samples.

Events arrive when a response record or telemetry batch is emitted. Tallyburn
does not interpolate those events across an assumed response duration, so the
rate is explicitly an observed response-level pace rather than in-flight
output generation speed. A zero one-minute rate means no supported source
reported raw token activity in that trailing minute; a response can still be
running.

Plan quota is a separate provider snapshot. It is never added to raw token
activity and is not inferred from local token counts.

Subscription capability is a separate, non-numeric observation. The Claude
adapter asks the official CLI for authentication status and retains only
`loggedIn`, a validated subscription type, and observation time. It discards
identity-bearing fields and never converts plan presence into a usage
percentage.

## Network boundary

The OTLP receiver binds to loopback and accepts only the standard metrics path
plus the Claude logs path when explicitly enabled. It places a fixed limit on
request bodies, rejects unsupported methods and media, and never records raw
payloads.

Prometheus adapters accept only unauthenticated `http` URLs on
`127.0.0.1`, `::1`, or `localhost`. They do not follow redirects, bound
response size and time, and parse only exact runtime token counter names.

OTLP is untrusted only at the network perimeter: loopback peers are assumed to
be trusted. The full JSON envelope exists transiently during parsing and can
contain identity attributes or, in log mode, content enabled by upstream
telemetry flags. The normalized model copies only allowlisted usage fields and
opaque identifiers.

The optional Codex account bridge launches the official local app-server,
identifies the client as `tallyburn`, performs the documented initialization
handshake, and calls only read methods. Codex owns its authentication storage
and network connection.

The optional Claude account adapter launches the official CLI's non-model
`auth status --json` command. Claude owns its authentication storage and any
network behavior. Tallyburn neither opens credential files nor creates a
Claude network client, and the macOS sidecar strips provider credential
environment variables before launch.

On macOS, the adapter can use the returned organization id only in private
memory to derive the two exact Chromium Simple Cache filenames for Claude
Desktop's `/usage` response. The reader validates Chromium's
[`SimpleFileHeader`](https://chromium.googlesource.com/chromium/src/+/HEAD/net/disk_cache/simple/simple_entry_format.h),
the full Claude origin and endpoint, entry size, regular-file type, modification
time, compression bound, and the two allowlisted quota windows. It never scans
unrelated response bodies, opens cookies, or sends a request. This is a
best-effort compatibility adapter for Claude Desktop's existing usage ring,
not a public provider API; any format mismatch fails closed.

No provider network client exists in the Tallyburn runtime.

## Persistence

Raw activity is reconstructed from provider telemetry and local backfill at
startup. The initial version keeps token events and sanitized account
capability in memory.

Account capability and Claude Desktop cache data are not persisted by
Tallyburn. The only persistent state is the sanitized Claude status-line quota
snapshot:

```text
version
provider
observation timestamp
primary/secondary used percentage
window length
optional reset timestamp
```

It is written atomically in the user's state directory with private file
permissions.
