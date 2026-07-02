"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FelicityClient = void 0;
const crypto_1 = __importDefault(require("crypto"));
const http_1 = require("./http");
const store_1 = require("./store");
const battery_1 = require("./battery");
const cache_1 = require("./cache");
class FelicityClient {
    constructor({ user, pass, cache, ttl = 30, snapshotStore, dailySnapshotStore, _fetch = http_1.felicityRequest }) {
        this._token = null;
        this._tokenExpiry = 0;
        this._user = user;
        this._pass = pass;
        this._cache = cache ?? new cache_1.MemoryCacheAdapter();
        this._ttl = ttl;
        this._fetch = _fetch;
        this._snapshotStore = snapshotStore ?? store_1.snapshotStore;
        this._dailySnapshotStore = dailySnapshotStore ?? store_1.dailySnapshotStore;
    }
    // ── Auth ──────────────────────────────────────────────────────────────────
    async _ensureToken() {
        if (!this._user || !this._pass)
            throw new Error("FelicityClient: user and pass are required");
        if (this._token && Date.now() < this._tokenExpiry)
            return this._token;
        const encPass = crypto_1.default
            .publicEncrypt({ key: http_1.RSA_PUB, padding: crypto_1.default.constants.RSA_PKCS1_PADDING }, Buffer.from(this._pass))
            .toString("base64");
        const resp = await this._fetch("POST", "/userlogin", { userName: this._user, password: encPass, version: "1.0" });
        if (resp.code !== 200)
            throw new Error(`Felicity login failed: ${resp.message ?? resp.code}`);
        const data = resp.data;
        const raw = data?.token
            ?? data?.data?.token
            ?? data;
        this._token = String(raw).replace(/^Bearer_/, "");
        this._tokenExpiry = Date.now() + http_1.TOKEN_TTL_MS;
        return this._token;
    }
    // ── Fetch ─────────────────────────────────────────────────────────────────
    async _fetchAll() {
        const PAGE_SIZE = 100;
        let retried = false;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const token = await this._ensureToken();
            let allDevices = [];
            let pageNum = 1;
            let authFailed = false;
            while (true) {
                const devResp = await this._fetch("POST", "/device/list_device_all_type", { pageNum, pageSize: PAGE_SIZE }, token);
                if (devResp.code !== 200) {
                    if (!retried && (devResp.code === 401 || devResp.code === 403 || /token|auth|expired/i.test(devResp.message ?? ""))) {
                        retried = true;
                        this._token = null;
                        this._tokenExpiry = 0;
                        authFailed = true;
                        break;
                    }
                    throw new Error(`Device list failed: ${devResp.message ?? devResp.code} — response: ${JSON.stringify(devResp).slice(0, 200)}`);
                }
                const page = (devResp.data?.dataList ?? []);
                allDevices.push(...page);
                if (page.length < PAGE_SIZE)
                    break;
                pageNum++;
            }
            if (authFailed)
                continue;
            const devices = allDevices.filter((d) => d.deviceType === "BP");
            const dateStr = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
            const batteries = await Promise.all(devices.map(async (dev) => {
                const snap = await this._fetch("POST", "/device/get_device_snapshot", { deviceSn: dev.deviceSn, deviceType: "BP", dateStr }, token);
                if (snap.code !== 200)
                    throw new Error(`Snapshot failed for ${dev.deviceSn}: ${snap.message ?? snap.code}`);
                return (0, battery_1.buildBattery)(dev, snap.data);
            }));
            batteries.sort((a, b) => a.alias.localeCompare(b.alias));
            return batteries;
        }
    }
    // ── Public API ────────────────────────────────────────────────────────────
    async getBatteries() {
        const CACHE_KEY = `batteries:${this._user}`;
        const cached = await this._cache.get(CACHE_KEY);
        if (cached)
            return { ...cached, fromCache: true, trend: this._snapshotStore.getAllTrends(cached.batteries) };
        const batteries = await this._fetchAll();
        const fetchedAt = new Date().toISOString();
        await this._cache.set(CACHE_KEY, { batteries, fetchedAt }, this._ttl);
        this._snapshotStore.maybeAdd(batteries);
        this._dailySnapshotStore.maybeAdd(batteries);
        return { batteries, fetchedAt, fromCache: false, trend: this._snapshotStore.getAllTrends(batteries) };
    }
    async getBattery(id) {
        const { batteries, fetchedAt, fromCache } = await this.getBatteries();
        const battery = batteries.find((b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id);
        return { battery: battery ?? null, fetchedAt, fromCache };
    }
}
exports.FelicityClient = FelicityClient;
