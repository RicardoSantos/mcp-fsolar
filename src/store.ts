import fs   from "fs";
import os   from "os";
import path from "path";
import { clamp, pickSnapshotFields, type SnapshotEntry } from "./helpers";
import { TrendDirection }                                 from "./enums";
import { logger }                                         from "./logger";
import type { Battery }                                   from "./battery";

const TREND_STABLE_MV = 3;

// ── Snapshot config ───────────────────────────────────────────────────────────

const SNAPSHOT_MS_DEFAULT   = 10 * 60 * 1000;
const SNAPSHOT_MS_MIN       = 60 * 1000;
const SNAPSHOT_MS_MAX       = 60 * 60 * 1000;
const SNAPSHOT_DAYS_DEFAULT = 3;
const SNAPSHOT_DAYS_MIN     = 1;
const SNAPSHOT_DAYS_MAX     = 30;
const DAILY_DAYS_DEFAULT    = 90;
const DAILY_DAYS_MIN        = 7;
const DAILY_DAYS_MAX        = 365;

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

// ── Singletons ────────────────────────────────────────────────────────────────

export const snapshotStore:      BatterySnapshotStore = new BatterySnapshotStore();
export const dailySnapshotStore: DailySnapshotStore   = new DailySnapshotStore();
