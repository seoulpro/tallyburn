#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
macos_root="$project_root/apps/macos"
derived_data="$project_root/build/macos"

command -v xcodegen >/dev/null
command -v xcodebuild >/dev/null

if command -v pnpm >/dev/null; then
  pnpm_command=(pnpm)
elif command -v corepack >/dev/null; then
  pnpm_command=(corepack pnpm)
else
  printf '%s\n' \
    "pnpm is required. Install it with 'corepack enable' or 'npm install -g pnpm@10.34.5'." \
    >&2
  exit 1
fi

"${pnpm_command[@]}" --dir "$project_root" install --frozen-lockfile
"${pnpm_command[@]}" --dir "$project_root" build

(
  cd "$macos_root"
  xcodegen generate
  xcodebuild \
    -project Tallyburn.xcodeproj \
    -scheme Tallyburn \
    -configuration Debug \
    -derivedDataPath "$derived_data" \
    CODE_SIGNING_ALLOWED=NO \
    build
)

printf '%s\n' "$derived_data/Build/Products/Debug/Tallyburn.app"
