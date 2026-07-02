"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dailySnapshotStore = exports.snapshotStore = exports.DailySnapshotStore = exports.BatterySnapshotStore = exports.SnapshotStore = void 0;
exports.resolveSnapshotConfig = resolveSnapshotConfig;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const helpers_1 = require("./helpers");
const enums_1 = require("./enums");
const logger_1 = require("./logger");
const TREND_STABLE_MV = 3;
// ── Snapshot config ───────────────────────────────────────────────────────────
const SNAPSHOT_MS_DEFAULT = 10 * 60 * 1000;
const SNAPSHOT_MS_MIN = 60 * 1000;
const SNAPSHOT_MS_MAX = 60 * 60 * 1000;
const SNAPSHOT_DAYS_DEFAULT = 3;
const SNAPSHOT_DAYS_MIN = 1;
const SNAPSHOT_DAYS_MAX = 30;
const DAILY_DAYS_DEFAULT = 90;
const DAILY_DAYS_MIN = 7;
const DAILY_DAYS_MAX = 365;
function resolveSnapshotConfig() {
    const enabled = (process.env.FELICITY_SNAPSHOT_ENABLED ?? "true") === "true";
    const ms = (0, helpers_1.clamp)(SNAPSHOT_MS_MIN, parseInt(process.env.FELICITY_SNAPSHOT_MS ?? String(SNAPSHOT_MS_DEFAULT), 10), SNAPSHOT_MS_MAX);
    const days = (0, helpers_1.clamp)(SNAPSHOT_DAYS_MIN, parseInt(process.env.FELICITY_SNAPSHOT_DAYS ?? String(SNAPSHOT_DAYS_DEFAULT), 10), SNAPSHOT_DAYS_MAX);
    const ddays = (0, helpers_1.clamp)(DAILY_DAYS_MIN, parseInt(process.env.FELICITY_DAILY_DAYS ?? String(DAILY_DAYS_DEFAULT), 10), DAILY_DAYS_MAX);
    const maxIntra = Math.ceil((days * 24 * 60 * 60 * 1000) / ms);
    return { enabled, ms, maxIntra, ddays };
}
// ── SnapshotStore ─────────────────────────────────────────────────────────────
class SnapshotStore {
    constructor({ fileName, maxSnapshots, intervalMs }) {
        this._fileName = fileName;
        this._maxSnapshots = maxSnapshots;
        this._intervalMs = intervalMs;
    }
    get _file() {
        return path_1.default.join(process.env.SNAPSHOT_DIR ?? os_1.default.tmpdir(), this._fileName);
    }
    _load() {
        try {
            const parsed = JSON.parse(fs_1.default.readFileSync(this._file, "utf8"));
            return parsed.snapshots ?? [];
        }
        catch {
            return [];
        }
    }
    _save(snapshots) {
        try {
            const dest = this._file;
            const tmp = dest + ".tmp";
            fs_1.default.writeFileSync(tmp, JSON.stringify({ snapshots }, null, 2));
            fs_1.default.renameSync(tmp, dest);
            try {
                fs_1.default.chmodSync(dest, 0o600);
            }
            catch { /* Windows */ }
        }
        catch (e) {
            logger_1.logger.error("SnapshotStore write failed", { store: this._fileName, err: e.message });
        }
    }
    maybeAdd(batteries) {
        try {
            const snapshots = this._load();
            const last = snapshots[snapshots.length - 1];
            if (last && Date.now() - new Date(last.ts).getTime() < this._intervalMs)
                return;
            snapshots.push({ ts: new Date().toISOString(), batteries: batteries.map(helpers_1.pickSnapshotFields) });
            if (snapshots.length > this._maxSnapshots)
                snapshots.splice(0, snapshots.length - this._maxSnapshots);
            this._save(snapshots);
        }
        catch { /* non-fatal */ }
    }
    getSnapshots() { return this._load(); }
}
exports.SnapshotStore = SnapshotStore;
// ── BatterySnapshotStore ──────────────────────────────────────────────────────
class BatterySnapshotStore extends SnapshotStore {
    constructor() {
        const { ms, maxIntra } = resolveSnapshotConfig();
        super({ fileName: "battery-snapshots.json", maxSnapshots: maxIntra, intervalMs: ms });
    }
    _computeTrend(sn, snapshots) {
        const history = snapshots
            .map((s) => s.batteries.find((b) => b.sn === sn))
            .filter((b) => b != null);
        if (history.length < 2)
            return null;
        const deltas = history.map((b) => b.cellDelta).filter((v) => v != null);
        if (deltas.length < 2)
            return null;
        const change = deltas[deltas.length - 1] - deltas[0];
        let currentBalancingStreak = 0;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].isBalancing)
                currentBalancingStreak++;
            else
                break;
        }
        return {
            direction: change < -TREND_STABLE_MV ? enums_1.TrendDirection.IMPROVING : change > TREND_STABLE_MV ? enums_1.TrendDirection.DEGRADING : enums_1.TrendDirection.STABLE,
            deltaChange: change,
            history: deltas,
            balancingCount: history.filter((b) => b.isBalancing).length,
            snapshotCount: history.length,
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
            if (trend)
                result[bat.sn] = trend;
        }
        return result;
    }
}
exports.BatterySnapshotStore = BatterySnapshotStore;
// ── DailySnapshotStore ────────────────────────────────────────────────────────
class DailySnapshotStore extends SnapshotStore {
    constructor() {
        const { ddays } = resolveSnapshotConfig();
        super({ fileName: "battery-daily.json", maxSnapshots: ddays, intervalMs: 24 * 60 * 60 * 1000 });
    }
}
exports.DailySnapshotStore = DailySnapshotStore;
// ── Singletons ────────────────────────────────────────────────────────────────
exports.snapshotStore = new BatterySnapshotStore();
exports.dailySnapshotStore = new DailySnapshotStore();
