#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const https  = require("https");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

// ── RSA public key (extracted from Fsolar-android4.0.4.apk) ──────────────────

const RSA_PUB =
  "-----BEGIN PUBLIC KEY-----\n" +
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnAJE68pjWZmtSg6ZJs9F\n" +
  "ZugJXC6bBSluTW6mJttOLOaljrdErVnM5DNN+YFzpB9pAysTErjY1bnSVuEwQSwp\n" +
  "tnqUji7Ch2qMj2n+0eCp8p6vtSh7/tFr2ul8nDRtkoswLANAIwtUk/G85ipMpmY1\n" +
  "W642LImnEJmGkkddlbjbjxJTZWR5hc/d9cPWb+AR77LxFFrMik3c+44v1kQlIPFP\n" +
  "6EjIbOvt/Lv7fHWD9JI/YzN4y1gK7C/VQdNGuikQyNg+5W3rg9ecYf9I5uLAQwY\n" +
  "/hxeI3lbNsErebqKe2EbJ8AwcNIC0lDBz53Sq0ML89QapEuy3fB+upuctxLULVDC\n" +
  "bNwIDAQAB\n" +
  "-----END PUBLIC KEY-----";

const API_HOST          = "shine-api.felicitysolar.com";
const REQUEST_TIMEOUT_MS = 10_000;

// ── Low-level HTTP ────────────────────────────────────────────────────────────

function felicityRequest(method, urlPath, body, token) {
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: API_HOST,
        path:     urlPath,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token   ? { Authorization: `Bearer_${token}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Felicity API returned non-JSON: ${data.slice(0, 120)}`)); }
        });
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(new Error("Felicity API request timed out")); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nullableInt(v)   { return v != null ? parseInt(v)   : null; }
function nullableFloat(v) { return v != null ? parseFloat(v) : null; }

function pickSnapshotFields(b) {
  return {
    sn:            b.sn,
    alias:         b.alias,
    soc:           b.soc,
    soh:           b.soh,
    power:         b.power,
    cellDelta:     b.cellDelta,
    cellMin:       b.cellVoltageMin,
    cellMax:       b.cellVoltageMax,
    maxCellNum:    b.maxCellNum,
    minCellNum:    b.minCellNum,
    isBalancing:   b.isBalancing,
    voltages:      b.cellVoltages,
    temps:         b.cellTemps,
    tempMax:       b.tempMax,
    tempMin:       b.tempMin,
    warningCount:  b.warningCount,
    batCycleIndex: b.batCycleIndex,
  };
}

// ── SnapshotStore ─────────────────────────────────────────────────────────────

class SnapshotStore {
  constructor({ fileName, maxSnapshots, intervalMs }) {
    this._fileName     = fileName;
    this._maxSnapshots = maxSnapshots;
    this._intervalMs   = intervalMs;
  }

  get _file() {
    return path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), this._fileName);
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this._file, "utf8")).snapshots ?? []; }
    catch { return []; }
  }

  _save(snapshots) {
    try { fs.writeFileSync(this._file, JSON.stringify({ snapshots }, null, 2)); }
    catch (e) { console.error(`[SnapshotStore:${this._fileName}] write failed: ${e.message}`); }
  }

  maybeAdd(batteries) {
    try {
      const snapshots = this._load();
      const last = snapshots[snapshots.length - 1];
      if (last && Date.now() - new Date(last.ts).getTime() < this._intervalMs) return;
      snapshots.push({ ts: new Date().toISOString(), batteries: batteries.map(pickSnapshotFields) });
      if (snapshots.length > this._maxSnapshots)
        snapshots.splice(0, snapshots.length - this._maxSnapshots);
      this._save(snapshots);
    } catch { /* non-fatal */ }
  }

  getSnapshots() { return this._load(); }
}

// ── Snapshot config helpers ───────────────────────────────────────────────────

const SNAPSHOT_MS_DEFAULT   = 10 * 60 * 1000;   // 10 min
const SNAPSHOT_MS_MIN       = 60 * 1000;         // 1 min
const SNAPSHOT_MS_MAX       = 60 * 60 * 1000;    // 1 hour
const SNAPSHOT_DAYS_DEFAULT = 3;
const SNAPSHOT_DAYS_MIN     = 1;
const SNAPSHOT_DAYS_MAX     = 30;
const DAILY_DAYS_DEFAULT    = 90;
const DAILY_DAYS_MIN        = 7;
const DAILY_DAYS_MAX        = 365;

