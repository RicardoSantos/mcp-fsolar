# Architecture

## Module map

| File | Purpose |
|---|---|
| `server.ts` | MCP server factory (`createServer`), HTTP route handler, `main()` boot |
| `index.ts` | Public library re-exports (all types, functions, classes) |
| `bin/fsolar-mcp.js` | CLI entry point — delegates to `dist/server.js` |
| `src/constants.ts` | Single source of truth for all thresholds and magic numbers |
| `src/enums.ts` | Frozen const objects: `ChargingState`, `HealthStatus`, `TrendDirection`, `HookEvent` |
| `src/errors.ts` | `AppError` with `statusCode` for consistent HTTP error responses |
| `src/logger.ts` | `Logger` interface + `createLogger()` factory + default `logger` singleton |
| `src/client.ts` | `FelicityClient` — RSA auth, token refresh, pagination, cached battery fetch |
| `src/http.ts` | `felicityRequest` fetch wrapper; RSA public key (base64) |
| `src/battery.ts` | `buildBattery` — API response → `Battery` domain type |
| `src/cache.ts` | `MemoryCacheAdapter` implementing `CacheAdapter` interface |
| `src/compute.ts` | `computeHealth`, `computeAutonomy` — pure math over batteries + snapshots |
| `src/analyze.ts` | `computeAlerts`, `computeEnergyHistory`, `computeCellStats`, `computePowerStats` |
| `src/store.ts` | `SnapshotStore`, `DailyEnergyStore` — intraday + daily persistence |
| `src/state.ts` | `startPoller`, `readState`, `snapshotEmitter` — poll loop and materialized state |
| `src/hooks.ts` | `HookStore` — webhook delivery, SSRF guard, cooldowns, retry queue, HMAC signing |
| `src/middleware.ts` | `makeCheckAuth`, `makeRateLimit`, `makeGetAllowedOrigin`, `readBody` |
| `src/helpers.ts` | `clamp`, `sleep`, `pickNextSunrise`, `nullableInt`, `nullableFloat` |

---

## Three deployment modes

| Mode | Transport | Entry |
|---|---|---|
| **stdio** | Direct Claude Code auto-launch | `npx fsolar-mcp` |
| **HTTP** | REST + SSE + `/events` stream | `node dist/server.js` |
| **Embedded** | Programmatic library | `require('fsolar-mcp')` |

Mode is auto-detected via `!process.stdin.isTTY`, or set explicitly with `FELICITY_MODE=stdio|http`.

---

## Startup sequence

```
1. loadEnv()                    — reads .env file (searches __dirname, then cwd)
2. FelicityClient(user, pass)   — constructs client; credentials NOT validated yet
3. createServer(client, opts)   — wires middleware, MCP tools, HTTP routes
4. startPoller(client, opts)    — starts 30s poll loop; fires first tick immediately
   4a. client.getBatteries()    — RSA-encrypted login + token refresh if needed
   4b. snapshotStore.maybeAdd() — writes intraday snapshot if interval elapsed
   4c. computeHealth()          — per-battery health from snapshots
   4d. computeAutonomy()        — fleet autonomy estimate
   4e. hookStore.fire()         — fires events, SSRF-safe delivery, retry queue
   4f. hookStore.retryFailed()  — drains dead-letter retry queue
   4g. writeState()             — persists materialized state to felicity-state.json
   4h. snapshotEmitter.emit()   — notifies SSE /events subscribers (30s cadence)
5. httpServer.listen(PORT)      — HTTP server starts accepting connections
```

---

## Data flow

```
Felicity Cloud API
        │
        ▼
 FelicityClient                (RSA auth, token TTL, pagination, 30s cache)
        │
        ▼
 Battery[]                     (live state from buildBattery())
        │
   ┌────┴──────────────────────────────────────────────────────────┐
   │                     startPoller() — 30s tick                  │
   ├───────────────────────────────────────────────────────────────┤
   │  SnapshotStore.maybeAdd()     (10min intraday, 3-day rolling) │
   │  DailyEnergyStore.update()    (90-day daily accumulator)      │
   │  computeHealth(bats, snaps)   → BatteryHealth per battery     │
   │  computeAutonomy(bats, snaps) → AutonomyResult (fleet)        │
   │  hookStore.fire(bats, health) → webhook delivery              │
   │  writeState()                 → felicity-state.json           │
   │  snapshotEmitter.emit()       → SSE /events subscribers       │
   └───────────────────────────────────────────────────────────────┘
        │                │                │
        ▼                ▼                ▼
  MCP Tools         REST API          /events SSE
  (20 tools)        (20+ routes)      (real-time dashboards)
```

---

## Persistence files

All files live in `SNAPSHOT_DIR` (default `os.tmpdir()`). Written atomically (`.tmp` → `renameSync`). All written with `chmod 0o600`.

| File | Content | Retention |
|---|---|---|
| `battery-state.json` | Latest materialized state (batteries, health, autonomy) | Overwritten each tick |
| `felicity-state.json` | Same as above (legacy name) | Overwritten each tick |
| `battery-snapshots.json` | Intraday battery snapshots | Rolling 3 days (`FELICITY_SNAPSHOT_DAYS`) |
| `battery-energy.json` | Daily charge/discharge kWh history | Rolling 90 days (`FELICITY_DAILY_DAYS`) |
| `battery-hooks.json` | Registered webhook subscriptions | Until deleted via API |
| `battery-hook-cooldowns.json` | Per-event cooldown timestamps | Pruned after 48h |
| `battery-hook-retries.json` | Failed delivery retry queue | Expires after 24h |

---

## Security middleware stack

Applied to all routes except `/health` (auth-exempt) and `/sse` + `/messages` (MCP transport):

```
Request
  └─ makeGetAllowedOrigin()   → CORS (localhost-only default)
  └─ makeCheckAuth()          → Bearer / X-API-Key with timing-safe HMAC
       └─ query-string ?key= rejected explicitly (401)
  └─ makeRateLimit()          → token bucket per IP (60 req/min default)
  └─ readBody()               → 64 KB cap; AppError(413) on overflow
  └─ route handler
```

---

## Design decisions

### One process, two transports
A single Node.js process hosts both the MCP server and the HTTP server. The SSE transport bridges the two. This means:
- stdio mode: no HTTP server started; MCP connects directly to Claude Code's stdio pipe
- HTTP mode: both MCP (via `/sse`) and REST share the same poll loop and in-memory state

### Closure-based configuration binding
`cfg` (the active server config) is captured in a closure inside `createServer()`. Routes and tools close over it. This is simpler than dependency injection at the cost of testability — mitigated by the factory pattern (`createServer` returns a `ServerResult` so tests can create isolated instances).

### Crash guards only in `main()`
`uncaughtException` and `unhandledRejection` handlers are registered only in `main()`, not at module level. This lets `require('fsolar-mcp')` work cleanly in a parent process without double-registering global handlers.

### Atomic file writes
Every persistence write follows `.tmp` → `renameSync`. This prevents corrupt JSON if the process crashes mid-write. The OS rename is atomic on the same filesystem.

### Retry queue as dead-letter log
Failed webhook deliveries go into `battery-hook-retries.json`. On each poller tick, `retryFailed()` drains the queue. Entries expire after 24h. The queue is capped at 200 entries to bound disk usage.

### Constants centralization
All thresholds, cooldowns, and tuning constants live in `src/constants.ts`. No magic numbers in business logic. `compute.ts` re-exports the health threshold subset for the public API (`index.ts`).
