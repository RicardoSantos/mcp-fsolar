# mcp-fsolar Add-on

Runs the **mcp-fsolar** battery bridge server inside Home Assistant Supervisor. It polls the Felicity Solar cloud API and exposes live battery data as:

- A **REST API** (`GET /batteries`, `/health`, `/alerts`, `/energy`, …) consumed by the **ha-fsolar** Lovelace cards
- An **SSE stream** (`GET /events`) for real-time card updates
- An **MCP server** for Claude Code / Claude Desktop

## Prerequisites

- Felicity Solar account credentials (the same email + password used in the Felicity app)
- The **ha-fsolar** Lovelace cards installed via HACS (optional but recommended)

## Configuration

| Option | Required | Default | Description |
|---|---|---|---|
| `felicity_user` | ✅ | — | Felicity cloud account email |
| `felicity_pass` | ✅ | — | Felicity cloud account password |
| `port` | | 3010 | TCP port exposed on the host |
| `poll_ms` | | 30 000 | How often to poll the Felicity cloud (ms) |
| `api_key` | | — | If set, REST requests must include `Authorization: Bearer <key>` |
| `cors_origin` | | — | Allowed CORS origin (e.g. `http://homeassistant.local:8123`). Defaults to localhost only. |
| `rate_limit` | | 60 | Max REST requests per IP per minute (0 = disabled) |
| `trust_proxy` | | false | Trust `X-Forwarded-For` (set true when behind nginx/Traefik) |
| `low_soc_pct` | | 20 | SOC threshold for `LOW_SOC` webhook events (%) |
| `snapshot_ms` | | 600 000 | Intraday snapshot interval (ms) |
| `snapshot_days` | | 3 | Days of intraday snapshots to retain |
| `daily_days` | | 90 | Days of daily energy history to retain |

All data files (snapshots, hooks, cooldowns) are stored in `/data` and survive add-on restarts and updates.

## Connecting ha-fsolar cards

Set the card URL to the add-on port on your HA host:

```yaml
type: custom:felicity-fleet-card
url: http://homeassistant.local:3010
api_key: your_key   # only if you set one above
mode: sse
```

## Port forwarding

The add-on exposes port 3010 on the host by default. If this conflicts with another service, change `port` in the add-on configuration.

If you want to access the REST API from outside your local network, put it behind a reverse proxy (nginx, Caddy, Traefik) and set `trust_proxy: true` and `cors_origin` accordingly.

## Webhooks

Register webhooks via `POST /hooks` to receive battery events (low SOC, high temperature, stale data) at any URL. Webhooks are stored in `/data/battery-hooks.json` and are persisted across restarts.
