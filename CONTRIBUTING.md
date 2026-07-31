# Contributing

Contributions are welcome. Tallyburn is in beta, so interfaces and the stream
protocol may still change.

## Local setup

```bash
npm install --global pnpm@10.34.5
pnpm install
```

If your Node.js distribution includes Corepack, `corepack enable` is an
alternative to the global pnpm installation. The exact pnpm version is pinned
in `package.json`.

## Checks

Before opening a pull request:

```bash
pnpm check
pnpm test
```

`pnpm test` compiles the project and runs the Node test suite against the build
output.

Release maintainers can verify an already-published npm version on any platform
with `pnpm release:verify:npm -- <version>`. On macOS,
`pnpm release:verify -- <version>` additionally verifies the signed and
notarized GitHub release app. These commands download public artifacts and do
not publish or modify a release.

For macOS shell changes:

```bash
pnpm macos:build
cd apps/macos
xcodebuild \
  -project Tallyburn.xcodeproj \
  -scheme Tallyburn \
  -configuration Debug \
  -derivedDataPath ../../build/macos \
  CODE_SIGNING_ALLOWED=NO \
  test
```

Run `xcodegen generate` in `apps/macos` first if you added or removed a Swift
file, since the Xcode project is generated from `project.yml`.

## Test data

Use synthetic fixtures only. Never include a real transcript, account
identifier, credential, prompt, local absolute path, or provider response in
code, tests, issues, or pull requests.

## Parser and receiver changes

A parser or receiver change should:

- allow unknown fields for forward compatibility;
- fail closed when required numeric fields are missing;
- avoid retaining the original record;
- preserve deduplication across replay and file rotation;
- include a privacy-canary test proving that unapproved content cannot reach the
  normalized event or persistent state.

## Scope boundaries

Some things are deliberately out of scope, and a pull request adding them is
unlikely to be merged:

- reading provider credentials, Keychain entries, or credential files;
- calling undocumented subscription or usage endpoints;
- proxying or intercepting model traffic;
- inferring a plan quota percentage from token counts;
- binding a telemetry receiver to a non-loopback address by default;
- cost or billing estimation, which is not equivalent to subscription usage.

New provider adapters should rely on a signal the provider documents officially.
See [`docs/PROVIDER_SUPPORT.md`](docs/PROVIDER_SUPPORT.md) for the current
matrix and the reasoning behind unsupported sources.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow
[`SECURITY.md`](SECURITY.md).

## Licensing

By submitting a contribution, you agree that it is licensed under Apache-2.0 as
described in the project license.
