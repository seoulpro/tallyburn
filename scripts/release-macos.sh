#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
macos_root="$project_root/apps/macos"
release_root="${TALLYBURN_RELEASE_DIR:-$project_root/build/release}"
derived_data="$release_root/DerivedData"
notary_profile="${TALLYBURN_NOTARY_PROFILE:-}"
requested_identity="${TALLYBURN_SIGNING_IDENTITY:-}"
mode="${1:-release}"

usage() {
  printf '%s\n' \
    "usage: release-macos.sh [preflight|release]" \
    "" \
    "Required:" \
    "  A Developer ID Application certificate in the login keychain" \
    "  TALLYBURN_NOTARY_PROFILE set to an xcrun notarytool keychain profile" \
    "" \
    "Optional:" \
    "  TALLYBURN_SIGNING_IDENTITY selects one certificate when several exist" \
    "  TALLYBURN_RELEASE_DIR changes the output directory"
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit "${2:-1}"
}

case "$mode" in
  preflight | release) ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "macOS releases must be built on macOS."
fi

for executable in security xcrun xcodebuild xcodegen; do
  command -v "$executable" >/dev/null ||
    fail "$executable is required."
done

if command -v pnpm >/dev/null; then
  pnpm_command=(pnpm)
elif command -v corepack >/dev/null; then
  pnpm_command=(corepack pnpm)
else
  fail \
    "pnpm is required. Install it with 'corepack enable' or 'npm install -g pnpm@10.34.5'."
fi

developer_identities=()
while IFS= read -r candidate; do
  developer_identities+=("$candidate")
done < <(
  /usr/bin/security find-identity -v -p codesigning |
    /usr/bin/sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p'
)

if [[ -n "$requested_identity" ]]; then
  signing_identity=""
  for candidate in "${developer_identities[@]}"; do
    if [[ "$candidate" == "$requested_identity" ]]; then
      signing_identity="$candidate"
      break
    fi
  done
  [[ -n "$signing_identity" ]] ||
    fail "TALLYBURN_SIGNING_IDENTITY does not match an installed Developer ID Application certificate."
elif ((${#developer_identities[@]} == 1)); then
  signing_identity="${developer_identities[0]}"
elif ((${#developer_identities[@]} == 0)); then
  fail "No Developer ID Application certificate is installed."
else
  fail "Multiple Developer ID Application certificates are installed; set TALLYBURN_SIGNING_IDENTITY."
fi

team_id="$(
  printf '%s\n' "$signing_identity" |
    /usr/bin/sed -n 's/.*(\([A-Z0-9][A-Z0-9]*\))$/\1/p'
)"
[[ "$team_id" =~ ^[A-Z0-9]{10}$ ]] ||
  fail "The Developer ID Application certificate has no recognizable Team ID."

[[ -n "$notary_profile" ]] ||
  fail "Set TALLYBURN_NOTARY_PROFILE to a notarytool keychain profile."

if ! /usr/bin/xcrun notarytool history \
  --keychain-profile "$notary_profile" \
  >/dev/null; then
  fail "The notarytool keychain profile could not authenticate."
fi

printf '%s\n' "Developer ID signing and notarization credentials are ready."
if [[ "$mode" == "preflight" ]]; then
  exit 0
fi

"${pnpm_command[@]}" --dir "$project_root" install --frozen-lockfile
"${pnpm_command[@]}" --dir "$project_root" run engine:macos

(
  cd "$macos_root"
  xcodegen generate
  xcodebuild \
    -project Tallyburn.xcodeproj \
    -scheme Tallyburn \
    -configuration Release \
    -destination "generic/platform=macOS" \
    -derivedDataPath "$derived_data" \
    TALLYBURN_ENGINE_EXECUTABLE="$project_root/build/engine/tallyburn" \
    TALLYBURN_ENGINE_NOTICES="$project_root/build/engine/CollectionEngineNotices.txt" \
    CODE_SIGNING_ALLOWED=YES \
    CODE_SIGNING_REQUIRED=YES \
    CODE_SIGN_STYLE=Manual \
    CODE_SIGN_IDENTITY="$signing_identity" \
    DEVELOPMENT_TEAM="$team_id" \
    ENABLE_HARDENED_RUNTIME=YES \
    OTHER_CODE_SIGN_FLAGS="--timestamp" \
    build
)

app_path="$derived_data/Build/Products/Release/Tallyburn.app"
[[ -d "$app_path" ]] || fail "The Release app was not produced."

/usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"
/usr/bin/lipo -archs "$app_path/Contents/MacOS/Tallyburn" |
  /usr/bin/grep -q "arm64" ||
  fail "The app is missing the arm64 architecture."
/usr/bin/lipo -archs "$app_path/Contents/MacOS/Tallyburn" |
  /usr/bin/grep -q "x86_64" ||
  fail "The app is missing the x86_64 architecture."

package_version="$(
  cd "$project_root"
  node -p "require('./package.json').version"
)"
artifact="$release_root/Tallyburn-$package_version-macos-universal.zip"
/bin/mkdir -p "$release_root"
/bin/rm -f "$artifact"
/usr/bin/ditto \
  -c \
  -k \
  --sequesterRsrc \
  --keepParent \
  "$app_path" \
  "$artifact"

/usr/bin/xcrun notarytool submit \
  "$artifact" \
  --keychain-profile "$notary_profile" \
  --wait
/usr/bin/xcrun stapler staple "$app_path"
/usr/bin/xcrun stapler validate "$app_path"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"
/usr/sbin/spctl --assess --type execute --verbose=4 "$app_path"

# Recreate the distributable archive so it contains the stapled ticket.
/bin/rm -f "$artifact"
/usr/bin/ditto \
  -c \
  -k \
  --sequesterRsrc \
  --keepParent \
  "$app_path" \
  "$artifact"

/usr/bin/shasum -a 256 "$artifact"
printf '%s\n' "$artifact"
