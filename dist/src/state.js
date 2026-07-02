"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.snapshotEmitter = void 0;
exports.readState = readState;
exports.startPoller = startPoller;
const events_1 = require("events");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const store_1 = require("./store");
const hooks_1 = require("./hooks");
const compute_1 = require("./compute");
const logger_1 = require("./logger");
const POLL_MS = parseInt(process.env.FELICITY_POLL_MS ?? "30000", 10);
const TELEMETRY_MS = parseInt(process.env.FELICITY_TELEMETRY_MS ?? "300000", 10);
exports.snapshotEmitter = new events_1.EventEmitter();
function _stateFile() {
    return path_1.default.join(process.env.SNAPSHOT_DIR ?? os_1.default.tmpdir(), "felicity-state.json");
}
function _writeState(batteries, snapshots, health, snapshotStore) {
    try {
        const trend = snapshotStore.getAllTrends(batteries, snapshots);
        const autonomy = (0, compute_1.computeAutonomy)(batteries, snapshots);
        const dest = _stateFile();
        const tmp = dest + ".tmp";
        fs_1.default.writeFileSync(tmp, JSON.stringify({ batteries, trend, health, autonomy, updatedAt: new Date().toISOString() }, null, 2));
        fs_1.default.renameSync(tmp, dest);
        try {
            fs_1.default.chmodSync(dest, 0o600);
        }
        catch { /* Windows */ }
    }
    catch (e) {
        logger_1.logger.error("_writeState failed", { err: e.message });
    }
}
async function readState() {
    try {
        return JSON.parse(await fs_1.default.promises.readFile(_stateFile(), "utf8"));
    }
    catch {
        return null;
    }
}
function startPoller(client, opts = {}) {
    const snapshotStore = opts.snapshotStore ?? store_1.snapshotStore;
    const hookStore = opts.hookStore ?? hooks_1.hookStore;
    let _tickRunning = false;
    let _lastBatteries = null;
    let _lastHealth = null;
    function _emitSnapshot() {
        if (!_lastBatteries)
            return;
        const payload = { batteries: _lastBatteries, health: _lastHealth ?? {}, ts: new Date().toISOString() };
        exports.snapshotEmitter.emit("snapshot", payload);
        hookStore.fireSnapshot(payload).catch(() => { });
    }
    async function tick() {
        if (_tickRunning)
            return;
        _tickRunning = true;
        try {
            const { batteries } = await client.getBatteries();
            const snapshots = snapshotStore.getSnapshots();
            const health = (0, compute_1.computeHealth)(batteries, snapshots);
            _lastBatteries = batteries;
            _lastHealth = health;
            _writeState(batteries, snapshots, health, snapshotStore);
            await hookStore.fire(batteries, health);
        }
        catch (err) {
            logger_1.logger.error("tick error", { err: err.message });
        }
        finally {
            _tickRunning = false;
        }
    }
    tick();
    const tickInterval = setInterval(tick, POLL_MS);
    const telemetryInterval = setInterval(_emitSnapshot, TELEMETRY_MS);
    return {
        stop() {
            clearInterval(tickInterval);
            clearInterval(telemetryInterval);
        },
    };
}
