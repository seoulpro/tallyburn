# Provider support

Tallyburn separates three capabilities that providers expose through different
interfaces:

1. **token activity** — completed-request input, cache, reasoning, and output
   counters;
2. **rolling history** — timestamped observations aggregated into local windows;
3. **plan quota** — an official percentage or remaining allowance for a
   provider-defined subscription window.

Token totals never imply a plan quota. A provider can support the first two
capabilities without supporting the third.

## Support matrix

| Provider | Token activity | Collection | Plan quota |
| --- | --- | --- | --- |
| Codex | Local session JSONL | Automatic | Opt-in official app-server rate-limit read |
| Claude Code | Local session JSONL, or official `claude_code.token.usage` OTLP | Automatic (JSONL); opt-in (OTLP) | Official status-line, client status, macOS desktop cache, and structured limit records |
| Gemini CLI | Official `gemini_cli.token.usage` OTLP metric | Opt-in OTLP | Not exposed by the supported metric; never inferred |
| GitHub Copilot CLI | Standard `gen_ai.client.token.usage` OTLP histogram | Opt-in OTLP | Not exposed by the supported metric; never inferred |
| Qwen Code | Official `qwen-code.token.usage` OTLP metric | Opt-in OTLP | Not exposed by the supported metric; never inferred |
| llama.cpp | Exact prompt/predicted Prometheus counters | Opt-in loopback URL | Not applicable to local inference |
| vLLM | Exact prompt/generation Prometheus counters | Opt-in loopback URL | Not applicable to self-hosted inference |

"Automatic" means the signal is read with no additional configuration.
"Opt-in" means you must start a Tallyburn listener and configure the provider's
own official telemetry export.

## Local backfill (Codex and Claude Code)

Without setup, Tallyburn extracts allowlisted numeric fields from:

- `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`
- `$CLAUDE_CONFIG_DIR/projects`

These transcript formats are internal to their clients and may change.
Tallyburn tails files incrementally, handles partial lines, deduplicates
repeated Claude message records, computes Codex deltas from cumulative
counters, and removes parent usage replayed at the start of forked Codex or
subagent sessions. Conversation content, tool arguments, paths inside records,
and credentials never enter the event model.

This path requires no additional login. Disable it with `--no-backfill`.

## Claude Code

### Official OpenTelemetry (recommended for live collection)

Start the receiver:

```bash
tallyburn --otel-port 4318
```

Then opt Claude Code into metrics-only telemetry. The equivalent user setting
is:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "none",
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "http://127.0.0.1:4318/v1/metrics",
    "OTEL_METRIC_EXPORT_INTERVAL": "5000",
    "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "delta"
  }
}
```

Tallyburn never edits Claude settings. Review existing user and managed
telemetry first, and do not replace an administrator-managed endpoint. The
signal-specific endpoint above avoids redirecting unrelated telemetry.

Official metrics can carry account, organization, email, and session resource
attributes. Tallyburn parses the OTLP envelope transiently, retains only token
categories, model, timestamp, and an opaque dedupe key, and discards the rest.

Request-level OTLP logs can replace metrics:

```bash
tallyburn --otel-port 4318 --otel-logs
```

In this mode `/v1/logs` is authoritative and `/v1/metrics` is acknowledged but
not counted, preventing dual-export duplicates. Configure Claude Code with
`OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json`, and
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:4318/v1/logs`.

Log envelopes can contain prompts, tool details, or raw API bodies when the
corresponding Claude Code content flags are enabled. Tallyburn receives and
parses the complete envelope even though it allowlists only
`claude_code.api_request` token fields. Keep content-logging flags disabled and
prefer metrics-only mode.

### Plan detection and quota

```bash
tallyburn --claude-account
```

This launches `claude auth status --json`, an official non-model command.
Tallyburn retains only `loggedIn`, a validated subscription type, and the
observation time; identity, email, organization, and account fields are
discarded. Detecting a plan does not reveal its allowance, so Tallyburn shows
**usage unverified** rather than inventing a percentage. Disable with
`--no-claude-account` or `--offline`.

Claude Code can pass its official 5-hour and 7-day percentages to a status-line
command:

```json
{
  "statusLine": {
    "type": "command",
    "command": "tallyburn statusline"
  }
}
```

This stores only percentage, window length, reset time, and observation time in
Tallyburn's local state directory, and prints a compact quota line back to
Claude Code. Do not overwrite an existing status-line integration without
deciding how to preserve it.

Claude Code runs status lines for interactive sessions, but headless `-p`
invocations can consume quota without refreshing that snapshot. Tallyburn
therefore hides a Claude percentage once it observes newer token usage rather
than presenting a stale number as current. It also recognizes Claude Code's
structured local `429` session-limit and weekly-limit records and marks only the
matching window as 100%; ordinary transcript text is never read as a limit
signal.

On macOS, `--claude-account` can additionally read the recent, already-cached
official usage response that Claude Desktop fetched for its own usage ring. It
derives the exact cache filename from the organization id returned by
`auth status`, keeps that id only in process memory, makes no provider network
request, and exposes only the percentages, reset time, and cache modification
time. Stale, malformed, unrelated, or unsupported cache entries fail closed.

## Codex

```bash
tallyburn --codex-account
```

Codex owns and refreshes its existing login. Tallyburn identifies itself to the
official app-server, requests `account/rateLimits/read`, and never opens Codex
credential storage. This control-plane request consumes no model tokens, but it
is an authenticated provider request; omit the flag or use `--offline` for a
fully passive run. It can be enabled persistently with
`TALLYBURN_CODEX_ACCOUNT=1` or `"codexAccount": true` in the config file;
`--offline` and `--no-codex-account` override every enable surface.

