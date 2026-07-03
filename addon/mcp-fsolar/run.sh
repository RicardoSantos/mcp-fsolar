#!/usr/bin/with-contenv bashio

# Required credentials
export FELICITY_USER="$(bashio::config 'felicity_user')"
export FELICITY_PASS="$(bashio::config 'felicity_pass')"

# Server
export FELICITY_PORT="$(bashio::config 'port')"
export FELICITY_MODE="http"

# Polling
export FELICITY_POLL_MS="$(bashio::config 'poll_ms')"

# Persistence — /data is mapped by HA Supervisor and survives restarts
export SNAPSHOT_DIR="/data"

# Snapshots
export FELICITY_SNAPSHOT_ENABLED="true"
export FELICITY_SNAPSHOT_MS="$(bashio::config 'snapshot_ms')"
export FELICITY_SNAPSHOT_DAYS="$(bashio::config 'snapshot_days')"
export FELICITY_DAILY_DAYS="$(bashio::config 'daily_days')"

# Security
export FELICITY_RATE_LIMIT="$(bashio::config 'rate_limit')"
export FELICITY_LOW_SOC_PCT="$(bashio::config 'low_soc_pct')"

if bashio::config.true 'trust_proxy'; then
  export FELICITY_TRUST_PROXY="1"
fi

if bashio::config.has_value 'api_key'; then
  export FELICITY_API_KEY="$(bashio::config 'api_key')"
fi

if bashio::config.has_value 'cors_origin'; then
  export FELICITY_CORS_ORIGIN="$(bashio::config 'cors_origin')"
fi

bashio::log.info "Starting mcp-fsolar on port ${FELICITY_PORT}"
exec node /app/bin/fsolar-mcp.js