function resolveSnapshotConfig() {
  const enabled = (process.env.FELICITY_SNAPSHOT_ENABLED ?? "true") === "true";
  const ms      = Math.min(SNAPSHOT_MS_MAX,  Math.max(SNAPSHOT_MS_MIN,  parseInt(process.env.FELICITY_SNAPSHOT_MS   ?? String(SNAPSHOT_MS_DEFAULT))));
  const days    = Math.min(SNAPSHOT_DAYS_MAX, Math.max(SNAPSHOT_DAYS_MIN, parseInt(process.env.FELICITY_SNAPSHOT_DAYS ?? String(SNAPSHOT_DAYS_DEFAULT))));
  const ddays   = Math.min(DAILY_DAYS_MAX,    Math.max(DAILY_DAYS_MIN,    parseInt(process.env.FELICITY_DAILY_DAYS    ?? String(DAILY_DAYS_DEFAULT))));
  const maxIntra = Math.ceil((days * 24 * 60 * 60 * 1000) / ms);
  return { enabled, ms, maxIntra, ddays };
}

// ── BatterySnapshotStore ──────────────────────────────────────────────────────

class BatterySnapshotStore extends SnapshotStore {
  constructor() {
    const { ms, maxIntra } = resolveSnapshotConfig();
    super({ fileName: "battery-snapshots.json", maxSnapshots: maxIntra, intervalMs: ms });
  }

  _computeTrend(sn, snapshots) {
    const history = snapshots
      .map((s) => s.batteries.find((b) => b.sn === sn))
      .filter(Boolean);
    if (history.length < 2) return null;
    const deltas = history.map((b) => b.cellDelta).filter((v) => v != null);
    if (deltas.length < 2) return null;
    const change = deltas[deltas.length - 1] - deltas[0];
    let currentBalancingStreak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].isBalancing) currentBalancingStreak++;
      else break;
    }
    return {
      direction:              change < -3 ? "improving" : change > 3 ? "degrading" : "stable",
      deltaChange:            change,
      history:                deltas,
      balancingCount:         history.filter((b) => b.isBalancing).length,
      snapshotCount:          history.length,
      currentBalancingStreak,
    };
  }

  getTrend(sn) {
    return this._computeTrend(sn, this._load());
  }

  getAllTrends(batteries) {
    const snapshots = this._load();
    const result = {};
    for (const bat of batteries) {
      const trend = this._computeTrend(bat.sn, snapshots);
      if (trend) result[bat.sn] = trend;
    }
    return result;
  }
}

// ── DailySnapshotStore ────────────────────────────────────────────────────────

class DailySnapshotStore extends SnapshotStore {
  constructor() {
    const { ddays } = resolveSnapshotConfig();
    super({ fileName: "battery-daily.json", maxSnapshots: ddays, intervalMs: 24 * 60 * 60 * 1000 });
  }
}

const snapshotStore      = new BatterySnapshotStore();
const dailySnapshotStore = new DailySnapshotStore();

// ── HookStore ─────────────────────────────────────────────────────────────────

const HOOK_COOLDOWNS_H = {
  cell_delta_warn: 24,
  cell_delta_crit: 4,
  temp_warn:       4,
  temp_crit:       1,
  outlier:         24,
  soh_warn:        168,
  low_soc:         4,
};

