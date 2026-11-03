#!/bin/sh
# Platform role (docker/start.sh APP_ROLE=platform): the keys arrive as
# *_KEY_JSON env values (Coolify secrets) and are written to the files the
# server reads through *_KEY_FILE (default /secrets/<name>.json); state
# lives under /state. *_KEY_HEX or a mounted *_KEY_FILE work too.
set -e
trim() { printf '%s' "$1" | tr -d '\n\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }
# Trim first, then default (the server's env() treats blank as unset).
v=$(trim "${GATE_KEY_FILE:-}");   export GATE_KEY_FILE="${v:-/secrets/gate.json}"
v=$(trim "${LOCK_KEY_FILE:-}");   export LOCK_KEY_FILE="${v:-/secrets/lock.json}"
v=$(trim "${WALLET_KEY_FILE:-}"); export WALLET_KEY_FILE="${v:-/secrets/wallet.json}"
v=$(trim "${STATE_FILE:-}");      export STATE_FILE="${v:-/state/platform-state.json}"
v=$(trim "${CACHE_DIR:-}");       export CACHE_DIR="${v:-/state/cache}"

# valid_key_file <file>: {"priv":"<64 hex>"} (checked in node, output dropped).
valid_key_file() {
  node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(typeof o.priv!=="string"||!/^[0-9a-f]{64}$/i.test(o.priv))throw 0}catch(e){process.exit(1)}' "$1" 2>/dev/null
}

# write_key <NAME>, in the server's order (services/platform/server.mjs
# `secret`): <NAME>_KEY_HEX wins; else <NAME>_KEY_JSON replaces
# $<NAME>_KEY_FILE (0600, atomically, only once it is valid); else an
# existing $<NAME>_KEY_FILE is used. Every refusal names the variable only:
# the server's JSON.parse error would quote part of a malformed key.
write_key() {
  eval "json=\${${1}_KEY_JSON:-} hex=\${${1}_KEY_HEX:-} file=\${${1}_KEY_FILE}"
  hex=$(printf '%s' "$hex" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  if [ -n "$hex" ]; then
    case "$hex" in
      *[!0-9a-fA-F]*) bad=1 ;;
      *) [ "${#hex}" -eq 64 ] && bad= || bad=1 ;;
    esac
    if [ -n "$bad" ]; then
      echo "platform-entrypoint: ${1}_KEY_HEX is not 64 hex characters" >&2
      exit 64
    fi
    return 0
  fi
  case "$file" in
    /*) ;;
    *) echo "platform-entrypoint: ${1}_KEY_FILE must be an absolute path" >&2; exit 64 ;;
  esac
  if [ -n "$json" ]; then
    (umask 077; mkdir -p "$(dirname "$file")")
    tmp="$file.tmp.$$"
    (umask 077; printf '%s' "$json" > "$tmp")
    if ! valid_key_file "$tmp"; then
      rm -f "$tmp"
      echo "platform-entrypoint: ${1}_KEY_JSON is not {\"priv\":\"<64 hex>\"}" >&2
      exit 64
    fi
    chmod 600 "$tmp"
    mv -f "$tmp" "$file"
    return 0
  fi
  if [ -f "$file" ]; then
    if ! valid_key_file "$file"; then
      echo "platform-entrypoint: ${1}_KEY_FILE does not hold {\"priv\":\"<64 hex>\"}" >&2
      exit 64
    fi
    return 0
  fi
  echo "platform-entrypoint: none of ${1}_KEY_HEX, ${1}_KEY_JSON, ${1}_KEY_FILE is set" >&2
  exit 64
}
write_key GATE
write_key LOCK
write_key WALLET
unset json hex file tmp bad v
# Written to disk: the JSON copies leave the server process's environment
# (the container's configured env, docker inspect, still has them).
unset GATE_KEY_JSON LOCK_KEY_JSON WALLET_KEY_JSON

mkdir -p "$CACHE_DIR" "$(dirname "$STATE_FILE")"
exec node services/platform/server.mjs
