"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hookStore = exports.HookStore = exports.HOOK_COOLDOWNS_H = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const https_1 = __importDefault(require("https"));
const http_1 = __importDefault(require("http"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const node_http2_1 = require("node:http2");
const compute_1 = require("./compute");
const enums_1 = require("./enums");
const logger_1 = require("./logger");
const helpers_1 = require("./helpers");
const errors_1 = require("./errors");
const { HTTP_STATUS_BAD_REQUEST } = node_http2_1.constants;
const HOOK_DELIVERY_TIMEOUT_MS = 8000;
const DEFAULT_COOLDOWN_H = 4;
const DELIVERY_MAX_ATTEMPTS = 3;
const DELIVERY_LOG_SIZE = 50;
const VALID_EVENTS = new Set(Object.values(enums_1.HookEvent));
const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0$|::1$|::ffff:|fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i;
function _isPrivateHost(hostname) {
    const h = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
    if (PRIVATE_HOST.test(h))
        return true;
    if (/^0x[0-9a-f]+$/i.test(h))
        return true;
    if (/^0\d/.test(h))
        return true;
    if (/^\d+$/.test(h))
        return true;
    return false;
}
const LOW_SOC_PCT = parseInt(process.env.FELICITY_LOW_SOC_PCT ?? "20", 10);
exports.HOOK_COOLDOWNS_H = {
    [enums_1.HookEvent.CELL_DELTA_CRIT]: 1,
    [enums_1.HookEvent.CELL_DELTA_WARN]: 4,
    [enums_1.HookEvent.TEMP_CRIT]: 1,
    [enums_1.HookEvent.TEMP_WARN]: 4,
    [enums_1.HookEvent.SOH_WARN]: 24,
    [enums_1.HookEvent.LOW_SOC]: 2,
    [enums_1.HookEvent.FULL]: 8,
    [enums_1.HookEvent.ONLINE]: 1,
    [enums_1.HookEvent.OFFLINE]: 1,
};
function _hookFile() {
    return path_1.default.join(process.env.SNAPSHOT_DIR ?? os_1.default.tmpdir(), "battery-hooks.json");
}
function _cooldownFile() {
    return path_1.default.join(process.env.SNAPSHOT_DIR ?? os_1.default.tmpdir(), "battery-hook-cooldowns.json");
}
class HookStore {
    constructor() {
        this._prevBatInfo = null;
        this._deliveryLog = new Map();
        this._hooks = this._loadFromDisk();
        this._cooldowns = this._loadCooldownsFromDisk();
    }
    _loadFromDisk() {
        try {
            const parsed = JSON.parse(fs_1.default.readFileSync(_hookFile(), "utf8"));
            return parsed.hooks ?? [];
        }
        catch {
            return [];
        }
    }
    _loadCooldownsFromDisk() {
        try {
            return JSON.parse(fs_1.default.readFileSync(_cooldownFile(), "utf8"));
        }
        catch {
            return {};
        }
    }
    _save() {
        try {
            const dest = _hookFile();
            const tmp = dest + ".tmp";
            fs_1.default.writeFileSync(tmp, JSON.stringify({ hooks: this._hooks }, null, 2));
            fs_1.default.renameSync(tmp, dest);
            try {
                fs_1.default.chmodSync(dest, 0o600);
            }
            catch { /* Windows */ }
        }
        catch (e) {
            logger_1.logger.error("HookStore save failed", { err: e.message });
        }
    }
    _saveCooldowns() {
        try {
            const dest = _cooldownFile();
            const tmp = dest + ".tmp";
            fs_1.default.writeFileSync(tmp, JSON.stringify(this._cooldowns, null, 2));
            fs_1.default.renameSync(tmp, dest);
            try {
                fs_1.default.chmodSync(dest, 0o600);
            }
            catch { /* Windows */ }
        }
        catch (e) {
            logger_1.logger.error("HookStore cooldown save failed", { err: e.message });
        }
    }
    add({ url, events, secret }) {
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            throw new errors_1.AppError("invalid webhook url", HTTP_STATUS_BAD_REQUEST);
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            throw new errors_1.AppError("webhook url must use http or https", HTTP_STATUS_BAD_REQUEST);
        }
        if (_isPrivateHost(parsed.hostname)) {
            throw new errors_1.AppError("webhook url must not target a private address", HTTP_STATUS_BAD_REQUEST);
        }
        if (events?.length) {
            const unknown = events.filter((e) => !VALID_EVENTS.has(e));
            if (unknown.length) {
                throw new errors_1.AppError(`unknown event(s): ${unknown.join(", ")}`, HTTP_STATUS_BAD_REQUEST);
            }
        }
        const id = crypto_1.default.randomBytes(4).toString("hex");
        const createdAt = new Date().toISOString();
        const hook = { id, url, events: events ?? [], secret: secret ?? null, createdAt };
        this._hooks.push(hook);
        this._save();
        const { secret: _s, ...publicHook } = hook;
        return publicHook;
    }
    remove(id) {
        const before = this._hooks.length;
        this._hooks = this._hooks.filter((h) => h.id !== id);
        if (this._hooks.length === before)
            return false;
        this._deliveryLog.delete(id);
        this._save();
        return true;
    }
    list() {
        return this._hooks.map(({ secret: _s, ...h }) => h);
    }
    _httpPost(hookUrl, body, headers) {
        const url = new URL(hookUrl);
        const lib = url.protocol === "https:" ? https_1.default : http_1.default;
        return new Promise((resolve) => {
            const req = lib.request({ hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, method: "POST", headers }, (res) => {
                res.resume();
                res.on("end", () => resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0 }));
            });
            req.setTimeout(HOOK_DELIVERY_TIMEOUT_MS, () => { req.destroy(); resolve({ ok: false, status: 0 }); });
            req.on("error", () => resolve({ ok: false, status: 0 }));
            req.write(body);
            req.end();
        });
    }
    _logDelivery(hookId, entry) {
        let log = this._deliveryLog.get(hookId);
        if (!log) {
            log = [];
            this._deliveryLog.set(hookId, log);
        }
        log.push(entry);
        if (log.length > DELIVERY_LOG_SIZE)
            log.shift();
    }
    getDeliveries(hookId) {
        return (this._deliveryLog.get(hookId) ?? []).slice().reverse();
    }
    async _deliver(hook, event, payload) {
        const body = JSON.stringify({ event, ...payload, ts: new Date().toISOString() });
        const headers = {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
        };
        if (hook.secret)
            headers["X-Hub-Signature-256"] = "sha256=" + crypto_1.default.createHmac("sha256", hook.secret).update(body).digest("hex");
        let result = { ok: false, status: 0 };
        let attempts = 0;
        for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt++) {
            if (attempt > 1)
                await (0, helpers_1.sleep)(2 ** (attempt - 2) * 1000);
            result = await this._httpPost(hook.url, body, headers);
            attempts = attempt;
            if (result.ok)
                break;
        }
        this._logDelivery(hook.id, { event, url: hook.url, ok: result.ok, status: result.status, attempts, ts: new Date().toISOString() });
    }
    async fireSnapshot(payload) {
        for (const hook of this._hooks) {
            if (hook.events.length && !hook.events.includes(enums_1.HookEvent.SNAPSHOT))
                continue;
            this._deliver(hook, enums_1.HookEvent.SNAPSHOT, payload).catch(() => { });
        }
    }
    async fire(batteries, health) {
        const currentBatInfo = new Map(batteries.map((b) => [b.sn, b.alias]));
        const prevBatInfo = this._prevBatInfo;
        this._prevBatInfo = currentBatInfo;
        const hooks = this._hooks;
        if (!hooks.length)
            return;
        const cooldowns = this._cooldowns;
        const now = Date.now();
        let changed = false;
        function _maybeQueue(events, ev) {
            const cooldownH = exports.HOOK_COOLDOWNS_H[ev.event] ?? DEFAULT_COOLDOWN_H;
            const key = `${ev.sn}:${ev.event}`;
            if (cooldowns[key] && now - cooldowns[key] < cooldownH * 3600000)
                return;
            cooldowns[key] = now;
            changed = true;
            events.push(ev);
        }
        const events = [];
        for (const bat of batteries) {
            const h = health?.[bat.sn];
            if (h) {
                const healthChecks = [
                    { event: enums_1.HookEvent.CELL_DELTA_CRIT, match: h.cellDeltaStatus === enums_1.HealthStatus.CRIT, value: h.cellDelta, threshold: compute_1.HEALTH_CELL_DELTA_CRIT },
                    { event: enums_1.HookEvent.CELL_DELTA_WARN, match: h.cellDeltaStatus === enums_1.HealthStatus.WARN, value: h.cellDelta, threshold: compute_1.HEALTH_CELL_DELTA_WARN },
                    { event: enums_1.HookEvent.TEMP_CRIT, match: h.tempStatus === enums_1.HealthStatus.CRIT, value: h.tempMax, threshold: compute_1.HEALTH_TEMP_CRIT },
                    { event: enums_1.HookEvent.TEMP_WARN, match: h.tempStatus === enums_1.HealthStatus.WARN, value: h.tempMax, threshold: compute_1.HEALTH_TEMP_WARN },
                    { event: enums_1.HookEvent.SOH_WARN, match: h.sohStatus === enums_1.HealthStatus.WARN, value: h.soh, threshold: compute_1.HEALTH_SOH_WARN },
                ];
                for (const c of healthChecks) {
                    if (c.match)
                        _maybeQueue(events, { event: c.event, sn: bat.sn, alias: bat.alias, value: c.value ?? null, threshold: c.threshold });
                }
            }
            const socChecks = [
                { event: enums_1.HookEvent.LOW_SOC, match: bat.soc > 0 && bat.soc <= LOW_SOC_PCT, value: bat.soc, threshold: LOW_SOC_PCT },
                { event: enums_1.HookEvent.FULL, match: bat.soc >= 100 && bat.chargingState === enums_1.ChargingState.STANDBY, value: bat.soc, threshold: 100 },
            ];
            for (const c of socChecks) {
                if (c.match)
                    _maybeQueue(events, { event: c.event, sn: bat.sn, alias: bat.alias, value: c.value, threshold: c.threshold });
            }
        }
        if (prevBatInfo !== null) {
            for (const [sn, alias] of currentBatInfo) {
                if (!prevBatInfo.has(sn))
                    _maybeQueue(events, { event: enums_1.HookEvent.ONLINE, sn, alias, value: null, threshold: null });
            }
            for (const [sn, alias] of prevBatInfo) {
                if (!currentBatInfo.has(sn))
                    _maybeQueue(events, { event: enums_1.HookEvent.OFFLINE, sn, alias, value: null, threshold: null });
            }
        }
        if (changed)
            this._saveCooldowns();
        for (const ev of events) {
            for (const hook of hooks) {
                if (hook.events.length && !hook.events.includes(ev.event))
                    continue;
                this._deliver(hook, ev.event, { sn: ev.sn, alias: ev.alias, value: ev.value, threshold: ev.threshold })
                    .catch(() => { });
            }
        }
    }
}
exports.HookStore = HookStore;
exports.hookStore = new HookStore();
