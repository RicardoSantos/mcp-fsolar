# Changelog

All notable changes to this project will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.12] — 2026-07-01

### Changed
- `index.js`: refactored from monolithic ~750-line file into focused modules under `src/` — `helpers.js`, `http.js`, `cache.js`, `battery.js`, `store.js`, `hooks.js`, `compute.js`, `state.js`; root `index.js` is now a thin re-export wrapper with zero logic
- `ALGORITHMS.md`: moved to `docs/ALGORITHMS.md`; `README.md` link updated
- `package.json`: `files` includes `src/` and `docs/`; public API unchanged

## [1.0.11] — 2026-07-01

### Fixed
- `computeAutonomy`: `estimatedSocAtSunrise` no longer requires `packCapacityKwh` to be explicitly passed — uses the same `totalCapacityKwh` already derived from `bat.ratedEnergyKwh` (Felicity API field) or `bat.remainingKwh / (bat.soc / 100)` per battery

## [1.0.10] — 2026-06-30

### Fixed
- `server.js`: `process.on("uncaughtException")` logs ISO timestamp + full stack and exits 1 — crash always leaves a record in Docker logs
- `server.js`: `process.on("unhandledRejection")` logs ISO timestamp without killing the process
- `server.js`: `readBody()` enforces 64 KB body limit on all POST requests; returns HTTP 413 on overflow
- `server.js`: `PORT` and `POLL_MS` `parseInt` given explicit radix 10

## [1.0.9] — 2026-06-30

### Changed
- `computeHealth`: pre-index snapshot entries by SN before battery loop — eliminates O(M) `find()` per snapshot per battery; single pass build of `Map<sn, entries[]>`
- `computeHealth`: outlier detection no longer gated on live `chargingState === "discharging"` — snapshot-level power filter (`power < 0`) is sufficient; standby ticks no longer erase a previously flagged weak cell
- `startPoller`: snapshots loaded once per tick and threaded through `_writeState`, `computeHealth`, and `hookStore.fire()` — was reading disk 3× per tick
- `startPoller`: `computeHealth` computed once per tick and passed to both `_writeState` and `hookStore.fire()` — was computed twice
- `startPoller`: mutex flag prevents overlapping ticks if Felicity API is slow (10s timeout vs. short poll intervals)
- `_writeState`, `SnapshotStore._save`, `HookStore._save`: atomic writes via `.tmp` + `fs.renameSync` — prevents corrupt JSON on process crash mid-write
- `HookStore.add`: webhook IDs now use `crypto.randomBytes(4).toString("hex")` instead of `Math.random()`
- `resolveSnapshotConfig`: uses `clamp()` helper with explicit radix 10 in `parseInt`
- `nullableInt`: added explicit radix 10 to `parseInt`
- `computeAutonomy`: renamed reducer variables to eliminate `b`/`sn` shadowing; `clamp()` used for `dischargeRateKw` and `estimatedSocAtSunrise`
- `TOKEN_TTL_MS` named constant replaces inline `72 * 60 * 60 * 1000`

## [1.0.8] — 2026-06-30

### Added
- `computeHealth` now returns `dischargeDelta: number | null` per battery — median cell delta from discharge-only snapshots (delta < 30 mV), excludes top-of-charge BMS balancing noise
- `computeAutonomy` now returns `estimatedHoursToFull: number | null` at fleet level and per battery — hours until 100% SOC at current charge rate (null when not charging)
- `AutonomyPerBattery.estimatedHoursToFull` TypeScript type

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