class HookStore {
  get _file() {
    return path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), "battery-hooks.json");
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this._file, "utf8")).hooks ?? []; }
    catch { return []; }
  }

  _save(hooks) {
    try { fs.writeFileSync(this._file, JSON.stringify({ hooks }, null, 2)); }
    catch (e) { console.error("[HookStore] write failed:", e.message); }
  }

  list() { return this._load(); }

  add({ url, events, params = {} }) {
    const hooks = this._load();
    const hook = {
      id:        Math.random().toString(36).slice(2, 10),
      url,
      events:    events ?? Object.keys(HOOK_COOLDOWNS_H),
      params,
      createdAt: new Date().toISOString(),
      lastFired: {},
    };
    hooks.push(hook);
    this._save(hooks);
    return hook;
  }

  remove(id) {
    const hooks = this._load();
    const next  = hooks.filter((h) => h.id !== id);
    if (next.length === hooks.length) return false;
    this._save(next);
    return true;
  }

  async fire(batteries, health) {
    const hooks = this._load();
    if (!hooks.length) return;
    let dirty = false;

    for (const hook of hooks) {
      for (const bat of batteries) {
        const h = health[bat.sn] ?? {};

        const checks = [
          { event: "cell_delta_crit", active: h.cellDeltaStatus === "crit",   value: bat.cellDelta,  threshold: HEALTH_CELL_DELTA_CRIT },
          { event: "cell_delta_warn", active: h.cellDeltaStatus === "warn",   value: bat.cellDelta,  threshold: HEALTH_CELL_DELTA_WARN },
          { event: "temp_crit",       active: h.tempStatus      === "crit",   value: bat.tempMax,    threshold: HEALTH_TEMP_CRIT },
          { event: "temp_warn",       active: h.tempStatus      === "warn",   value: bat.tempMax,    threshold: HEALTH_TEMP_WARN },
          { event: "soh_warn",        active: h.sohStatus       === "warn",   value: bat.soh,        threshold: HEALTH_SOH_WARN },
          { event: "outlier",         active: h.outliers?.length > 0,         value: h.outliers,     threshold: null },
          { event: "low_soc",         active: bat.soc <= (hook.params.lowSocThreshold ?? 25), value: bat.soc, threshold: hook.params.lowSocThreshold ?? 25 },
        ];

        for (const { event, active, value, threshold } of checks) {
          if (!active || !hook.events.includes(event)) continue;

          const key       = `${event}:${bat.sn}`;
          const lastFired = hook.lastFired[key] ? new Date(hook.lastFired[key]).getTime() : 0;
          const cooldownMs = (HOOK_COOLDOWNS_H[event] ?? 4) * 3_600_000;
          if (Date.now() - lastFired < cooldownMs) continue;

          const payload = { event, battery: bat.alias, sn: bat.sn, value, threshold, ts: new Date().toISOString() };
          try {
            await fetch(hook.url, {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify(payload),
              signal:  AbortSignal.timeout(5000),
            });
            hook.lastFired[key] = payload.ts;
            dirty = true;
            console.log(`[hooks] fired ${event} → ${bat.alias} → ${hook.url}`);
          } catch (e) {
            console.error(`[hooks] POST ${hook.url} failed:`, e.message);
          }
        }
      }
    }

    if (dirty) this._save(hooks);
  }
}

const hookStore = new HookStore();

// ── Materialized state ────────────────────────────────────────────────────────

function _stateFile() {
  return path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), "battery-state.json");
}

function _writeState(batteries) {
  try {
    const snapshots   = snapshotStore.getSnapshots();
    const trends      = snapshotStore.getAllTrends(batteries);
    const health      = computeHealth(batteries, snapshots);
    const autonomy    = computeAutonomy(batteries, snapshots);
    const totalPowerW = batteries.reduce((s, b) => s + b.power, 0);
    const state = {
      updatedAt: new Date().toISOString(),
      batteries,
      trends,
      health,
      autonomy,
      fleet: {
        totalKwh:       Math.round(batteries.reduce((s, b) => s + b.remainingKwh, 0) * 100) / 100,
        totalPowerW:    Math.round(totalPowerW),
        avgSoc:         Math.round(batteries.reduce((s, b) => s + b.soc, 0) / batteries.length),
        worstCellDelta: batteries.reduce((m, b) => b.cellDelta != null && b.cellDelta > m ? b.cellDelta : m, 0) || null,
        maxTempC:       batteries.reduce((m, b) => b.tempMax > m ? b.tempMax : m, -Infinity),
      },
    };
    fs.writeFileSync(_stateFile(), JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[fsolar] state write failed:", e.message);
  }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(_stateFile(), "utf8")); }
  catch { return null; }
}

// ── startPoller ───────────────────────────────────────────────────────────────

function startPoller(client) {
  const { enabled, ms } = resolveSnapshotConfig();
  if (!enabled) {
    console.log("[fsolar] snapshot poller disabled (FELICITY_SNAPSHOT_ENABLED=false)");
    return () => {};
  }
  async function tick() {
    try {
      const { batteries } = await client.getBatteries();
      _writeState(batteries);
      const snapshots = snapshotStore.getSnapshots();
      const health    = computeHealth(batteries, snapshots);
      await hookStore.fire(batteries, health);
    } catch (e) {
      console.error("[fsolar] poller error:", e.message);
    }
  }
  tick();
  const timer = setInterval(tick, ms);
  if (timer.unref) timer.unref();
  console.log(`[fsolar] snapshot poller started — every ${ms / 1000}s`);
  return () => clearInterval(timer);
}

