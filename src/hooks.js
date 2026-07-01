"use strict";

const crypto = require("crypto");
const fs     = require("fs");
const https  = require("https");
const http   = require("http");
const os     = require("os");
const path   = require("path");
const {
  HEALTH_CELL_DELTA_WARN,
  HEALTH_CELL_DELTA_CRIT,
  HEALTH_TEMP_WARN,
  HEALTH_TEMP_CRIT,
  HEALTH_SOH_WARN,
} = require("./compute");
const { ChargingState, HealthStatus, HookEvent } = require("./enums");
const { logger }                                 = require("./logger");
const { sleep }                                  = require("./helpers");
const { AppError }                               = require("./errors");
const { constants: { HTTP_STATUS_BAD_REQUEST } } = require("node:http2");

const HOOK_DELIVERY_TIMEOUT_MS = 8_000;  // per-request timeout for webhook HTTP delivery
const DEFAULT_COOLDOWN_H       = 4;      // fallback cooldown if event is not in HOOK_COOLDOWNS_H
const DELIVERY_MAX_ATTEMPTS    = 3;      // initial attempt + 2 retries
const DELIVERY_LOG_SIZE        = 50;     // ring-buffer depth per hook
const VALID_EVENTS             = new Set(Object.values(HookEvent));
// Regex matches private/loopback hostnames to block SSRF via registered webhooks.
// Covers IPv4 private/loopback, IPv6 loopback (::1), IPv6 link-local (fe80::),
// IPv6 ULA (fc00::/7 → fc/fd prefixes), and IPv4-mapped IPv6 (::ffff:).
const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0$|::1$|::ffff:|fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i;

function _isPrivateHost(hostname) {
  // WHATWG URL parser wraps IPv6 in brackets: "[::1]" → strip them before matching
  const h = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (PRIVATE_HOST.test(h)) return true;
  if (/^0x[0-9a-f]+$/i.test(h)) return true;  // hex IPv4: 0x7f000001
  if (/^0\d/.test(h)) return true;              // octal IPv4: 0177.0.0.1
  if (/^\d+$/.test(h)) return true;             // decimal IPv4: 2130706433
  return false;
}

const LOW_SOC_PCT = parseInt(process.env.FELICITY_LOW_SOC_PCT ?? "20", 10);

// Default cooldowns in hours per event type
const HOOK_COOLDOWNS_H = {
  [HookEvent.CELL_DELTA_CRIT]: 1,
  [HookEvent.CELL_DELTA_WARN]: 4,
  [HookEvent.TEMP_CRIT]:       1,
  [HookEvent.TEMP_WARN]:       4,
  [HookEvent.SOH_WARN]:       24,
  [HookEvent.LOW_SOC]:         2,
  [HookEvent.FULL]:            8,
  [HookEvent.ONLINE]:          1,
  [HookEvent.OFFLINE]:         1,
};

function _hookFile() {
  return path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), "battery-hooks.json");
}

function _cooldownFile() {
  return path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), "battery-hook-cooldowns.json");
}

class HookStore {
  constructor() {
    // Tracks alias of each known battery SN from the previous fire() call.
    // null = no prior poll; used to detect ONLINE/OFFLINE transitions.
    this._prevBatInfo = null;
    // In-memory copies — loaded once at construction, flushed to disk on mutations.
    this._hooks       = this._loadFromDisk();
    this._cooldowns   = this._loadCooldownsFromDisk();
    // Ring-buffer of delivery results: Map<hookId, Array<entry>> (not persisted).
    this._deliveryLog = new Map();
  }

  _loadFromDisk() {
    try { return JSON.parse(fs.readFileSync(_hookFile(), "utf8")).hooks ?? []; }
    catch { return []; }
  }

  _loadCooldownsFromDisk() {
    try { return JSON.parse(fs.readFileSync(_cooldownFile(), "utf8")); }
    catch { return {}; }
  }

