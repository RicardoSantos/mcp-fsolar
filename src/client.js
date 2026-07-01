"use strict";

const crypto = require("crypto");
const { RSA_PUB, TOKEN_TTL_MS, felicityRequest } = require("./http");
const { snapshotStore, dailySnapshotStore }      = require("./store");
const { buildBattery }                           = require("./battery");
const { MemoryCacheAdapter }                     = require("./cache");

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
    this._tokenExpiry = Date.now() + TOKEN_TTL_MS;
    return this._token;
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────

  async _fetchAll() {
    const token   = await this._ensureToken();
    const devResp = await this._fetch("POST", "/device/list_device_all_type", { pageNum: 1, pageSize: 100 }, token);
    if (devResp.code !== 200)
      throw new Error(`Device list failed: ${devResp.message ?? devResp.code} — response: ${JSON.stringify(devResp).slice(0, 200)}`);

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

module.exports = { FelicityClient };