// ── MemoryCacheAdapter ────────────────────────────────────────────────────────

class MemoryCacheAdapter {
  constructor() { this._store = new Map(); }

  async get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this._store.delete(key); return null; }
    return entry.value;
  }

  async set(key, value, ttlSeconds) {
    this._store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}

// ── Data transform ────────────────────────────────────────────────────────────

function buildBattery(device, snap) {
  const cells = (snap.bmsVoltageList ?? []).map(Number);

  const maxCellNum = nullableInt(snap.maxVoltageNum2bms);
  const minCellNum = nullableInt(snap.minVoltageNum2bms);

  // 8 entries, only 4 real sensors; 3276.7 (32767/10) is the "no sensor" sentinel
  const cellTemps = (Array.isArray(snap.cellTempList) ? snap.cellTempList : [])
    .map(Number)
    .filter((t) => !isNaN(t) && t < 200);

  const cellDelta = cells.length ? Math.max(...cells) - Math.min(...cells) : null;

  return {
    sn:            device.deviceSn,
    alias:         device.alias,
    model:         device.deviceModel,
    status:        device.status,
    soc:           parseFloat(snap.battSoc    ?? device.battSoc  ?? "0"),
    soh:           parseFloat(snap.battSoh    ?? "100"),
    voltage:       parseFloat(snap.battVolt   ?? "0"),
    current:       parseFloat(snap.battCurr   ?? "0"),
    power:         parseFloat(snap.bmsPower   ?? device.bmsPower ?? "0"),
    chargingState: snap.bmsChargingState === 1 ? "charging"
                 : snap.bmsChargingState === 2 ? "discharging"
                 : "standby",
    tempMax:       parseFloat(snap.tempMax ?? "0"),
    tempMin:       parseFloat(snap.tempMin ?? "0"),
    cellTemps,
    cellVoltages:   cells,
    cellVoltageMax: cells.length ? Math.max(...cells) : null,
    cellVoltageMin: cells.length ? Math.min(...cells) : null,
    cellDelta,
    maxCellNum,
    minCellNum,
    // 4 modules of 4 cells each
    modules: cells.length === 16
      ? Array.from({ length: 4 }, (_, m) => {
          const mc = cells.slice(m * 4, m * 4 + 4);
          return { index: m + 1, cells: mc, temp: cellTemps[m] ?? null,
                   min: Math.min(...mc), max: Math.max(...mc), delta: Math.max(...mc) - Math.min(...mc) };
        })
      : [],
    chargeVoltLimit:      parseFloat(snap.BMSLCVolt ?? "0")             || null,
    dischargeVoltLimit:   parseFloat(snap.BMSLDVolt ?? "0")             || null,
    chargeCurrLimit:      parseFloat(snap.BMSLCCurr ?? "0")             || null,
    dischargeCurrLimit:   parseFloat(snap.BMSLDCurr ?? snap.bmsldcurr ?? "0") || null,
    batCycleIndex:        nullableInt(snap.batCycleIndex),
    batFullCount:         nullableInt(snap.batFullCount),
    batUnderVoltageCount: nullableInt(snap.batUnderVoltageCount),
    warningCount:         snap.warningCount != null ? parseInt(snap.warningCount) : 0,
    remainingKwh:         parseFloat(snap.remainingBatteryEnergy1 ?? "0"),
    capacityAh:           parseFloat(snap.battCapacity ?? device.battCapacity ?? "314"),
    ratedEnergyKwh:       nullableFloat(snap.ratedEnergy) || null,
    dataTime:             snap.dataTimeStr ?? null,
    reportFreqSec:        nullableInt(snap.reportFreq),
    wifiSignal:           parseInt(snap.wifiSignal ?? device.wifiSignal ?? "0"),
    bmsState:             nullableInt(snap.bmsState),
    isBalancing:          snap.bmsState != null ? (parseInt(snap.bmsState) & 64) !== 0 : false,
  };
}

// ── FelicityClient ────────────────────────────────────────────────────────────

