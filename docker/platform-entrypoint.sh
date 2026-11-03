#!/bin/sh
# Platform role (docker/start.sh APP_ROLE=platform): the keys arrive as
# *_KEY_JSON env values (Coolify secrets) and are written to files the
# server reads through *_KEY_FILE; state lives under /state.
set -e
umask 077
for v in GATE_KEY_JSON LOCK_KEY_JSON WALLET_KEY_JSON; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then
    echo "platform-entrypoint: $v is not set" >&2
    exit 64
  fi
done
mkdir -p /secrets
printf '%s' "$GATE_KEY_JSON"   > /secrets/gate.json
printf '%s' "$LOCK_KEY_JSON"   > /secrets/lock.json
printf '%s' "$WALLET_KEY_JSON" > /secrets/wallet.json
export GATE_KEY_FILE="${GATE_KEY_FILE:-/secrets/gate.json}"
export LOCK_KEY_FILE="${LOCK_KEY_FILE:-/secrets/lock.json}"
export WALLET_KEY_FILE="${WALLET_KEY_FILE:-/secrets/wallet.json}"
export STATE_FILE="${STATE_FILE:-/state/platform-state.json}"
export CACHE_DIR="${CACHE_DIR:-/state/cache}"
umask 022
mkdir -p "$CACHE_DIR" "$(dirname "$STATE_FILE")"
exec node services/platform/server.mjs
