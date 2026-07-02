import crypto from "crypto";
import fs     from "fs";
import https  from "https";
import http   from "http";
import os     from "os";
import path   from "path";
import { constants } from "node:http2";
import {
  HEALTH_CELL_DELTA_WARN,
  HEALTH_CELL_DELTA_CRIT,
  HEALTH_TEMP_WARN,
  HEALTH_TEMP_CRIT,
  HEALTH_SOH_WARN,
  type BatteryHealth,
} from "./compute";
import { ChargingState, HealthStatus, HookEvent } from "./enums";
import { logger }                                  from "./logger";
import { sleep }                                   from "./helpers";
import { AppError }                                from "./errors";
import type { Battery }                            from "./battery";

const { HTTP_STATUS_BAD_REQUEST } = constants;

const HOOK_DELIVERY_TIMEOUT_MS = 8_000;
const DEFAULT_COOLDOWN_H       = 4;
const DELIVERY_MAX_ATTEMPTS    = 3;
const DELIVERY_LOG_SIZE        = 50;
const VALID_EVENTS: Set<string> = new Set(Object.values(HookEvent));

const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0$|::1$|::ffff:|fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i;

function _isPrivateHost(hostname: string): boolean {
  const h = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (PRIVATE_HOST.test(h)) return true;
  if (/^0x[0-9a-f]+$/i.test(h)) return true;
  if (/^0\d/.test(h)) return true;
  if (/^\d+$/.test(h)) return true;
  return false;
}

const LOW_SOC_PCT = parseInt(process.env.FELICITY_LOW_SOC_PCT ?? "20", 10);

export const HOOK_COOLDOWNS_H: Record<string, number> = {
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

function _hookFile(): string {
  return path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), "battery-hooks.json");
}

function _cooldownFile(): string {
  return path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), "battery-hook-cooldowns.json");
}

export interface HookSubscription {
  id:        string;
  url:       string;
  events:    string[];
  createdAt: string;
}

interface StoredHook extends HookSubscription {
  secret: string | null;
}

export interface HookDelivery {
  event:    string;
  url:      string;
  ok:       boolean;
  status:   number;
  attempts: number;
  ts:       string;
}

export interface SnapshotPayload {
  batteries: Battery[];
  health:    Record<string, BatteryHealth>;
  ts:        string;
}

export class HookStore {
  private _prevBatInfo: Map<string, string> | null = null;
  private _hooks:       StoredHook[];
  private _cooldowns:   Record<string, number>;
  private _deliveryLog: Map<string, HookDelivery[]> = new Map();

  constructor() {
    this._hooks     = this._loadFromDisk();
    this._cooldowns = this._loadCooldownsFromDisk();
  }

