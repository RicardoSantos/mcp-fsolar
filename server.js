#!/usr/bin/env node
/**
 * Felicity Solar MCP + HTTP server.
 *
 * Two interfaces from one process:
 *   REST  →  http://localhost:3010/batteries
 *   MCP   →  http://localhost:3010/sse
 *
 * Register with Claude Code:
 *   claude mcp add felicity --transport sse http://localhost:3010/sse
 *
 * Start: node fsolar/server.js   (or: npm start inside fsolar/)
 */

const http = require("http");
const fs   = require("fs");
const path = require("path");
const { McpServer }          = require("@modelcontextprotocol/sdk/server/mcp.js");
const { SSEServerTransport }  = require("@modelcontextprotocol/sdk/server/sse.js");
const { z }                  = require("zod");
const { FelicityClient, MemoryCacheAdapter, snapshotStore, startPoller } = require("./index.js");

// ── Config ────────────────────────────────────────────────────────────────────

function loadEnv() {
  for (const dir of [__dirname, process.cwd()]) {
    try {
      fs.readFileSync(path.join(dir, ".env"), "utf8").split("\n").forEach((line) => {
        const eq = line.indexOf("=");
        if (eq > 0) {
          const k = line.slice(0, eq).trim();
          if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
        }
      });
      return;
    } catch { /* try next directory */ }
  }
}
loadEnv();

const PORT    = parseInt(process.env.FELICITY_PORT    ?? "3010");
const POLL_MS = parseInt(process.env.FELICITY_POLL_MS ?? "30000");

// ── Client + shared cache ─────────────────────────────────────────────────────

const cache  = new MemoryCacheAdapter();
const client = new FelicityClient({
  user:  process.env.FELICITY_USER,
  pass:  process.env.FELICITY_PASS,
  cache,
  ttl:   POLL_MS / 1000,
});

let pollError = null;

async function poll() {
  try {
    const { batteries } = await client.getBatteries();
    pollError = null;
    const summary = batteries.map((b) => `${b.alias} ${b.soc}% ${b.chargingState} ${b.power}W`).join(" | ");
    console.log(`[poll] ${new Date().toLocaleTimeString()} — ${summary}`);
  } catch (err) {
    pollError = err.message;
    console.error(`[poll] Error: ${err.message}`);
  }
}

// ── MCP tools ─────────────────────────────────────────────────────────────────

const mcp = new McpServer({ name: "felicity-batteries", version: "1.0.0" });

mcp.tool("get_all_batteries",
  "Live status of all Felicity batteries: SOC, power, voltage, temperature, charging state.",
  {},
  async () => {
    const { batteries, fetchedAt, fromCache } = await client.getBatteries();
    if (!batteries.length) return { content: [{ type: "text", text: "No data yet." }] };
    const totalPower = batteries.reduce((s, b) => s + b.power, 0);
    const avgSoc     = Math.round(batteries.reduce((s, b) => s + b.soc, 0) / batteries.length);
    const text = [
      `Fetched: ${fetchedAt}  (${fromCache ? "cache" : "live"})`,
      `Batteries: ${batteries.length}  Avg SOC: ${avgSoc}%  Total power: ${totalPower.toFixed(0)} W`,
      "",
      ...batteries.map((b) =>
        `${b.alias}  SOC ${b.soc}%  ${b.chargingState}  ${b.power} W\n` +
        `  ${b.voltage} V  ${b.current} A  ${b.tempMin}–${b.tempMax} °C  Δcell ${b.cellDelta} mV  ${b.remainingKwh} kWh left`
      ),
    ].join("\n");
    return { content: [{ type: "text", text }] };
  }
);

mcp.tool("get_battery",
  "Detailed status of one battery by alias (Bat1/Bat2/Bat3) or serial number.",
  { id: z.string().describe("Alias (Bat1/Bat2/Bat3) or serial number") },
  async ({ id }) => {
    const { battery, fetchedAt, fromCache } = await client.getBattery(id);
    if (!battery) return { content: [{ type: "text", text: `Battery '${id}' not found.` }] };
    return { content: [{ type: "text", text: JSON.stringify({ ...battery, fetchedAt, fromCache }, null, 2) }] };
  }
);

