#!/bin/sh
# Platform role (docker/start.sh APP_ROLE=platform): the keys arrive as
# *_KEY_JSON env values (Coolify secrets) and are written to the files the
# server reads through *_KEY_FILE (default /secrets/<name>.json); state
# lives under /state. A key given as *_KEY_HEX instead is left to the server.
set -e
export GATE_KEY_FILE="${GATE_KEY_FILE:-/secrets/gate.json}"
export LOCK_KEY_FILE="${LOCK_KEY_FILE:-/secrets/lock.json}"
export WALLET_KEY_FILE="${WALLET_KEY_FILE:-/secrets/wallet.json}"
export STATE_FILE="${STATE_FILE:-/state/platform-state.json}"
export CACHE_DIR="${CACHE_DIR:-/state/cache}"

# write_key <NAME>: <NAME>_KEY_JSON -> $<NAME>_KEY_FILE (0600). Never echo
# the value: a parse error downstream would quote it into the logs, so a
# value that is not a JSON object is refused here by name only.
write_key() {
  eval "json=\${${1}_KEY_JSON:-} hex=\${${1}_KEY_HEX:-} file=\${${1}_KEY_FILE}"
  if [ -z "$json" ]; then
    [ -n "$hex" ] && return 0
    echo "platform-entrypoint: ${1}_KEY_JSON is not set" >&2
    exit 64
  fi
  case "$json" in
    \{*) ;;
    *) echo "platform-entrypoint: ${1}_KEY_JSON is not a JSON object" >&2; exit 64 ;;
  esac
  mkdir -p "$(dirname "$file")"
  (umask 077; printf '%s' "$json" > "$file")
  chmod 600 "$file"
}
write_key GATE
write_key LOCK
write_key WALLET
unset json hex file

mkdir -p "$CACHE_DIR" "$(dirname "$STATE_FILE")"
exec node services/platform/server.mjs
