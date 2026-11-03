#!/bin/sh
# Platform role (docker/start.sh APP_ROLE=platform): the keys arrive as
# *_KEY_JSON env values (Coolify secrets) and are written to the files the
# server reads through *_KEY_FILE (default /secrets/<name>.json); state
# lives under /state. *_KEY_HEX or a mounted *_KEY_FILE work too.
set -ef   # -f: no globbing of operator-supplied paths
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

# stage_key <NAME>, in the server's order (services/platform/server.mjs
# `secret`): <NAME>_KEY_HEX wins; else <NAME>_KEY_JSON is staged in a temp
# file (0600) next to $<NAME>_KEY_FILE and checked; else an existing
# $<NAME>_KEY_FILE is checked and used. Nothing is replaced until all three
# keys pass (commit below). The Coolify secret is the source of truth: a
# valid *_KEY_JSON replaces the file. Every refusal names the variable only:
# the server's JSON.parse error would quote part of a malformed key.
# `~` and relative *_KEY_FILE paths are refused (the server would expand ~).
staged=""
used=" "
trap 'for t in $staged; do rm -f "$t"; done' EXIT
trap 'exit 143' INT TERM
stage_key() {
  eval "json=\${${1}_KEY_JSON:-} hex=\${${1}_KEY_HEX:-} file=\${${1}_KEY_FILE}"
  # Ends only (as the server's .trim()); inner whitespace is refused below.
  hex=$(printf '%s' "$hex" | awk 'BEGIN{RS="\001"} {sub(/^[ \t\r\n]+/,""); sub(/[ \t\r\n]+$/,""); printf "%s", $0}')
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
    *[[:space:]]*) echo "platform-entrypoint: ${1}_KEY_FILE must not contain whitespace" >&2; exit 64 ;;
    /*) ;;
    *) echo "platform-entrypoint: ${1}_KEY_FILE must be an absolute path" >&2; exit 64 ;;
  esac
  case "$used" in
    *" $file "*) echo "platform-entrypoint: ${1}_KEY_FILE is the same file as another key's" >&2; exit 64 ;;
  esac
  used="$used$file "
  if [ -e "$file" ] && [ ! -f "$file" ]; then
    echo "platform-entrypoint: ${1}_KEY_FILE is not a regular file" >&2
    exit 64
  fi
  if [ -n "$(trim "$json")" ]; then
    (umask 077; mkdir -p "$(dirname "$file")")
    tmp="$file.tmp.$$"
    staged="$staged $tmp"
    (umask 077; printf '%s' "$json" > "$tmp")
    chmod 600 "$tmp"
    if ! valid_key_file "$tmp"; then
      echo "platform-entrypoint: ${1}_KEY_JSON is not {\"priv\":\"<64 hex>\"}" >&2
      exit 64
    fi
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
stage_key GATE
stage_key LOCK
stage_key WALLET
# All three passed: replace the files (same directory, so each is a rename).
for t in $staged; do
  sync "$t" 2>/dev/null || sync
  mv -f "$t" "${t%.tmp.*}"
done
staged=""
unset json hex file tmp bad v
# Written to disk: the JSON copies leave the server process's environment
# (the container's configured env, docker inspect, still has them).
unset GATE_KEY_JSON LOCK_KEY_JSON WALLET_KEY_JSON

mkdir -p "$CACHE_DIR" "$(dirname "$STATE_FILE")"
exec node services/platform/server.mjs
