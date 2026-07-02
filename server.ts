#!/usr/bin/env node
import http from "http";
import fs   from "fs";
import path from "path";
import os   from "os";

import { McpServer }            from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport }   from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z }                    from "zod";
import { constants }            from "node:http2";

import { FelicityClient }                       from "./src/client";
import { CELLS_PER_MODULE }                     from "./src/battery";
import { MemoryCacheAdapter }                   from "./src/cache";
import { snapshotStore as _defaultSnapshotStore,
         dailyEnergyStore as _defaultDailyEnergyStore } from "./src/store";
import { hookStore     as _defaultHookStore     } from "./src/hooks";
import { startPoller, snapshotEmitter, readState } from "./src/state";
import { computeHealth, computeAutonomy }         from "./src/compute";
import { computeAlerts, computeEnergyHistory,
         computeCellStats, computePowerStats }   from "./src/analyze";
import { HealthStatus, TrendDirection }           from "./src/enums";
import { createLogger, logger as _defaultLogger, type Logger } from "./src/logger";
import { makeGetAllowedOrigin, makeCheckAuth,
         makeRateLimit, readBody }               from "./src/middleware";
import { AppError }                              from "./src/errors";
import type { BatterySnapshotStore, DailyEnergyStore } from "./src/store";
import type { HookStore }                              from "./src/hooks";

const {
  HTTP_STATUS_OK, HTTP_STATUS_CREATED, HTTP_STATUS_NO_CONTENT,
  HTTP_STATUS_BAD_REQUEST, HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
} = constants;

// Resolve package.json: when running from source (__dirname = project root),
// package.json is at ./package.json; when running from dist/, it is at ../package.json.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const version: string = (() => {
  for (const p of [path.join(__dirname, "package.json"), path.join(__dirname, "../package.json")]) {
    if (fs.existsSync(p)) return (require(p) as { version: string }).version;
  }
  return "0.0.0";
})();

// ── Mode detection ────────────────────────────────────────────────────────────

const IS_STDIO = process.env.FELICITY_MODE === "http"  ? false
               : process.env.FELICITY_MODE === "stdio" ? true
               : !process.stdin.isTTY;

// ── .env loader ───────────────────────────────────────────────────────────────

