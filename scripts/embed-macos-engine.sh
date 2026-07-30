#!/usr/bin/env bash
set -euo pipefail

if (($# != 4)); then
  printf '%s\n' \
    "usage: embed-macos-engine.sh ENGINE APP_CONTENTS REQUESTED_ARCHS NOTICES" \
    >&2
  exit 64
fi

engine_path="$1"
app_contents="$2"
requested_archs="$3"
notices_path="$4"
entitlements_path="$(
  cd "$(dirname "${BASH_SOURCE[0]}")"
  pwd
)/macos-engine.entitlements"

if [[ ! -f "$engine_path" || ! -x "$engine_path" ]]; then
  printf '%s\n' "The collection engine must be an executable file." >&2
  exit 65
fi

if [[ ! -f "$notices_path" ]]; then
  printf '%s\n' \
    "A collection-engine third-party notices file is required." \
    >&2
  exit 65
fi

if [[ ! -f "$entitlements_path" ]]; then
  printf '%s\n' \
    "The collection-engine entitlements file is required." \
    >&2
  exit 65
fi

engine_kind="$(/usr/bin/file -b "$engine_path")"
if [[ "$engine_kind" != *"Mach-O"* ]]; then
  printf '%s\n' \
    "The bundled collection engine must be a standalone Mach-O executable." \
    >&2
  exit 65
fi

available_archs="$(/usr/bin/lipo -archs "$engine_path")"
for architecture in $requested_archs; do
  if [[ " $available_archs " != *" $architecture "* ]]; then
    printf '%s\n' \
      "The collection engine is missing architecture $architecture." \
      >&2
    exit 65
  fi
done

"$engine_path" --version >/dev/null

helpers_directory="$app_contents/Helpers"
resources_directory="$app_contents/Resources"
destination="$helpers_directory/tallyburn"
/bin/mkdir -p "$helpers_directory"
/bin/mkdir -p "$resources_directory"
/usr/bin/ditto "$engine_path" "$destination"
/usr/bin/ditto \
  "$notices_path" \
  "$resources_directory/CollectionEngineNotices.txt"
/bin/chmod 0755 "$destination"

if [[ "${CODE_SIGNING_ALLOWED:-NO}" == "YES" ]]; then
  signing_identity="${EXPANDED_CODE_SIGN_IDENTITY:--}"
  /usr/bin/codesign \
    --force \
    --options runtime \
    --entitlements "$entitlements_path" \
    --sign "$signing_identity" \
    "$destination"
  /usr/bin/codesign --verify --strict "$destination"
  "$destination" --version >/dev/null
fi

printf '%s\n' "$destination"
