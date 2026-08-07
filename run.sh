#!/usr/bin/env bash
#
# redoubt — one entry point for everything you normally want to run.
#
#   ./run.sh                 play one match and print the battle report
#   ./run.sh match 7         same, with a specific seed
#   ./run.sh batch 1000      balance statistics over N matches
#   ./run.sh play            start the server and the 2D client, then play
#   ./run.sh test            unit + property + balance-gate tests
#   ./run.sh check           typecheck, then the full test suite
#   ./run.sh setup           install pnpm (if missing) and dependencies
#
# Any flags after the subcommand are passed straight through, so
# `./run.sh match 7 --lane Valley --hash` works.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

readonly DEFAULT_SEED=42
readonly DEFAULT_MATCHES=100
readonly PNPM_VERSION=9.15.4

# --- toolchain -------------------------------------------------------------

# pnpm may live in ~/.local/bin, which is not always on a non-interactive PATH.
find_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    echo "pnpm"
  elif [[ -x "$HOME/.local/bin/pnpm" ]]; then
    echo "$HOME/.local/bin/pnpm"
  else
    return 1
  fi
}

require_pnpm() {
  local found
  if ! found="$(find_pnpm)"; then
    echo "pnpm is not installed. Run: ./run.sh setup" >&2
    exit 1
  fi
  PNPM="$found"
}

require_deps() {
  require_pnpm
  if [[ ! -d node_modules ]]; then
    echo "==> dependencies missing, installing"
    "$PNPM" install
  fi
}

# --- subcommands -----------------------------------------------------------

cmd_setup() {
  if ! find_pnpm >/dev/null; then
    echo "==> installing pnpm@${PNPM_VERSION} into ~/.local"
    # /usr/local is usually root-owned; keep the install in the user prefix.
    npm config set prefix "$HOME/.local"
    npm install -g "pnpm@${PNPM_VERSION}"
  fi
  require_pnpm
  echo "==> installing dependencies"
  "$PNPM" install
  echo
  echo "Ready. Try: ./run.sh"
}

cmd_match() {
  require_deps
  local seed="$DEFAULT_SEED"
  # A bare leading number is the seed; anything else is a passthrough flag.
  if [[ $# -gt 0 && "$1" =~ ^-?[0-9]+$ ]]; then
    seed="$1"
    shift
  fi
  "$PNPM" --silent sim --seed "$seed" "$@"
}

cmd_batch() {
  require_deps
  local matches="$DEFAULT_MATCHES"
  if [[ $# -gt 0 && "$1" =~ ^[0-9]+$ ]]; then
    matches="$1"
    shift
  fi
  "$PNPM" --silent sim --matches "$matches" "$@"
}

# Runs both halves of the playable build and waits. Ctrl-C stops the pair.
cmd_play() {
  require_deps
  local port="${1:-8787}"
  local seed="${2:-$DEFAULT_SEED}"

  "$PNPM" --silent --filter @redoubt/server start --port "$port" --seed "$seed" &
  local server_pid=$!
  # Stop the server whichever way this function exits, including Ctrl-C.
  trap 'kill "$server_pid" 2>/dev/null' EXIT INT TERM

  echo
  echo "  server  ws://localhost:${port}"
  echo "  client  http://localhost:5173/   (append ?join=you to skip the splash)"
  echo
  "$PNPM" --silent --filter @redoubt/client dev
}

cmd_serve() {
  require_deps
  "$PNPM" --silent --filter @redoubt/server start "$@"
}

cmd_test() {
  require_deps
  "$PNPM" --silent test "$@"
}

cmd_typecheck() {
  require_deps
  "$PNPM" --silent typecheck
}

cmd_check() {
  require_deps
  echo "==> typecheck"
  "$PNPM" --silent typecheck
  echo "==> tests"
  "$PNPM" --silent test
}

# Print the header comment block, stopping at the first line of real code so
# the usage text stays correct however much the script grows.
cmd_help() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' \
    "${BASH_SOURCE[0]}"
}

# --- dispatch --------------------------------------------------------------

main() {
  local subcommand="${1:-match}"
  [[ $# -gt 0 ]] && shift

  case "$subcommand" in
    match | run | sim) cmd_match "$@" ;;
    batch | matches) cmd_batch "$@" ;;
    play) cmd_play "$@" ;;
    serve | server) cmd_serve "$@" ;;
    test | t) cmd_test "$@" ;;
    typecheck | tc) cmd_typecheck ;;
    check | ci) cmd_check ;;
    setup | install) cmd_setup ;;
    help | -h | --help) cmd_help ;;
    *)
      echo "unknown command: ${subcommand}" >&2
      echo >&2
      cmd_help >&2
      exit 2
      ;;
  esac
}

main "$@"