function loadEnv(): void {
  for (const dir of [__dirname, process.cwd()]) {
    try {
      fs.readFileSync(path.join(dir, ".env"), "utf8").split("\n").forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const eq = trimmed.indexOf("=");
        if (eq > 0) {
          const k = trimmed.slice(0, eq).trim();
          let v   = trimmed.slice(eq + 1).trim();
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

const _SNAPSHOT_MAP: Record<string, string> = {
  intraday: "battery-snapshots.json",
  daily:    "battery-daily.json",
  state:    "battery-state.json",
};

function _snapshotFile(store: string): string | null {
  const file = _SNAPSHOT_MAP[store];
  return file ? path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), file) : null;
}

const textContent = (text: string): { content: Array<{ type: "text"; text: string }> } =>
  ({ content: [{ type: "text", text }] });

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: http.ServerResponse, err: Error & { statusCode?: number }): void {
  if (res.headersSent) return;
  const status  = err.statusCode ?? HTTP_STATUS_INTERNAL_SERVER_ERROR;
  const message = status === HTTP_STATUS_PAYLOAD_TOO_LARGE
    ? "request body too large"
    : (err.message || "internal server error");
  sendJson(res, status, { error: message });
}

const LFP_NOMINAL_CYCLES = 4000;

// ── Public types ──────────────────────────────────────────────────────────────

export interface ServerOptions {
  apiKey?:           string | null;
  rateLimit?:        number;
  corsOrigin?:       string | null;
  trustProxy?:       boolean;
  port?:             number;
  snapshotStore?:    BatterySnapshotStore;
  dailyEnergyStore?: DailyEnergyStore;
  hookStore?:        HookStore;
  logger?:           Logger;
}

export interface ServerResult {
  httpServer:    http.Server;
  mcp:           InstanceType<typeof McpServer>;
  setPollError(err: Error | string | null): void;
  close():       Promise<void>;
}

// ── Server factory ────────────────────────────────────────────────────────────

export function createServer(client: FelicityClient, opts: ServerOptions = {}): ServerResult {
  const {
    apiKey:           serverApiKey           = null,
    rateLimit:        serverRateLimit        = 60,
    corsOrigin:       serverCorsOrigin       = null,
    port:             serverPort             = 3010,
    trustProxy:       serverTrustProxy       = false,
    snapshotStore:    serverSnapshotStore    = _defaultSnapshotStore,
    dailyEnergyStore: serverDailyEnergyStore = _defaultDailyEnergyStore,
    hookStore:        serverHookStore        = _defaultHookStore,
    logger:           serverLogger           = _defaultLogger,
  } = opts;

  let pollError: string | null = null;

  function setPollError(errOrMsg: Error | string | null): void {
    pollError = errOrMsg
      ? ((errOrMsg as Error).message ?? String(errOrMsg))
      : null;
  }

  // ── Middleware ────────────────────────────────────────────────────────────

  const getAllowedOrigin               = makeGetAllowedOrigin(serverCorsOrigin);
  const checkAuth                     = makeCheckAuth(serverApiKey);
  const { checkRateLimit, stopPurge } = makeRateLimit(serverRateLimit, serverTrustProxy);

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
      const cellDeltas = batteries.map((b) => b.cellDelta).filter((v): v is number => v != null);
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
    async ({ id }) => {
      const { batteries, trend } = await client.getBatteries();
      const arrow = (d: string): string =>
        d === TrendDirection.IMPROVING ? "↓" : d === TrendDirection.DEGRADING ? "↑" : "→";
      let entries: Array<[string, (typeof trend)[string]]>;
      if (id) {
        const bat = batteries.find((b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id);
        if (!bat) return textContent(`Battery '${id}' not found.`);
        const t = trend[bat.sn];
        entries = t ? [[bat.alias, t]] : [];
      } else {
        entries = Object.entries(trend)
          .map(([sn, t]) => [batteries.find((b) => b.sn === sn)?.alias ?? sn, t] as [string, (typeof trend)[string]]);
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
    async ({ id }) => {
      const { batteries, fetchedAt, fromCache } = await client.getBatteries();
      const snapshots = serverSnapshotStore.getSnapshots();
      const health    = computeHealth(batteries, snapshots);
      const targets   = id
        ? batteries.filter((b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id)
        : batteries;
      if (!targets.length) return textContent(`Battery '${id}' not found.`);
      const label = (s: string | null): string =>
        s === HealthStatus.CRIT ? "CRIT" : s === HealthStatus.WARN ? "WARN" : s === HealthStatus.OK ? "OK" : "N/A";
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
    async ({ sunriseAt, packCapacityKwh, minSocPct }) => {
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

  mcp.tool(
    "get_alerts",
    "Active alert list ranked by severity. Checks cell imbalance, temperature, SOH, outlier cells, BMS warnings, under-voltage events, and data staleness.",
    { id: z.string().optional().describe("Alias (Bat1/Bat2/Bat3) or serial number; omit for all batteries") },
    async ({ id }) => {
      const { batteries } = await client.getBatteries();
      const snapshots  = serverSnapshotStore.getSnapshots();
      const health     = computeHealth(batteries, snapshots);
      const targets    = id
        ? batteries.filter((b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id)
        : batteries;
      if (id && !targets.length) return textContent(`Battery '${id}' not found.`);
      const alerts = computeAlerts(targets, health);
      if (!alerts.length) return textContent("No active alerts.");
      return textContent(alerts.map((a) => `[${a.severity.toUpperCase()}] ${a.battery}  ${a.code}: ${a.message}`).join("\n"));
    }
  );

  mcp.tool(
    "get_energy_history",
    "Daily charge/discharge energy totals (kWh) — up to 90 days from persistent store, merged with live intraday data. Shows peak rates and net balance.",
    {},
    async () => {
      const live      = computeEnergyHistory(serverSnapshotStore.getSnapshots());
      const persisted = serverDailyEnergyStore.get();
      const merged    = new Map([...persisted, ...live].map((e) => [e.date, e]));
      const history   = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
      if (!history.length) return textContent("Not enough snapshots for energy history (need at least 2 readings ~10 min apart).");
      const lines = history.map((d) =>
        `${d.date}  ↑${d.kwhCharged} kWh  ↓${d.kwhDischarged} kWh  net ${d.kwhNet >= 0 ? "+" : ""}${d.kwhNet} kWh` +
        `  peak ↑${d.peakChargeKw} kW ↓${d.peakDischargeKw} kW  (${d.snapshotCount} samples)`
      );
      return textContent(lines.join("\n"));
    }
  );

  mcp.tool(
    "get_cell_stats",
    "Per-cell voltage statistics from intraday snapshots: mean, stddev, min/max, deviation from pack average, and trend direction.",
    { id: z.string().describe("Alias (Bat1/Bat2/Bat3) or serial number") },
    async ({ id }) => {
      const { batteries } = await client.getBatteries();
      const bat = batteries.find((b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id);
      if (!bat) return textContent(`Battery '${id}' not found.`);
      const snapshots = serverSnapshotStore.getSnapshots();
      const stats     = computeCellStats(snapshots, bat.sn);
      if (!stats.length) return textContent("Not enough snapshots for cell statistics (need at least 2 readings).");
      const lines = stats.map((c) =>
        `Cell ${String(c.cell).padStart(2, "0")} (M${c.module})  mean ${c.mean} mV  σ ${c.stddev}  ` +
        `range ${c.min}–${c.max} mV  dev ${c.meanDeviation >= 0 ? "+" : ""}${c.meanDeviation} mV  ${c.trend}`
      );
      return textContent(lines.join("\n"));
    }
  );

  mcp.tool(
    "get_module_health",
    "Per-module voltage aggregates (min/max/mean/delta) for one battery using live cell voltages. Flags modules containing persistent outlier cells.",
    { id: z.string().describe("Alias (Bat1/Bat2/Bat3) or serial number") },
    async ({ id }) => {
      const { batteries } = await client.getBatteries();
      const bat = batteries.find((b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id);
      if (!bat) return textContent(`Battery '${id}' not found.`);
      const snapshots  = serverSnapshotStore.getSnapshots();
      const health     = computeHealth(batteries, snapshots);
      const h          = health[bat.sn];
      const outlierSet = new Set(h?.outliers ?? []);
      const moduleMap  = new Map<number, number[]>();
      bat.cellVoltages.forEach((v, i) => {
        const mod = Math.ceil((i + 1) / CELLS_PER_MODULE);
        if (!moduleMap.has(mod)) moduleMap.set(mod, []);
        moduleMap.get(mod)!.push(v);
      });
      const lines = [...moduleMap.entries()].map(([mod, vs]) => {
        const min   = Math.min(...vs);
        const max   = Math.max(...vs);
        const mean  = Math.round(vs.reduce((s, v) => s + v, 0) / vs.length);
        const start = (mod - 1) * CELLS_PER_MODULE + 1;
        const hasOutlier = vs.some((_, i) => outlierSet.has(start + i));
        return `Module ${mod}  min ${min} mV  max ${max} mV  mean ${mean} mV  delta ${max - min} mV${hasOutlier ? "  [OUTLIER]" : ""}`;
      });
      return textContent([`${bat.alias}  ${bat.cellVoltages.length} cells  ${moduleMap.size} modules`, "", ...lines].join("\n"));
    }
  );

  mcp.tool(
    "get_limit_headroom",
    "Headroom between current voltage/current and BMS protection limits. Useful for spotting packs running close to cutoff thresholds.",
    { id: z.string().optional().describe("Alias (Bat1/Bat2/Bat3) or serial number; omit for all batteries") },
    async ({ id }) => {
      const { batteries } = await client.getBatteries();
      const targets = id
        ? batteries.filter((b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id)
        : batteries;
      if (id && !targets.length) return textContent(`Battery '${id}' not found.`);
      const lines = targets.map((bat) => {
        const cvRoom  = bat.chargeVoltLimit    != null ? (bat.chargeVoltLimit    - bat.voltage).toFixed(1) : "N/A";
        const dvRoom  = bat.dischargeVoltLimit != null ? (bat.voltage - bat.dischargeVoltLimit).toFixed(1) : "N/A";
        const ccRoom  = bat.chargeCurrLimit    != null ? (bat.chargeCurrLimit    - Math.abs(bat.current)).toFixed(1) : "N/A";
        const dcRoom  = bat.dischargeCurrLimit != null ? (bat.dischargeCurrLimit - Math.abs(bat.current)).toFixed(1) : "N/A";
        return (
          `${bat.alias}  V=${bat.voltage} V  I=${bat.current} A\n` +
          `  charge volt headroom: ${cvRoom} V  discharge volt headroom: ${dvRoom} V\n` +
          `  charge curr headroom: ${ccRoom} A  discharge curr headroom: ${dcRoom} A`
        );
      });
      return textContent(lines.join("\n\n"));
    }
  );

  mcp.tool(
    "get_lifetime_stats",
    "Cycle count, full-charge events, under-voltage events, warning count, and projected remaining LFP cycle life (nominal 4000 cycles).",
    { id: z.string().optional().describe("Alias (Bat1/Bat2/Bat3) or serial number; omit for all batteries") },
    async ({ id }) => {
      const { batteries } = await client.getBatteries();
      const targets = id
        ? batteries.filter((b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id)
        : batteries;
      if (id && !targets.length) return textContent(`Battery '${id}' not found.`);
      const lines = targets.map((bat) => {
        const cycles    = bat.batCycleIndex ?? 0;
        const pct       = Math.round(cycles / LFP_NOMINAL_CYCLES * 100);
        const remaining = LFP_NOMINAL_CYCLES - cycles;
        return (
          `${bat.alias}\n` +
          `  Cycles used: ${cycles} / ${LFP_NOMINAL_CYCLES} (${pct}%)\n` +
          `  Cycles remaining (est.): ${remaining}\n` +
          `  Full charges: ${bat.batFullCount ?? "N/A"}  Under-voltage events: ${bat.batUnderVoltageCount ?? "N/A"}  Warnings: ${bat.warningCount}`
        );
      });
      return textContent(lines.join("\n\n"));
    }
  );

  mcp.tool(
    "get_capacity_estimate",
    "Estimates real usable capacity (remainingKwh ÷ SOC%) vs rated capacity per battery. Most accurate at 20–80% SOC.",
    { id: z.string().optional().describe("Alias (Bat1/Bat2/Bat3) or serial number; omit for all batteries") },
    async ({ id }) => {
      const { batteries } = await client.getBatteries();
      const targets = id
        ? batteries.filter((b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id)
        : batteries;
      if (id && !targets.length) return textContent(`Battery '${id}' not found.`);
      const lines = targets.map((bat) => {
        if (bat.soc < 5 || bat.soc > 95)
          return `${bat.alias}  SOC ${bat.soc}% — outside 5–95% range, estimate unreliable`;
        const estimated = Math.round((bat.remainingKwh / (bat.soc / 100)) * 100) / 100;
        const degraded  = bat.ratedEnergyKwh != null
          ? Math.round((1 - estimated / bat.ratedEnergyKwh) * 100)
          : null;
        return (
          `${bat.alias}  SOC ${bat.soc}%  remaining ${bat.remainingKwh} kWh\n` +
          `  Estimated capacity: ${estimated} kWh` +
          (bat.ratedEnergyKwh != null ? `  Rated: ${bat.ratedEnergyKwh} kWh  Degradation: ~${degraded}%` : "")
        );
      });
      return textContent(lines.join("\n\n"));
    }
  );

  mcp.tool(
    "get_power_stats",
    "Charge/discharge power statistics from intraday snapshots: peak kW, average kW, C-rate, and fraction of samples above 0.5C.",
    {},
    async () => {
      const { batteries } = await client.getBatteries();
      const snapshots     = serverSnapshotStore.getSnapshots();
      const stats         = computePowerStats(snapshots, batteries);
      if (!stats.totalSamples) return textContent("No snapshots available.");
      return textContent([
        `Samples: ${stats.totalSamples}  (charge: ${stats.chargeSamples}  discharge: ${stats.dischargeSamples})`,
        "",
        `Peak charge:    ${stats.peakChargeKw} kW    Avg: ${stats.avgChargeKw} kW`,
        `Peak discharge: ${stats.peakDischargeKw} kW    Avg: ${stats.avgDischargeKw} kW`,
        stats.avgCRate      != null ? `Avg C-rate (discharge): ${stats.avgCRate} C` : "Avg C-rate: N/A (no rated capacity)",
        stats.pctAboveHalfC != null ? `Samples above 0.5C: ${stats.pctAboveHalfC}%` : "",
      ].filter(Boolean).join("\n"));
    }
  );

  mcp.tool(
    "get_cost_savings",
    "Estimated monetary savings from discharged energy × electricity tariff. Pass tariffKwh or set FELICITY_TARIFF_KWH env var.",
    { tariffKwh: z.number().optional().describe("Electricity tariff in currency-per-kWh (e.g. 0.25 for €0.25/kWh)") },
    async ({ tariffKwh }) => {
      const rate      = tariffKwh ?? (process.env.FELICITY_TARIFF_KWH ? parseFloat(process.env.FELICITY_TARIFF_KWH) : null);
      const live      = computeEnergyHistory(serverSnapshotStore.getSnapshots());
      const persisted = serverDailyEnergyStore.get();
      const merged    = new Map([...persisted, ...live].map((e) => [e.date, e]));
      const history   = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
      if (!history.length) return textContent("Not enough snapshots for cost savings calculation (need at least 2 readings).");
      const totalDischarged = history.reduce((s, d) => s + d.kwhDischarged, 0);
      const totalCharged    = history.reduce((s, d) => s + d.kwhCharged,    0);
      const lines: string[] = [
        `Period: ${history[0].date} → ${history[history.length - 1].date}  (${history.length} day${history.length !== 1 ? "s" : ""})`,
        "",
        `Total discharged: ${Math.round(totalDischarged * 100) / 100} kWh`,
        `Total charged:    ${Math.round(totalCharged    * 100) / 100} kWh`,
      ];
      if (rate != null && !isNaN(rate) && rate > 0) {
        const savings = Math.round(totalDischarged * rate * 100) / 100;
        lines.push("", `Tariff: ${rate}/kWh  →  Estimated savings: ${savings}`);
        lines.push("", "Daily breakdown:");
        for (const d of history) {
          const daySavings = Math.round(d.kwhDischarged * rate * 100) / 100;
          lines.push(`  ${d.date}  ${d.kwhDischarged} kWh discharged  →  ${daySavings} saved`);
        }
      } else {
        lines.push("", "Set FELICITY_TARIFF_KWH env var or pass tariffKwh param to see monetary savings.");
      }
      return textContent(lines.join("\n"));
    }
  );

  // ── HTTP server ────────────────────────────────────────────────────────────

  const sseTransports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
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
    if (req.method === "OPTIONS") { res.writeHead(HTTP_STATUS_NO_CONTENT); res.end(); return; }

    if (url.pathname !== "/health" && !checkRateLimit(req, res)) return;
    if (url.pathname !== "/health" && !checkAuth(req, res)) return;

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
        const bpath = url.pathname.slice("/batteries/".length);
        const slash = bpath.indexOf("/");
        const bid   = slash >= 0 ? bpath.slice(0, slash) : bpath;
        const bsub  = slash >= 0 ? bpath.slice(slash + 1) : "";

        if (bsub === "cell-stats") {
          const { batteries } = await client.getBatteries();
          const bat = batteries.find((b) => b.alias.toLowerCase() === bid.toLowerCase() || b.sn === bid);
          if (!bat) { sendJson(res, HTTP_STATUS_NOT_FOUND, { error: "not found" }); return; }
          sendJson(res, HTTP_STATUS_OK, { battery: bat.alias, sn: bat.sn, stats: computeCellStats(serverSnapshotStore.getSnapshots(), bat.sn) });
          return;
        }

        if (bsub === "module-health") {
          const { batteries } = await client.getBatteries();
          const bat = batteries.find((b) => b.alias.toLowerCase() === bid.toLowerCase() || b.sn === bid);
          if (!bat) { sendJson(res, HTTP_STATUS_NOT_FOUND, { error: "not found" }); return; }
          const health    = computeHealth(batteries, serverSnapshotStore.getSnapshots());
          const outliers  = new Set(health[bat.sn]?.outliers ?? []);
          const moduleMap = new Map<number, number[]>();
          bat.cellVoltages.forEach((v, i) => {
            const m = Math.ceil((i + 1) / CELLS_PER_MODULE);
            if (!moduleMap.has(m)) moduleMap.set(m, []);
            moduleMap.get(m)!.push(v);
          });
          const modules = [...moduleMap.entries()].map(([mod, vs]) => ({
            module:     mod,
            min:        Math.min(...vs),
            max:        Math.max(...vs),
            mean:       Math.round(vs.reduce((s, v) => s + v, 0) / vs.length),
            delta:      Math.max(...vs) - Math.min(...vs),
            hasOutlier: vs.some((_, i) => outliers.has((mod - 1) * CELLS_PER_MODULE + 1 + i)),
          }));
          sendJson(res, HTTP_STATUS_OK, { battery: bat.alias, sn: bat.sn, modules });
          return;
        }

        if (!bsub) {
          const result = await client.getBattery(bid);
          if (!result.battery) { sendJson(res, HTTP_STATUS_NOT_FOUND, { error: "not found" }); return; }
          sendJson(res, HTTP_STATUS_OK, result);
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/hooks") {
        sendJson(res, HTTP_STATUS_OK, serverHookStore.list());
        return;
      }

      if (req.method === "POST" && url.pathname === "/hooks") {
        const body = await readBody(req);
        let parsed: { url?: string; events?: string[]; secret?: string };
        try   { parsed = JSON.parse(body) as typeof parsed; }
        catch { throw new AppError("invalid JSON body", HTTP_STATUS_BAD_REQUEST); }
        const { url: hookUrl, events, secret } = parsed;
        if (!hookUrl) { sendJson(res, HTTP_STATUS_BAD_REQUEST, { error: "url required" }); return; }
        sendJson(res, HTTP_STATUS_CREATED, serverHookStore.add({ url: hookUrl, events, secret }));
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/hooks/") && url.pathname.endsWith("/deliveries")) {
        const id    = url.pathname.slice("/hooks/".length, -"/deliveries".length);
        const found = serverHookStore.list().some((h) => h.id === id);
        if (!found) { sendJson(res, HTTP_STATUS_NOT_FOUND, { error: "hook not found" }); return; }
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
        const file  = _snapshotFile(store);
        if (!file) { sendJson(res, HTTP_STATUS_NOT_FOUND, { error: `unknown store '${store}' — use intraday, daily or state` }); return; }
        try {
          const data = await fs.promises.readFile(file, "utf8");
          res.writeHead(HTTP_STATUS_OK, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${store}.json"` });
          res.end(data);
        } catch {
          sendJson(res, HTTP_STATUS_NOT_FOUND, { error: "no data yet" });
        }
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/snapshots/")) {
        const store    = url.pathname.slice("/snapshots/".length);
        const deletable = ["intraday", "daily"];
        const toDelete  = store === "all"
          ? deletable.map(_snapshotFile).filter((f): f is string => f !== null)
          : deletable.includes(store) ? [_snapshotFile(store)].filter((f): f is string => f !== null) : [];
        if (!toDelete.length) { sendJson(res, HTTP_STATUS_NOT_FOUND, { error: `unknown store '${store}' — use intraday, daily or all` }); return; }
        const deleted: string[] = [];
        for (const f of toDelete) {
          try { await fs.promises.unlink(f); deleted.push(path.basename(f)); }
          catch { /* already gone */ }
        }
        serverLogger.info("snapshots reset", { deleted });
        sendJson(res, HTTP_STATUS_OK, { ok: true, deleted });
        return;
      }

      if (req.method === "GET" && url.pathname === "/alerts") {
        const qid = url.searchParams.get("id") ?? undefined;
        const { batteries } = await client.getBatteries();
        const targets = qid
          ? batteries.filter((b) => b.alias.toLowerCase() === qid.toLowerCase() || b.sn === qid)
          : batteries;
        if (qid && !targets.length) { sendJson(res, HTTP_STATUS_NOT_FOUND, { error: "not found" }); return; }
        const alerts = computeAlerts(targets, computeHealth(batteries, serverSnapshotStore.getSnapshots()));
        sendJson(res, HTTP_STATUS_OK, { alerts, count: alerts.length });
        return;
      }

      if (req.method === "GET" && url.pathname === "/energy") {
        const live      = computeEnergyHistory(serverSnapshotStore.getSnapshots());
        const persisted = serverDailyEnergyStore.get();
        const merged    = new Map([...persisted, ...live].map((e) => [e.date, e]));
        const history   = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
        sendJson(res, HTTP_STATUS_OK, { history });
        return;
      }

      if (req.method === "GET" && url.pathname === "/limit-headroom") {
        const qid = url.searchParams.get("id") ?? undefined;
        const { batteries } = await client.getBatteries();
        const targets = qid
          ? batteries.filter((b) => b.alias.toLowerCase() === qid.toLowerCase() || b.sn === qid)
          : batteries;
        if (qid && !targets.length) { sendJson(res, HTTP_STATUS_NOT_FOUND, { error: "not found" }); return; }
        sendJson(res, HTTP_STATUS_OK, {
          batteries: targets.map((bat) => ({
            alias:                 bat.alias,
            sn:                    bat.sn,
            voltage:               bat.voltage,
            current:               bat.current,
            chargeVoltHeadroom:    bat.chargeVoltLimit    != null ? Math.round((bat.chargeVoltLimit    - bat.voltage) * 10) / 10 : null,
            dischargeVoltHeadroom: bat.dischargeVoltLimit != null ? Math.round((bat.voltage - bat.dischargeVoltLimit) * 10) / 10 : null,
            chargeCurrHeadroom:    bat.chargeCurrLimit    != null ? Math.round((bat.chargeCurrLimit    - Math.abs(bat.current)) * 10) / 10 : null,
            dischargeCurrHeadroom: bat.dischargeCurrLimit != null ? Math.round((bat.dischargeCurrLimit - Math.abs(bat.current)) * 10) / 10 : null,
          })),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/lifetime-stats") {
        const qid = url.searchParams.get("id") ?? undefined;
        const { batteries } = await client.getBatteries();
        const targets = qid
          ? batteries.filter((b) => b.alias.toLowerCase() === qid.toLowerCase() || b.sn === qid)
          : batteries;
        if (qid && !targets.length) { sendJson(res, HTTP_STATUS_NOT_FOUND, { error: "not found" }); return; }
        sendJson(res, HTTP_STATUS_OK, {
          batteries: targets.map((bat) => {
            const cycles = bat.batCycleIndex ?? 0;
            return {
              alias:              bat.alias,
              sn:                 bat.sn,
              cyclesUsed:         cycles,
              nominalCycles:      LFP_NOMINAL_CYCLES,
              cyclesPct:          Math.round(cycles / LFP_NOMINAL_CYCLES * 100),
              cyclesRemaining:    LFP_NOMINAL_CYCLES - cycles,
              fullCharges:        bat.batFullCount        ?? null,
              underVoltageEvents: bat.batUnderVoltageCount ?? null,
              warningCount:       bat.warningCount,
            };
          }),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/capacity") {
        const qid = url.searchParams.get("id") ?? undefined;
        const { batteries } = await client.getBatteries();
        const targets = qid
          ? batteries.filter((b) => b.alias.toLowerCase() === qid.toLowerCase() || b.sn === qid)
          : batteries;
        if (qid && !targets.length) { sendJson(res, HTTP_STATUS_NOT_FOUND, { error: "not found" }); return; }
        sendJson(res, HTTP_STATUS_OK, {
          batteries: targets.map((bat) => {
            const estimated = bat.soc >= 5 && bat.soc <= 95
              ? Math.round((bat.remainingKwh / (bat.soc / 100)) * 100) / 100
              : null;
            return {
              alias:                bat.alias,
              sn:                   bat.sn,
              soc:                  bat.soc,
              remainingKwh:         bat.remainingKwh,
              estimatedCapacityKwh: estimated,
              ratedCapacityKwh:     bat.ratedEnergyKwh ?? null,
              degradationPct:       estimated != null && bat.ratedEnergyKwh != null
                ? Math.round((1 - estimated / bat.ratedEnergyKwh) * 100)
                : null,
            };
          }),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/power-stats") {
        const { batteries } = await client.getBatteries();
        sendJson(res, HTTP_STATUS_OK, computePowerStats(serverSnapshotStore.getSnapshots(), batteries));
        return;
      }

      if (req.method === "GET" && url.pathname === "/cost-savings") {
        const tariffParam = url.searchParams.get("tariff");
        const rate = tariffParam != null
          ? parseFloat(tariffParam)
          : (process.env.FELICITY_TARIFF_KWH ? parseFloat(process.env.FELICITY_TARIFF_KWH) : null);
        const live      = computeEnergyHistory(serverSnapshotStore.getSnapshots());
        const persisted = serverDailyEnergyStore.get();
        const merged2   = new Map([...persisted, ...live].map((e) => [e.date, e]));
        const history   = [...merged2.values()].sort((a, b) => a.date.localeCompare(b.date));
        const totalDischarged = Math.round(history.reduce((s, d) => s + d.kwhDischarged, 0) * 100) / 100;
        const totalCharged    = Math.round(history.reduce((s, d) => s + d.kwhCharged,    0) * 100) / 100;
        sendJson(res, HTTP_STATUS_OK, {
          period:             history.length ? { from: history[0].date, to: history[history.length - 1].date } : null,
          totalDischargedKwh: totalDischarged,
          totalChargedKwh:    totalCharged,
          tariff:             rate ?? null,
          estimatedSavings:   rate != null && !isNaN(rate) && rate > 0
            ? Math.round(totalDischarged * rate * 100) / 100
            : null,
          history,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(HTTP_STATUS_OK, {
          "Content-Type":  "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection":    "keep-alive",
        });
        res.write("retry: 5000\n\n");
        const onSnapshot = (payload: unknown): void => {
          res.write(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`);
        };
        snapshotEmitter.on("snapshot", onSnapshot);
        req.on("close", () => snapshotEmitter.off("snapshot", onSnapshot));
        // Send last persisted state immediately so clients don't wait for next tick
        readState().then((state) => {
          if (state) res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        }).catch(() => {});
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
        const transport = sessionId ? sseTransports.get(sessionId) : undefined;
        if (!transport) { res.writeHead(HTTP_STATUS_NOT_FOUND); res.end("Session not found"); return; }
        const body = await readBody(req);
        let parsed: unknown;
        try   { parsed = JSON.parse(body); }
        catch { throw new AppError("invalid JSON body", HTTP_STATUS_BAD_REQUEST); }
        await transport.handlePostMessage(req, res, parsed);
        return;
      }

      res.writeHead(HTTP_STATUS_NOT_FOUND); res.end("Not found");
    } catch (err: unknown) {
      serverLogger.error("request error", { method: req.method, path: url.pathname, err: (err as Error).message });
      sendError(res, err as Error & { statusCode?: number });
    }
  });

  function close(): Promise<void> {
    stopPurge();
    return new Promise((resolve) => {
      httpServer.close(() => resolve());
      setTimeout(resolve, 5000).unref();
    });
  }

  return { httpServer, mcp, setPollError, close };
}

export async function startServer(
  client: FelicityClient,
  opts:   ServerOptions = {}
): Promise<{ port: number; url: string; setPollError(err: Error | string | null): void; close(): Promise<void> }> {
  const port = opts.port ?? 3010;
  const { httpServer, setPollError, close } = createServer(client, { ...opts, port });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, resolve);
  });
  return { port, url: `http://localhost:${port}`, setPollError, close };
}

// ── Boot (standalone only) ────────────────────────────────────────────────────

export async function main(): Promise<void> {
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

  const serverOpts: ServerOptions = {
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

  const poller = startPoller(client, {
    onTick: (err, batteries) => {
      if (err) {
        setPollError(err);
        _defaultLogger.error("poll error", { err: err.message });
      } else if (batteries) {
        setPollError(null);
        _defaultLogger.info("poll", { batteries: batteries.length, summary: batteries.map((b) => `${b.alias}=${b.soc}%`).join(" ") });
      }
    },
  });

  if (IS_STDIO) {
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
  } else {
    const shutdown = (): void => {
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
  main().catch((err: unknown) => {
    _defaultLogger.error("startup failed", { err: (err as Error).message });
    process.exit(1);
  });
}
