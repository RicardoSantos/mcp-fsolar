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
const { HealthStatus, HookEvent } = require("./enums");

const HOOK_DELIVERY_TIMEOUT_MS = 8_000;  // per-request timeout for webhook HTTP delivery
const DEFAULT_COOLDOWN_H       = 4;      // fallback cooldown if event is not in HOOK_COOLDOWNS_H

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
  _load() {
    try { return JSON.parse(fs.readFileSync(_hookFile(), "utf8")).hooks ?? []; }
    catch { return []; }
  }

  _save(hooks) {
    try {
      const dest = _hookFile();
      const tmp  = dest + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ hooks }, null, 2));
      fs.renameSync(tmp, dest);
      try { fs.chmodSync(dest, 0o600); } catch { /* Windows */ }
    } catch (e) { console.error(`[HookStore] save failed: ${e.message}`); }
  }

  _loadCooldowns() {
    try { return JSON.parse(fs.readFileSync(_cooldownFile(), "utf8")); }
    catch { return {}; }
  }

  _saveCooldowns(cooldowns) {
    try {
      const dest = _cooldownFile();
      const tmp  = dest + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(cooldowns, null, 2));
      fs.renameSync(tmp, dest);
      try { fs.chmodSync(dest, 0o600); } catch { /* Windows */ }
    } catch (e) { console.error(`[HookStore] cooldown save failed: ${e.message}`); }
  }

  add({ url, events, secret }) {
    let parsed;
    try { parsed = new URL(url); } catch {
      throw Object.assign(new Error("invalid webhook url"), { statusCode: 400 });
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw Object.assign(new Error("webhook url must use http or https"), { statusCode: 400 });
    }
    const hooks = this._load();
    const id = crypto.randomBytes(4).toString("hex");
    hooks.push({ id, url, events: events ?? [], secret: secret ?? null, createdAt: new Date().toISOString() });
    this._save(hooks);
    return id;
  }

  remove(id) {
    const hooks = this._load().filter((h) => h.id !== id);
    this._save(hooks);
  }

  list() { return this._load(); }

  async _deliver(hook, event, payload) {
    const body = JSON.stringify({ event, ...payload, ts: new Date().toISOString() });
    const headers = {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    if (hook.secret) {
      headers["X-Hub-Signature-256"] = "sha256=" +
        crypto.createHmac("sha256", hook.secret).update(body).digest("hex");
    }
    const url = new URL(hook.url);
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

  async fireSnapshot(payload) {
    const hooks = this._load();
    for (const hook of hooks) {
      if (hook.events.length && !hook.events.includes(HookEvent.SNAPSHOT)) continue;
      this._deliver(hook, HookEvent.SNAPSHOT, payload).catch(() => {});
    }
  }

  async fire(batteries, health) {
    const hooks     = this._load();
    if (!hooks.length) return;

    const cooldowns = this._loadCooldowns();
    const now       = Date.now();
    let changed     = false;

    const events = [];
    for (const bat of batteries) {
      const h = health?.[bat.sn];
      if (!h) continue;

      const checks = [
        { event: HookEvent.CELL_DELTA_CRIT, match: h.cellDeltaStatus === HealthStatus.CRIT, threshold: HEALTH_CELL_DELTA_CRIT },
        { event: HookEvent.CELL_DELTA_WARN, match: h.cellDeltaStatus === HealthStatus.WARN, threshold: HEALTH_CELL_DELTA_WARN },
        { event: HookEvent.TEMP_CRIT,       match: h.tempStatus       === HealthStatus.CRIT, threshold: HEALTH_TEMP_CRIT },
        { event: HookEvent.TEMP_WARN,       match: h.tempStatus       === HealthStatus.WARN, threshold: HEALTH_TEMP_WARN },
        { event: HookEvent.SOH_WARN,        match: h.sohStatus        === HealthStatus.WARN, threshold: HEALTH_SOH_WARN },
      ];

      for (const c of checks) {
        if (!c.match) continue;
        const key = `${bat.sn}:${c.event}`;
        const cooldownH = HOOK_COOLDOWNS_H[c.event] ?? DEFAULT_COOLDOWN_H;
        if (cooldowns[key] && now - cooldowns[key] < cooldownH * 3_600_000) continue;
        cooldowns[key] = now;
        changed = true;
        events.push({ event: c.event, sn: bat.sn, alias: bat.alias, value: h[c.event.replace("_crit", "").replace("_warn", "")] ?? null, threshold: c.threshold });
      }
    }

    if (changed) this._saveCooldowns(cooldowns);

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
