#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
exports.startServer = startServer;
exports.main = main;
const http_1 = __importDefault(require("http"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/server/sse.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const node_http2_1 = require("node:http2");
const client_1 = require("./src/client");
const cache_1 = require("./src/cache");
const store_1 = require("./src/store");
const hooks_1 = require("./src/hooks");
const state_1 = require("./src/state");
const compute_1 = require("./src/compute");
const enums_1 = require("./src/enums");
const logger_1 = require("./src/logger");
const middleware_1 = require("./src/middleware");
const errors_1 = require("./src/errors");
const { HTTP_STATUS_OK, HTTP_STATUS_CREATED, HTTP_STATUS_NO_CONTENT, HTTP_STATUS_BAD_REQUEST, HTTP_STATUS_NOT_FOUND, HTTP_STATUS_PAYLOAD_TOO_LARGE, HTTP_STATUS_INTERNAL_SERVER_ERROR, HTTP_STATUS_SERVICE_UNAVAILABLE, } = node_http2_1.constants;
// Resolve package.json: when running from source (__dirname = project root),
// package.json is at ./package.json; when running from dist/, it is at ../package.json.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const version = (() => {
    for (const p of [path_1.default.join(__dirname, "package.json"), path_1.default.join(__dirname, "../package.json")]) {
        if (fs_1.default.existsSync(p))
            return require(p).version;
    }
    return "0.0.0";
})();
// ── Mode detection ────────────────────────────────────────────────────────────
const IS_STDIO = process.env.FELICITY_MODE === "http" ? false
    : process.env.FELICITY_MODE === "stdio" ? true
        : !process.stdin.isTTY;
