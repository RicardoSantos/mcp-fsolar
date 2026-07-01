#!/usr/bin/env node
/**
 * Felicity Solar MCP + HTTP server.
 *
 * Three modes:
 *   stdio     →  launched by Claude Code / Claude Desktop / Cursor via command config
 *   HTTP      →  REST http://localhost:3010/batteries  +  MCP http://localhost:3010/sse
 *   embedded  →  required as a library; caller gets { httpServer, mcp, close } from createServer()
 *
 * Register with Claude Code (auto-launch, no separate process):
 *   claude mcp add felicity -e FELICITY_USER=you@example.com -e FELICITY_PASS=pass -- npx fsolar-mcp
 *
 * Or run as persistent server and connect via SSE:
 *   claude mcp add felicity --transport sse http://localhost:3010/sse
 *
 * Or embed programmatically:
 *   const { createServer, FelicityClient, MemoryCacheAdapter } = require('mcp-fsolar')
 *   const client = new FelicityClient({ user, pass, cache: new MemoryCacheAdapter() })
 *   const { httpServer, close } = createServer(client, { port: 3010 })
 *   httpServer.listen(3010)
 */

const http = require("http");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const { McpServer }            = require("@modelcontextprotocol/sdk/server/mcp.js");
const { SSEServerTransport }   = require("@modelcontextprotocol/sdk/server/sse.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z }                    = require("zod");

const { FelicityClient }                       = require("./src/client");
const { MemoryCacheAdapter }                   = require("./src/cache");
const { snapshotStore: _defaultSnapshotStore } = require("./src/store");
const { hookStore:     _defaultHookStore     } = require("./src/hooks");
const { startPoller }                          = require("./src/state");
const { computeHealth, computeAutonomy }       = require("./src/compute");
const { HealthStatus, TrendDirection }         = require("./src/enums");
const { createLogger, logger: _defaultLogger } = require("./src/logger");
const { makeGetAllowedOrigin, makeCheckAuth,
        makeRateLimit, readBody }              = require("./src/middleware");
const { version }                              = require("./package.json");

// ── Mode detection ────────────────────────────────────────────────────────────

const IS_STDIO = process.env.FELICITY_MODE === "http"  ? false
               : process.env.FELICITY_MODE === "stdio" ? true
               : !process.stdin.isTTY;

// ── .env loader ───────────────────────────────────────────────────────────────

function loadEnv() {
  for (const dir of [__dirname, process.cwd()]) {
    try {
      fs.readFileSync(path.join(dir, ".env"), "utf8").split("\n").forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return; // skip blanks and comments
        const eq = trimmed.indexOf("=");
        if (eq > 0) {
          const k = trimmed.slice(0, eq).trim();
          let v   = trimmed.slice(eq + 1).trim();
          // strip surrounding single or double quotes
          if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
            v = v.slice(1, -1);
          }
          if (!process.env[k]) process.env[k] = v;
        }
      });
      return;
    } catch { /* try next directory */ }
  }
}
loadEnv();

// ── Module-level helpers ──────────────────────────────────────────────────────

const _SNAPSHOT_MAP = { intraday: "battery-snapshots.json", daily: "battery-daily.json", state: "battery-state.json" };
function _snapshotFile(store) {
  const file = _SNAPSHOT_MAP[store];
  return file ? path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), file) : null;
}

// Wraps a string into the MCP tool content response shape.
const textContent = (text) => ({ content: [{ type: "text", text }] });

// ── Server factory ────────────────────────────────────────────────────────────