  _save() {
    try {
      const dest = _hookFile();
      const tmp  = dest + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ hooks: this._hooks }, null, 2));
      fs.renameSync(tmp, dest);
      try { fs.chmodSync(dest, 0o600); } catch { /* Windows */ }
    } catch (e) { logger.error("HookStore save failed", { err: e.message }); }
  }

  _saveCooldowns() {
    try {
      const dest = _cooldownFile();
      const tmp  = dest + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this._cooldowns, null, 2));
      fs.renameSync(tmp, dest);
      try { fs.chmodSync(dest, 0o600); } catch { /* Windows */ }
    } catch (e) { logger.error("HookStore cooldown save failed", { err: e.message }); }
  }

  add({ url, events, secret }) {
    let parsed;
    try { parsed = new URL(url); } catch {
      throw new AppError("invalid webhook url", HTTP_STATUS_BAD_REQUEST);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new AppError("webhook url must use http or https", HTTP_STATUS_BAD_REQUEST);
    }
    if (_isPrivateHost(parsed.hostname)) {
      throw new AppError("webhook url must not target a private address", HTTP_STATUS_BAD_REQUEST);
    }
    if (events?.length) {
      const unknown = events.filter((e) => !VALID_EVENTS.has(e));
      if (unknown.length) {
        throw new AppError(`unknown event(s): ${unknown.join(", ")}`, HTTP_STATUS_BAD_REQUEST);
      }
    }
    const id        = crypto.randomBytes(4).toString("hex");
    const createdAt = new Date().toISOString();
    const hook      = { id, url, events: events ?? [], secret: secret ?? null, createdAt };
    this._hooks.push(hook);
    this._save();
    const { secret: _s, ...publicHook } = hook;
    return publicHook;
  }

  remove(id) {
    const before = this._hooks.length;
    this._hooks = this._hooks.filter((h) => h.id !== id);
    if (this._hooks.length === before) return false;
    this._deliveryLog.delete(id);
    this._save();
    return true;
  }

  list() { return this._hooks.map(({ secret: _s, ...h }) => h); }

  _httpPost(hookUrl, body, headers) {
    const url = new URL(hookUrl);
    const lib = url.protocol === "https:" ? https : http;
    return new Promise((resolve) => {
      const req = lib.request({ hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, method: "POST", headers }, (res) => {
        res.resume();
        res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      });
      req.setTimeout(HOOK_DELIVERY_TIMEOUT_MS, () => { req.destroy(); resolve({ ok: false, status: 0 }); });
      req.on("error", () => resolve({ ok: false, status: 0 }));
      req.write(body);
      req.end();
    });
  }

  _logDelivery(hookId, entry) {
    let log = this._deliveryLog.get(hookId);
    if (!log) { log = []; this._deliveryLog.set(hookId, log); }
    log.push(entry);
    if (log.length > DELIVERY_LOG_SIZE) log.shift();
  }

  getDeliveries(hookId) {
    return (this._deliveryLog.get(hookId) ?? []).slice().reverse();
  }

  async _deliver(hook, event, payload) {
    const body    = JSON.stringify({ event, ...payload, ts: new Date().toISOString() });
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    if (hook.secret)
      headers["X-Hub-Signature-256"] = "sha256=" + crypto.createHmac("sha256", hook.secret).update(body).digest("hex");

    let result   = { ok: false, status: 0 };
    let attempts = 0;
    for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(2 ** (attempt - 2) * 1000);
      result   = await this._httpPost(hook.url, body, headers);
      attempts = attempt;
      if (result.ok) break;
    }

    this._logDelivery(hook.id, { event, url: hook.url, ok: result.ok, status: result.status, attempts, ts: new Date().toISOString() });
  }

  async fireSnapshot(payload) {
    for (const hook of this._hooks) {
      if (hook.events.length && !hook.events.includes(HookEvent.SNAPSHOT)) continue;
      this._deliver(hook, HookEvent.SNAPSHOT, payload).catch(() => {});
    }
  }

  async fire(batteries, health) {
    // Track battery map before loading hooks so transitions are recorded even
    // when no hooks are registered (hooks may be added before the next poll).
    const currentBatInfo = new Map(batteries.map((b) => [b.sn, b.alias]));
    const prevBatInfo    = this._prevBatInfo;
    this._prevBatInfo    = currentBatInfo;

    const hooks = this._hooks;
    if (!hooks.length) return;

    const cooldowns = this._cooldowns;  // reference — mutations persist in this._cooldowns
    const now       = Date.now();
    let changed     = false;

    function _maybeQueue(events, ev) {
      const cooldownH = HOOK_COOLDOWNS_H[ev.event] ?? DEFAULT_COOLDOWN_H;
      const key = `${ev.sn}:${ev.event}`;
      if (cooldowns[key] && now - cooldowns[key] < cooldownH * 3_600_000) return;
      cooldowns[key] = now;
      changed = true;
      events.push(ev);
    }

    const events = [];

    // ── Per-battery property checks ───────────────────────────────────────────
    for (const bat of batteries) {
      const h = health?.[bat.sn];

      // Health-computed checks (require a health record)
      if (h) {
        const healthChecks = [
          { event: HookEvent.CELL_DELTA_CRIT, match: h.cellDeltaStatus === HealthStatus.CRIT, value: h.cellDelta,  threshold: HEALTH_CELL_DELTA_CRIT },
          { event: HookEvent.CELL_DELTA_WARN, match: h.cellDeltaStatus === HealthStatus.WARN, value: h.cellDelta,  threshold: HEALTH_CELL_DELTA_WARN },
          { event: HookEvent.TEMP_CRIT,       match: h.tempStatus       === HealthStatus.CRIT, value: h.tempMax,   threshold: HEALTH_TEMP_CRIT },
          { event: HookEvent.TEMP_WARN,       match: h.tempStatus       === HealthStatus.WARN, value: h.tempMax,   threshold: HEALTH_TEMP_WARN },
          { event: HookEvent.SOH_WARN,        match: h.sohStatus        === HealthStatus.WARN, value: h.soh,       threshold: HEALTH_SOH_WARN },
        ];
        for (const c of healthChecks) {
          if (c.match) _maybeQueue(events, { event: c.event, sn: bat.sn, alias: bat.alias, value: c.value ?? null, threshold: c.threshold });
        }
      }

      // SOC-based checks (do not require a health record)
      const socChecks = [
        { event: HookEvent.LOW_SOC, match: bat.soc > 0 && bat.soc <= LOW_SOC_PCT, value: bat.soc, threshold: LOW_SOC_PCT },
        { event: HookEvent.FULL,    match: bat.soc >= 100 && bat.chargingState === ChargingState.STANDBY, value: bat.soc, threshold: 100 },
      ];
      for (const c of socChecks) {
        if (c.match) _maybeQueue(events, { event: c.event, sn: bat.sn, alias: bat.alias, value: c.value, threshold: c.threshold });
      }
    }

    // ── Online / offline transition checks ────────────────────────────────────
    if (prevBatInfo !== null) {
      for (const [sn, alias] of currentBatInfo) {
        if (!prevBatInfo.has(sn))
          _maybeQueue(events, { event: HookEvent.ONLINE, sn, alias, value: null, threshold: null });
      }
      for (const [sn, alias] of prevBatInfo) {
        if (!currentBatInfo.has(sn))
          _maybeQueue(events, { event: HookEvent.OFFLINE, sn, alias, value: null, threshold: null });
      }
    }

    if (changed) this._saveCooldowns();

    for (const ev of events) {
      for (const hook of hooks) {
        if (hook.events.length && !hook.events.includes(ev.event)) continue;
        this._deliver(hook, ev.event, { sn: ev.sn, alias: ev.alias, value: ev.value, threshold: ev.threshold })
          .catch(() => {/* fire-and-forget */});
      }
    }
  }
}

const hookStore = new HookStore();

module.exports = { HookStore, hookStore, HOOK_COOLDOWNS_H };
