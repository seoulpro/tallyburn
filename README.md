# Tallyburn

Tallyburn is a local-first AI token usage monitor for Codex, Claude Code,
Gemini CLI, GitHub Copilot CLI, Qwen Code, llama.cpp, and vLLM. One measurement
core powers a terminal dashboard, a Node.js library, and a native macOS menu bar
app.

It shows configurable rolling windows, a 60-second live activity graph, observed
token rates, and provider-reported subscription quota — without sending prompts,
running models, opening credential storage, or proxying provider traffic.

> **Beta.** Version `0.1.0-beta.1`. Interfaces and the stream protocol may still
> change between beta releases.

<p align="center">
  <img
    src="https://raw.githubusercontent.com/seoulpro/tallyburn/main/docs/images/tallyburn-dashboard.png"
    width="390"
    alt="Tallyburn menu bar dashboard showing live token rate, provider rates, token composition, and plan quota"
  >
</p>
<p align="center"><sub>Synthetic data shown in English; the app follows the Mac language and appearance.</sub></p>

## Install

### macOS app

Download `Tallyburn-0.1.0-beta.1-macos-universal.zip` from the
[`v0.1.0-beta.1` release](https://github.com/seoulpro/tallyburn/releases/tag/v0.1.0-beta.1),
unzip it, and move `Tallyburn.app` to `/Applications`. The build is universal
(Apple silicon and Intel), signed with a Developer ID certificate, and notarized
by Apple.

The app embeds its collection engine. You do not need Node.js, pnpm, or a
separate CLI path.

Requires macOS 14 or newer.

### Cross-platform CLI

```bash
npm install -g tallyburn@next
tallyburn
```

Requires Node.js 20.11 or newer. `next` is the explicit preview channel; use it
to keep tracking betas once stable releases begin.

## Quick start

Try the interface without touching any provider data:

```bash
tallyburn --demo
```

Check which clients and sources are visible on this machine:

```bash
tallyburn doctor
```

Print one snapshot for a script:

```bash
tallyburn snapshot --json
```

With no configuration, Tallyburn reads the numeric records that Codex and Claude
Code already write locally. Use either client normally and usage appears. No
separate Tallyburn account or provider sign-in is required.

## What is measured

- **Raw token activity** — fresh input, cache reads, cache writes, output, and
  reasoning metadata observed from supported local signals.
- **Rolling totals** — any combination of `ms`, `s`, `m`, `h`, and `d` windows,
  up to six windows and 30 days.
- **Live rate** — the trailing one-minute moving average, resampled every
  second.
- **Plan quota** — a provider-reported percentage and reset time, only when the
  provider publishes one.

### Response-level, not token-by-token

Tallyburn is response-level near-real-time. Supported signals arrive after an
API request completes and the client exports its next batch, so export cadence
depends on the client. Tallyburn does not count tokens as they stream, and it
does not interpolate a completed response across an assumed duration.

The value shown as `tok/s` is a trailing one-minute moving average:

```text
sum(raw tokens reported in [now - 60 seconds, now]) / 60 seconds
```

The graph draws once-per-second samples of that same calculation as steps, so
its right edge and the headline always agree. `0 tok/s` means no supported
source reported usage in the trailing minute — it does not prove that no
response is currently running.

These figures include input, cache, and output activity. They are not
output-generation speed benchmarks.

### Token activity and plan quota are separate

Raw token counts are never converted into a quota percentage. Subscription
limits can weight models, tools, and cache behavior differently, so the two
numbers are not interchangeable. A plan can also be *detected* without a fresh
percentage being available; Tallyburn shows the plan and marks usage as
unverified rather than inventing a meter.

### Accuracy boundary

Totals cover activity observed from supported signals **on this machine**. They
exclude other computers, general ChatGPT or claude.ai web conversations, and
sessions that emit no supported signal, unless a supported signal reaches this
machine.

Malformed records are counted as skipped, and an unrecognized future schema can
produce no observations without a hard error. Tallyburn is an operational
monitor, not a billing ledger, and cost estimation is deliberately out of scope.

## Supported sources

| Provider | Token activity | Plan quota |
| --- | --- | --- |
| Codex | Automatic (local session files) | Opt-in official app-server read |
| Claude Code | Automatic (local session files) or opt-in OTLP | Official status-line, client, and structured limit records |
| Gemini CLI | Opt-in OTLP | Not exposed; never inferred |
| GitHub Copilot CLI | Opt-in OTLP | Not exposed; never inferred |
| Qwen Code | Opt-in OTLP | Not exposed; never inferred |
| llama.cpp | Opt-in loopback Prometheus endpoint | Not applicable |
| vLLM | Opt-in loopback Prometheus endpoint | Not applicable |

Ollama and LM Studio expose accurate per-response usage but no passive global
counter that Tallyburn can safely observe, so they are not listed as supported
adapters.

See [`docs/PROVIDER_SUPPORT.md`](https://github.com/seoulpro/tallyburn/blob/main/docs/PROVIDER_SUPPORT.md) for the exact metric
names, per-provider setup commands, and limitations.

## Privacy and security

Tallyburn:

- binds its OpenTelemetry receiver to `127.0.0.1` only;
- stores no prompt, response, email, account ID, organization ID, or OAuth
  material;
- replaces provider session, request, and message identifiers with truncated
  SHA-256 keys before they enter the normalized store;
- never reads Keychain, `auth.json`, `.credentials.json`, or undocumented usage
  endpoints;
- never intercepts TLS and never acts as an inference proxy;
- makes no provider network request of its own.

Optional quota and plan reads are delegated to the official provider clients,
which keep ownership of sign-in. Tallyburn does not open credentials. Use
`--offline` to disable every authenticated read.

Local backfill necessarily opens local transcript files before projecting them
into the numeric model, and discards each original record immediately. Use
`--no-backfill` if you prefer Tallyburn never to open them:

```bash
tallyburn --otel-port 4318 --no-backfill
```

The loopback OTLP listener trusts local peers. Any process that can reach the
port can submit usage, so do not expose or forward it.

See [`docs/ARCHITECTURE.md`](https://github.com/seoulpro/tallyburn/blob/main/docs/ARCHITECTURE.md) and
[`SECURITY.md`](https://github.com/seoulpro/tallyburn/blob/main/SECURITY.md) for the full trust boundary.

## Configuration

Pass options directly:

```bash
tallyburn --windows 30m,1h,3h,12h --refresh 1s
```

Or create a config file at `~/.config/tallyburn/config.json` (or
`%APPDATA%\tallyburn\config.json` on Windows; `XDG_CONFIG_HOME` is honoured):

```json
{
  "windows": ["1h", "3h", "12h"],
  "refresh": "1s",
  "providers": ["codex", "claude"],
  "color": true
}
```

Environment equivalents include `TALLYBURN_WINDOWS`, `TALLYBURN_REFRESH`,
`TALLYBURN_PROVIDERS`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR`. Local runtime
endpoints use `TALLYBURN_LLAMACPP_METRICS` and `TALLYBURN_VLLM_METRICS`. Set
`TALLYBURN_BACKFILL=0` for the equivalent of `--no-backfill`.

Run `tallyburn --help` for the complete option list.

## Node.js library

The package root exposes the same monitor the CLI uses. Importing it does not
start collection.

```js
import { createTallyburnMonitor } from "tallyburn";

const monitor = await createTallyburnMonitor({
  windows: ["1h", "3h", "12h"],
  providers: ["codex", "claude"],
  refreshMs: 1_000,
});

const unsubscribe = monitor.subscribe((snapshot) => {
  console.log(snapshot.liveRate?.all.tokensPerMinute);
});

await monitor.start();

// At application shutdown:
unsubscribe();
await monitor.stop();
```

For a native client, `tallyburn stream` emits versioned NDJSON snapshots. The
stream omits event IDs and source paths; it carries only observed rates, rolling
aggregates, chart buckets, quota, and numeric source health.

## Build from source

```bash
npm install --global pnpm@10.34.5
pnpm install
pnpm test
pnpm build
```

If your Node.js distribution includes Corepack, `corepack enable` is an
alternative to the global pnpm installation. The exact pnpm version is pinned
in `package.json`.

Build and run the macOS app from source with
[`apps/macos/README.md`](https://github.com/seoulpro/tallyburn/blob/main/apps/macos/README.md). Contribution setup and checks
are in [`CONTRIBUTING.md`](https://github.com/seoulpro/tallyburn/blob/main/CONTRIBUTING.md).

## License and trademarks

Code is licensed under the [Apache License 2.0](https://github.com/seoulpro/tallyburn/blob/main/LICENSE). Project marks are
addressed in [`TRADEMARKS.md`](https://github.com/seoulpro/tallyburn/blob/main/TRADEMARKS.md).

Tallyburn is independent and is not affiliated with, endorsed by, or sponsored
by OpenAI, Anthropic, Google, GitHub, Microsoft, Alibaba Cloud, or their
affiliates. Product names are used only to describe compatibility.
