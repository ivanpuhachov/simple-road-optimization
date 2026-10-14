#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
session_name=road-editor-solver-app
restart=false

usage() {
  printf 'Usage: ./run.sh [-r]\n  -r  Restart the app session.\n'
}

while getopts ':rh' option; do
  case "$option" in
    r) restart=true ;;
    h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
shift "$((OPTIND - 1))"
if (($# > 0)); then
  usage >&2
  exit 2
fi

if ! command -v tmux >/dev/null 2>&1; then
  printf 'tmux is required. Install tmux, then run ./run.sh again.\n' >&2
  exit 1
fi
if [[ ! -x "$repo_root/.venv/bin/uvicorn" || ! -x "$repo_root/road-editor-solver-app/node_modules/.bin/vite" ]]; then
  printf 'Dependencies are missing. Run ./install.sh first.\n' >&2
  exit 1
fi

if tmux has-session -t "=$session_name" 2>/dev/null; then
  if [[ "$restart" == true ]]; then
    if [[ -n "${TMUX:-}" && "$(tmux display-message -p '#S')" == "$session_name" ]]; then
      printf 'Run ./run.sh -r from a terminal outside the app session.\n' >&2
      exit 1
    fi
    tmux kill-session -t "=$session_name"
    sleep 1
  else
    printf 'The app session is already running.\n'
  fi
fi

if ! tmux has-session -t "=$session_name" 2>/dev/null; then
  api_pane="$(tmux new-session -d -P -F '#{pane_id}' -s "$session_name" -c "$repo_root")"
  web_pane="$(tmux split-window -d -P -F '#{pane_id}' -h -t "$api_pane" -c "$repo_root/road-editor-solver-app")"
  tmux select-layout -t "$session_name" even-horizontal >/dev/null

  printf -v api_command '%q ' "$repo_root/.venv/bin/uvicorn" server:app --app-dir road-editor-solver-app --host 127.0.0.1 --port 8765
  printf -v web_command '%q ' npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
  tmux send-keys -t "$api_pane" "$api_command" C-m
  tmux send-keys -t "$web_pane" "$web_command" C-m
  tmux select-pane -t "$web_pane"
  printf 'Started the app session.\n'
fi

printf 'Web app: http://127.0.0.1:5173\n'
if [[ -t 0 && -t 1 ]]; then
  printf 'Detach from tmux with Ctrl-B, then D.\n'
  if [[ -n "${TMUX:-}" ]]; then
    tmux switch-client -t "$session_name"
  else
    tmux attach-session -t "$session_name"
  fi
else
  printf 'View the servers with: tmux attach -t %s\n' "$session_name"
fi
