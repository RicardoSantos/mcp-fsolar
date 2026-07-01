"use strict";

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { clamp, pickSnapshotFields } = require("./helpers");
const { TrendDirection }            = require("./enums");

const TREND_STABLE_MV = 3;  // dead-band: delta change within ±3 mV is classified as "stable"

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

function resolveSnapshotConfig() {
  const enabled = (process.env.FELICITY_SNAPSHOT_ENABLED ?? "true") === "true";
  const ms    = clamp(SNAPSHOT_MS_MIN,   parseInt(process.env.FELICITY_SNAPSHOT_MS   ?? String(SNAPSHOT_MS_DEFAULT),   10), SNAPSHOT_MS_MAX);
  const days  = clamp(SNAPSHOT_DAYS_MIN, parseInt(process.env.FELICITY_SNAPSHOT_DAYS ?? String(SNAPSHOT_DAYS_DEFAULT), 10), SNAPSHOT_DAYS_MAX);
  const ddays = clamp(DAILY_DAYS_MIN,    parseInt(process.env.FELICITY_DAILY_DAYS    ?? String(DAILY_DAYS_DEFAULT),    10), DAILY_DAYS_MAX);
  const maxIntra = Math.ceil((days * 24 * 60 * 60 * 1000) / ms);
  return { enabled, ms, maxIntra, ddays };
}

// ── SnapshotStore ─────────────────────────────────────────────────────────────

class SnapshotStore {
  constructor({ fileName, maxSnapshots, intervalMs }) {
    this._fileName     = fileName;
    this._maxSnapshots = maxSnapshots;
    this._intervalMs   = intervalMs;
  }

  get _file() {
    return path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), this._fileName);
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this._file, "utf8")).snapshots ?? []; }
    catch { return []; }
  }

  _save(snapshots) {
    try {
      const dest = this._file;
      const tmp  = dest + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ snapshots }, null, 2));
      fs.renameSync(tmp, dest);
      try { fs.chmodSync(dest, 0o600); } catch { /* Windows */ }
    } catch (e) { console.error(`[SnapshotStore:${this._fileName}] write failed: ${e.message}`); }
  }

  maybeAdd(batteries) {
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

  getSnapshots() { return this._load(); }
}

// ── BatterySnapshotStore ──────────────────────────────────────────────────────

class BatterySnapshotStore extends SnapshotStore {
  constructor() {
    const { ms, maxIntra } = resolveSnapshotConfig();
    super({ fileName: "battery-snapshots.json", maxSnapshots: maxIntra, intervalMs: ms });
  }

  _computeTrend(sn, snapshots) {
    const history = snapshots
      .map((s) => s.batteries.find((b) => b.sn === sn))
      .filter(Boolean);
    if (history.length < 2) return null;
    const deltas = history.map((b) => b.cellDelta).filter((v) => v != null);
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

  getTrend(sn) {
    return this._computeTrend(sn, this._load());
  }

  getAllTrends(batteries, snapshots) {
    const snaps = snapshots ?? this._load();
    const result = {};
    for (const bat of batteries) {
      const trend = this._computeTrend(bat.sn, snaps);
      if (trend) result[bat.sn] = trend;
    }
    return result;
  }
}

// ── DailySnapshotStore ────────────────────────────────────────────────────────

class DailySnapshotStore extends SnapshotStore {
  constructor() {
    const { ddays } = resolveSnapshotConfig();
    super({ fileName: "battery-daily.json", maxSnapshots: ddays, intervalMs: 24 * 60 * 60 * 1000 });
  }
}

// ── Singletons ────────────────────────────────────────────────────────────────

const snapshotStore      = new BatterySnapshotStore();
const dailySnapshotStore = new DailySnapshotStore();

module.exports = {
  SnapshotStore,
  BatterySnapshotStore,
  DailySnapshotStore,
  snapshotStore,
  dailySnapshotStore,
  resolveSnapshotConfig,
};
