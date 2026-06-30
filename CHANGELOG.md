# Changelog

All notable changes to this project will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.3] — 2026-06-30

### Added
- `startPoller(client)` — background snapshot poller for library consumers
- `FELICITY_SNAPSHOT_ENABLED` — enable/disable the snapshot mechanism (default `true`)
- `FELICITY_SNAPSHOT_MS` — configurable snapshot interval, clamped 1 min–1 hour (default 10 min)
- `FELICITY_SNAPSHOT_DAYS` — intra-day snapshot retention in days, clamped 1–30 (default 3)
- `FELICITY_DAILY_DAYS` — daily snapshot retention in days, clamped 7–365 (default 90)

### Fixed
- Credentials validated at request time instead of construction (fixes build-time errors in Next.js)

## [1.0.0] — 2026-06-30

### Added
- MCP server with six tools: `get_all_batteries`, `get_battery`, `get_cell_voltages`,
  `get_fleet_summary`, `get_balance_trend`, `get_snapshots`
- REST API: `GET /batteries`, `GET /batteries/:id`, `GET /sse`
- JS client library (`FelicityClient`, `MemoryCacheAdapter`) with TypeScript types
- RSA-encrypted login, automatic token refresh, background polling
- `probe.js` debug utility for raw API inspection
