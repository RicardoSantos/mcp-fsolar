# Changelog

All notable changes to this project will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.7] — 2026-06-30

### Added
- `computeAutonomy` now returns `perBattery[]` — per-pack estimated hours until `minSocPct` at current discharge rate
- Fleet `estimatedHours` now correctly subtracts the `minSocPct` floor (previously used raw `totalRemainingKwh`)
- `AutonomyPerBattery` TypeScript type

## [1.0.6] — 2026-06-30

### Added
- `HookStore` — webhook notification system persisted to `battery-hooks.json`
  - `add({ url, events, params })`, `remove(id)`, `list()`
  - `fire(batteries, health)` — called by poller after each tick, respects per-event cooldowns
  - Events: `cell_delta_crit`, `cell_delta_warn`, `temp_crit`, `temp_warn`, `outlier`, `soh_warn`, `low_soc`
- `hookStore` singleton exported from library
- REST endpoints in standalone server: `GET /hooks`, `POST /hooks`, `DELETE /hooks/:id`
- `HookStore`, `HookSubscription`, `HookPayload` TypeScript types
- `ALGORITHMS.md` — detailed documentation of all formulas, thresholds, assumptions, and webhook rules

## [1.0.5] — 2026-06-30

### Added
- `computeHealth(batteries, snapshots)` — per-battery health: cell delta status (ok/warn/crit), temp status, SOH status, persistent cell outliers, average C-rate
- `computeAutonomy(batteries, snapshots, opts)` — fleet autonomy: estimated hours, discharge rate, `estimatedSocAtSunrise` (null unless `sunriseAt` + `packCapacityKwh` provided)
- `startPoller` now writes `health` and `autonomy` into `battery-state.json`
- `BatteryHealth`, `AutonomyResult`, `AutonomyOptions` TypeScript types

## [1.0.4] — 2026-06-30

### Added
- `readState()` — reads pre-computed materialized state (`battery-state.json`)
- `startPoller` now writes `battery-state.json` after each successful poll (batteries, trends, fleet summary)
- REST endpoints in standalone server: `GET /snapshots/{intraday|daily|state}` (download), `DELETE /snapshots/{intraday|daily|all}` (reset)
- `FleetSummary` and `MaterializedState` TypeScript types

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
