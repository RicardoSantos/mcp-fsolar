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
npm test              # unit tests only (cache, snapshot, transform, client)
npm run test:security # live integration tests — requires a running server on port 3010
```

Security tests need a pre-started server and matching credentials:

```bash
FELICITY_USER=x FELICITY_PASS=y FELICITY_API_KEY=secret FELICITY_MODE=http node server.js &
FELICITY_API_KEY=secret npm run test:security
```

## Project structure

```
server.js          Server factory — exports createServer() + startServer(); run with node server.js
index.js           Public API — FelicityClient, createServer, startServer, HookStore, snapshot stores
src/
  hooks.js         Webhook store, SSRF validation, event delivery, per-event cooldowns
  compute.js       Health metric derivation
  enums.js         HealthStatus, HookEvent, TrendDirection
  snapshot.js      Intraday + daily snapshot persistence
  transform.js     Raw Felicity API → typed BatteryState
test/
  cache.test.js    MemoryCacheAdapter unit tests
  snapshot.test.js Snapshot store unit tests
  transform.test.js Battery data transform unit tests
  client.test.js   FelicityClient unit tests
  security.test.js Live HTTP security suite (auth, CORS, SSRF, rate limiting, webhooks)
```

## Three usage modes

| Mode | How | When |
|---|---|---|
| **stdio** | `npx fsolar-mcp` | Claude Code auto-launch; no persistent process |
| **HTTP** | `node server.js` | Persistent server for dashboards + multi-client SSE |
| **embedded** | `const { createServer, startServer } = require('mcp-fsolar')` | Inside another Node.js process |

Embedded mode example:

```js
const { startServer, FelicityClient, MemoryCacheAdapter, startPoller } = require('mcp-fsolar')
const client = new FelicityClient({ user, pass, cache: new MemoryCacheAdapter() })
const { url, setPollError, close } = await startServer(client, { port: 3010 })
startPoller(client)  // begins background health computation and snapshot storage
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
| `SNAPSHOT_DIR` | `os.tmpdir()` | Directory for snapshot + hook persistence |