The Codex app-server surface is documented as experimental and can change.
Tallyburn treats incompatibility as unavailable quota; local token backfill
remains independent. It does not call `account/read`, so email-bearing account
metadata is never requested.

## Gemini CLI

Gemini CLI exports the official `gemini_cli.token.usage` counter. Start
Tallyburn with OTLP enabled, then launch Gemini CLI with:

```bash
GEMINI_TELEMETRY_ENABLED=true \
GEMINI_TELEMETRY_TARGET=local \
GEMINI_TELEMETRY_OTLP_PROTOCOL=http \
GEMINI_TELEMETRY_OTLP_ENDPOINT=http://127.0.0.1:4318 \
gemini
```

Tallyburn accepts only input, cache, output, thought, tool, model, and timing
fields. Cached tokens are projected as a subset of input, tool-use prompt tokens
remain input, and thought tokens remain a reasoning subset of output. Gemini's
simultaneously exported standard GenAI histogram is ignored so one request
cannot be counted twice.

## GitHub Copilot CLI

GitHub Copilot CLI exports the standard `gen_ai.client.token.usage` histogram.
Launch it with its official JSON HTTP exporter pointed at Tallyburn:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
copilot
```

Tallyburn attributes this metric to Copilot only when the OTLP resource carries
the official `service.name=github-copilot`. It reads the histogram sum for input
and output tokens — never its request count — and ignores prompt content and
unrelated attributes.

## Qwen Code

Start a metrics-only collector:

```bash
tallyburn --provider qwen --no-backfill --otel-port 4318
```

Then launch Qwen Code with its HTTP exporter:

```bash
QWEN_TELEMETRY_ENABLED=true \
QWEN_TELEMETRY_OTLP_PROTOCOL=http \
QWEN_TELEMETRY_OTLP_ENDPOINT=http://127.0.0.1:4318 \
qwen
```

The equivalent keys can be placed under `telemetry` in `~/.qwen/settings.json`;
Tallyburn never edits that file. Qwen appends `/v1/metrics` to the base
endpoint. Trace and log requests receive `404` before Tallyburn reads their
bodies.

Qwen's counter is cumulative. Tallyburn maintains a bounded per-process
baseline, emits only increases, ignores exporter replays, and re-baselines after
a process reset. Start Tallyburn before Qwen Code if the first sample should be
included; otherwise that sample establishes a baseline instead of appearing as a
burst.

Cached Qwen prompt tokens are a subset of its input counter, and Tallyburn
subtracts that overlap. Thought tokens are retained as the reasoning subset of
output.

## llama.cpp and vLLM

Enable llama.cpp's optional metrics endpoint, then point Tallyburn at it:

```bash
tallyburn --provider llamacpp \
  --llamacpp-metrics http://127.0.0.1:8080/metrics
```

For vLLM:

```bash
tallyburn --provider vllm \
  --vllm-metrics http://127.0.0.1:8000/metrics
```

Only exact prompt and generation counter names are accepted. Endpoints must be
unauthenticated loopback HTTP URLs; redirects, remote hosts, query strings,
oversized bodies, and unrelated metrics are rejected. The first successful
scrape establishes a baseline, then only positive counter deltas are recorded,
and a counter reset re-baselines instead of producing negative activity. vLLM's
`model_name` label is retained when present.

These counters are runtime-wide: they cover every client of that server, not
only your own session.

## Not currently supported

Ollama and LM Studio expose accurate usage in individual API responses, but
neither publishes a passive global token counter that Tallyburn can observe
without instrumenting the calling application or installing a proxy. They are
therefore not advertised as passive adapters.

Generalizing standard OpenTelemetry GenAI metrics across all emitters would
require a source-identity allowlist and precedence rules, because several
clients emit both custom and standard metrics for the same request.

## Runtime versus model identity

An open-weight model is a **model identity**, while Ollama, LM Studio,
llama.cpp, and vLLM are **runtimes**. Snapshots retain both:

```text
provider/runtime: llamacpp
model: qwen3:30b
```

This keeps a locally hosted Qwen model distinct from the Qwen cloud service or a
Qwen Code subscription.

## Privacy and trust boundary

- Collect numeric counters from loopback or allowlisted local files.
- Do not read provider credentials or silently install a proxy.
- Do not persist prompts, responses, account identifiers, or raw OTLP
  envelopes.
- Treat Prometheus counters as runtime-wide and label their scope accurately.
- Treat response usage as completed-request activity, not in-flight generation
  speed.
- Display plan percentages only when the provider publishes the percentage or
  remaining allowance directly.

## Provider colours

The macOS app stores provider colour overrides as validated sRGB hex values in
its own preferences. Every supported provider has a stable default and can be
customized before it is connected; other observed providers receive a
deterministic fallback colour. Provider names remain visible beside every colour
cue, and quota warning colours stay semantic and independent of provider
identity.

## Official references

- [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage)
- [Claude Code status lines](https://code.claude.com/docs/en/statusline)
- [Codex app-server events](https://developers.openai.com/codex/app-server)
- [Gemini CLI OpenTelemetry](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md)
- [GitHub Copilot CLI OpenTelemetry](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#opentelemetry-monitoring)
- [Qwen Code OpenTelemetry](https://qwenlm.github.io/qwen-code-docs/en/developers/development/telemetry/)
- [OpenTelemetry GenAI token metric](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-metrics.md)
- [llama.cpp server metrics](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [vLLM metrics](https://docs.vllm.ai/en/stable/design/metrics/)
