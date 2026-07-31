#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
default_version="$(node -p 'require(process.argv[1]).version' "$project_root/package.json")"
version="${1:-${TALLYBURN_RELEASE_VERSION:-$default_version}}"

if [[ ! "$version" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]]; then
  printf 'error: invalid release version: %s\n' "$version" >&2
  exit 64
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'error: macOS is required to verify the app signature and notarization.\n' >&2
  exit 69
fi

for executable in curl codesign ditto lipo node npm shasum spctl xcrun; do
  command -v "$executable" >/dev/null || {
    printf 'error: %s is required.\n' "$executable" >&2
    exit 69
  }
done

output_directory="${2:-${TALLYBURN_VERIFY_DIR:-$project_root/build/release-verification/$version}}"
mkdir -p "$output_directory"
output_directory="$(cd "$output_directory" && pwd)"
artifact_name="Tallyburn-$version-macos-universal.zip"
artifact_path="$output_directory/$artifact_name"
release_url="https://github.com/seoulpro/tallyburn/releases/download/v$version/$artifact_name"
temporary_artifact="$artifact_path.download"

rm -f "$temporary_artifact"
curl \
  --proto '=https' \
  --tlsv1.2 \
  --fail \
  --location \
  --retry 3 \
  --output "$temporary_artifact" \
  "$release_url"
mv "$temporary_artifact" "$artifact_path"

extract_directory="$(mktemp -d "$output_directory/extract.XXXXXX")"
cleanup() {
  rm -rf "$extract_directory"
}
trap cleanup EXIT
ditto -x -k "$artifact_path" "$extract_directory"

app_path="$extract_directory/Tallyburn.app"
helper_path="$app_path/Contents/Helpers/tallyburn"
if [[ ! -d "$app_path" || ! -x "$helper_path" ]]; then
  printf 'error: the release archive does not contain the expected app and helper.\n' >&2
  exit 65
fi

codesign --verify --deep --strict --verbose=2 "$app_path"
xcrun stapler validate "$app_path"
spctl --assess --type execute --verbose=4 "$app_path"

signing_report="$output_directory/codesign.txt"
codesign -d --verbose=4 "$app_path" 2>"$signing_report"
grep -q '^Authority=Developer ID Application:' "$signing_report"
grep -Eq '^TeamIdentifier=[A-Z0-9]{10}$' "$signing_report"

entitlements="$output_directory/entitlements.plist"
codesign -d --entitlements :- "$app_path" >"$entitlements" 2>/dev/null
if /usr/libexec/PlistBuddy \
  -c 'Print :com.apple.security.get-task-allow' \
  "$entitlements" \
  2>/dev/null | grep -q '^true$'; then
  printf 'error: the public app enables get-task-allow.\n' >&2
  exit 65
fi

for binary in "$app_path/Contents/MacOS/Tallyburn" "$helper_path"; do
  architectures=" $(lipo -archs "$binary") "
  for architecture in arm64 x86_64; do
    if [[ "$architectures" != *" $architecture "* ]]; then
      printf 'error: %s is missing the %s architecture.\n' "$binary" "$architecture" >&2
      exit 65
    fi
  done
done

bundle_version="$(
  /usr/libexec/PlistBuddy \
    -c 'Print :CFBundleShortVersionString' \
    "$app_path/Contents/Info.plist"
)"
expected_bundle_version="${version%%-*}"
if [[ "$bundle_version" != "$expected_bundle_version" ]]; then
  printf \
    'error: the app reports bundle version %s; expected %s.\n' \
    "$bundle_version" \
    "$expected_bundle_version" \
    >&2
  exit 65
fi

installed_version="$("$helper_path" --version)"
if [[ "$installed_version" != "$version" ]]; then
  printf \
    'error: the embedded CLI reports %s; expected %s.\n' \
    "$installed_version" \
    "$version" \
    >&2
  exit 65
fi
"$helper_path" snapshot --demo --json |
  node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (
        value.schemaVersion !== 1 ||
        value.type !== "snapshot" ||
        !Array.isArray(value.snapshot?.windows) ||
        value.snapshot.windows.length === 0
      ) {
        throw new Error("Invalid embedded CLI snapshot.");
      }
    });
  '

TALLYBURN_VERIFY_DIR="$output_directory/npm" \
  node "$project_root/scripts/verify-public-npm.mjs" "$version" \
  >"$output_directory/npm-verification-output.json"

npm_tarball="$output_directory/npm/tallyburn-$version.tgz"
if [[ ! -f "$npm_tarball" ]]; then
  printf 'error: the npm verifier did not preserve the downloaded tarball.\n' >&2
  exit 65
fi

app_sha256="$(shasum -a 256 "$artifact_path" | awk '{print $1}')"
npm_sha256="$(shasum -a 256 "$npm_tarball" | awk '{print $1}')"
cat >"$output_directory/SHA256SUMS" <<EOF
$app_sha256  $artifact_name
$npm_sha256  npm/tallyburn-$version.tgz
EOF

cat >"$output_directory/verification-summary.txt" <<EOF
Tallyburn $version public release verification

GitHub release: $release_url
macOS artifact SHA-256: $app_sha256
npm artifact SHA-256: $npm_sha256

Verified:
- Developer ID signature
- Apple notarization ticket
- Gatekeeper assessment
- arm64 and x86_64 app and helper binaries
- embedded CLI version and demo snapshot
- npm registry integrity and package installation
- npm CLI version, demo snapshot, and doctor check
EOF

printf 'Verified Tallyburn %s public release artifacts.\n' "$version"
printf 'Report: %s\n' "$output_directory/verification-summary.txt"
printf 'Checksums: %s\n' "$output_directory/SHA256SUMS"
