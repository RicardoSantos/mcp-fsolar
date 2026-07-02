# CLAUDE.md — fsolar-mcp

## Project overview

Felicity Solar battery MCP server + REST API. Exposes per-cell voltages, SOC, SOH, temperatures, BMS counters, balancing state, and computed health metrics to Claude and any MCP client.

## Key documents

| File | What it covers |
|---|---|
| [`README.md`](README.md) | Setup, usage modes (MCP, REST API, embedded, JS library, webhooks), env vars |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Branch naming, conventional commits, PR process |
| [`SECURITY.md`](SECURITY.md) | Security policy and responsible disclosure |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history |
| [`docs/ALGORITHMS.md`](docs/ALGORITHMS.md) | Every derived metric formula (cell delta, SOC, SOH, trend), snapshot persistence, webhook system |

## Running tests

```bash
npm test              # build + run all unit and security tests via node --test on dist/
npm run test:security # build + run only the live security tests (server must be running)
```

Security tests need a pre-started server and matching credentials:

```bash
FELICITY_USER=x FELICITY_PASS=y FELICITY_API_KEY=secret FELICITY_MODE=http node dist/server.js &
FELICITY_API_KEY=secret npm run test:security
```

## Project structure

```
server.ts          Server factory (TypeScript source) — exports createServer() + startServer()
index.ts           Public API barrel (TypeScript source) — re-exports all public symbols
bin/
  fsolar-mcp.js    CLI entry point — calls dist/server.js main() after build
dist/              Compiled output (tsc → CommonJS + .d.ts); this is what npm publishes
src/
  errors.ts        AppError class (Error subclass with statusCode)
  logger.ts        createLogger() — injectable structured JSON logger (writes to stderr)
  middleware.ts    makeGetAllowedOrigin, makeCheckAuth, makeRateLimit, readBody factories
  hooks.ts         Webhook store, SSRF validation, event delivery, per-event cooldowns, retry
  compute.ts       Health metric derivation (computeHealth, computeAutonomy)
  enums.ts         HealthStatus, HookEvent, TrendDirection, ChargingState
  client.ts        FelicityClient — auth, pagination, caching
  http.ts          felicityRequest using fetch() + AbortSignal.timeout()
  helpers.ts       sleep(), pickSnapshotFields(), pickNextSunrise() and other shared utilities
  state.ts         startPoller, readState, snapshotEmitter
  store.ts         SnapshotStore, BatterySnapshotStore, DailySnapshotStore
  battery.ts       buildBattery — raw Felicity API → typed Battery
  cache.ts         MemoryCacheAdapter, CacheAdapter interface
test/
  cache.test.ts      MemoryCacheAdapter unit tests
  client.test.ts     FelicityClient unit tests
  compute.test.ts    computeHealth + computeAutonomy unit tests
  errors.test.ts     AppError unit tests
  helpers.test.ts    nullableInt, clamp, sleep, pickSnapshotFields, pickNextSunrise
  hooks.test.ts      HookStore SSRF, cooldowns, event filtering
  logger.test.ts     createLogger JSON output
  middleware.test.ts CORS, auth, rate limit, body parsing
  snapshot.test.ts   BatterySnapshotStore trend computation
  transform.test.ts  buildBattery field mapping
  analyze.test.ts    analyzeBatteries + computePowerStats unit tests
  security.test.ts   Live HTTP security suite (auth, CORS, SSRF, rate limiting, webhooks)
```

**Build step required:** TypeScript source must be compiled before running the server:

```bash
npm run build   # tsc → emits dist/ with .js + .d.ts files
node dist/server.js
```


## Three usage modes

| Mode | How | When |
|---|---|---|
| **stdio** | `npx fsolar-mcp` | Claude Code auto-launch; no persistent process |
| **HTTP** | `node dist/server.js` | Persistent server for dashboards + multi-client SSE |
| **embedded** | `const { createServer, startServer } = require('mcp-fsolar')` | Inside another Node.js process |

Embedded mode example:

```js
const { startServer, FelicityClient, MemoryCacheAdapter, startPoller } = require('mcp-fsolar')
const client = new FelicityClient({ user, pass, cache: new MemoryCacheAdapter() })
const { url, setPollError, close } = await startServer(client, { port: 3010 })
startPoller(client)  // begins background health computation and snapshot storage
```

## TypeScript conventions

**All source is TypeScript with `strict: true`.** No `any`, no `@ts-ignore`, no implicit nullable access.

Use `import type` for type-only imports:

```ts
import type { Battery }          from "./battery"
import type { BatterySnapshot }  from "./store"
```

Enums are frozen const objects that double as types — both the runtime value and the type share the same name:

```ts
export const ChargingState = Object.freeze({ CHARGING: "charging", ... } as const)
export type  ChargingState = typeof ChargingState[keyof typeof ChargingState]
```

When TypeScript and the MCP SDK interact (Zod v4), do **not** add `= {}` defaults to optional-param destructuring in tool handlers — Zod v4 types optional fields as `T | undefined`, not omittable, so `= {}` is a type error:

```ts
// ✗ wrong — type error with Zod v4
async ({ id } = {}) => { ... }

// ✓ correct
async ({ id }) => { ... }
```

**New public types must be exported from `index.ts`.** Declaration files are auto-generated by `tsc` — never hand-edit files in `dist/`.

## Code conventions

**HTTP status codes — always use `node:http2` named constants, never raw numbers.** This applies everywhere: `res.writeHead(...)`, `new AppError(...)`, fallback expressions.

```ts
import { constants } from "node:http2";
const { HTTP_STATUS_OK, HTTP_STATUS_CREATED, HTTP_STATUS_NO_CONTENT,
        HTTP_STATUS_BAD_REQUEST, HTTP_STATUS_UNAUTHORIZED,
        HTTP_STATUS_NOT_FOUND, HTTP_STATUS_PAYLOAD_TOO_LARGE,
        HTTP_STATUS_TOO_MANY_REQUESTS, HTTP_STATUS_INTERNAL_SERVER_ERROR,
        HTTP_STATUS_SERVICE_UNAVAILABLE } = constants;

// Good
res.writeHead(HTTP_STATUS_OK, { "Content-Type": "application/json" });
throw new AppError("not found", HTTP_STATUS_NOT_FOUND);
const status = err.statusCode ?? HTTP_STATUS_INTERNAL_SERVER_ERROR;

// Bad — never write raw numbers
res.writeHead(200, ...);
throw new AppError("not found", 404);

// Note: 413 is HTTP_STATUS_PAYLOAD_TOO_LARGE (NOT REQUEST_ENTITY_TOO_LARGE, which is undefined in Node.js)
```

## Key conventions

**`createServer` is the unit of isolation.** All security helpers, MCP tools, and HTTP routes live inside `createServer(client, opts)`. Avoid module-level server state — it prevents embedding.

**Crash guards in `main()` only.** `uncaughtException` / `unhandledRejection` are registered inside `main()`, not at module level, so they don't double-register when the file is `require()`d.

**`setPollError(err)` wires poll errors into tool output.** The `get_fleet_summary` tool shows the last poll error. `main()` calls `setPollError` on each poll cycle; embedded callers get `setPollError` from `createServer` return value.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `FELICITY_USER` | — | Felicity cloud username (required) |
| `FELICITY_PASS` | — | Felicity cloud password (required) |
| `FELICITY_API_KEY` | — | Bearer token for the REST API (optional) |
| `FELICITY_PORT` | `3010` | HTTP listen port |
| `FELICITY_RATE_LIMIT` | `60` | Requests per minute per IP (`0` = disabled) |
| `FELICITY_MODE` | auto | `http` forces HTTP mode; `stdio` forces stdio |
| `FELICITY_TOKEN_TTL_H` | `6` | Felicity auth token lifetime in hours before proactive refresh |
| `FELICITY_LOW_SOC_PCT` | `20` | SOC % threshold for the `low_soc` webhook event |
| `FELICITY_TARIFF_KWH` | — | Electricity tariff in currency/kWh used by `get_cost_savings` tool |
| `SNAPSHOT_DIR` | `os.tmpdir()` | Directory for snapshot + hook persistence |
