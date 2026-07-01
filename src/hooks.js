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

// Default cooldowns in hours per event type
const HOOK_COOLDOWNS_H = {
  cell_delta_crit: 1,
  cell_delta_warn: 4,
  temp_crit:       1,
  temp_warn:       4,
  soh_warn:       24,
  low_soc:         2,
  full:            8,
  online:          1,
  offline:         1,
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
      const tmp = _hookFile() + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ hooks }, null, 2));
      fs.renameSync(tmp, _hookFile());
    } catch (e) { console.error(`[HookStore] save failed: ${e.message}`); }
  }

  _loadCooldowns() {
    try { return JSON.parse(fs.readFileSync(_cooldownFile(), "utf8")); }
    catch { return {}; }
  }

  _saveCooldowns(cooldowns) {
    try {
      const tmp = _cooldownFile() + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(cooldowns, null, 2));
      fs.renameSync(tmp, _cooldownFile());
    } catch (e) { console.error(`[HookStore] cooldown save failed: ${e.message}`); }
  }

  add({ url, events, secret }) {
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
      req.setTimeout(8_000, () => { req.destroy(); resolve({ ok: false, status: 0 }); });
      req.on("error", () => resolve({ ok: false, status: 0 }));
      req.write(body);
      req.end();
    });
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
        { event: "cell_delta_crit", match: h.cellDeltaStatus === "crit",  threshold: HEALTH_CELL_DELTA_CRIT },
        { event: "cell_delta_warn", match: h.cellDeltaStatus === "warn",  threshold: HEALTH_CELL_DELTA_WARN },
        { event: "temp_crit",       match: h.tempStatus       === "crit", threshold: HEALTH_TEMP_CRIT },
        { event: "temp_warn",       match: h.tempStatus       === "warn", threshold: HEALTH_TEMP_WARN },
        { event: "soh_warn",        match: h.sohStatus        === "warn", threshold: HEALTH_SOH_WARN },
      ];

      for (const c of checks) {
        if (!c.match) continue;
        const key = `${bat.sn}:${c.event}`;
        const cooldownH = HOOK_COOLDOWNS_H[c.event] ?? 4;
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
