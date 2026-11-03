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

# write_key <NAME>: <NAME>_KEY_JSON -> $<NAME>_KEY_FILE (0600). The value is
# never printed: it is validated here ({"priv":"<64 hex>"}) and refused by
# name only, because the server's JSON.parse error would quote it.
write_key() {
  eval "json=\${${1}_KEY_JSON:-} hex=\${${1}_KEY_HEX:-} file=\${${1}_KEY_FILE}"
  case "$file" in
    "~"*) echo "platform-entrypoint: ${1}_KEY_FILE must be an absolute path" >&2; exit 64 ;;
  esac
  rm -f "$file"
  if [ -z "$json" ]; then
    if [ -n "$(printf '%s' "$hex" | tr -d '[:space:]')" ]; then return 0; fi
    echo "platform-entrypoint: ${1}_KEY_JSON is not set" >&2
    exit 64
  fi
  mkdir -p "$(dirname "$file")"
  (umask 077; printf '%s' "$json" > "$file")
  chmod 600 "$file"
  if ! node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(typeof o.priv!=="string"||!/^[0-9a-f]{64}$/i.test(o.priv))throw 0}catch(e){process.exit(1)}' "$file" 2>/dev/null; then
    rm -f "$file"
    echo "platform-entrypoint: ${1}_KEY_JSON is not {\"priv\":\"<64 hex>\"}" >&2
    exit 64
  fi
}
write_key GATE
write_key LOCK
write_key WALLET
unset json hex file
# The keys are on disk now; keep them out of the server's environment.
unset GATE_KEY_JSON LOCK_KEY_JSON WALLET_KEY_JSON

mkdir -p "$CACHE_DIR" "$(dirname "$STATE_FILE")"
exec node services/platform/server.mjs
