# mcp-fsolar — Review Findings & Fix Plan

Generated: 2026-07-01  
Source: Full code review of `server.js`, `src/client.js`, `src/hooks.js`, `src/compute.js`, `src/store.js`, `src/state.js`, `src/battery.js`, `src/http.js`, `src/cache.js`, `src/helpers.js`, `src/enums.js`

---

## Fix Groups

### Group 1 — Critical / High (Security + Correctness) ← **current**
| # | Finding | File(s) | Status |
|---|---|---|---|
| 1 | `/sse` and `/messages` bypass all auth and rate-limiting | `server.js:309` | ✅ done — rate-limit all paths; auth all except `GET /sse` |
| 2 | Dead `HookEvent` values — `LOW_SOC`, `FULL`, `ONLINE`, `OFFLINE` never fired | `src/hooks.js` | ✅ done — added SOC checks + ONLINE/OFFLINE transition tracking |
| 3 | `HookStore.add()` returns bare string instead of `{ id, ... }` | `src/hooks.js:97`, `server.js:343` | ✅ done — returns `{ id, url, events, createdAt }` |
| 4 | SSRF regex incomplete — misses IPv6 private, hex/octal IPv4 | `src/hooks.js:22` | ✅ done — extended regex + `_isPrivateHost()` helper |
| 5 | Rate limiter blind to reverse proxy (`X-Forwarded-For`) | `server.js:145` | ✅ done — `FELICITY_TRUST_PROXY=1` opt-in |

### Group 2 — Architecture
| # | Finding | File(s) | Status |
|---|---|---|---|
| 6 | `startPoller` intervals leak — not cleared on `close()` | `src/state.js:52` | ✅ done — returns `{ stop() }`; `main()` calls it on SIGTERM/SIGINT |
| 7 | `TOKEN_TTL_MS = 72h` stale token — no retry-on-401 | `src/http.js`, `src/client.js` | ✅ done — `_fetchAll` retries once on 401/403/auth-keyword responses |
| 8 | Singleton stores prevent safe multi-instance embedding | `src/store.js:132`, `src/hooks.js:186` | ✅ done — `createServer`, `startPoller`, `FelicityClient` all accept injected stores |
| 9 | `HookStore` reads disk on every `_load()` — no in-memory cache | `src/hooks.js` | ✅ done — `_hooks`/`_cooldowns` loaded once at construction, write-through on mutations |
| 10 | Snapshot file path object duplicated in GET + DELETE handlers | `server.js:365–393` | ✅ done — `_snapshotFile(store)` helper used in both handlers |
| 11 | Synchronous `fs.readFileSync` in HTTP request handlers | `server.js:373`, `src/hooks.js` | ✅ done — `GET /snapshots` uses `fs.promises.readFile` |

### Group 3 — Missing Features
| # | Finding | File(s) | Status |
|---|---|---|---|
| 12 | `get_health` MCP tool missing — `computeHealth()` not exposed | `server.js` | ✅ done — per-battery CRIT/WARN/OK labels, outliers, C-rate, discharge-delta |
| 13 | `get_autonomy` MCP tool missing — `computeAutonomy()` not exposed | `server.js` | ✅ done — hours to empty/full, SOC at sunrise, per-battery breakdown |
| 14 | `GET /health` liveness endpoint missing | `server.js` | ✅ done — 200/503, uptime, version, pollError; exempt from auth + rate-limit |
| 15 | Webhook retry + delivery log missing | `src/hooks.js` | ✅ done — `_httpPost()` transport; `_deliver()` retries 3× with 1s/2s backoff; 50-entry per-hook ring buffer; `GET /hooks/:id/deliveries` endpoint |
| 16 | Device list not paginated past 100 | `src/client.js:48` | ✅ done — paginate inner loop until page < PAGE_SIZE; auth-retry restarts from page 1 |

### Group 4 — Readability
| # | Finding | File(s) | Status |
|---|---|---|---|
| 17 | `createServer` is a 350-line monolith — extract middleware + router | `server.js` | ✅ done — `src/middleware.js` with `makeGetAllowedOrigin`, `makeCheckAuth`, `makeRateLimit`, `readBody`; removed `crypto` import from server.js |
| 18 | `_hmac` hardcoded key has no explanation | `server.js:121` | ✅ done (Group 1) |
| 19 | No structured logging — raw `console.log` strings | all | ✅ done — `src/logger.js` JSON-to-stderr; all console calls replaced; injectable via `createServer({logger})` |

---

## Detailed Findings

### 1 — `/sse` auth bypass (Critical)
`server.js:309`: `isMcpPath` skips both `checkRateLimit` and `checkAuth`. Any caller on the
network can open an SSE connection and invoke all MCP tools — live battery data — without a
key. Fix: apply auth/rate-limit to SSE too; skip only if `serverApiKey` is null (open mode).

