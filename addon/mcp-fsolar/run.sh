#!/bin/sh
# HA Supervisor writes add-on options to /data/options.json.
# Read them with Node.js (always available in node:20-alpine) instead of bashio.
#
# This same image can also run as a plain Docker container (no HA Supervisor,
# no /data/options.json) with env vars passed via `docker run -e` / compose.
# get_opt then returns "" for every key, so set_opt below only exports when it
# gets a non-empty value — otherwise it leaves whatever is already in the
# environment untouched instead of overwriting it with "".

OPTIONS=/data/options.json

get_opt() {
  node -e "
    try {
      const o = JSON.parse(require('fs').readFileSync('${OPTIONS}', 'utf8'));
      const v = o['$1'];
      if (v !== undefined && v !== null && v !== '') process.stdout.write(String(v));
    } catch (_) {}
  " 2>/dev/null
}

# set_opt VAR_NAME option_key — exports VAR_NAME from options.json only when
# that option is actually set; otherwise preserves any pre-existing env var.
set_opt() {
  v="$(get_opt "$2")"
  if [ -n "$v" ]; then
    export "$1=$v"
  fi
}

set_opt FELICITY_USER         felicity_user
set_opt FELICITY_PASS         felicity_pass
set_opt FELICITY_PORT         port
export FELICITY_MODE="http"
set_opt FELICITY_POLL_MS      poll_ms

# /data is mapped by HA Supervisor and persists across restarts/updates.
# Under plain Docker (no Supervisor), only default SNAPSHOT_DIR if the
# caller hasn't already set one themselves.
export SNAPSHOT_DIR="${SNAPSHOT_DIR:-/data}"
export FELICITY_SNAPSHOT_ENABLED="${FELICITY_SNAPSHOT_ENABLED:-true}"
set_opt FELICITY_SNAPSHOT_MS   snapshot_ms
set_opt FELICITY_SNAPSHOT_DAYS snapshot_days
set_opt FELICITY_DAILY_DAYS    daily_days

set_opt FELICITY_RATE_LIMIT    rate_limit
set_opt FELICITY_LOW_SOC_PCT   low_soc_pct

if [ "$(get_opt trust_proxy)" = "true" ]; then
  export FELICITY_TRUST_PROXY="1"
fi

set_opt FELICITY_API_KEY     api_key
set_opt FELICITY_CORS_ORIGIN cors_origin

echo "[mcp-fsolar] Starting on port ${FELICITY_PORT:-3010}"
exec node /app/bin/fsolar-mcp.js
