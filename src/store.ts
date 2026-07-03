import fs   from "fs";
import os   from "os";
import path from "path";
import { clamp, pickSnapshotFields, type SnapshotEntry } from "./helpers";
import { TrendDirection }                                 from "./enums";
import { logger }                                         from "./logger";
import { TREND_STABLE_MV,
         SNAPSHOT_MS_DEFAULT, SNAPSHOT_MS_MIN, SNAPSHOT_MS_MAX,
         SNAPSHOT_DAYS_DEFAULT, SNAPSHOT_DAYS_MIN, SNAPSHOT_DAYS_MAX,
         DAILY_DAYS_DEFAULT, DAILY_DAYS_MIN, DAILY_DAYS_MAX }   from "./constants";
import type { Battery }                                   from "./battery";

export interface BatterySnapshot {
  ts:        string;
  batteries: SnapshotEntry[];
}

export interface BalanceTrend {
  direction:              TrendDirection;
  deltaChange:            number;
  history:                number[];
  balancingCount:         number;
  snapshotCount:          number;
  currentBalancingStreak: number;
}

export function resolveSnapshotConfig(): { enabled: boolean; ms: number; maxIntra: number; ddays: number } {
  const enabled = (process.env.FELICITY_SNAPSHOT_ENABLED ?? "true") === "true";
  const ms    = clamp(SNAPSHOT_MS_MIN,   parseInt(process.env.FELICITY_SNAPSHOT_MS   ?? String(SNAPSHOT_MS_DEFAULT),   10), SNAPSHOT_MS_MAX);
  const days  = clamp(SNAPSHOT_DAYS_MIN, parseInt(process.env.FELICITY_SNAPSHOT_DAYS ?? String(SNAPSHOT_DAYS_DEFAULT), 10), SNAPSHOT_DAYS_MAX);
  const ddays = clamp(DAILY_DAYS_MIN,    parseInt(process.env.FELICITY_DAILY_DAYS    ?? String(DAILY_DAYS_DEFAULT),    10), DAILY_DAYS_MAX);
  const maxIntra = Math.ceil((days * 24 * 60 * 60 * 1000) / ms);
  return { enabled, ms, maxIntra, ddays };
}

// ── SnapshotStore ─────────────────────────────────────────────────────────────

export class SnapshotStore {
  protected _fileName:     string;
  protected _maxSnapshots: number;
  protected _intervalMs:   number;

  constructor({ fileName, maxSnapshots, intervalMs }: { fileName: string; maxSnapshots: number; intervalMs: number }) {
    this._fileName     = fileName;
    this._maxSnapshots = maxSnapshots;
    this._intervalMs   = intervalMs;
  }

  protected get _file(): string {
    return path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), this._fileName);
  }

  protected _load(): BatterySnapshot[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file, "utf8")) as { snapshots?: BatterySnapshot[] };
      return parsed.snapshots ?? [];
    } catch { return []; }
  }

  protected _save(snapshots: BatterySnapshot[]): void {
    try {
      const dest = this._file;
      const tmp  = dest + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ snapshots }, null, 2));
      fs.renameSync(tmp, dest);
      try { fs.chmodSync(dest, 0o600); } catch { /* Windows */ }
    } catch (e: unknown) {
      logger.error("SnapshotStore write failed", { store: this._fileName, err: (e as Error).message });
    }
  }

  maybeAdd(batteries: Battery[]): void {
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

  getSnapshots(): BatterySnapshot[] { return this._load(); }
}

// ── BatterySnapshotStore ──────────────────────────────────────────────────────

export class BatterySnapshotStore extends SnapshotStore {
  constructor() {
    const { ms, maxIntra } = resolveSnapshotConfig();
    super({ fileName: "battery-snapshots.json", maxSnapshots: maxIntra, intervalMs: ms });
  }

