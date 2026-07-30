#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_path="$project_root/build/macos/Build/Products/Debug/Tallyburn.app"
app_executable="$app_path/Contents/MacOS/Tallyburn"
cli_script="$project_root/dist/src/cli.js"

"$project_root/scripts/build-macos-dev.sh"

existing_pids=()
while IFS= read -r pid; do
  [[ -n "$pid" ]] || continue
  command_line="$(ps -p "$pid" -o command=)"
  if [[ "$command_line" == "$app_executable" ]]; then
    existing_pids+=("$pid")
  fi
done < <(pgrep -x Tallyburn || true)

if ((${#existing_pids[@]} > 0)); then
  printf '%s\n' "Restarting the existing Tallyburn development app…"
  kill -TERM "${existing_pids[@]}"
  for _ in {1..30}; do
    remaining=0
    for pid in "${existing_pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        remaining=1
        break
      fi
    done
    ((remaining == 0)) && break
    sleep 0.1
  done
fi

node_path="$(command -v node)"
open -g \
  --env "TALLYBURN_NODE_PATH=$node_path" \
  --env "TALLYBURN_CLI_SCRIPT=$cli_script" \
  "$app_path"

launched=0
for _ in {1..30}; do
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if [[ "$(ps -p "$pid" -o command=)" == "$app_executable" ]]; then
      launched=1
      break
    fi
  done < <(pgrep -x Tallyburn || true)
  ((launched == 1)) && break
  sleep 0.1
done

if ((launched == 0)); then
  printf '%s\n' "Tallyburn did not start. Open $app_path manually." >&2
  exit 1
fi

printf '%s\n' \
  "Tallyburn is running in the menu bar. Click the flame icon to continue."
