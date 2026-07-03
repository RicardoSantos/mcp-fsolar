#!/bin/sh
# HA Supervisor writes add-on options to /data/options.json.
# Read them with Node.js (always available in node:20-alpine) instead of bashio.

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

export FELICITY_USER="$(get_opt felicity_user)"
export FELICITY_PASS="$(get_opt felicity_pass)"
export FELICITY_PORT="$(get_opt port)"
export FELICITY_MODE="http"
export FELICITY_POLL_MS="$(get_opt poll_ms)"

# /data is mapped by HA Supervisor and persists across restarts/updates
export SNAPSHOT_DIR="/data"
export FELICITY_SNAPSHOT_ENABLED="true"
export FELICITY_SNAPSHOT_MS="$(get_opt snapshot_ms)"
export FELICITY_SNAPSHOT_DAYS="$(get_opt snapshot_days)"
export FELICITY_DAILY_DAYS="$(get_opt daily_days)"

export FELICITY_RATE_LIMIT="$(get_opt rate_limit)"
export FELICITY_LOW_SOC_PCT="$(get_opt low_soc_pct)"

if [ "$(get_opt trust_proxy)" = "true" ]; then
  export FELICITY_TRUST_PROXY="1"
fi

API_KEY="$(get_opt api_key)"
if [ -n "$API_KEY" ]; then
  export FELICITY_API_KEY="$API_KEY"
fi

CORS="$(get_opt cors_origin)"
if [ -n "$CORS" ]; then
  export FELICITY_CORS_ORIGIN="$CORS"
fi

echo "[mcp-fsolar] Starting on port ${FELICITY_PORT:-3010}"
exec node /app/bin/fsolar-mcp.js