  private _computeTrend(sn: string, snapshots: BatterySnapshot[]): BalanceTrend | null {
    const history = snapshots
      .map((s) => s.batteries.find((b) => b.sn === sn))
      .filter((b): b is SnapshotEntry => b != null);
    if (history.length < 2) return null;
    const deltas = history.map((b) => b.cellDelta).filter((v): v is number => v != null);
    if (deltas.length < 2) return null;
    const change = deltas[deltas.length - 1] - deltas[0];
    let currentBalancingStreak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].isBalancing) currentBalancingStreak++;
      else break;
    }
    return {
      direction:              change < -TREND_STABLE_MV ? TrendDirection.IMPROVING : change > TREND_STABLE_MV ? TrendDirection.DEGRADING : TrendDirection.STABLE,
      deltaChange:            change,
      history:                deltas,
      balancingCount:         history.filter((b) => b.isBalancing).length,
      snapshotCount:          history.length,
      currentBalancingStreak,
    };
  }

  getTrend(sn: string): BalanceTrend | null {
    return this._computeTrend(sn, this._load());
  }

  getAllTrends(batteries: Pick<Battery, "sn">[], snapshots?: BatterySnapshot[]): Record<string, BalanceTrend> {
    const snaps = snapshots ?? this._load();
    const result: Record<string, BalanceTrend> = {};
    for (const bat of batteries) {
      const trend = this._computeTrend(bat.sn, snaps);
      if (trend) result[bat.sn] = trend;
    }
    return result;
  }
}

// ── DailySnapshotStore ────────────────────────────────────────────────────────

export class DailySnapshotStore extends SnapshotStore {
  constructor() {
    const { ddays } = resolveSnapshotConfig();
    super({ fileName: "battery-daily.json", maxSnapshots: ddays, intervalMs: 24 * 60 * 60 * 1000 });
  }
}

// ── DailyEnergyStore ──────────────────────────────────────────────────────────

export interface DailyEnergy {
  date:            string;
  kwhCharged:      number;
  kwhDischarged:   number;
  kwhNet:          number;
  peakChargeKw:    number;
  peakDischargeKw: number;
  snapshotCount:   number;
}

export class DailyEnergyStore {
  private _records:         DailyEnergy[];
  private readonly _maxDays: number;

  constructor() {
    const { ddays } = resolveSnapshotConfig();
    this._maxDays   = ddays;
    this._records   = this._load();
  }

  private get _file(): string {
    return path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), "battery-energy.json");
  }

  private _load(): DailyEnergy[] {
    try { return JSON.parse(fs.readFileSync(this._file, "utf8")) as DailyEnergy[]; }
    catch { return []; }
  }

  private _save(): void {
    try {
      const dest = this._file;
      const tmp  = dest + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this._records, null, 2));
      fs.renameSync(tmp, dest);
      try { fs.chmodSync(dest, 0o600); } catch { /* Windows */ }
    } catch (e: unknown) {
      logger.error("DailyEnergyStore write failed", { err: (e as Error).message });
    }
  }

  update(entries: DailyEnergy[]): void {
    if (!entries.length) return;
    const cutoff = new Date(Date.now() - this._maxDays * 86_400_000).toISOString().slice(0, 10);
    const map    = new Map(this._records.map((r) => [r.date, r]));
    for (const e of entries) {
      if (e.date >= cutoff) map.set(e.date, e);
    }
    this._records = [...map.values()]
      .filter((r) => r.date >= cutoff)
      .sort((a, b) => a.date.localeCompare(b.date));
    this._save();
  }

  get(): DailyEnergy[] { return this._records.slice(); }
}

// ── Singletons ────────────────────────────────────────────────────────────────

export const snapshotStore:      BatterySnapshotStore = new BatterySnapshotStore();
export const dailySnapshotStore: DailySnapshotStore   = new DailySnapshotStore();
export const dailyEnergyStore:   DailyEnergyStore     = new DailyEnergyStore();
