#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

for tool in uv npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Missing %s. Install it, then run ./install.sh again.\n' "$tool" >&2
    exit 1
  fi
done

cd "$repo_root"
uv sync
npm ci --prefix "$repo_root/road-editor-solver-app"

printf 'Dependencies are ready. Start the app with ./run.sh.\n'