/**
 * Create a configured HTTP+MCP server instance without starting it.
 *
 * The returned `httpServer` is not yet listening — call `httpServer.listen(port)`
 * or use `startServer()` which does both in one step.
 *
 * After starting, call `startPoller(client)` from `./index.js` to begin background
 * health computation, snapshot storage, and webhook delivery.
 *
 * @param {object}  client             FelicityClient instance.
 * @param {object}  [opts]
 * @param {string}  [opts.apiKey]      HMAC-SHA256 bearer token required on REST endpoints.
 * @param {number}  [opts.rateLimit]   Max requests per minute per IP (0 = off). Default 60.
 * @param {string}  [opts.corsOrigin]   Fixed CORS origin (default: reflect localhost only).
 * @param {boolean} [opts.trustProxy]  Trust X-Forwarded-For for rate-limit IP. Only set when behind a trusted proxy.
 * @param {number}  [opts.port]        Port hint used in URL construction. Default 3010.
 * @returns {{ httpServer: import('http').Server, mcp: object, setPollError(err): void, close(): Promise<void> }}
 */
function createServer(client, opts = {}) {
  const {
    apiKey:     serverApiKey     = null,
    rateLimit:  serverRateLimit  = 60,
    corsOrigin: serverCorsOrigin = null,
    port:       serverPort       = 3010,
    trustProxy:    serverTrustProxy    = false,
    snapshotStore: serverSnapshotStore = _defaultSnapshotStore,
    hookStore:     serverHookStore     = _defaultHookStore,
    logger:        serverLogger        = _defaultLogger,
  } = opts;

  let pollError = null;

  function setPollError(errOrMsg) {
    pollError = errOrMsg ? (errOrMsg.message ?? String(errOrMsg)) : null;
  }

  // ── Middleware ────────────────────────────────────────────────────────────

  const getAllowedOrigin             = makeGetAllowedOrigin(serverCorsOrigin);
  const checkAuth                    = makeCheckAuth(serverApiKey);
  const { checkRateLimit, stopPurge} = makeRateLimit(serverRateLimit, serverTrustProxy);

  // ── MCP tools ─────────────────────────────────────────────────────────────

  const mcp = new McpServer({ name: "felicity-batteries", version });

  mcp.tool(
    "get_all_batteries",
    "Live status of all Felicity batteries: SOC, power, voltage, temperature, charging state.",
    {},
    async () => {
      const { batteries, fetchedAt, fromCache } = await client.getBatteries();
      if (!batteries.length) return textContent("No data yet.");
      const totalPower = batteries.reduce((s, b) => s + b.power, 0);
      const avgSoc     = Math.round(batteries.reduce((s, b) => s + b.soc, 0) / batteries.length);
      return textContent([
        `Fetched: ${fetchedAt}  (${fromCache ? "cache" : "live"})`,
        `Batteries: ${batteries.length}  Avg SOC: ${avgSoc}%  Total power: ${totalPower.toFixed(0)} W`,
        "",
        ...batteries.map((b) =>
          `${b.alias}  SOC ${b.soc}%  ${b.chargingState}  ${b.power} W\n` +
          `  ${b.voltage} V  ${b.current} A  ${b.tempMin}–${b.tempMax} °C  Δcell ${b.cellDelta} mV  ${b.remainingKwh} kWh left`
        ),
      ].join("\n"));
    }
  );

  mcp.tool(
    "get_battery",
    "Detailed status of one battery by alias (Bat1/Bat2/Bat3) or serial number.",
    { id: z.string().describe("Alias (Bat1/Bat2/Bat3) or serial number") },
    async ({ id }) => {
      const { battery, fetchedAt, fromCache } = await client.getBattery(id);
      if (!battery) return textContent(`Battery '${id}' not found.`);
      return textContent(JSON.stringify({ ...battery, fetchedAt, fromCache }, null, 2));
    }
  );

  mcp.tool(
    "get_cell_voltages",
    "Individual cell voltages (mV) for one battery. Useful for detecting cell imbalance.",
    { id: z.string().describe("Alias (Bat1/Bat2/Bat3) or serial number") },
    async ({ id }) => {
      const { battery } = await client.getBattery(id);
      if (!battery) return textContent(`Battery '${id}' not found.`);
      const lines = battery.cellVoltages.map((v, i) => `Cell ${String(i + 1).padStart(2, "0")}: ${v} mV`);
      lines.push(`\nMin ${battery.cellVoltageMin} mV  Max ${battery.cellVoltageMax} mV  Δ ${battery.cellDelta} mV`);
      return textContent(lines.join("\n"));
    }
  );

  mcp.tool(
    "get_fleet_summary",
    "Compact health summary: total energy, worst cell imbalance, temperatures.",
    {},
    async () => {
      const { batteries, fetchedAt, fromCache } = await client.getBatteries();
      if (!batteries.length) return textContent("No data yet.");
      const totalKwh   = batteries.reduce((s, b) => s + b.remainingKwh, 0);
      const totalPower = batteries.reduce((s, b) => s + b.power, 0);
      const cellDeltas = batteries.map((b) => b.cellDelta).filter((v) => v != null);
      const worstDelta = cellDeltas.length ? Math.max(...cellDeltas) : null;
      return textContent([
        `Total remaining: ${totalKwh.toFixed(2)} kWh`,
        `Total power: ${totalPower.toFixed(0)} W (${totalPower > 0 ? "charging" : "discharging"})`,
        `SOC: ${batteries.map((b) => `${b.alias}=${b.soc}%`).join("  ")}`,
        worstDelta != null ? `Worst cell delta: ${worstDelta} mV` : "Cell delta: N/A",
        `Max temp: ${Math.max(...batteries.map((b) => b.tempMax))} °C`,
        `Fetched: ${fetchedAt}  (${fromCache ? "cache" : "live"})`,
        pollError ? `[WARN] ${pollError}` : "",
      ].filter(Boolean).join("\n"));
    }
  );

  mcp.tool(
    "get_balance_trend",
    "Balance trend for batteries over the last ~60 min. Shows whether cell delta (mV spread) is improving, stable, or degrading.",
    { id: z.string().optional().describe("Alias (Bat1/Bat2/Bat3) or serial number; omit for all batteries") },
    async ({ id } = {}) => {
      const { batteries, trend } = await client.getBatteries();
      const arrow = (d) => d === TrendDirection.IMPROVING ? "↓" : d === TrendDirection.DEGRADING ? "↑" : "→";
      let entries;
      if (id) {
        const bat = batteries.find((b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id);
        if (!bat) return textContent(`Battery '${id}' not found.`);
        const t = trend[bat.sn];
        entries = t ? [[bat.alias, t]] : [];
      } else {
        entries = Object.entries(trend)
          .map(([sn, t]) => [batteries.find((b) => b.sn === sn)?.alias ?? sn, t]);
      }
      if (!entries.length)
        return textContent("No trend data yet — need at least 2 snapshots (~10 min apart).");
      const lines = entries.map(([name, t]) => {
        const sign = t.deltaChange > 0 ? "+" : "";
        const hist = t.history.slice(-4).join(" → ") + " mV";
        return `${name}  ${arrow(t.direction)} ${t.direction}  ${sign}${t.deltaChange} mV over ${t.snapshotCount} snapshots\n  history: ${hist}  (${t.balancingCount}× balancing active)`;
      });
      return textContent(lines.join("\n\n"));
    }
  );

  mcp.tool(
    "get_snapshots",
    "Raw battery pack snapshots for the last ~60 min (one per ~10 min). Includes cell voltages, delta, SOC, and balancing state.",
    {},
    async () => {
      const snapshots = serverSnapshotStore.getSnapshots();
      if (!snapshots.length)
        return textContent("No snapshots yet — first snapshot is taken on the next fresh API poll.");
      return textContent(JSON.stringify(snapshots, null, 2));
    }
  );

  mcp.tool(
    "get_health",
    "Per-battery health report: cell delta status, temperature status, SOH, weak/outlier cell indices, average C-rate, and discharge-phase delta.",
    { id: z.string().optional().describe("Alias (Bat1/Bat2/Bat3) or serial number; omit for all batteries") },
    async ({ id } = {}) => {
      const { batteries, fetchedAt, fromCache } = await client.getBatteries();
      const snapshots = serverSnapshotStore.getSnapshots();
      const health    = computeHealth(batteries, snapshots);
      const targets   = id
        ? batteries.filter((b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id)
        : batteries;
      if (!targets.length) return textContent(`Battery '${id}' not found.`);
      const label = (s) => s === HealthStatus.CRIT ? "CRIT" : s === HealthStatus.WARN ? "WARN" : s === HealthStatus.OK ? "OK" : "N/A";
      const lines = targets.map((bat) => {
        const h = health[bat.sn];
        if (!h) return `${bat.alias}  no health data`;
        return (
          `${bat.alias}  cellDelta: ${label(h.cellDeltaStatus)} (${h.cellDelta ?? "?"}mV)  temp: ${label(h.tempStatus)} (${h.tempMax ?? "?"}°C)  SOH: ${label(h.sohStatus)} (${h.soh ?? "?"}%)\n` +
          `  outliers: ${h.outliers.length ? `cell ${h.outliers.join(", ")}` : "none"}  avg C-rate: ${h.avgCRate ?? "N/A"}  discharge-delta: ${h.dischargeDelta != null ? `${h.dischargeDelta} mV` : "N/A"}`
        );
      });
      return textContent([`Fetched: ${fetchedAt}  (${fromCache ? "cache" : "live"})`, "", ...lines].join("\n"));
    }
  );

  mcp.tool(
    "get_autonomy",
    "Fleet autonomy estimate: hours until the pack hits minSoc, hours to full charge, and optional SOC projection at a given sunrise time.",
    {
      sunriseAt:       z.string().optional().describe("ISO timestamp of next sunrise — enables SOC-at-sunrise projection"),
      packCapacityKwh: z.number().optional().describe("Known total fleet capacity in kWh (improves accuracy when SOC is not 100%)"),
      minSocPct:       z.number().optional().describe("Discharge stop threshold in %. Default 5."),
    },
    async ({ sunriseAt, packCapacityKwh, minSocPct } = {}) => {
      const { batteries, fetchedAt, fromCache } = await client.getBatteries();
      const snapshots = serverSnapshotStore.getSnapshots();
      const autonomy  = computeAutonomy(batteries, snapshots, { sunriseAt, packCapacityKwh, minSocPct });
      const floor     = minSocPct ?? 5;
      const lines = [
        `Fetched: ${fetchedAt}  (${fromCache ? "cache" : "live"})`,
        "",
        `Total remaining: ${autonomy.totalRemainingKwh} kWh  Discharge rate: ${autonomy.dischargeRateKw} kW`,
        `Estimated hours until ${floor}% SOC: ${autonomy.estimatedHours} h`,
        autonomy.estimatedHoursToFull != null
          ? `Estimated hours to full: ${autonomy.estimatedHoursToFull} h`
          : "Estimated hours to full: N/A (not charging)",
        autonomy.estimatedSocAtSunrise != null
          ? `SOC at sunrise: ${autonomy.estimatedSocAtSunrise}%`
          : sunriseAt ? "SOC at sunrise: N/A" : "SOC at sunrise: provide sunriseAt param to enable",
        "",
        "Per battery:",
        ...autonomy.perBattery.map((b) =>
          `  ${b.alias}  ${b.remainingKwh} kWh  ~${b.estimatedHours} h until empty` +
          (b.estimatedHoursToFull != null ? `  ~${b.estimatedHoursToFull} h to full` : "")
        ),
      ];
      return textContent(lines.join("\n"));
    }
  );

  // ── HTTP server ────────────────────────────────────────────────────────────

  const sseTransports = new Map();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${serverPort}`);

    const allowedOrigin = getAllowedOrigin(req);
    if (allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // /health is exempt from rate-limiting and auth (used by k8s probes, load balancers).
    // /sse is exempt from auth only (SSE clients cannot easily send headers; rate-limited).
    // All other paths are rate-limited and auth-guarded.
    const isPublicPath = url.pathname === "/health" || url.pathname === "/sse";
    if (!isPublicPath && !checkRateLimit(req, res)) return;
    if (url.pathname !== "/health" && url.pathname !== "/sse" && !checkAuth(req, res)) return;

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        const httpStatus = pollError ? 503 : 200;
        res.writeHead(httpStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: !pollError, uptime: Math.floor(process.uptime()), version, pollError: pollError ?? null }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/batteries") {
        const result = await client.getBatteries();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...result, pollError }));
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/batteries/")) {
        const id     = url.pathname.slice("/batteries/".length);
        const result = await client.getBattery(id);
        if (!result.battery) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // ── Webhook subscriptions ───────────────────────────────────────────────

      if (req.method === "GET" && url.pathname === "/hooks") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(serverHookStore.list()));
        return;
      }

      if (req.method === "POST" && url.pathname === "/hooks") {
        const body = await readBody(req);
        try {
          const { url: hookUrl, events, secret } = JSON.parse(body);
          if (!hookUrl) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "url required" })); return; }
          const hook = serverHookStore.add({ url: hookUrl, events, secret });
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify(hook));
        } catch (e) {
          const status = e.statusCode ?? 400;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: status === 413 ? "request body too large" : (e.message || "invalid request") }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/hooks/") && url.pathname.endsWith("/deliveries")) {
        const id    = url.pathname.slice("/hooks/".length, -"/deliveries".length);
        const found = serverHookStore.list().some((h) => h.id === id);
        if (!found) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "hook not found" })); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(serverHookStore.getDeliveries(id)));
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/hooks/")) {
        const id = url.pathname.slice("/hooks/".length);
        const ok = serverHookStore.remove(id);
        res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok }));
        return;
      }

      // ── Snapshot download ───────────────────────────────────────────────────

      if (req.method === "GET" && url.pathname.startsWith("/snapshots/")) {
        const store = url.pathname.slice("/snapshots/".length);
        const file  = _snapshotFile(store);
        if (!file) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: `unknown store '${store}' — use intraday, daily or state` })); return; }
        try {
          const data = await fs.promises.readFile(file, "utf8");
          res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${store}.json"` });
          res.end(data);
        } catch { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "no data yet" })); }
        return;
      }

      // ── Snapshot reset ──────────────────────────────────────────────────────

      if (req.method === "DELETE" && url.pathname.startsWith("/snapshots/")) {
        const store    = url.pathname.slice("/snapshots/".length);
        const deletable = ["intraday", "daily"];
        const toDelete  = store === "all"
          ? deletable.map(_snapshotFile).filter(Boolean)
          : deletable.includes(store) ? [_snapshotFile(store)] : [];
        if (!toDelete.length) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: `unknown store '${store}' — use intraday, daily or all` })); return; }
        const deleted = [];
        for (const f of toDelete) { try { fs.unlinkSync(f); deleted.push(path.basename(f)); } catch { /* already gone */ } }
        serverLogger.info("snapshots reset", { deleted });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, deleted }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        sseTransports.set(transport.sessionId, transport);
        res.on("close", () => sseTransports.delete(transport.sessionId));
        await mcp.connect(transport);
        return;
      }

      if (req.method === "POST" && url.pathname === "/messages") {
        const sessionId = url.searchParams.get("sessionId");
        const transport = sseTransports.get(sessionId);
        if (!transport) { res.writeHead(404); res.end("Session not found"); return; }
        try {
          const body = await readBody(req);
          await transport.handlePostMessage(req, res, JSON.parse(body));
        } catch (e) {
          if (!res.headersSent) {
            const status = e.statusCode ?? 400;
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: status === 413 ? "request body too large" : "Invalid request" }));
          }
        }
        return;
      }

      res.writeHead(404); res.end("Not found");
    } catch (err) {
      serverLogger.error("request error", { method: req.method, path: url.pathname, err: err.message });
      if (!res.headersSent) {
        const status = err.statusCode ?? 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: status === 413 ? "request body too large" : err.message }));
      }
    }
  });

  function close() {
    stopPurge();
    return new Promise((resolve) => {
      httpServer.close(resolve);
      setTimeout(resolve, 5000).unref();
    });
  }

  return { httpServer, mcp, setPollError, close };
}

