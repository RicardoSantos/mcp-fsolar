import crypto from "crypto";
import { RSA_PUB, TOKEN_TTL_MS, felicityRequest }                              from "./http";
import { snapshotStore as _defaultSnapshotStore,
         dailySnapshotStore as _defaultDailySnapshotStore,
         type BatterySnapshot }                                                from "./store";
import { buildBattery }                                                        from "./battery";
import { MemoryCacheAdapter, type CacheAdapter }                               from "./cache";
import { logger }                                                              from "./logger";
import type { Battery }                                                        from "./battery";
import type { BatterySnapshotStore, DailySnapshotStore, BalanceTrend }        from "./store";

export interface BatteriesResult {
  batteries: Battery[];
  fetchedAt: string;
  fromCache: boolean;
  trend:     Record<string, BalanceTrend>;
}

export interface BatteryResult {
  battery:   Battery | null;
  fetchedAt: string;
  fromCache: boolean;
}

export interface FelicityClientOptions {
  user:                string;
  pass:                string;
  cache?:              CacheAdapter;
  ttl?:                number;
  snapshotStore?:      BatterySnapshotStore;
  dailySnapshotStore?: DailySnapshotStore;
  /** Internal: override HTTP transport (for testing). */
  _fetch?: typeof felicityRequest;
}

interface ApiResponse {
  code:    number;
  message?: string;
  data?:   unknown;
}

export class FelicityClient {
  private _user:               string;
  private _pass:               string;
  private _cache:              CacheAdapter;
  private _ttl:                number;
  private _fetch:              typeof felicityRequest;
  private _token:              string | null     = null;
  private _tokenExpiry:        number            = 0;
  private _snapshotStore:      BatterySnapshotStore;
  private _dailySnapshotStore: DailySnapshotStore;

  constructor({ user, pass, cache, ttl = 30, snapshotStore, dailySnapshotStore, _fetch = felicityRequest }: FelicityClientOptions) {
    this._user               = user;
    this._pass               = pass;
    this._cache              = cache ?? new MemoryCacheAdapter();
    this._ttl                = ttl;
    this._fetch              = _fetch;
    this._snapshotStore      = snapshotStore      ?? _defaultSnapshotStore;
    this._dailySnapshotStore = dailySnapshotStore ?? _defaultDailySnapshotStore;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private async _ensureToken(): Promise<string> {
    if (!this._user || !this._pass) throw new Error("FelicityClient: user and pass are required");
    if (this._token && Date.now() < this._tokenExpiry) return this._token;
    const encPass = crypto
      .publicEncrypt({ key: RSA_PUB, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(this._pass))
      .toString("base64");
    const resp = await this._fetch("POST", "/userlogin", { userName: this._user, password: encPass, version: "1.0" }) as ApiResponse;
    if (resp.code !== 200) throw new Error(`Felicity login failed: ${resp.message ?? resp.code}`);
    const data = resp.data as Record<string, unknown> | null | undefined;
    const raw  = (data as Record<string, unknown> | null)?.token
      ?? (data as Record<string, Record<string, unknown>> | null)?.data?.token
      ?? data;
    this._token       = String(raw).replace(/^Bearer_/, "");
    this._tokenExpiry = Date.now() + TOKEN_TTL_MS;
    return this._token;
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────

  private async _fetchAll(): Promise<Battery[]> {
    const PAGE_SIZE = 100;
    let retried = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const token      = await this._ensureToken();
      let allDevices: Record<string, unknown>[] = [];
      let pageNum      = 1;
      let authFailed   = false;

      while (true) {
        const devResp = await this._fetch("POST", "/device/list_device_all_type", { pageNum, pageSize: PAGE_SIZE }, token) as ApiResponse;

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

        const page = ((devResp.data as Record<string, unknown>)?.dataList ?? []) as Record<string, unknown>[];
        allDevices.push(...page);
        if (page.length < PAGE_SIZE) break;
        pageNum++;
      }

      if (authFailed) continue;

      const devices = allDevices.filter((d) => d.deviceType === "BP");
      const dateStr = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

      const batteries = await Promise.all(
        devices.map(async (dev) => {
          const snap = await this._fetch("POST", "/device/get_device_snapshot",
            { deviceSn: dev.deviceSn, deviceType: "BP", dateStr }, token) as ApiResponse;
          if (snap.code !== 200) throw new Error(`Snapshot failed for ${dev.deviceSn}: ${snap.message ?? snap.code}`);
          return buildBattery(dev, snap.data as Record<string, unknown>);
        })
      );

      batteries.sort((a, b) => a.alias.localeCompare(b.alias));
      return batteries;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async getBatteries(): Promise<BatteriesResult> {
    const CACHE_KEY = `batteries:${this._user}`;
    const cached    = await this._cache.get(CACHE_KEY);
    if (cached) return { ...cached, fromCache: true, trend: this._snapshotStore.getAllTrends(cached.batteries) };

    const batteries = await this._fetchAll();
    const fetchedAt = new Date().toISOString();
    await this._cache.set(CACHE_KEY, { batteries, fetchedAt }, this._ttl);
    this._snapshotStore.maybeAdd(batteries);
    this._dailySnapshotStore.maybeAdd(batteries);
    return { batteries, fetchedAt, fromCache: false, trend: this._snapshotStore.getAllTrends(batteries) };
  }

  async getBattery(id: string): Promise<BatteryResult> {
    const { batteries, fetchedAt, fromCache } = await this.getBatteries();
    const battery = batteries.find(
      (b) => b.alias.toLowerCase() === id.toLowerCase() || b.sn === id
    );
    return { battery: battery ?? null, fetchedAt, fromCache };
  }
}