class FelicityClient {
  /**
   * @param {object}   opts
   * @param {string}   opts.user      - Felicity account email
   * @param {string}   opts.pass      - Felicity account password (plain text)
   * @param {object}   [opts.cache]   - Cache adapter { get, set }. Defaults to MemoryCacheAdapter.
   * @param {number}   [opts.ttl=30]  - Cache TTL in seconds.
   * @param {Function} [opts._fetch]  - Internal: override HTTP transport (for testing).
   */
  constructor({ user, pass, cache, ttl = 30, _fetch = felicityRequest }) {
    this._user        = user;
    this._pass        = pass;
    this._cache       = cache ?? new MemoryCacheAdapter();
    this._ttl         = ttl;
    this._fetch       = _fetch;
    this._token       = null;
    this._tokenExpiry = 0;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async _ensureToken() {
    if (!this._user || !this._pass) throw new Error("FelicityClient: user and pass are required");
    if (this._token && Date.now() < this._tokenExpiry) return this._token;
    const encPass = crypto
      .publicEncrypt({ key: RSA_PUB, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(this._pass))
      .toString("base64");
    const resp = await this._fetch("POST", "/userlogin", { userName: this._user, password: encPass, version: "1.0" });
    if (resp.code !== 200) throw new Error(`Felicity login failed: ${resp.message ?? resp.code}`);
    const raw = resp.data?.token ?? resp.data?.data?.token ?? resp.data;
    this._token       = String(raw).replace(/^Bearer_/, "");
    this._tokenExpiry = Date.now() + 72 * 60 * 60 * 1000;
    return this._token;
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────

  async _fetchAll() {
    const token   = await this._ensureToken();
    const devResp = await this._fetch("POST", "/device/list_device_all_type", { pageNum: 1, pageSize: 100 }, token);
    if (devResp.code !== 200) throw new Error(`Device list failed: ${devResp.message ?? devResp.code} — response: ${JSON.stringify(devResp).slice(0, 200)}`);

    const allDevices = devResp.data?.dataList ?? [];
    if (allDevices.length >= 100)
      console.warn("[fsolar] device list hit pageSize=100 — some devices may be missing");

    const devices = allDevices.filter((d) => d.deviceType === "BP");
    const dateStr = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

    const batteries = await Promise.all(
      devices.map(async (dev) => {
        const snap = await this._fetch("POST", "/device/get_device_snapshot",
          { deviceSn: dev.deviceSn, deviceType: "BP", dateStr }, token);
        if (snap.code !== 200) throw new Error(`Snapshot failed for ${dev.deviceSn}: ${snap.message ?? snap.code}`);
        return buildBattery(dev, snap.data);
      })
    );

    batteries.sort((a, b) => a.alias.localeCompare(b.alias));
    return batteries;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async getBatteries() {
    const CACHE_KEY = `batteries:${this._user}`;
    const cached    = await this._cache.get(CACHE_KEY);
    if (cached) return { ...cached, fromCache: true, trend: snapshotStore.getAllTrends(cached.batteries) };

    const batteries = await this._fetchAll();
    const fetchedAt = new Date().toISOString();
    await this._cache.set(CACHE_KEY, { batteries, fetchedAt }, this._ttl);
    snapshotStore.maybeAdd(batteries);
    dailySnapshotStore.maybeAdd(batteries);
    return { batteries, fetchedAt, fromCache: false, trend: snapshotStore.getAllTrends(batteries) };
  }

  async getBattery(id) {
    const { batteries, fetchedAt, fromCache } = await this.getBatteries();
    const battery = batteries.find(
      (b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id
    );
    return { battery: battery ?? null, fetchedAt, fromCache };
  }
}

// ── computeHealth ─────────────────────────────────────────────────────────────

const HEALTH_CELL_DELTA_WARN = 120;  // mV
const HEALTH_CELL_DELTA_CRIT = 200;  // mV
const HEALTH_TEMP_WARN       = 40;   // °C
const HEALTH_TEMP_CRIT       = 50;   // °C
const HEALTH_OUTLIER_MV      = 35;   // mV below pack avg, persistent across last 3 snaps
const HEALTH_SOH_WARN        = 90;   // %

function computeHealth(batteries, snapshots) {
  const lastN  = snapshots.slice(-3);
  const result = {};

  for (const bat of batteries) {
    const cellDeltaStatus = bat.cellDelta == null ? null
      : bat.cellDelta >= HEALTH_CELL_DELTA_CRIT ? "crit"
      : bat.cellDelta >= HEALTH_CELL_DELTA_WARN ? "warn"
      : "ok";

    const tempStatus = bat.tempMax == null ? null
      : bat.tempMax >= HEALTH_TEMP_CRIT ? "crit"
      : bat.tempMax >= HEALTH_TEMP_WARN ? "warn"
      : "ok";

    const sohStatus = bat.soh == null ? null : bat.soh < HEALTH_SOH_WARN ? "warn" : "ok";

    // Persistent cell outliers — only meaningful while discharging
    let outliers = [];
    if (bat.chargingState === "discharging" && lastN.length >= 3 && bat.cellVoltages?.length > 0) {
      const avg = bat.cellVoltages.reduce((s, v) => s + v, 0) / bat.cellVoltages.length;
      outliers = bat.cellVoltages
        .map((v, i) => ({ cell: i + 1, dev: v - avg }))
        .filter((c) => c.dev < -HEALTH_OUTLIER_MV)
        .filter((o) => lastN.every((snap) => {
          const b = snap.batteries.find((b) => b.sn === bat.sn);
          if (!b?.voltages?.length || (b.power ?? 0) >= 0) return false;
          const a = b.voltages.reduce((s, v) => s + v, 0) / b.voltages.length;
          return (b.voltages[o.cell - 1] ?? a) - a < -HEALTH_OUTLIER_MV;
        }))
        .map((o) => o.cell);
    }

    // Average C-rate from recent snapshots
    const recentSnaps = snapshots.slice(-6);
    const ratedW = (bat.capacityAh ?? 0) * (bat.voltage ?? 48);
    const cRates = recentSnaps.flatMap((s) => {
      const b = s.batteries.find((b) => b.sn === bat.sn);
      if (!b || Math.abs(b.power ?? 0) < 50 || ratedW <= 0) return [];
      return [Math.abs(b.power) / ratedW];
    });
    const avgCRate = cRates.length
      ? Math.round(cRates.reduce((s, v) => s + v, 0) / cRates.length * 100) / 100
      : null;

    result[bat.sn] = {
      alias:           bat.alias,
      cellDeltaStatus,
      cellDelta:       bat.cellDelta ?? null,
      tempStatus,
      tempMax:         bat.tempMax ?? null,
      sohStatus,
      soh:             bat.soh ?? null,
      outliers,
      avgCRate,
    };
  }

  return result;
}

// ── computeAutonomy ───────────────────────────────────────────────────────────

function computeAutonomy(batteries, snapshots, opts = {}) {
  const { sunriseAt = null, packCapacityKwh = null, minSocPct = 5, defaultDischargeKw = 1.5 } = opts;

  const totalRemainingKwh = batteries.reduce((s, b) => s + b.remainingKwh, 0);
  const totalPowerW       = batteries.reduce((s, b) => s + (b.power ?? 0), 0);

  let dischargeRateKw;
  if (totalPowerW < -100) {
    dischargeRateKw = -totalPowerW / 1000;
  } else {
    const nightSnaps = snapshots.filter((s) => s.batteries.some((b) => (b.power ?? 0) < -100));
    const avgW = nightSnaps.length
      ? nightSnaps.reduce((s, sn) => s + sn.batteries.reduce((a, b) => a + Math.abs(Math.min(0, b.power ?? 0)), 0), 0) / nightSnaps.length
      : 0;
    dischargeRateKw = avgW > 100 ? avgW / 1000 : defaultDischargeKw;
  }
  dischargeRateKw = Math.max(0.2, Math.min(24, dischargeRateKw));

  const estimatedHours = Math.round(totalRemainingKwh / dischargeRateKw * 10) / 10;

  let estimatedSocAtSunrise = null;
  if (sunriseAt != null && packCapacityKwh != null) {
    const hoursToSunrise = Math.max(0, (new Date(sunriseAt).getTime() - Date.now()) / 3_600_000);
    const minKwh = packCapacityKwh * (minSocPct / 100);
    const remaining = Math.max(minKwh, totalRemainingKwh - dischargeRateKw * hoursToSunrise);
    estimatedSocAtSunrise = Math.max(minSocPct, Math.min(100, Math.round((remaining / packCapacityKwh) * 100)));
  }

  return {
    totalRemainingKwh:    Math.round(totalRemainingKwh * 10) / 10,
    dischargeRateKw:      Math.round(dischargeRateKw * 10) / 10,
    estimatedHours,
    estimatedSocAtSunrise,
  };
}

module.exports = {
  FelicityClient,
  MemoryCacheAdapter,
  SnapshotStore,
  BatterySnapshotStore,
  DailySnapshotStore,
  snapshotStore,
  dailySnapshotStore,
  hookStore,
  startPoller,
  readState,
  computeHealth,
  computeAutonomy,
  buildBattery,
};