// ── .env loader ───────────────────────────────────────────────────────────────
function loadEnv() {
    for (const dir of [__dirname, process.cwd()]) {
        try {
            fs_1.default.readFileSync(path_1.default.join(dir, ".env"), "utf8").split("\n").forEach((line) => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#"))
                    return;
                const eq = trimmed.indexOf("=");
                if (eq > 0) {
                    const k = trimmed.slice(0, eq).trim();
                    let v = trimmed.slice(eq + 1).trim();
                    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
                        v = v.slice(1, -1);
                    }
                    if (!process.env[k])
                        process.env[k] = v;
                }
            });
            return;
        }
        catch { /* try next directory */ }
    }
}
loadEnv();
// ── Module-level helpers ──────────────────────────────────────────────────────
const _SNAPSHOT_MAP = {
    intraday: "battery-snapshots.json",
    daily: "battery-daily.json",
    state: "battery-state.json",
};
function _snapshotFile(store) {
    const file = _SNAPSHOT_MAP[store];
    return file ? path_1.default.join(process.env.SNAPSHOT_DIR ?? os_1.default.tmpdir(), file) : null;
}
const textContent = (text) => ({ content: [{ type: "text", text }] });
function sendJson(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}
function sendError(res, err) {
    if (res.headersSent)
        return;
    const status = err.statusCode ?? HTTP_STATUS_INTERNAL_SERVER_ERROR;
    const message = status === HTTP_STATUS_PAYLOAD_TOO_LARGE
        ? "request body too large"
        : (err.message || "internal server error");
    sendJson(res, status, { error: message });
}
// ── Server factory ────────────────────────────────────────────────────────────
function createServer(client, opts = {}) {
    const { apiKey: serverApiKey = null, rateLimit: serverRateLimit = 60, corsOrigin: serverCorsOrigin = null, port: serverPort = 3010, trustProxy: serverTrustProxy = false, snapshotStore: serverSnapshotStore = store_1.snapshotStore, hookStore: serverHookStore = hooks_1.hookStore, logger: serverLogger = logger_1.logger, } = opts;
    let pollError = null;
    function setPollError(errOrMsg) {
        pollError = errOrMsg
            ? (errOrMsg.message ?? String(errOrMsg))
            : null;
    }
    // ── Middleware ────────────────────────────────────────────────────────────
    const getAllowedOrigin = (0, middleware_1.makeGetAllowedOrigin)(serverCorsOrigin);
    const checkAuth = (0, middleware_1.makeCheckAuth)(serverApiKey);
    const { checkRateLimit, stopPurge } = (0, middleware_1.makeRateLimit)(serverRateLimit, serverTrustProxy);
    // ── MCP tools ─────────────────────────────────────────────────────────────
    const mcp = new mcp_js_1.McpServer({ name: "felicity-batteries", version });
    mcp.tool("get_all_batteries", "Live status of all Felicity batteries: SOC, power, voltage, temperature, charging state.", {}, async () => {
        const { batteries, fetchedAt, fromCache } = await client.getBatteries();
        if (!batteries.length)
            return textContent("No data yet.");
        const totalPower = batteries.reduce((s, b) => s + b.power, 0);
        const avgSoc = Math.round(batteries.reduce((s, b) => s + b.soc, 0) / batteries.length);
        return textContent([
            `Fetched: ${fetchedAt}  (${fromCache ? "cache" : "live"})`,
            `Batteries: ${batteries.length}  Avg SOC: ${avgSoc}%  Total power: ${totalPower.toFixed(0)} W`,
            "",
            ...batteries.map((b) => `${b.alias}  SOC ${b.soc}%  ${b.chargingState}  ${b.power} W\n` +
                `  ${b.voltage} V  ${b.current} A  ${b.tempMin}–${b.tempMax} °C  Δcell ${b.cellDelta} mV  ${b.remainingKwh} kWh left`),
        ].join("\n"));
    });
    mcp.tool("get_battery", "Detailed status of one battery by alias (Bat1/Bat2/Bat3) or serial number.", { id: zod_1.z.string().describe("Alias (Bat1/Bat2/Bat3) or serial number") }, async ({ id }) => {
        const { battery, fetchedAt, fromCache } = await client.getBattery(id);
        if (!battery)
            return textContent(`Battery '${id}' not found.`);
        return textContent(JSON.stringify({ ...battery, fetchedAt, fromCache }, null, 2));
    });
    mcp.tool("get_cell_voltages", "Individual cell voltages (mV) for one battery. Useful for detecting cell imbalance.", { id: zod_1.z.string().describe("Alias (Bat1/Bat2/Bat3) or serial number") }, async ({ id }) => {
        const { battery } = await client.getBattery(id);
        if (!battery)
            return textContent(`Battery '${id}' not found.`);
        const lines = battery.cellVoltages.map((v, i) => `Cell ${String(i + 1).padStart(2, "0")}: ${v} mV`);
        lines.push(`\nMin ${battery.cellVoltageMin} mV  Max ${battery.cellVoltageMax} mV  Δ ${battery.cellDelta} mV`);
        return textContent(lines.join("\n"));
    });
    mcp.tool("get_fleet_summary", "Compact health summary: total energy, worst cell imbalance, temperatures.", {}, async () => {
        const { batteries, fetchedAt, fromCache } = await client.getBatteries();
        if (!batteries.length)
            return textContent("No data yet.");
        const totalKwh = batteries.reduce((s, b) => s + b.remainingKwh, 0);
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
    });
    mcp.tool("get_balance_trend", "Balance trend for batteries over the last ~60 min. Shows whether cell delta (mV spread) is improving, stable, or degrading.", { id: zod_1.z.string().optional().describe("Alias (Bat1/Bat2/Bat3) or serial number; omit for all batteries") }, async ({ id }) => {
        const { batteries, trend } = await client.getBatteries();
        const arrow = (d) => d === enums_1.TrendDirection.IMPROVING ? "↓" : d === enums_1.TrendDirection.DEGRADING ? "↑" : "→";
        let entries;
        if (id) {
            const bat = batteries.find((b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id);
            if (!bat)
                return textContent(`Battery '${id}' not found.`);
            const t = trend[bat.sn];
            entries = t ? [[bat.alias, t]] : [];
        }
        else {
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
    });
    mcp.tool("get_snapshots", "Raw battery pack snapshots for the last ~60 min (one per ~10 min). Includes cell voltages, delta, SOC, and balancing state.", {}, async () => {
        const snapshots = serverSnapshotStore.getSnapshots();
        if (!snapshots.length)
            return textContent("No snapshots yet — first snapshot is taken on the next fresh API poll.");
        return textContent(JSON.stringify(snapshots, null, 2));
    });
    mcp.tool("get_health", "Per-battery health report: cell delta status, temperature status, SOH, weak/outlier cell indices, average C-rate, and discharge-phase delta.", { id: zod_1.z.string().optional().describe("Alias (Bat1/Bat2/Bat3) or serial number; omit for all batteries") }, async ({ id }) => {
        const { batteries, fetchedAt, fromCache } = await client.getBatteries();
        const snapshots = serverSnapshotStore.getSnapshots();
        const health = (0, compute_1.computeHealth)(batteries, snapshots);
        const targets = id
            ? batteries.filter((b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id)
            : batteries;
        if (!targets.length)
            return textContent(`Battery '${id}' not found.`);
        const label = (s) => s === enums_1.HealthStatus.CRIT ? "CRIT" : s === enums_1.HealthStatus.WARN ? "WARN" : s === enums_1.HealthStatus.OK ? "OK" : "N/A";
        const lines = targets.map((bat) => {
            const h = health[bat.sn];
            if (!h)
                return `${bat.alias}  no health data`;
            return (`${bat.alias}  cellDelta: ${label(h.cellDeltaStatus)} (${h.cellDelta ?? "?"}mV)  temp: ${label(h.tempStatus)} (${h.tempMax ?? "?"}°C)  SOH: ${label(h.sohStatus)} (${h.soh ?? "?"}%)\n` +
                `  outliers: ${h.outliers.length ? `cell ${h.outliers.join(", ")}` : "none"}  avg C-rate: ${h.avgCRate ?? "N/A"}  discharge-delta: ${h.dischargeDelta != null ? `${h.dischargeDelta} mV` : "N/A"}`);
        });
        return textContent([`Fetched: ${fetchedAt}  (${fromCache ? "cache" : "live"})`, "", ...lines].join("\n"));
    });
    mcp.tool("get_autonomy", "Fleet autonomy estimate: hours until the pack hits minSoc, hours to full charge, and optional SOC projection at a given sunrise time.", {
        sunriseAt: zod_1.z.string().optional().describe("ISO timestamp of next sunrise — enables SOC-at-sunrise projection"),
        packCapacityKwh: zod_1.z.number().optional().describe("Known total fleet capacity in kWh (improves accuracy when SOC is not 100%)"),
        minSocPct: zod_1.z.number().optional().describe("Discharge stop threshold in %. Default 5."),
    }, async ({ sunriseAt, packCapacityKwh, minSocPct }) => {
        const { batteries, fetchedAt, fromCache } = await client.getBatteries();
        const snapshots = serverSnapshotStore.getSnapshots();
        const autonomy = (0, compute_1.computeAutonomy)(batteries, snapshots, { sunriseAt, packCapacityKwh, minSocPct });
        const floor = minSocPct ?? 5;
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
            ...autonomy.perBattery.map((b) => `  ${b.alias}  ${b.remainingKwh} kWh  ~${b.estimatedHours} h until empty` +
                (b.estimatedHoursToFull != null ? `  ~${b.estimatedHoursToFull} h to full` : "")),
        ];
        return textContent(lines.join("\n"));
    });
    // ── HTTP server ────────────────────────────────────────────────────────────
    const sseTransports = new Map();
    const httpServer = http_1.default.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", `http://localhost:${serverPort}`);
        const allowedOrigin = getAllowedOrigin(req);
        if (allowedOrigin) {
            res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
            res.setHeader("Vary", "Origin");
        }
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "OPTIONS") {
            res.writeHead(HTTP_STATUS_NO_CONTENT);
            res.end();
            return;
        }
        if (url.pathname !== "/health" && !checkRateLimit(req, res))
            return;
        if (url.pathname !== "/health" && url.pathname !== "/sse" && !checkAuth(req, res))
            return;
        try {
            if (req.method === "GET" && url.pathname === "/health") {
                const status = pollError ? HTTP_STATUS_SERVICE_UNAVAILABLE : HTTP_STATUS_OK;
                sendJson(res, status, { ok: !pollError, uptime: Math.floor(process.uptime()), version, pollError: pollError ?? null });
                return;
            }
            if (req.method === "GET" && url.pathname === "/batteries") {
                const result = await client.getBatteries();
                sendJson(res, HTTP_STATUS_OK, { ...result, pollError });
                return;
            }
            if (req.method === "GET" && url.pathname.startsWith("/batteries/")) {
                const id = url.pathname.slice("/batteries/".length);
                const result = await client.getBattery(id);
                if (!result.battery) {
                    sendJson(res, HTTP_STATUS_NOT_FOUND, { error: "not found" });
                    return;
                }
                sendJson(res, HTTP_STATUS_OK, result);
                return;
            }
            if (req.method === "GET" && url.pathname === "/hooks") {
                sendJson(res, HTTP_STATUS_OK, serverHookStore.list());
                return;
            }
            if (req.method === "POST" && url.pathname === "/hooks") {
                const body = await (0, middleware_1.readBody)(req);
                let parsed;
                try {
                    parsed = JSON.parse(body);
                }
                catch {
                    throw new errors_1.AppError("invalid JSON body", HTTP_STATUS_BAD_REQUEST);
                }
                const { url: hookUrl, events, secret } = parsed;
                if (!hookUrl) {
                    sendJson(res, HTTP_STATUS_BAD_REQUEST, { error: "url required" });
                    return;
                }
                sendJson(res, HTTP_STATUS_CREATED, serverHookStore.add({ url: hookUrl, events, secret }));
                return;
            }
            if (req.method === "GET" && url.pathname.startsWith("/hooks/") && url.pathname.endsWith("/deliveries")) {
                const id = url.pathname.slice("/hooks/".length, -"/deliveries".length);
                const found = serverHookStore.list().some((h) => h.id === id);
                if (!found) {
                    sendJson(res, HTTP_STATUS_NOT_FOUND, { error: "hook not found" });
                    return;
                }
                sendJson(res, HTTP_STATUS_OK, serverHookStore.getDeliveries(id));
                return;
            }
            if (req.method === "DELETE" && url.pathname.startsWith("/hooks/")) {
                const id = url.pathname.slice("/hooks/".length);
                const ok = serverHookStore.remove(id);
                sendJson(res, ok ? HTTP_STATUS_OK : HTTP_STATUS_NOT_FOUND, { ok });
                return;
            }
            if (req.method === "GET" && url.pathname.startsWith("/snapshots/")) {
                const store = url.pathname.slice("/snapshots/".length);
                const file = _snapshotFile(store);
                if (!file) {
                    sendJson(res, HTTP_STATUS_NOT_FOUND, { error: `unknown store '${store}' — use intraday, daily or state` });
                    return;
                }
                try {
                    const data = await fs_1.default.promises.readFile(file, "utf8");
                    res.writeHead(HTTP_STATUS_OK, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${store}.json"` });
                    res.end(data);
                }
                catch {
                    sendJson(res, HTTP_STATUS_NOT_FOUND, { error: "no data yet" });
                }
                return;
            }
            if (req.method === "DELETE" && url.pathname.startsWith("/snapshots/")) {
                const store = url.pathname.slice("/snapshots/".length);
                const deletable = ["intraday", "daily"];
                const toDelete = store === "all"
                    ? deletable.map(_snapshotFile).filter((f) => f !== null)
                    : deletable.includes(store) ? [_snapshotFile(store)].filter((f) => f !== null) : [];
                if (!toDelete.length) {
                    sendJson(res, HTTP_STATUS_NOT_FOUND, { error: `unknown store '${store}' — use intraday, daily or all` });
                    return;
                }
                const deleted = [];
                for (const f of toDelete) {
                    try {
                        await fs_1.default.promises.unlink(f);
                        deleted.push(path_1.default.basename(f));
                    }
                    catch { /* already gone */ }
                }
                serverLogger.info("snapshots reset", { deleted });
                sendJson(res, HTTP_STATUS_OK, { ok: true, deleted });
                return;
            }
            if (req.method === "GET" && url.pathname === "/sse") {
                const transport = new sse_js_1.SSEServerTransport("/messages", res);
                sseTransports.set(transport.sessionId, transport);
                res.on("close", () => sseTransports.delete(transport.sessionId));
                await mcp.connect(transport);
                return;
            }
            if (req.method === "POST" && url.pathname === "/messages") {
                const sessionId = url.searchParams.get("sessionId");
                const transport = sessionId ? sseTransports.get(sessionId) : undefined;
                if (!transport) {
                    res.writeHead(HTTP_STATUS_NOT_FOUND);
                    res.end("Session not found");
                    return;
                }
                const body = await (0, middleware_1.readBody)(req);
                let parsed;
                try {
                    parsed = JSON.parse(body);
                }
                catch {
                    throw new errors_1.AppError("invalid JSON body", HTTP_STATUS_BAD_REQUEST);
                }
                await transport.handlePostMessage(req, res, parsed);
                return;
            }
            res.writeHead(HTTP_STATUS_NOT_FOUND);
            res.end("Not found");
        }
        catch (err) {
            serverLogger.error("request error", { method: req.method, path: url.pathname, err: err.message });
            sendError(res, err);
        }
    });
    function close() {
        stopPurge();
        return new Promise((resolve) => {
            httpServer.close(() => resolve());
            setTimeout(resolve, 5000).unref();
        });
    }
    return { httpServer, mcp, setPollError, close };
}
async function startServer(client, opts = {}) {
    const port = opts.port ?? 3010;
    const { httpServer, setPollError, close } = createServer(client, { ...opts, port });
    await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, resolve);
    });
    return { port, url: `http://localhost:${port}`, setPollError, close };
}
// ── Boot (standalone only) ────────────────────────────────────────────────────
async function main() {
    process.on("uncaughtException", (err) => {
        logger_1.logger.error("uncaught exception", { err: err.message, stack: err.stack });
        process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
        logger_1.logger.error("unhandled rejection", { reason: String(reason) });
    });
    if (!process.env.FELICITY_USER || !process.env.FELICITY_PASS) {
        logger_1.logger.error("missing credentials — set FELICITY_USER and FELICITY_PASS in .env or environment");
        process.exit(1);
    }
    const POLL_MS = parseInt(process.env.FELICITY_POLL_MS ?? "30000", 10);
    const PORT = parseInt(process.env.FELICITY_PORT ?? "3010", 10);
    const serverOpts = {
        apiKey: process.env.FELICITY_API_KEY || null,
        rateLimit: parseInt(process.env.FELICITY_RATE_LIMIT ?? "60", 10),
        corsOrigin: process.env.FELICITY_CORS_ORIGIN ?? null,
        trustProxy: process.env.FELICITY_TRUST_PROXY === "1",
        port: PORT,
    };
    const cache = new cache_1.MemoryCacheAdapter();
    const client = new client_1.FelicityClient({
        user: process.env.FELICITY_USER,
        pass: process.env.FELICITY_PASS,
        cache,
        ttl: POLL_MS / 1000,
    });
    const { httpServer, mcp, setPollError, close } = createServer(client, serverOpts);
    async function poll() {
        try {
            const { batteries } = await client.getBatteries();
            setPollError(null);
            logger_1.logger.info("poll", { batteries: batteries.length, summary: batteries.map((b) => `${b.alias}=${b.soc}%`).join(" ") });
        }
        catch (err) {
            setPollError(err);
            logger_1.logger.error("poll error", { err: err.message });
        }
    }
    await poll();
    setInterval(poll, POLL_MS);
    const poller = (0, state_1.startPoller)(client);
    if (IS_STDIO) {
        const transport = new stdio_js_1.StdioServerTransport();
        await mcp.connect(transport);
    }
    else {
        const shutdown = () => {
            logger_1.logger.info("shutting down");
            poller.stop();
            close().then(() => process.exit(0));
            setTimeout(() => process.exit(1), 5000).unref();
        };
        process.on("SIGTERM", shutdown);
        process.on("SIGINT", shutdown);
        httpServer.listen(PORT, () => {
            logger_1.logger.info("server started", { port: PORT, poll_s: POLL_MS / 1000, version });
        });
    }
}
if (require.main === module) {
    main().catch((err) => {
        logger_1.logger.error("startup failed", { err: err.message });
        process.exit(1);
    });
}
