# Tallyburn for macOS — development

This directory contains the native SwiftUI menu bar shell. It uses
`MenuBarExtra` and runs without a Dock icon.

> This document covers **building from source**. If you only want to run
> Tallyburn, download the signed and notarized universal build from the
> [releases page](https://github.com/seoulpro/tallyburn/releases) instead — it
> embeds its collection engine and needs no Node.js or pnpm setup.

## Requirements

- macOS 14 or newer
- Xcode capable of targeting macOS 14
- [XcodeGen](https://github.com/yonaskolb/XcodeGen)
- Node.js 20.11 or newer

## Development build

From the repository root:

```bash
npm install --global pnpm@10.34.5
pnpm macos:build
```

If your Node.js distribution includes Corepack, `corepack enable` is an
alternative to the global pnpm installation. The exact pnpm version is pinned
in `package.json`.

The generated application is written to:

```text
build/macos/Build/Products/Debug/Tallyburn.app
```

Run it against the current checkout:

```bash
./scripts/run-macos-dev.sh
```

The run script rebuilds the checkout, gracefully replaces an existing
development process from the same bundle, verifies that the new process started,
and returns to the shell. `BUILD SUCCEEDED` marks the end of the Xcode build,
not a command that should be left running.

`project.yml` is the source of truth for the generated Xcode project. Run
`xcodegen generate` in this directory after changing the project definition, and
before running `xcodebuild` on a checkout that added or removed source files.

## Tests

```bash
cd apps/macos
xcodebuild \
  -project Tallyburn.xcodeproj \
  -scheme Tallyburn \
  -configuration Debug \
  -derivedDataPath ../../build/macos \
  CODE_SIGNING_ALLOWED=NO \
  test
```

## Runtime model

The app starts a single child process:

```text
tallyburn stream
```

The child owns JSONL backfill, supported CLI OTLP, optional llama.cpp and vLLM
counter polling, the Codex account bridge, sanitized Claude plan discovery,
rolling aggregation, and refresh timing. The app decodes protocol version 1
snapshots from stdout and never receives event IDs, source paths, or account
identity fields.

Helper resolution order:

1. `TALLYBURN_CLI_SCRIPT` with `TALLYBURN_NODE_PATH`
2. a CLI path saved in Settings
3. the engine bundled inside the app
4. common Homebrew and pnpm global locations

Release builds always use the bundled engine, so steps 1, 2, and 4 exist for
development against a checkout.

## Interface

The panel has three modes — **Now**, **History**, and **Limits** — and opens on
Now.

- **Now** shows the live rate headline, a 60-second graph, per-provider rates,
  a token-composition strip, and a compact preview of verified quota.
- **History** owns the configurable rolling-window selector, its graph, totals,
  and the per-provider breakdown.
- **Limits** owns provider quota rows and detected plans whose usage percentage
  is not yet verified.

The headline and the graph's right edge use the same trailing one-minute moving
average, so they always agree. Raw reports remain available as 60 epoch-aligned
one-second buckets. This is not an estimate of in-flight generation speed.

The menu bar defaults to an icon-only label so it stays compact on notched Macs.
An average tokens-per-second label is available in Settings. Pause, Mini and
Expanded, Settings, and Quit stay visible while content scrolls. The 320 × 300
mini monitor retains the live average, graph, selected rolling total, and
provider rates.

## First-run privacy choices

- **Standard local monitoring** projects numeric fields from supported local
  transcript files and detects sanitized Claude plan presence.
- **Local metrics only** disables transcript backfill and listens for Claude,
  Gemini, GitHub Copilot, and Qwen metrics on loopback port 4318, plus any
  configured local model-server counters.
- **Demo preview** uses synthetic data and touches no provider data.

Codex plan quota is a separate opt-in. Claude plan presence is detected
automatically through the official non-model authentication status command; its
usage percentage stays hidden until a fresh official percentage or structured
limit signal exists.

Standard mode can opt into the same loopback listener in Settings, where a
compact menu copies the official environment command for each supported CLI.
Local model servers are configured with explicit loopback `/metrics` URLs.
Tallyburn never edits provider settings and never infers plan quota from token
totals.

## Settings and accessibility

Settings changes are staged. Monitoring changes use **Apply & Restart** to
validate and save them with one helper restart. Menu-bar and login preferences
use **Apply** without interrupting monitoring. **Revert** restores the last
applied values. Connection failures offer **Try Again** and **Open Settings**,
and a manual retry restores the full reconnect budget.

The app ships English and Korean localizations, semantic status text alongside
colour, keyboard-reachable calculation help, VoiceOver summaries for charts,
providers, and quotas, Reduce Motion support, and light and dark appearances.
The application icon is compiled through the asset catalog at every supported
size.

## Release build

Release tooling lives in `scripts/release-macos.sh`:

```bash
pnpm macos:release:preflight   # verify signing and notarization credentials
pnpm macos:release             # build, sign, notarize, staple, and package
```

The release path builds the collection engine as a Node.js single executable,
signs nested code before the outer app, enables Hardened Runtime, notarizes with
Apple, staples the ticket, and produces
`Tallyburn-<version>-macos-universal.zip` containing both arm64 and x86_64
slices. It requires a Developer ID Application certificate and valid
notarization credentials.

Distribution is direct Developer ID. App Sandbox would require explicit
user-selected access to the Codex and Claude data directories and additional
constraints around the Codex child process.
