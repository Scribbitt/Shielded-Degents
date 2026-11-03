#!/bin/sh
# One image, three processes. APP_ROLE picks which one this container runs:
#   platform  the platform service on :5030 (keys from GATE/LOCK/WALLET_KEY_JSON, see platform-entrypoint.sh)
#   web       the web vault on :8790 (PORT), configured from WEB_NETWORK / PUBLIC_* env
#   dev       (default) the whole regtest dev stack, bitcoind included (scripts/dev-stack.mjs)
# Hosts that ignore a start command (Coolify's dockerfile build pack) set APP_ROLE instead.
set -e
cd /app
case "${APP_ROLE:-dev}" in
  platform) exec sh docker/platform-entrypoint.sh ;;
  web)      exec node apps/web/build.mjs --serve ;;
  dev)      exec node scripts/dev-stack.mjs ;;
  *)        echo "unknown APP_ROLE '${APP_ROLE}' (expected platform, web or dev)" >&2; exit 64 ;;
esac
