# Changelog

All notable changes to this project will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.25] — 2026-07-02

### Changed
- **TypeScript conversion** — entire codebase (`src/*.ts`, `index.ts`, `server.ts`) converted from plain JavaScript to TypeScript with `strict: true`
- `dist/` is now the compiled output directory (`tsc` emits CommonJS + `.d.ts` declaration files); `npm run build` required before running the server
- `bin/fsolar-mcp.js` replaces the old `server.js` bin entry — delegates to `dist/server.js`
- `package.json` `main` / `types` now point into `dist/`; `files` includes `dist/` and `bin/`
- All public interfaces and types (`Battery`, `BatteryHealth`, `AutonomyResult`, `AutonomyPerBattery`, `BatterySnapshot`, `MaterializedState`, `CacheAdapter`, `HookSubscription`, `SnapshotPayload`, `Logger`, etc.) are now TypeScript-native — generated `.d.ts` files replace the hand-maintained `index.d.ts`

### Fixed
- Hand-maintained `index.d.ts` drift — the root cause of the v1.0.21/v1.0.22 build failure — eliminated permanently; declaration files are now generated from source

### Added
- `tsconfig.json` — `target: ES2020`, `module: CommonJS`, `declaration: true`, `strict: true`, `types: ["node"]`
- `tsx` dev dependency — used as test loader (`--require tsx/cjs`) so unit tests run directly against TypeScript source without a build step

## [1.0.18] — 2026-07-01

### Added
- `test/security.test.js` — 36-test live security suite covering authentication, CORS, path traversal, SSRF, request size limits, security headers, and webhook lifecycle
- `FELICITY_MODE=http|stdio` env var — explicit transport override (auto-detect via TTY can be bypassed in non-interactive shells)
- `FELICITY_API_KEY` — optional API key authentication on all REST endpoints; accepted via `Authorization: Bearer` or `X-API-Key` header
- `FELICITY_CORS_ORIGIN` — configurable CORS origin; defaults to localhost origins only
- `FELICITY_RATE_LIMIT` — in-memory token-bucket rate limiter (default 60 req/min per IP; set `0` to disable)

### Fixed
- `POST /hooks`: `params` → `secret` destructuring — HMAC webhook signing now works correctly (was silently broken since v1.0.6)
- `DELETE /hooks/:id` now returns 200 on success and 404 when the id is not found (previously always returned 404)
- `readBody`: drain remaining bytes before rejecting oversized request so the 413 response is delivered correctly

### Security
- API key comparison uses `crypto.timingSafeEqual` with HMAC normalisation — eliminates timing side-channel
- Webhook registration blocks private/loopback hostnames (SSRF protection)
- `GET /hooks` no longer returns the `secret` field — redacted in `list()`
- `battery-state.json` now created with `chmod 0o600` after every write (previously missed; snapshots/hooks files fixed in v1.0.17)
- Webhook `events` array validated against `HookEvent` enum on registration
- Security headers: `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` on all responses

## [1.0.17] — 2026-07-01

### Added
- Stdio transport auto-detected via `!process.stdin.isTTY` — `fsolar-mcp` can now be launched directly by Claude Code, Claude Desktop, and Cursor via the `command/args` MCP config without a separate server process

### Changed
- README: MCP section expanded with Claude Desktop, Cursor, and generic SSE client configs
- README: REST API section now includes full endpoint table (12 routes incl. `/snapshots/*`), curl examples, and response shapes

### Fixed
- `SNAPSHOT_DIR` env var documented in configuration table (was in code but not in README)
- CORS `Access-Control-Allow-Methods` now includes `DELETE`

### Security
- `Access-Control-Allow-Origin` restricted to localhost origins by default (`*` removed)
- Webhook URL validated on `POST /hooks`: must be valid URL with `http` or `https` protocol
- `chmod 0o600` applied to all snapshot and hook JSON files after write
- `hookStore.remove()` returns `bool` so caller can distinguish 200 from 404

## [1.0.16] — 2026-07-01

### Added
- CI: GitHub Release created automatically after `npm publish` via workflow
- README: fleet view and cell-inspection screenshots
- README: full Available data reference tables (per-battery, cell, BMS limits, lifecycle counters, modules, balance trend)
- `SECURITY.md` and GitHub issue templates

## [1.0.15] — 2026-07-01

### Fixed
- `docs/` directory now included in published npm package (`files` in `package.json`)

## [1.0.14] — 2026-07-01

### Fixed
- README link to `ALGORITHMS.md` corrected after move to `docs/`

## [1.0.13] — 2026-07-01

### Changed
- `src/enums.js` (new): `ChargingState`, `HealthStatus`, `TrendDirection`, `HookEvent` — all discriminant strings now exported as frozen objects; bare string literals removed from `battery.js`, `compute.js`, `store.js`, `hooks.js`, `server.js`
- `src/battery.js`, `src/compute.js`, `src/hooks.js`, `src/store.js`: all non-obvious numeric literals replaced with named constants (`BMS_BALANCING_BIT`, `CELL_COUNT`, `OUTLIER_SNAP_WINDOW`, `TREND_STABLE_MV`, `HOOK_DELIVERY_TIMEOUT_MS`, etc.)
- `index.d.ts`: interface fields (`chargingState`, `direction`, `cellDeltaStatus`, etc.) now reference enum types instead of inline string unions
- `CONTRIBUTING.md`: no-magic-strings and no-magic-numbers rules added with examples, exceptions, and checklists
- `docs/ALGORITHMS.md`: string enums reference and named constants reference tables added

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
