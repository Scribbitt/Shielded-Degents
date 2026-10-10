#!/bin/sh
set -e
mkdir -p /secrets
printf '%s' "$GATE_KEY_JSON"   > /secrets/gate.json
printf '%s' "$LOCK_KEY_JSON"   > /secrets/lock.json
printf '%s' "$WALLET_KEY_JSON" > /secrets/wallet.json
mkdir -p /state/cache
exec node services/platform/server.mjs