mcp.tool("get_cell_voltages",
  "Individual cell voltages (mV) for one battery. Useful for detecting cell imbalance.",
  { id: z.string().describe("Alias (Bat1/Bat2/Bat3) or serial number") },
  async ({ id }) => {
    const { battery } = await client.getBattery(id);
    if (!battery) return { content: [{ type: "text", text: `Battery '${id}' not found.` }] };
    const lines = battery.cellVoltages.map((v, i) => `Cell ${String(i + 1).padStart(2, "0")}: ${v} mV`);
    lines.push(`\nMin ${battery.cellVoltageMin} mV  Max ${battery.cellVoltageMax} mV  Δ ${battery.cellDelta} mV`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

mcp.tool("get_fleet_summary",
  "Compact health summary: total energy, worst cell imbalance, temperatures.",
  {},
  async () => {
    const { batteries, fetchedAt, fromCache } = await client.getBatteries();
    if (!batteries.length) return { content: [{ type: "text", text: "No data yet." }] };
    const totalKwh   = batteries.reduce((s, b) => s + b.remainingKwh, 0);
    const totalPower = batteries.reduce((s, b) => s + b.power, 0);
    const cellDeltas = batteries.map((b) => b.cellDelta).filter((v) => v != null);
    const worstDelta = cellDeltas.length ? Math.max(...cellDeltas) : null;
    const text = [
      `Total remaining: ${totalKwh.toFixed(2)} kWh`,
      `Total power: ${totalPower.toFixed(0)} W (${totalPower > 0 ? "charging" : "discharging"})`,
      `SOC: ${batteries.map((b) => `${b.alias}=${b.soc}%`).join("  ")}`,
      worstDelta != null ? `Worst cell delta: ${worstDelta} mV` : "Cell delta: N/A",
      `Max temp: ${Math.max(...batteries.map((b) => b.tempMax))} °C`,
      `Fetched: ${fetchedAt}  (${fromCache ? "cache" : "live"})`,
      pollError ? `⚠ ${pollError}` : "",
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

mcp.tool(
  "get_balance_trend",
  "Balance trend for batteries over the last ~60 min. Shows whether cell delta (mV spread) is improving, stable, or degrading.",
  { id: z.string().optional().describe("Alias (Bat1/Bat2/Bat3) or serial number; omit for all batteries") },
  async ({ id } = {}) => {
    const { batteries } = await client.getBatteries();
    const arrow = (d) => d === "improving" ? "↓" : d === "degrading" ? "↑" : "→";
    let entries;
    if (id) {
      const bat = batteries.find((b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id);
      if (!bat) return { content: [{ type: "text", text: `Battery '${id}' not found.` }] };
      const trend = snapshotStore.getTrend(bat.sn);
      entries = trend ? [[bat.alias, trend]] : [];
    } else {
      entries = Object.entries(snapshotStore.getAllTrends(batteries))
        .map(([sn, t]) => [batteries.find((b) => b.sn === sn)?.alias ?? sn, t]);
    }
    if (!entries.length)
      return { content: [{ type: "text", text: "No trend data yet — need at least 2 snapshots (~10 min apart)." }] };
    const lines = entries.map(([name, t]) => {
      const sign = t.deltaChange > 0 ? "+" : "";
      const hist = t.history.slice(-4).join(" → ") + " mV";
      return `${name}  ${arrow(t.direction)} ${t.direction}  ${sign}${t.deltaChange} mV over ${t.snapshotCount} snapshots\n  history: ${hist}  (${t.balancingCount}× balancing active)`;
    });
    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

mcp.tool(
  "get_snapshots",
  "Raw battery pack snapshots for the last ~60 min (one per ~10 min). Includes cell voltages, delta, SOC, and balancing state.",
  {},
  async () => {
    const snapshots = snapshotStore.getSnapshots();
    if (!snapshots.length)
      return { content: [{ type: "text", text: "No snapshots yet — first snapshot is taken on the next fresh API poll." }] };
    return { content: [{ type: "text", text: JSON.stringify(snapshots, null, 2) }] };
  }
);

// ── HTTP server ───────────────────────────────────────────────────────────────

const sseTransports = new Map();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  try {
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
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          await transport.handlePostMessage(req, res, JSON.parse(body));
        } catch (e) {
          if (!res.headersSent) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Invalid request" })); }
        }
      });
      return;
    }

    res.writeHead(404); res.end("Not found");
  } catch (err) {
    console.error(`[http] ${req.method} ${url.pathname} — ${err.message}`);
    if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: err.message })); }
  }
});

// ── Shutdown ──────────────────────────────────────────────────────────────────

function shutdown() {
  console.log("\n[fsolar] shutting down…");
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.FELICITY_USER || !process.env.FELICITY_PASS) {
    console.error("[fsolar] Missing credentials — set FELICITY_USER and FELICITY_PASS in .env or environment");
    process.exit(1);
  }
  console.log(`[fsolar] Felicity MCP + REST server — port ${PORT}  poll ${POLL_MS / 1000}s`);
  await poll();
  setInterval(poll, POLL_MS);
  startPoller(client);
  httpServer.listen(PORT, () => {
    console.log(`[fsolar] REST  http://localhost:${PORT}/batteries`);
    console.log(`[fsolar] MCP   http://localhost:${PORT}/sse`);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