  private _loadFromDisk(): StoredHook[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(_hookFile(), "utf8")) as { hooks?: StoredHook[] };
      return parsed.hooks ?? [];
    } catch { return []; }
  }

  private _loadCooldownsFromDisk(): Record<string, number> {
    try { return JSON.parse(fs.readFileSync(_cooldownFile(), "utf8")) as Record<string, number>; }
    catch { return {}; }
  }

  private _save(): void {
    try {
      const dest = _hookFile();
      const tmp  = dest + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ hooks: this._hooks }, null, 2));
      fs.renameSync(tmp, dest);
      try { fs.chmodSync(dest, 0o600); } catch { /* Windows */ }
    } catch (e: unknown) { logger.error("HookStore save failed", { err: (e as Error).message }); }
  }

  private _saveCooldowns(): void {
    try {
      const dest = _cooldownFile();
      const tmp  = dest + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this._cooldowns, null, 2));
      fs.renameSync(tmp, dest);
      try { fs.chmodSync(dest, 0o600); } catch { /* Windows */ }
    } catch (e: unknown) { logger.error("HookStore cooldown save failed", { err: (e as Error).message }); }
  }

  add({ url, events, secret }: { url: string; events?: string[]; secret?: string }): HookSubscription {
    let parsed: URL;
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
    const hook: StoredHook = { id, url, events: events ?? [], secret: secret ?? null, createdAt };
    this._hooks.push(hook);
    this._save();
    const { secret: _s, ...publicHook } = hook;
    return publicHook;
  }

  remove(id: string): boolean {
    const before = this._hooks.length;
    this._hooks = this._hooks.filter((h) => h.id !== id);
    if (this._hooks.length === before) return false;
    this._deliveryLog.delete(id);
    this._save();
    return true;
  }

  list(): HookSubscription[] {
    return this._hooks.map(({ secret: _s, ...h }) => h);
  }

  private _httpPost(hookUrl: string, body: string, headers: Record<string, string | number>): Promise<{ ok: boolean; status: number }> {
    const url = new URL(hookUrl);
    const lib = url.protocol === "https:" ? https : http;
    return new Promise((resolve) => {
      const req = lib.request(
        { hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, method: "POST", headers },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0 }));
        }
      );
      req.setTimeout(HOOK_DELIVERY_TIMEOUT_MS, () => { req.destroy(); resolve({ ok: false, status: 0 }); });
      req.on("error", () => resolve({ ok: false, status: 0 }));
      req.write(body);
      req.end();
    });
  }

  private _logDelivery(hookId: string, entry: HookDelivery): void {
    let log = this._deliveryLog.get(hookId);
    if (!log) { log = []; this._deliveryLog.set(hookId, log); }
    log.push(entry);
    if (log.length > DELIVERY_LOG_SIZE) log.shift();
  }

  getDeliveries(hookId: string): HookDelivery[] {
    return (this._deliveryLog.get(hookId) ?? []).slice().reverse();
  }

  private async _deliver(hook: StoredHook, event: string, payload: Record<string, unknown>): Promise<void> {
    const body    = JSON.stringify({ event, ...payload, ts: new Date().toISOString() });
    const headers: Record<string, string | number> = {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
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

  async fireSnapshot(payload: SnapshotPayload): Promise<void> {
    for (const hook of this._hooks) {
      if (hook.events.length && !hook.events.includes(HookEvent.SNAPSHOT)) continue;
      this._deliver(hook, HookEvent.SNAPSHOT, payload as unknown as Record<string, unknown>).catch(() => {});
    }
  }

  async fire(batteries: Battery[], health: Record<string, BatteryHealth>): Promise<void> {
    const currentBatInfo = new Map(batteries.map((b) => [b.sn, b.alias]));
    const prevBatInfo    = this._prevBatInfo;
    this._prevBatInfo    = currentBatInfo;

    const hooks = this._hooks;
    if (!hooks.length) return;

    const cooldowns = this._cooldowns;
    const now       = Date.now();
    let changed     = false;

    interface FireEvent {
      event:     string;
      sn:        string;
      alias:     string;
      value:     number | null;
      threshold: number | null;
    }

    function _maybeQueue(events: FireEvent[], ev: FireEvent): void {
      const cooldownH = HOOK_COOLDOWNS_H[ev.event] ?? DEFAULT_COOLDOWN_H;
      const key = `${ev.sn}:${ev.event}`;
      if (cooldowns[key] && now - cooldowns[key] < cooldownH * 3_600_000) return;
      cooldowns[key] = now;
      changed = true;
      events.push(ev);
    }

    const events: FireEvent[] = [];

    for (const bat of batteries) {
      const h = health?.[bat.sn];

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

      const socChecks = [
        { event: HookEvent.LOW_SOC, match: bat.soc > 0 && bat.soc <= LOW_SOC_PCT, value: bat.soc, threshold: LOW_SOC_PCT },
        { event: HookEvent.FULL,    match: bat.soc >= 100 && bat.chargingState === ChargingState.STANDBY, value: bat.soc, threshold: 100 },
      ];
      for (const c of socChecks) {
        if (c.match) _maybeQueue(events, { event: c.event, sn: bat.sn, alias: bat.alias, value: c.value, threshold: c.threshold });
      }
    }

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

export const hookStore: HookStore = new HookStore();
