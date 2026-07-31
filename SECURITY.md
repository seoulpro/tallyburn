# Security policy

## Supported versions

Tallyburn is in beta. Security fixes are provided for the most recent published
release; earlier prereleases are not patched separately.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. If
private reporting is unavailable, email `lim@limsumin.com`.

Do not include real provider credentials, prompts, transcripts, or account
identifiers in a report. A minimal synthetic reproduction is preferred.

## Trust boundary

Tallyburn processes numeric usage metadata without accessing provider
credentials. Optional local backfill reads sensitive transcript records but
immediately projects them into an allowlisted numeric model and retains no
conversation content.

Optional account and quota reads are delegated to the official provider clients,
which own authentication and any network connection. Tallyburn does not open
credential storage and creates no provider network client of its own.

The OTLP receiver treats requests as trusted local input, not an authenticated
security boundary. Any process able to reach the loopback listener can submit
usage or consume collector resources. The receiver limits body size,
connections, and request time, but the port should not be exposed or forwarded.

Local transcript files remain sensitive even though Tallyburn reads only
selected numeric fields. Keep the same filesystem protections you apply to the
official client data directories.

## Project constraints

Tallyburn must not:

- read provider OAuth tokens, API keys, Keychain entries, or credential files;
- call undocumented subscription endpoints;
- proxy or intercept model traffic;
- persist OTLP payloads or transcript lines;
- log prompt, response, tool, file-path, email, account, or organization
  attributes;
- bind a telemetry receiver to a non-loopback address by default.

Changes to a parser or receiver should include a synthetic canary test proving
that unapproved content cannot enter the normalized event or persistent state.

## Distribution integrity

The macOS application published on the releases page is signed with a Developer
ID Application certificate and notarized by Apple. If macOS reports that a
downloaded Tallyburn build is unsigned, damaged, or from an unidentified
developer, do not bypass the warning — report it instead.