### 2 — Dead HookEvent values (High)
`HookEvent` exposes `LOW_SOC`, `FULL`, `ONLINE`, `OFFLINE`. Users can subscribe via
`POST /hooks`. But `hookStore.fire()` never emits them — only CELL_DELTA, TEMP, SOH.
Registered hooks for these events are silently broken.
Fix:
- `LOW_SOC`: `bat.soc <= LOW_SOC_PCT` (env `FELICITY_LOW_SOC_PCT`, default 20)
- `FULL`: `bat.soc >= 100 && bat.chargingState === ChargingState.STANDBY`
- `ONLINE` / `OFFLINE`: track `_prevStatus` map by SN, fire on transition

### 3 — `add()` returns string not object (High)
`hooks.js:97` returns bare string `id`; `server.js:343` serialises it as `"abc123"`.
REST convention: 201 response should be `{ id, url, events, createdAt }` (secret omitted).
The security test already works around this with a string/object branch — that workaround
can be cleaned up once the fix lands.

### 4 — SSRF regex gaps (High)
`PRIVATE_HOST` regex misses:
- IPv6 link-local `fe80::` and private `fc00::/7`
- IPv4-mapped IPv6 `::ffff:127.0.0.1`
- Hex IPv4 `0x7f000001`
- Octal IPv4 `0177.0.0.1`
- Decimal-encoded IPv4 `2130706433`
Add secondary check: parse `parsed.hostname` after stripping brackets; reject if it matches
extended patterns.

### 5 — Rate limiter proxy blind spot (Medium)
`req.socket.remoteAddress` is always `127.0.0.1` behind nginx/Caddy.
Fix: when `FELICITY_TRUST_PROXY=1`, read first value of `X-Forwarded-For` header.
**Only enable when explicitly configured** — blindly trusting the header without the env var
would allow clients to spoof IPs to bypass the limiter.

### 6 — `startPoller` interval leak
`setInterval` handles are never returned. `close()` cannot stop the poller.
Fix: return `{ stop() { clearInterval(tickInterval); clearInterval(telemetryInterval); } }`
and call `stop()` inside `server.close()`.

### 7 — Stale token (72h TTL, no retry-on-401)
If the Felicity password rotates or token is revoked, the cached token is used for up to 3
days. Fix: catch `code !== 200` from a non-login upstream call, clear `this._token`, and
retry the login once before propagating.

### 8 — Singleton store coupling
Module-level singletons mean two embedded instances share one file. Fix: accept
`{ hookStore, snapshotStore }` in `createServer` opts, with singletons as defaults.

### 9 — HookStore disk reads on every operation
`fire()` calls `_load()` (hooks) + `_loadCooldowns()` synchronously on every poll tick.
Fix: keep `_hooks` and `_cooldowns` in memory; reload on construction; write-through on
mutations only.

### 10 — Duplicate snapshot file map
`files` object is copy-pasted in two adjacent handlers. Extract to a shared const.

### 11 — Sync file reads in HTTP handlers
`fs.readFileSync` in `GET /snapshots/:store` handler blocks the event loop.
Fix: `fs.promises.readFile` (handlers are already async).

### 12 — `get_health` MCP tool
Expose `computeHealth(batteries, snapshots)` per-battery: `cellDeltaStatus`, `tempStatus`,
`sohStatus`, `outliers` (weak cell indices), `avgCRate`, `dischargeDelta`.

### 13 — `get_autonomy` MCP tool
Expose `computeAutonomy(batteries, snapshots)`: `estimatedHours`, `estimatedHoursToFull`,
`estimatedSocAtSunrise`, per-battery breakdown.

### 14 — `GET /health` endpoint
Return `{ ok: true, uptime: process.uptime(), pollError, version }`.

### 15 — Webhook retry + delivery log
Retry failed deliveries up to 3× with exponential backoff (1s → 2s → 4s).
Add in-memory ring buffer of last 50 delivery results per hook; expose as
`GET /hooks/:id/deliveries`.

### 16 — Device pagination
`pageSize: 100` is hardcoded; a `console.warn` fires but no second page is fetched.
Fix: loop `pageNum++` while `dataList.length === pageSize`.

### 17 — Monolith `createServer`
Extract `src/middleware.js` (auth, rate-limit, CORS, readBody) and a minimal route
dispatcher. Each piece becomes independently testable.

### 18 — Unexplained `_hmac` key
Add comment: *"static key normalises input length for `timingSafeEqual`; the actual secret
is what's compared, not this key"*.

### 19 — Structured logging
Accept optional `logger` in `createServer` opts; default to `console`. Emit objects
`{ ts, level, msg, ...fields }` so log aggregators can parse them.