/**
 * Create and start an HTTP+MCP server for the given Felicity client.
 *
 * Resolves once the server is listening. Call `startPoller(client)` from
 * `./index.js` afterwards to begin background health + snapshot collection.
 *
 * @param {object}  client   FelicityClient instance.
 * @param {object}  [opts]
 * @param {number}  [opts.port]        Port to listen on. Default 3010.
 * @param {string}  [opts.apiKey]      REST bearer token (optional).
 * @param {number}  [opts.rateLimit]   Req/min per IP (0 = off). Default 60.
 * @param {string}  [opts.corsOrigin]  Fixed CORS origin (default: localhost only).
 * @returns {Promise<{ port: number, url: string, setPollError(err): void, close(): Promise<void> }>}
 */
async function startServer(client, opts = {}) {
  const port = opts.port ?? 3010;
  const { httpServer, setPollError, close } = createServer(client, { ...opts, port });
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, resolve);
  });
  return { port, url: `http://localhost:${port}`, setPollError, close };
}

module.exports = { createServer, startServer };

// ── Boot (standalone only) ────────────────────────────────────────────────────

async function main() {
  process.on("uncaughtException", (err) => {
    _defaultLogger.error("uncaught exception", { err: err.message, stack: err.stack });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    _defaultLogger.error("unhandled rejection", { reason: String(reason) });
  });

  if (!process.env.FELICITY_USER || !process.env.FELICITY_PASS) {
    _defaultLogger.error("missing credentials — set FELICITY_USER and FELICITY_PASS in .env or environment");
    process.exit(1);
  }

  const POLL_MS = parseInt(process.env.FELICITY_POLL_MS ?? "30000", 10);
  const PORT    = parseInt(process.env.FELICITY_PORT    ?? "3010",  10);

  const serverOpts = {
    apiKey:     process.env.FELICITY_API_KEY     || null,
    rateLimit:  parseInt(process.env.FELICITY_RATE_LIMIT ?? "60", 10),
    corsOrigin: process.env.FELICITY_CORS_ORIGIN ?? null,
    trustProxy: process.env.FELICITY_TRUST_PROXY === "1",
    port:       PORT,
  };

  const cache  = new MemoryCacheAdapter();
  const client = new FelicityClient({
    user: process.env.FELICITY_USER,
    pass: process.env.FELICITY_PASS,
    cache,
    ttl:  POLL_MS / 1000,
  });

  const { httpServer, mcp, setPollError, close } = createServer(client, serverOpts);

  async function poll() {
    try {
      const { batteries } = await client.getBatteries();
      setPollError(null);
      _defaultLogger.info("poll", { batteries: batteries.length, summary: batteries.map((b) => `${b.alias}=${b.soc}%`).join(" ") });
    } catch (err) {
      setPollError(err);
      _defaultLogger.error("poll error", { err: err.message });
    }
  }

  await poll();
  setInterval(poll, POLL_MS);
  const poller = startPoller(client);

  if (IS_STDIO) {
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
  } else {
    const shutdown = () => {
      _defaultLogger.info("shutting down");
      poller.stop();
      close().then(() => process.exit(0));
      setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT",  shutdown);

    httpServer.listen(PORT, () => {
      _defaultLogger.info("server started", { port: PORT, poll_s: POLL_MS / 1000, version });
    });
  }
}

if (require.main === module) {
  main().catch((err) => { _defaultLogger.error("startup failed", { err: err.message }); process.exit(1); });
}
